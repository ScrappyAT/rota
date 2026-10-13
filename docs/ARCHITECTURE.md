# Architecture Overview

This document describes the implemented architecture of the Rota application.

## System Components

1. **Mobile App (`apps/mobile`)**: An Expo SDK 57 (React Native 0.86) application
   using Expo Router for navigation and `@tanstack/react-query` for server state.
   `expo-secure-store` holds the access/refresh tokens and the selected team id.
   Screens live in `apps/mobile/app/`, non-route code (API layer, contexts,
   components, utils) in `apps/mobile/src/`.

2. **Backend API (`apps/api`)**: Node.js + Express 4. Route handlers are thin and
   delegate validation to Zod schemas from `packages/shared`; team-scoped routes
   are protected by `authenticate` + `requireRole`. Multi-statement writes run in
   explicit Postgres transactions (`BEGIN`/`COMMIT`/`ROLLBACK` +
   `client.release()`) and write an activity event in the same transaction.

3. **Shared Package (`packages/shared`)**: Zod schemas, TypeScript types, and role
   constants consumed by both app and API via `packages/shared/dist`. Rebuild
   with `npm run build -w @rota/shared` after editing `src/`.

4. **Infrastructure (`infrastructure/docker-compose.yml`)**: PostgreSQL 15 (host
   port **5440**) and Redis 7 (host port **6380**). `.env` at the repo root
   targets these ports.

## Architecture Diagram

```mermaid
flowchart LR
    subgraph Mobile[Expo app - apps/mobile]
        UI[Screens + React Query]
        API_CLIENT[src/api/* - apiClient]
        TOKEN[SecureStore - access/refresh/team]
        UI --> API_CLIENT
        API_CLIENT --> TOKEN
    end

    subgraph API[Express API - apps/api]
        RATE[rate limiters:<br/>/auth 100, /teams 300,<br/>/invitations 300 in-memory;<br/>/devices 200 Redis;<br/>budgets env-overridable]
        AUTH[auth + requireRole RBAC]
        ROUTES[teams / shifts / swaps /<br/>activity / subscription /<br/>invitations / devices]
        PUSH[notifications service -> Expo push]
        RATE --> AUTH --> ROUTES
        ROUTES --> PUSH
    end

    subgraph Data[(PostgreSQL 15)]
        MIG[runner - migrations table]
        TX[explicit transactions + activity events]
    end

    subgraph Cache[(Redis 7)]
        RL[rl:devices fixed-window]
        HEALTH[health probe]
    end

    API_CLIENT -->|HTTPS /health + ApiResponse envelope| RATE
    ROUTES --> TX
    ROUTES --> Cache
    TX --> Data
    MIG --> Data
    PUSH -->|FCM/APNs| Mobile
```

Everything crosses the wire wrapped in the `ApiResponse` envelope; every
team-scoped route sits behind `authenticate` + `requireRole`.

## Response & Error Envelope

Every endpoint returns the `ApiResponse<T>` envelope: `{ success, data?,
error? }`. Zod failures surface as HTTP 400 `VALIDATION_ERROR`; other known
failures use `HttpError(statusCode, code, message)`; unknown errors fall through
to the centralized error handler as 500. The client treats HTTP 401 by rotating
the refresh token once and retrying the request (single-flight).

## Data Flow

- The mobile app calls typed functions in `apps/mobile/src/api/*` that wrap
  `apiClient.request`. React Query drives lists with
  `useInfiniteQuery` (cursor pagination) and mutations for actions.
- The API validates with Zod, enforces team membership via `requireRole`
  (`404` for non-members, `403` for wrong roles), and queries PostgreSQL with
  parameterized SQL only.
- Mutations that touch activity write `activity_events` rows transactionally
  with the data change; the feed is reads-only.

## Endpoint Inventory (Phase 1–4)

Auth (`/auth`): `POST /register`, `POST /login`, `POST /refresh`,
`POST /logout`, `GET /me`. Rate-limited (100 req / 15 min / IP).

Teams (`/teams`): `POST /`, `GET /`, `GET /:teamId`, `GET /:teamId/members`,
`PATCH /:teamId/members/:userId/role`, `DELETE /:teamId/members/:userId`.

Invitations (`/invitations`): `POST /team/:teamId` (create),
`POST /accept` (accept). Tokens stored as SHA-256 hashes; acceptance records a
`MEMBER_JOINED` activity event.

Shifts — nested under `/teams/:teamId/shifts`, owner/manager for writes,
all members for reads:

- `GET /` — list, cursor paginated, filters: `from`, `to`, `status`,
  `assignedTo`.
- `POST /` — create, optionally assigns `assigneeIds`; transactional.
- `GET /:shiftId` — detail with assignments (member names included).
- `PATCH /:shiftId` — update title/description/times/status; transactional.
- `DELETE /:shiftId` — cancels pending swaps first; transactional.
- `POST /:shiftId/assignments` — assign members (validated in-transaction);
  400 `INVALID_ASSIGNEE` if any is not a team member.
- `DELETE /:shiftId/assignments/:userId` — owner/manager, or self.
- `POST /:shiftId/swaps` — create swap request (assignee may offer the shift
  to a teammate).

