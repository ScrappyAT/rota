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
