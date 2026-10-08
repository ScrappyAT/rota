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

## Endpoint Inventory (Phase 1–3)

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

## Cursor Pagination

Keyset pagination over a stable total order `(timestamp, id)` — no `OFFSET`.
Cursor is `base64url(JSON {t, i})`. See `docs/PAGINATION.md`.

## Security & Tenant Isolation

`requireRole` rejects non-UUID `teamId`s with 400 before any SQL runs, applies
membership checks, and scopes every query by `team_id`. Every phase-3 write is
transactional, and swap approval re-validates membership and assignment state
inside the transaction. See `docs/SECURITY.md`.

## Known Gaps (accepted)

- `cors()` is open (`*`) — dev posture only; restrict before deployment.
- No rate limiting on `/teams` and `/invitations`.
- Redis connected but not yet used beyond the health check.
- Mobile runtime (navigation, list behavior) has not been exercised on a
  device; see `docs/IMPLEMENTATION-STATUS.md`.