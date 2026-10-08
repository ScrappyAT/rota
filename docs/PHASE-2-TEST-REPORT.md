# Rota - Phase 2 Test Report

## Overview
This document summarizes the testing strategy and results for Phase 2: Authentication, Teams, and Role-Based Access.

## Integration Tests
Integration tests were executed against a live local PostgreSQL and Redis instance running via Docker Compose.

The automated test suite (`apps/api/__tests__/integration.test.ts`) verifies the entire multi-tenant isolation and invitation lifecycle requested:

1. **Register User A:** Successfully inserts user and hashes password with Argon2id/bcrypt.
2. **Create Team A:** Inserts team and grants User A `OWNER` role.
3. **Register User B:** Created successfully.
4. **Create Team B:** Inserts team and grants User B `OWNER` role.
5. **Tenant Isolation Verification:** Verified that User A receives a `404 Not Found` when trying to access Team B, thanks to `requireRole` middleware.
6. **Invite User B to Team A:** `POST /invitations/team/:teamId` successfully creates a secure, hashed invitation token for User B with the `MANAGER` role.
7. **Accept Invitation:** `POST /invitations/accept` processes the token, inserts User B into Team A memberships, and nullifies the invitation.
8. **Role Verification:** Verified that `GET /teams/:teamId/members` correctly lists User B with the `MANAGER` role.
9. **Role-Based Authorization:** Verified that User B (`MANAGER`) receives a `403 Forbidden` when attempting an `OWNER`-only operation (modifying User A's role).

## Security Protections Confirmed
- **Password Hashing:** Passwords are never stored in plaintext (using bcrypt cost factor 10).
- **Token Rotation:** Refresh tokens are securely generated, stored as hashes, and revoked upon use or logout.
- **Tenant Data Isolation:** Users cannot query or mutate data for teams they do not belong to.
- **Role Scoping:** Actions such as removing owners or promoting to owner are correctly guarded.
- **Rate Limiting:** Authentication routes are rate-limited to 100 requests per 15 minutes to prevent brute force attacks.

## Test Results
All 10 tests passed successfully in 7.3s.

```
PASS __tests__/health.test.ts
PASS __tests__/integration.test.ts
Test Suites: 2 passed, 2 total
Tests:       10 passed, 10 total
```
