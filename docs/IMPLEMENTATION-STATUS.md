# Rota — Implementation Status

Single source of truth for what exists, what is verified, and what is missing.
Status categories:

- **Completed & verified** — code exists, tests were executed and observed.
- **Implemented, not independently verified** — code exists but was not
  executed/observed in a test or manual run.
- **Partially implemented** — works in a narrow case; gaps are listed.
- **Not started**
- **Blocked** — cannot proceed until a listed dependency is resolved.

Last full validation: 2026-10-08 (see "Validation history").

---

## Phase 1 — Foundation

| Feature | Status | Notes |
|---|---|---|
| npm workspaces monorepo | Completed & verified | `npm run typecheck/lint/test` traverse all workspaces |
| Shared package (schemas, types, Roles) | Completed & verified | Consumers resolve `packages/shared/dist`; rebuild after editing `src/` |
| Express bootstrap, health check, error handler | Completed & verified | `/health` covered by `health.test.ts`; Zod/malformed-JSON now map to 400 |
| Docker Compose Postgres 15 + Redis 7 | Completed & verified | Host ports 5440 / 6380; both containers were running during validation |
| Migration runner (`npm run db:migrate`) | Completed & verified | `migrations` table records `001`, `002`; re-runs skip applied files |
| Expo app shell (tabs, auth stack, teams stack) | Implemented, not independently verified | Type-checks; app was not launched during this audit |

## Phase 2 — Auth, Teams, Invitations, RBAC

| Feature | Status | Notes |
|---|---|---|
| Register / login / logout | Completed & verified | bcrypt cost 10; duplicate email → 400 `DUPLICATE_ACCOUNT` |
| `GET /auth/me` | Completed & verified | Exists and is exercised by tests |
| Access JWT (15 min) + opaque refresh token | Completed & verified | Refresh tokens stored as bcrypt hashes |
| Refresh rotation | Completed & verified | Old token revoked on every use |
| Refresh reuse detection | Completed & verified | Reuse of a rotated token revokes **all** active tokens for that user (added 2026-10-08) |
| Auth rate limiting | Completed & verified | 100 req / 15 min / IP on `/auth/*`; verified to return 429 |
| Team create / list / detail | Completed & verified | Transactional team + owner-membership insert |
| Cross-team isolation (`requireRole`) | Completed & verified | Non-member → 404; wrong role → 403 |
| Last-Owner protection (demote & remove) | Completed & verified | Both paths tested |
| Manager can only invite/remove STAFF | Completed & verified | Invite path and remove path tested |
| Invitation create (hashed, share-once token) | Completed & verified | SHA-256 hash stored; raw token returned once |
| Invitation expiry (3 days) & one-time use | Completed & verified | Both re-acceptance and expiry are tested |
| Invitation accept (email match, transactional) | Completed & verified | `accepted_at` set in same transaction as membership insert |
| Zod validation → HTTP 400 | Completed & verified | Previously returned 500; fixed |
| Explicit `JWT_SECRET` required in production | Completed & verified | Guard added in `env.ts` |
| Mobile: attach bearer token + refresh on 401 | Implemented, not independently verified | Previously no request carried an `Authorization` header; fixed, type-checks only |
| Mobile: session persistence (SecureStore) | Implemented, not independently verified | Restore-on-launch path exists; not observed on a device |
| Mobile team management screens | Implemented, not independently verified | Teams list, create, members, invite, accept wired to API |

### Known gaps in Phase 2 (accepted, not blocking)

- No invitation revoke/list-rejected endpoints (list shows only pending, valid).
- Expired/revoked refresh tokens are never purged from the table.
- Rate limiting covers only `/auth/*`; `/teams` and `/invitations` are not
  rate-limited (they require credentials and mutate less aggressively).
- `JWT_REFRESH_SECRET` in `env.ts` is unused (refresh tokens are opaque, not
  JWTs) — dead configuration, harmless.
- Last-owner checks are read-then-write, not serialized; a concurrent race
  could theoretically demote two owners at once (single-writer deployments are
  unaffected).
- `cors()` is wide open (`Access-Control-Allow-Origin: *` semantics); fine for
  local dev, must be restricted before any real deployment.
- Redis is connected but used only by the health check — no caching or shared
  rate-limit store yet.

## Phase 3 — Shifts, Swaps, Activity (not implemented)

See `docs/PHASE-3-PLAN.md` for the full design.

| Feature | Status |
|---|---|
| Shift creation / editing / deletion | Not started |
| Shift assignment (multi-assignee) | Not started |
| Swap requests and approvals | Not started |
| Activity feed + activity writes | Not started |
| Cursor pagination (timestamp + id) | Not started |
| Shift-related DB migrations and indexes | Not started |
| 10,000-record seed script | Not started |
| Mobile shift list, infinite scroll, pull-to-refresh | Not started |
| Mobile swaps + activity screens (currently placeholders) | Not started |

## Phase 4+ — Graduation requirements

| Requirement | Status | Notes |
|---|---|---|
| Shift scheduling | Not started | Phase 3 |
| Shift swaps | Not started | Phase 3 |
| Cursor pagination | Not started | Phase 3 |
| 10,000 activity records | Not started | Phase 3 seed script |
| Subscription billing and proration | Not started | No payment provider chosen |
| Push notifications | Not started | Requires Expo push tokens + notification writes |
| Offline shift viewing | Not started | Requires local persistence (AsyncStorage/SQLite) |
| Settings synchronization | Not started | Requires user settings table + API |
| Redis caching | Partially implemented | Redis is up and health-checked; no cache layer |
| PostgreSQL sharding simulation | Not started | Needs design decision (logical shards by team_id) |
| Load testing | Not started | Needs seeded data + k6/autocannon harness |
| Android development build | Not started | Currently Expo Go workflow only; no `eas build` performed |
| Deployment | Not started | Explicitly out of scope until requested |
| Demo video | Not started | Blocked on Phase 3 UI existing |

---

## Validation history

Executed on 2026-10-08 against the live local Docker Postgres (5440) and Redis
(6380), both migrated:

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS (api, mobile, shared — 0 errors) |
| Lint | `npm run lint` | PASS — 0 errors, 5 pre-existing unused-import warnings |
| Tests | `npm test` | PASS — 3 suites, **21 tests passed** |

Test breakdown:

- `health.test.ts` — 1 test (mocked deps).
- `integration.test.ts` — 19 tests (live DB): full Phase 2 scenario, last-owner
  protection, invitation one-time use and expiry, refresh rotation and reuse
  detection, validation errors, unauthenticated access.
- `rate-limit.test.ts` — 1 test (mocked deps): 429 after budget exceeded.

Supersedes `docs/PHASE-2-TEST-REPORT.md` (which reports the earlier 10-test
run and remains as a historical record).

**Not verified:** mobile runtime behavior. The Expo app was type-checked but
never launched on this machine; every mobile item above marked
"Implemented, not independently verified" carries that caveat.
