# Security Architecture

## Authentication
- Passwords are encrypted using standard `bcrypt` algorithms.
- JWT Access tokens are short-lived (15 minutes).
- Refresh tokens are long, cryptographically random strings stored as hashes in the database.
- Refresh tokens are rotated on every use and explicitly revoked upon logout.

## Multi-Tenant Isolation
- The system enforces hard tenant isolation using the `requireRole(allowedRoles)` middleware.
- Data access is bound by the `team_memberships` junction table.
- A user attempting to read from a `teamId` they do not belong to will receive a 404/403.
- Rate limiting is applied to all sensitive endpoints to mitigate brute force and credential stuffing.

## Roles
- **OWNER**: Can modify all aspects of the team, manage all roles, and remove any member. The last owner cannot be removed.
- **MANAGER**: Can manage shifts and invite STAFF. Cannot modify OWNERs or promote to MANAGER.
- **STAFF**: Read-only access to team settings, can manage their own shifts and requests.
