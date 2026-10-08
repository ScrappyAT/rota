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

## Phase 3 — Shifts, Swaps, Activity

See `docs/PHASE-3-PLAN.md` for the full design, `docs/PAGINATION.md` for the
cursor design and measured plans, `docs/PHASE-3-TEST-REPORT.md` for evidence.

| Feature | Status | Notes |
|---|---|---|
| Migration `003` (shifts, assignments, swaps, activity + indexes) | Completed & verified | Applied via `npm run db:migrate`; 10 tables verified in psql |
| Shift create / detail / update / delete | Completed & verified | Owner/manager only; transactional with activity write |
| Shift assignment (multi-assignee, unassign) | Completed & verified | Staff can unassign themselves; members-only validation |
| Swap request / approve / reject / cancel | Completed & verified | Approval transfers assignment atomically; dedupe + status guards |
| Activity feed + activity writes | Completed & verified | 10 event types; written in the same transaction as mutations |
| Incoming activity on `MEMBER_JOINED` | Completed & verified | Hooked into invitation accept |
| Cursor pagination (timestamp + id) | Completed & verified | Keyset on `(created_at|starts_at, id)`; limit+1; no OFFSET; `INVALID_CURSOR` → 400 |
| 10,000-record seed script (`db:seed:activity`) | Completed & verified | Idempotent reruns; `--reset` scoped to `payload->>'source'='seed'`; 10,000 rows live |
| Mobile shift list, infinite scroll, pull-to-refresh | Implemented, not independently verified | Type-checks; runtime not exercised on a device |
| Mobile shift detail + create screen | Implemented, not independently verified | Assign/unassign/swap actions wired; type-checks |
| Mobile swaps + activity screens | Implemented, not independently verified | Infinite lists + approve/reject/cancel mutations; type-checks |
| Mobile team selector + React Query data layer | Implemented, not independently verified | TeamContext persists selected team; TanStack Query v5 |
| Mobile FlatList list virtualization | Not started | Deferred: FlatList used now; FlashList swap documented in `docs/PAGINATION.md` |

## Phase 4+ — Graduation requirements

| Requirement | Status | Notes |
|---|---|---|
| Shift scheduling | Completed | Phase 3 |
| Shift swaps | Completed | Phase 3 |
| Cursor pagination | Completed | Phase 3 |
| 10,000 activity records | Completed | Phase 3 seed script (10,000 rows in live DB) |
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
| Tests | `npm test` | PASS — 4 suites, **43 tests passed** |

Test breakdown:

- `health.test.ts` — 1 test (mocked deps).
- `rate-limit.test.ts` — 1 test (mocked deps): 429 after budget exceeded.
- `integration.test.ts` — 19 tests (live DB): full Phase 2 scenario, last-owner
  protection, invitation one-time use and expiry, refresh rotation and reuse
  detection, validation errors, unauthenticated access.
- `phase3.test.ts` — 22 tests (live DB): shift lifecycle and RBAC, swap
  workflow (request → approve → assignment transfer), dedupe/status guards,
  cross-team denial, cursor pagination gaplessness + mid-walk stability, 400s
  on malformed cursors/params, feed isolation, and seed idempotency.
  `maxWorkers: 1` keeps Phase 3 and Phase 2 DB suites from racing on shared
  tables.

Phase 3 was validated against a live database seeded with **10,000 activity
rows** (see `docs/PHASE-3-TEST-REPORT.md` and `docs/PAGINATION.md`).

Supersedes `docs/PHASE-2-TEST-REPORT.md` (which reports the earlier 10-test
run and remains as a historical record).

**Not verified:** mobile runtime behavior. The Expo app was type-checked but
never launched on this machine; every mobile item marked
"Implemented, not independently verified" carries that caveat.
