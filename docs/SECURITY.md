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

## Billing & subscriptions (R1/R2)

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
- Money is integer minor units in the record's currency: USD cents for the
  versioned catalog, legacy NGN kobo retained. Gateway conversion/verification
  uses exact decimal handling, not an amount tolerance. Ledger rows are append-only;
  corrections use new entries, and historical NGN is never automatically converted.
- Invitation capacity is tenant-scoped: pending invites reserve seats, and capacity
  is serialized under the team lock. ACTIVE and eligible PAST_DUE grace allow
  protected writes; expired grace denies them. Phase 1 corrects failed-renewal
  boundary behavior in its separate review worktree.

## Roles
- **OWNER**: Can modify all aspects of the team, manage all roles, and remove any member. The last owner cannot be removed.
- **MANAGER**: Can manage shifts and invite STAFF. Cannot modify OWNERs or promote to MANAGER.
- **STAFF**: View team schedules and manage permitted personal assignments/swap requests; cannot create shifts or approve swaps.

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


## Graduation Phase 3 telemetry and threat evidence

Only allowlisted scalars leave the application log/error-tracking sinks.
Passwords, reset/refresh/access/invitation/push tokens (including fragments),
payment credentials, headers, body/query values, cache keys, raw SQL/errors and
provider payloads are excluded. See [OBSERVABILITY.md](OBSERVABILITY.md) and
`packages/shared/src/telemetry.ts`. Auth storage semantics are unchanged.
Native tokens remain in SecureStore; the web fallback remains localStorage and
requires a separate production web security strategy. No cookie migration is
claimed. EXPO_PUBLIC_API_URL and EXPO_PUBLIC_SENTRY_DSN are public build values;
server/payment/mail/encryption/upload secrets must never use EXPO_PUBLIC names.

| Threat | Existing control and code | Executed automated evidence / limit |
|---|---|---|
| Cross-team IDOR / stale membership | `middleware/tenant.ts` requireRole, primary auth/membership SQL | security, integration, cacheIsolation; separate Phase 1 authorization tests exercise stale read DB |
| Staff swap self-approval | `routes/swaps.ts`, OWNER/MANAGER gate + transaction | r3-policy.integration concurrent/role denials |
| Credential stuffing / quota bypass | `rate-limit-redis.ts` atomic shared IP/user budgets, fail closed | rate-limit and r3-policy.integration; trusted reverse-proxy configuration still needs rollout review |
| Refresh replay / stolen session | `routes/auth.ts` user lock, token digests, auth_version/session revoke | r3-auth.integration expiry, concurrent refresh, replay, logout-all; no physical multi-device claim |
| Reset/magic-link enumeration or replay | `routes/auth.ts` + `services/auth-email.ts`, fixed response, short-lived one-use digests, encrypted outbox | r3-auth.integration; custom-scheme hijacking remains a production concern |
| Duplicate/fraudulent settlement | billing reconciliation, idempotency UUID, immutable ledger, reference/currency/amount checks | billing.integration, financialCalculations, flutterwavePrecision, R2 recovery; providers mocked |
| Provider timeout / lost worker | durable outbox, attempts, no second initialization, uncertain-send fence | r2-jobs.integration killed-worker drills; not proof of live-provider exactly-once delivery |
| Injection / resource exhaustion | parameterized SQL, strict Zod, 32KiB/nesting/collection caps | security/r3-policy; Zod advisory is mitigated, not eliminated |
| Sensitive diagnostic exfiltration | fixed JSON logger + final Sentry allowlist, attachments dropped | six Phase 3 suites incl actual SDK envelope and fatal child-process tests |
| Cached stale authorization | primary role lookup + user write fence; cached data never authorizes | cacheIsolation/r3-routing and separate Phase 1 tests; no cancellation of already-running reads promised |

The table records code-backed controls, not a penetration-test certification.
No real credentials, provider operations, production migration or database
access was used for this phase. Dependency advisories remain tracked in the
Phase 3 report; do not suppress audit output or force an unverified Expo/Zod
major upgrade. Before release set log/Sentry access controls, retention and
privacy notice; test staging telemetry and user deletion/retention obligations.
