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
    M[Expo mobile / TanStack Query / SecureStore] -->|HTTPS + request ID| A[Express API / Zod / auth + tenant roles]
    A -->|authoritative writes + auth + financial reads| P[(PostgreSQL primary)]
    A -->|allowlisted safe reads / primary fence + fallback| R[(Optional read endpoint)]
    A --> C[(Redis cache + atomic rate limits)]
    P --> O[Transactional job_outbox + job_attempts]
    O --> D[Outbox dispatcher]
    D --> Q[(Redis / BullMQ)]
    Q --> W[Separate worker process]
    W --> P
    W --> E[Mockable Flutterwave / mail / Expo providers]
    A --> L[Allowlisted JSON logs + optional Sentry]
    W --> L
    M --> S[Optional JS-only Sentry / privacy scrubber]
    H[Separate team-hash sharding simulation] -.-> S0[(Shard 0)]
    H -.-> S1[(Shard 1)]
```

The shard simulation is independent of read replication; HTTP routes do not
transparently shard all live data. External operations run in workers, not
inside business transactions. Error monitoring is optional and never a
transaction dependency. The diagram describes code paths, not a verified
production hosting topology.


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
`notifications` row and transactional outbox intent, deduped by deterministic
event keys. The separate worker checks preferences/quiet hours, sends through
Expo and checks receipts. Uncertain sends require operator review.

## Billing & Subscriptions (Phase 4; superseded financial rules)

The endpoint list below describes the original Phase 4 contract. R1 amendments
are authoritative for current billing behavior; see the following R1 section
and `BILLING.md`.

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

## Operational boundaries

Redis-backed IP/user quotas are shared across instances and sensitive quotas
fail closed. Cache-aside applies to roster/calendar/activity with tenant keys,
TTLs and invalidation. Financial state and authorization use primary SQL.
R2 persists retries/dead jobs and uncertain delivery state. Those features are
implemented; live push/mail/provider delivery and physical Android interactions
remain separate acceptance evidence. Production origins, trusted proxies,
separate workers and bounded connection budgets require deployment review.

## Deployment & performance

- Packaging, Railway runbook, and env reference: `docs/DEPLOYMENT.md`.
- k6 load-testing harness, thresholds, and runbook: `docs/PERFORMANCE-TESTING.md`.
- Graduation close-out checklist: `docs/SUBMISSION.md`.

## Milestone R1 financial contract

- New paid catalog: Starter USD20/5 seats, Team USD50/15 + USD3 extra,
  Business USD120/40 + USD2 extra. Versioned IDs preserve historical NGN rows.
- `POST /teams/:teamId/subscription/{checkout,seats,renew}` requires UUID
  `Idempotency-Key`. `initiation.ts` commits a deduplication reservation and
  payment intent before an at-most-once provider call, returning 200/201/202.
- Proration separately floors unused old service and remaining new service.
  Plan downgrades/seat reductions are scheduled for period end; target capacity
  includes pending invitations. Team row locks serialize capacity writers.
- `ledger.ts` posts immutable charges/credits/refunds and subscription snapshots.
  Owner-only `GET /teams/:teamId/subscription/ledger/reconstruction` returns
  subscription state, scheduled change and per-currency totals from the ledger.
- Migration 007 adds plan pricing fields, revision/schedule/quote metadata,
  `billing_idempotency`, and append-only `financial_ledger`; 001-006 are unchanged.
- Gateway decimal strings preserve cents; settlement compares each payment's
  currency and amount. Revision checks fence late settlements and failures.
- Shared `PaymentAttempts` is used by mobile with persisted intent keys and
  `expo-crypto`. Existing authentication and API envelopes remain in place.
- Tests use `scripts/test-r1.ps1` with isolated main/shard/Redis services.
  No normal development/production database or provider is used.
- Durable jobs, settings, rate-limiter redesign, deployment and R2-R4 are
  outside this milestone. See `R1-IMPLEMENTATION-REPORT.md` for evidence.


## Milestone R2 - durable jobs and settings

Business transactions now write `job_outbox` alongside shifts, swaps, billing
changes and notification records. `addActivity` records DOMAIN_EVENT intents;
`notify(event, client)` records recipient intents on that same client. Routes
retain immediate cache invalidation; domain jobs provide durable invalidation
and notification fanout for shift changes and billing events.

`worker.ts` polls PostgreSQL and dispatches UUID/generation job IDs to BullMQ.
The same worker process handles notification sends and receipts, webhook jobs,
checkout initialization, read-only reconciliation/verification, and billing
period/grace rechecks. It is separately runnable from the API. PostgreSQL status
and session advisory locks fence overlapping processors; per-device claims fence
push retries. BullMQ persists delayed work/retries in Redis, and PostgreSQL can
repopulate missing Redis jobs. Attempt logs and DEAD rows survive worker exits.

Changed/new API contracts:

- `POST /billing/webhook/flutterwave`: verifies the existing v3 verif-hash,
  inserts an immutable first-received event plus job in one transaction, returns
  accepted/queued promptly. Provider verification and settlement occur in a job.
- `POST /teams/:teamId/subscription/{checkout,seats,renew}`: UUID idempotency keys
  remain mandatory. New payable intents return 202 with the original reference;
  workers populate the saved 201 checkout response after initialization.
- `GET /teams/:teamId/subscription/payments/:txRef`: also exposes checkoutUrl
  and initializationState for bounded client polling.
- `POST /teams/:teamId/subscription/verify`: enqueues read-only verification and
  returns 202/PENDING plus jobId. `GET .../verifications/:jobId` returns the stored
  result/error once processed. All remain owner-only and team-isolated.
- `GET /settings`, `PATCH /settings`: authenticated user's server-owned quiet
  hours, IANA zone, categories, fine-grained notification types, language/theme,
  overall updatedAt and per-field fieldUpdatedAt. Strict input schemas reject
  caller user IDs and timestamps. The old `/devices/preferences` contract remains
  backed by the same settings service and original preference columns.
- `GET /teams/:teamId/swaps/:swapId`: exact notification destination. Owners/
  managers, the requester and the offered staff member can read; other staff and
  nonmembers receive 404. UUID input validation returns 400.

Mobile settings refresh on login/foreground; the actual shared SettingsController
implements optimistic edits and rollback. Notification handling validates team/
destination IDs, verifies team membership, changes team context, then opens the
specific shift, swap detail or subscription. Explicit team route params protect
against a stale selected-team frame. Navigation theme follows the saved theme;
existing custom screen colors and text are not a complete theme/translation system.

Retry, uncertain-outcome and server-receive-time LWW tradeoffs, operational
commands and executed evidence are in `R2-IMPLEMENTATION-REPORT.md`.


## R3 auth and read routing

`POST /auth/password-reset/request {email}` and
`POST /auth/magic-link/request {email}` return the same generic success for
registered and unknown accounts. Both enqueue encrypted AUTH_EMAIL requests.
The worker resolves the account, persists one 15-minute token hash and an
additional encrypted delivery intent in one transaction. Resend-compatible
email POSTs use the delivery job UUID as provider idempotency key.

`POST /auth/password-reset/confirm {token,password}` consumes once and revokes
all refresh/access sessions; `POST /auth/magic-link/consume {token}` consumes
once and returns the existing AuthResponse shape. No GET consumes credentials.
`POST /auth/logout-all {}` requires authentication and invalidates every device.
`POST /auth/logout {refreshToken?}` revokes the current new-format session.
Legacy clients keep `/auth/refresh {userId,refreshToken}`; lazy upgrade preserves
valid opaque tokens. Refresh replay globally revokes the user, including newly
rotated descendants. Auth uses an authoritative user epoch and session lookup
on every request; Redis/replicas are never revocation authorities.

All request collections are bounded before Zod validation (32 KiB, 100 entries
per collection, 1,000 traversal nodes, depth 20). Route body schemas reject
unknown fields, aside from provider-owned webhook metadata. Query and UUID
shape validation precede route access. Billing redirect callback names remain
accepted. Redis quotas apply per IP and per normalized account/user; fixed
windows and their expiry are atomic. Sensitive errors fail closed with 503.

`services/read-routing.ts` supplies a bounded optional read pool for explicit
roster/calendar/activity SELECTs. Primary-only code handles authentication,
tenant membership, financial state, settings, details and all transactions.
Before an authenticated mutation, a user_write_fences upsert persists a
five-minute primary lease. During it reads bypass Redis and use primary SQL;
primary query results may refresh cache. Read errors roll back and fall back to
primary. Replication/lag is an operational topology concern, separate from the
unchanged team-hash sharding simulation. The independent read DB test is a
simulation, not proof of physical replication or automated failover.

The PDF's renewal grace means PAST_DUE remains writable while grace_ends_at is
in the future. Expired/missing grace denies protected writes; reads and renewal
remain available. Seat capacity, financial revisions and ledger rules remain
unchanged. Swap approval requires OWNER/MANAGER and locks the pending request;
staff requester/replacement status does not grant approval permission.

## Graduation Phase 3: observability

`middleware/request-logging.ts` runs before CORS, parsers and route handlers.
`services/observability.ts` keeps request context in AsyncLocalStorage and emits
one completion/abort event. `X-Request-ID` is generated on the server and exposed
through CORS; caller-supplied IDs are ignored. User IDs are read after auth runs.
Status defines the HTTP outcome, not proof of a successful financial settlement.

`services/job-runtime.ts` logs durable start/completion/retry/dead/deferred/skipped
outcomes plus BullMQ queue attempts (including failures before a DB claim).
`services/outbox.ts` logs only an **uncommitted intent** and its UUID; the caller
still owns COMMIT/ROLLBACK. No payload or transaction/deduplication key is altered.

Server and mobile Sentry use `packages/shared/src/telemetry.ts` as a final
allowlist. Raw errors, stacks, requests, users, breadcrumbs, arbitrary tags and
attachments cannot pass the configured event scrubber. Server 5xx/fatal errors,
worker failures and mobile JS/render/handled API-5xx paths are observed.
Missing DSNs and SDK failures do not fail business requests. See
[OBSERVABILITY.md](OBSERVABILITY.md) for schemas, incident tracing and limitations.

Primary pool: max `DB_POOL_MAX=10`, connect 2s, statement 15s, idle transaction 30s.
Read pool: max 10 by default, connect 1s, statement 3s, primary fallback.
Shard simulation: two independent pools, max 10 each, connect 3s, idle 10s.
Budget the sum across API replicas/workers/read endpoints; max is a ceiling,
not a claim that all connections are opened immediately. No PgBouncer or managed
physical WAL replication is configured by this repository.

Phase 1/2 source fixes remain in their own review worktrees. Their reports and
the Phase 3 combined-test inventory define what must be integrated; this document
does not imply those uncommitted changes are already in main.


## Graduation Phase 1 — billing boundary and membership authorization

`GET /teams` now executes its membership/team join on the primary. The list is
an authorization decision, so an unfenced caller must not receive former teams
from stale replica memberships. Newly joined teams are visible immediately.
Authorized team details, rosters, calendars and activity retain their explicit
read routing and existing primary write fences/fallback behavior.

The first server-verified failed renewal opens the configured grace window even
when initiation occurred at/after expiry. Its deadline is verification time plus
SUBSCRIPTION_GRACE_DAYS (default 14); later failures cannot extend or reopen it
for that service period. A provider verification outage is not a failed payment
and grants no grace. Scheduled reductions and zero-due changes preserve an
existing failure/deadline. Successful paid changes/renewals retain their existing
recovery behavior. Protected writes remain usable in grace and restricted after
the deadline; read access and the existing operation-specific policy are unchanged.

Expiry/grace materialization still increments revisions and appends immutable
STATE records. A pending renewal may cross only a continuous ledger history of
status-transition/renewal-failure revisions with identical team, plan, seats and
period, and no scheduled change. Missing proof, paid configuration changes and a
new paid period remain superseded; captured funds retain the existing manual
credit handling. No ledger row or historical migration is rewritten.

Verification and isolation details: `ROTA-GRADUATION-PHASE-1-REPORT.md`.


## Graduation Phase 2 — mobile requirements

`POST /invitations/accept` retains the existing authenticated, email-matched,
expiring, one-use redemption transaction and additionally returns
`{ success: true, data: { teamId } }`. Existing success-only clients remain
compatible. The new destination is disclosed only after successful redemption;
invalid, expired, reused and mismatched invitations do not disclose it. This is
the only backend behavior change in this phase; no migration is needed.

The already configured `rota` scheme routes shareable `rota:///teams/accept`
links to a public intake screen. Validated code/email/expiry are kept through
authentication in native SecureStore. The app redeems, refreshes the Query-owned
team list, verifies selection against that list and selects the server-returned
team. A saved successful destination permits retrying a failed membership refresh
without redeeming a second time. The API remains the invitation authority.

Teams/roles and settings are now TanStack Query projections. Context coordinates
identity/selection and exposes query results. Swaps use snapshot/cancel/optimistic
PENDING/reconcile/rollback mutation callbacks with a synchronous duplicate gate.
Settings retain server timestamps, optimistic rollback and foreground sync.
Upcoming assigned shifts have a separate user/team filesystem snapshot; a bounded
SecureStore identity lease permits cold read-only offline launch. Cached identity
blocks business API requests until server verification; known revocations clear
caches and leave durable team tombstones. Calendar, activity pagination and shift
editing use existing server endpoints. Full state ownership and tradeoffs:
`STATE.md`; executed evidence and device limitations:
`ROTA-GRADUATION-PHASE-2-REPORT.md`.
