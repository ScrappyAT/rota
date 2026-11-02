# Security Architecture

## Authentication
- Passwords are hashed using `bcrypt` (they are not reversibly encrypted).
- JWT Access tokens are short-lived (15 minutes).
- Refresh tokens are long, cryptographically random strings stored as hashes in the database.
- Refresh tokens are rotated on every use and explicitly revoked upon logout.
- Presenting a rotated refresh token is treated as reuse: the user's entire
  active session family is revoked and a 401 returns.

## Multi-Tenant Isolation
- The system enforces hard tenant isolation using the `requireRole(allowedRoles)` middleware.
- Data access is bound by the `team_memberships` junction table.
- A user attempting to read from a `teamId` they do not belong to will receive a 404/403.
- `requireRole` validates that `teamId` is a UUID before running any SQL,
  returning 400 for malformed ids instead of leaking a database error.
- Rate limiting is applied to all sensitive endpoints to mitigate brute force and credential stuffing.

## Billing & Subscriptions (Phase 4)

- Every `/teams/:teamId/subscription` route requires the caller to be the team
  **OWNER**; managers/staff get 403 and non-members get 404 (no cross-team
  plan, payment, or seat data is ever exposed).
- Payment verification (`POST /verify`) and the webhook settle through one
  guarded reconciliation path inside an explicit transaction:
  - payments are claimed with `UPDATE ... WHERE status = 'PENDING'`, so a
    concurrent or duplicate settlement cannot double-apply,
  - tx_ref, currency, amount, and `flw_transaction_id` are validated before
    any write; mismatch throws 400 `PAYMENT_MISMATCH` and the transaction is
    rolled back,
  - already-processed payments return `ALREADY_PROCESSED` without side effects.
- The webhook validates the `verif-hash` header using a **constant-time**
  comparison against `FLW_SECRET_HASH`, requires a real charge id, and
  deduplicates by `webhook_events.event_key` (PK) so replaying a webhook
  cannot re-settle. The webhook is rate limited (300 req / 15 min / IP).
- Secrets: `FLW_SECRET_KEY`, `FLW_PUBLIC_KEY`, and `FLW_SECRET_HASH` are read
  from the environment only, never logged or returned, and are required (with
  `JWT_SECRET`) when `NODE_ENV=production` (enforced in `env.ts`).
- Money is integer minor units (kobo); the Flutterwave client converts to the
  gateway's major unit and back with an explicit tolerance so forged/rounded
  amounts cannot float past validation.
- Invitation capacity is tenant-scoped: pending invites reserve seats, and an
  `ACTIVE` subscription is required to add members (403 `SUBSCRIPTION_REQUIRED`).

## Roles
- **OWNER**: Can modify all aspects of the team, manage all roles, and remove any member. The last owner cannot be removed.
- **MANAGER**: Can manage shifts and invite STAFF. Cannot modify OWNERs or promote to MANAGER.
- **STAFF**: Read-only access to team settings, can manage their own shifts and requests.

## Phase 3 — Shifts, Swaps, Activity

- **Shift writes** (`create/update/delete/assign`) require `OWNER` or `MANAGER`
  and run inside a transaction along with their activity event.
- **Unassign** is allowed for `OWNER`/`MANAGER`, or the staff member
  themselves. Staff cannot unassign other people.
- **Swap create** requires the requester to be assigned to the (active) shift;
  a proposed replacement must be a team member, and only one `PENDING` request
  per (shift, requester) is allowed (409 `SWAP_EXISTS`).
- **Swap approve** requires `OWNER`/`MANAGER`; rejection also permits the
  proposed replacement. Approval re-checks membership and assignment state *inside the
  transaction* (409 on stale state), then reads-modifies-writes:
  remove requester assignment → insert replacement assignment → mark swap
  `APPROVED` → record `SWAP_APPROVED`. All or nothing.
- **Swap cancel** is restricted to the requester.
- **Activity feed** is read-only and tenant-scoped; event types are validated
  against a fixed allow-list before hitting the database.
- Input validation is Zod-only; SQL is parameterized; no paths concatenate
  user input into SQL.


## R3 security model and compatibility

- Credential rows lock in user-first order; refresh rotation/replay and
  logout-all commit atomically. Access JWTs use HS256 and expire in 15 minutes.
  Each request checks the primary auth_version and session revocation state.
- A duplicated refresh is treated as replay even if caused by a network race.
  One rotation may succeed but its descendants are revoked by the duplicate.
  The mobile startup and automatic-refresh paths now share one in-flight
  promise; cross-process duplicate attempts still require signing in again.
- Pre-R3 access tokens without av/sid are accepted only while auth_version=0;
  legacy opaque bcrypt refresh tokens acquire a session on first use. Global
  revocation invalidates old access tokens immediately. A legacy access JWT
  cannot be revoked individually; it expires within 15 minutes, or logout-all
  can revoke it immediately. No historical refresh rows are deleted/migrated.
- Password reset/magic tokens contain 256 random bits, store only SHA-256
  digests in auth_action_tokens and expire after 15 minutes. Consumption is
  atomic under the user lock. Reset invalidates all sessions and outstanding
  action tokens. New requests invalidate previously issued same-purpose links.
- Email requests use the same encrypted enqueue path/status for unknown users.
  Known/unknown login performs bcrypt work and returns a generic invalid-login
  response. Rate-limit keys hash normalized principals; forged proxy headers
  are ignored by the production app's default trust-proxy policy.
- AUTH_EMAIL payloads use AES-256-GCM with random 96-bit IVs and a separate
  server key. Keep AUTH_MAIL_KEY stable while queued deliveries exist; key-ring
  rotation/retention tooling remains an operational gap. Tokens are never
  returned in JSON or logged. Prefer owned verified HTTPS app links in a future
  mobile release; the existing rota scheme can be claimed by another app.
- Redis sensitive quotas fail closed; INCR/expiry run in one Lua script. API
  retries, invite redemption, reset/links, payment intent/verification and
  provider webhooks retain independent quota namespaces. Configure trusted
  proxy topology explicitly before deployment; blindly trusting client
  X-Forwarded-For would bypass IP quotas.
- Read replicas cannot authorize users or settle payments. Primary-only
  permission checks occur before potentially cached tenant reads. Durable
  user write leases bypass stale caches. There is no automatic write failover.
- Request byte/collection/depth caps mitigate constrained-collection abuse in
  the retained Zod 3 dependency. This does not remove its npm advisory; the
  upstream patch requires a major version migration and remains tracked.

Verification and dependency disposition: [R3 report](R3-IMPLEMENTATION-REPORT.md).