Swaps — nested under `/teams/:teamId/swaps`:

- `GET /` — list; staff see only their own, owner/manager see the team's.
- `POST /:swapId/approve` — owner/manager/proposed replacement; transfers the
  assignment atomically; `409` guards for non-pending / not-assigned /
  already-assigned / non-member states.
- `POST /:swapId/reject` — owner/manager/proposed replacement.
- `POST /:swapId/cancel` — requester only.

Activity — nested under `/teams/:teamId/activity`:

- `GET /` — feed, cursor paginated, optional `type` filter.

Push notifications & devices — nested under `/devices`, **authenticated**,
Redis-backed rate limited (200 req / 15 min / IP):

- `POST /devices` — register an Expo push token for the current user.
- `GET /devices` — list the user's registered devices.
- `DELETE /devices/:deviceId` — unregister.
- `GET /devices/preferences` — push preferences (booleans for
  shift-assigned, swap-requested/approved/rejected events).
- `PATCH /devices/preferences` — update preferences.

Shifts and swap writes call `services/notifications` which writes a
`notifications` row (deduped by a deterministic `event_key`) and forwards to
the Expo push service for users with a registered device and the event enabled.

## Billing & Subscriptions (Phase 4)

Billing is nested under `/teams/:teamId/subscription`, **OWNER only**
(except the public `/billing` routes below). Design and money model in
`docs/BILLING.md`.

- `GET /` — enrollment summary (plan, seats, usage, capacity, pending payment,
  latest failed renewal, `billingEnabled`).
- `GET /plans` — plan catalog (FREE/STARTER/GROWTH/SCALE), ascending price.
- `POST /checkout` — `{ planCode, seats? }`; prorated charge or immediate apply.
- `POST /seats` — `{ seats }` on the current plan.
- `POST /renew` — one full period at current configuration.
- `POST /verify` — `{ txRef, transactionId }`; reconciles a gateway
  verification server-side.
- `GET /changes` — subscription change history, cursor paginated.
- `GET /billing` — invoice history, cursor paginated.

Public:

- `POST /billing/webhook/flutterwave` — Flutterwave webhook receiver
  (`verif-hash` header check, `event_key` dedupe, guarded settlement).
  Rate limited (300 req / 15 min / IP).
- `GET /billing/redirect` — non-secret landing page after hosted checkout.

Implementation notes:

- Money is integer minor units everywhere; only the Flutterwave client converts
  to/from the currency's major unit (`apps/api/src/billing/flutterwave.ts`).
- The gateway module is the single seam to external HTTP. Integration tests
  mock `initializeCheckout`/`verifyTransaction` while keeping webhook hash
  validation real (`apps/api/src/billing/flutterwave.ts`).
- Domain logic lives in `apps/api/src/billing/service.ts` (state transitions,
  seat capacity, change/renewal computation, reconciliation) and
  `proration.ts` (pure math, unit-tested).
- Billing cross-cutting gates: `assertCanGrow` in invitation create,
  `assertSubscriptionActive` in shift create (`apps/api/src/billing/service.ts`).
- Two new activity event types: `SUBSCRIPTION_CHANGED`, `PAYMENT_RECEIVED`.
- New env config: `BILLING_CURRENCY`, `BILLING_PERIOD_DAYS`,
  `SUBSCRIPTION_GRACE_DAYS`, `FLW_ENV`, `FLW_BASE_URL`, `FLW_SECRET_KEY`,
  `FLW_PUBLIC_KEY`, `FLW_SECRET_HASH` (see `apps/api/src/env.ts`).

## Cursor Pagination

Keyset pagination over a stable total order `(timestamp, id)` — no `OFFSET`.
Cursor is `base64url(JSON {t, i})`. See `docs/PAGINATION.md`.

## Security & Tenant Isolation

`requireRole` rejects non-UUID `teamId`s with 400 before any SQL runs, applies
membership checks, and scopes every query by `team_id`. Every phase-3 write is
transactional, and swap approval re-validates membership and assignment state
inside the transaction. See `docs/SECURITY.md`.

## Known Gaps (accepted)

- CORS is a comma-separated `CORS_ORIGIN` allow-list; default `*` is a dev
  posture only, and `env.ts` refuses `*` in production. Real origins are
  set at deploy time (see `docs/DEPLOYMENT.md`).
- `/auth` (100), `/teams` (300), and `/invitations` (300) limits are in-memory
  per instance; only `/devices` (200) is shared via Redis. Under horizontal
  scaling the in-memory limits become per-pod.
- Redis is used by the `/health` probe and the `/devices` rate limiter —
  no general cache layer yet.
- Push notifications deliver through Expo's hosted service; delivery
  confirmation/receipts and in-app foreground handling are still being wired
  in the mobile app.
- Mobile runtime (navigation, list behavior) has not been exercised on a
  device; see `docs/IMPLEMENTATION-STATUS.md`.

## Deployment & performance

- Packaging, Railway runbook, and env reference: `docs/DEPLOYMENT.md`.
- k6 load-testing harness, thresholds, and runbook: `docs/PERFORMANCE-TESTING.md`.
- Graduation close-out checklist: `docs/SUBMISSION.md`.