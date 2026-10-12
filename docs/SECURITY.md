# Security Architecture

## Authentication
- Passwords are encrypted using standard `bcrypt` algorithms.
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
- **Swap approve/reject** is restricted to `OWNER`/`MANAGER` or the proposed
  replacement. Approval re-checks membership and assignment state *inside the
  transaction* (409 on stale state), then reads-modifies-writes:
  remove requester assignment → insert replacement assignment → mark swap
  `APPROVED` → record `SWAP_APPROVED`. All or nothing.
- **Swap cancel** is restricted to the requester.
- **Activity feed** is read-only and tenant-scoped; event types are validated
  against a fixed allow-list before hitting the database.
- Input validation is Zod-only; SQL is parameterized; no paths concatenate
  user input into SQL.
