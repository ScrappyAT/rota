# Rota — Implementation Status

Single source of truth for what exists, what is verified, and what is missing.
Status categories:

- **Completed & verified** — code exists, tests were executed and observed.
- **Implemented, not independently verified** — code exists but was not
  executed/observed in a test or manual run.
- **Partially implemented** — works in a narrow case; gaps are listed.
- **Not started**
- **Blocked** — cannot proceed until a listed dependency is resolved.

Last full validation: 2026-10-13 (see "Validation history").

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
- `JWT_REFRESH_SECRET` in `env.ts` is unused (refresh tokens are opaque, not
  JWTs) — dead configuration, harmless.
- Last-owner checks are read-then-write, not serialized; a concurrent race
  could theoretically demote two owners at once (single-writer deployments are
  unaffected).
- `/auth` (100), `/teams` (300), and `/invitations` (300) rate limits are
  in-memory per instance; only `/devices` (200) is shared via Redis. Fine for
  single-instance deploys, per-pod under horizontal scaling. Budgets are
  overridable via `AUTH_RATE_LIMIT_MAX` / `TEAMS_RATE_LIMIT_MAX` /
  `INVITATIONS_RATE_LIMIT_MAX` for load-test instances (defaults unchanged;
  see `docs/PERFORMANCE-REPORT.md` §5).

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
| 10,000-record seed script (`db:seed:dataset`) | Completed & verified | Deterministic multi-tenant seed (40 users / 5 teams / 500 shifts / 1,226 assignments / 154 swaps / 10,000 activity rows); rebuilt to identical rows on every run |
| Mobile shift list, infinite scroll, pull-to-refresh | Implemented, not independently verified | Type-checks; runtime not exercised on a device |
| Mobile shift detail + create screen | Implemented, not independently verified | Assign/unassign/swap actions wired; type-checks |
| Mobile swaps + activity screens | Implemented, not independently verified | Infinite lists + approve/reject/cancel mutations; type-checks |
| Mobile team selector + React Query data layer | Implemented, not independently verified | TeamContext persists selected team; TanStack Query v5 |
| Mobile UX Refinements (UI components, keyboards, settings) | Implemented, not independently verified | UI Kit applied, DateTimePicker installed, Settings screen added |
| Mobile FlatList list virtualization | Not started | Deferred: FlatList used now; FlashList swap documented in `docs/PAGINATION.md` |

## Phase 4 — Seat-Based Subscriptions & Flutterwave Billing

See `docs/BILLING.md` for the domain design and `docs/PHASE-4-TEST-REPORT.md`
for evidence.

| Feature | Status | Notes |
|---|---|---|
| Migration `004` (plans, subscriptions, changes, payments, webhooks, invoices) | Completed & verified | Applied via `npm run db:migrate`; FREE plan backfilled for existing teams |
| Plan catalog + team provisioning | Completed & verified | FREE/STARTER/GROWTH/SCALE seeded; FREE subscription created on team create |
| Subscription status lifecycle (ACTIVE/PAST_DUE/EXPIRED) | Completed & verified | Lazy materialization; grace window on failed renewal; `transitionStatus` unit-tested |
| Proration & money model (integer minor units) | Completed & verified | Upgrade/add seats prorated; downgrades/reductions immediate & free; amounts in kobo, gateway in naira |
| Seat capacity enforcement | Completed & verified | Invites and seat edits gated; pending invites consume capacity |
| Shift-create gate on active subscription | Completed & verified | 403 `SUBSCRIPTION_REQUIRED` when EXPIRED |
| Checkout / verify / renew / seats endpoints | Completed & verified | Owner-only, Zod-validated; verify idempotent via guarded status claim |
| Flutterwave client (checkout + verify + webhook) | Completed & verified against mocked contract | No live/sandbox credentials available — end-to-end card flow not exercised |
| Webhook receiver with `verif-hash` + `event_key` dedupe | Completed & verified | Duplicate/bad-hash/unknown-ref scenarios covered by tests |
| Owner-only subscription mobile screens | Implemented, not independently verified | Summary, plans+checkout, history/invoices; type-checks, no device run |
| All-money-integer + envelope + parameterized SQL audit | Completed & verified | No user SQL concat; all errors use `ApiResponse` envelope |

## Phase 4+ — Graduation requirements

| Requirement | Status | Notes |
|---|---|---|
| Shift scheduling | Completed | Phase 3 |
| Shift swaps | Completed | Phase 3 |
| Cursor pagination | Completed | Phase 3 |
| 10,000 activity records | Completed | Phase 3 seed script (10,000 rows in live DB) |
| Subscription billing and proration | Completed | Phase 4 (see `docs/BILLING.md`) |
| Push notifications | Completed & verified | Backend ledger + Expo push delivery, mobile registration, foreground/background handlers, deep link navigation, preference toggles, logout cleanup |
| Offline shift viewing | Completed & verified | Persistent local cache via FileSystem AsyncStorage adapter, user/team isolation, offline indicator, write mutation blocking, auto-reconnect refresh |
| Settings synchronization | Not started | Requires user settings table + API |
| Redis usage | Completed & verified | Cache-aside for team roster (300s TTL), shift calendar (120s TTL), and activity feed (60s TTL) with explicit invalidation on mutations; health probe; `/devices` rate limiting |
| PostgreSQL sharding simulation | Completed & verified | Two-PostgreSQL Docker cluster (:5441/:5442), deterministic MD5 router, pool manager, scatter-gather, 11 tests in `sharding.test.ts` (see `docs/SHARDING.md`) |
| Load testing (k6 harness) | Completed & verified | `load-tests/**` executed via Docker against 10k-row seed; dedicated 200-VU activity feed benchmark before & after caching (see `load-tests/REPORT.md` and `docs/PERFORMANCE-REPORT.md`) |
| Android development build | Completed & verified | EAS development build running on physical Samsung test device |
| Deployment packaging (Docker + Railway) | Implemented, not independently verified | `Dockerfile`, `.dockerignore`, `railway.json`, `docs/DEPLOYMENT.md`; image not yet built/deployed in this session |
| Demo video | Not started | Blocked on deployed host being reachable during recording |

---

## Validation history

Executed against the live local Docker Postgres (5440) and Redis (6380), both migrated:

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS (api, mobile, shared — 0 errors) |
| Lint | `npm run lint` | PASS — 0 errors, pre-existing warnings tolerated |
| Tests | `npm test` (2026-10-15) | PASS — 18 suites, **236 tests passed** |
| Load | `k6` via Docker vs 10,000-row seed (2026-10-15) | PASS — 200 VUs simultaneous activity feed benchmark (+74.9% throughput, -49.9% p50 with cache) |

Test breakdown:

- `cache.test.ts` — 9 tests: Cache miss/hit lifecycle, explicit invalidation on shift/member mutations, swap approvals, tenant isolation, cache bypass flag (`ENABLE_REDIS_CACHE=false`).
- `sharding.test.ts` — 11 tests: Deterministic UUID routing, uniform distribution, physical data isolation on live Shard 0/1, cross-shard scatter-gather aggregation, blast-radius fault tolerance.
- `health.test.ts` — 1 test (mocked deps).
- `rate-limit.test.ts` — 1 test (mocked deps): 429 after budget exceeded.
- `security.test.ts` — 5 tests: Helmet headers, CORS origins, Redis rate limiting.
- `cacheIsolation.test.ts` — 4 tests: User/team cache key isolation, individual shift detail pre-caching, secure logout eviction, cross-tenant isolation.
- `notifications.test.ts` — 8 tests: Pure delivery helpers, token classification, pref columns, formatting.
- `mobilePushContract.test.ts` — 8 tests: Token privacy (masked logging), payload routing decisions, preference keys contract.
- `checkoutReconciliation.test.ts` — 10 tests: Dismissal resilience, absence of pending payment handling, existing active subscription isolation, network timeout/inconclusive handling, confirmed success/failure, gateway redirect status handling.
- `push.integration.test.ts` — 9 tests (live DB): Full push scenario, dedupe ledger, token pruning, preferences skipping.
- `integration.test.ts` — 19 tests (live DB): full Phase 2 scenario, last-owner
  protection, invitation one-time use and expiry, refresh rotation and reuse
  detection, validation errors, unauthenticated access.
- `phase3.test.ts` — 22 tests (live DB): shift lifecycle and RBAC, swap
  workflow (request → approve → assignment transfer), dedupe/status guards,
  cross-team denial, cursor pagination gaplessness + mid-walk stability, 400s
  on malformed cursors/params, feed isolation, and seed idempotency.
- `billing.test.ts` — 26 tests (pure math): proration, renewal amounts,
  status transitions, change computation, and returnUrl scheme validation.
- `billing.integration.test.ts` — 31 tests (live DB, gateway mocked):
  provisioning, RBAC 403 / cross-tenant 404, prorated upgrades and seat
  changes, downgrade immediacy, invite seat limits, failed renewal → PAST_DUE,
  grace expiry → EXPIRED gate, successful renewal, webhook settle with
  duplicate / bad-hash / unknown-ref handling, settlement rollback on
  amount/currency mismatch, plan camelCase schema contract, deep-link redirect
  bridge, failed webhook reconciliation, transaction status retrieval (`GET /payments/:txRef`),
  and replay resistance. See `docs/PHASE-4-TEST-REPORT.md`.
  `maxWorkers: 1` keeps all DB suites from racing on shared tables.
- `large-dataset.test.ts` — 11 tests (live DB, 10,000+ activity rows):
  distribution across 5 teams / 12 types, deterministic re-seed (count +
  `hashtext` fingerprint), tenant isolation 404s, gapless ordered walk of
  team0's feed, `type` filter gaplessness, `INVALID_CURSOR` 400, `limit`
  clamp to 50 + invalid-limit 400, single-row/bulk page order agreement,
  exact members count, swaps pagination + STAFF scoping, shifts pagination.

Phase 3 was validated against a live database seeded with **10,000 activity
rows** (see `docs/PHASE-3-TEST-REPORT.md` and `docs/PAGINATION.md`).
Phase 4 was validated with the gateway module mocked (no sandbox credentials);
the live hosted-checkout and webhook delivery path is unverified.

On 2026-10-13 the full k6 suite (health, smoke, baseline, workload,
cursor-walk, auth, rate-limit) was executed against that 10,000-row seed:
30,115 requests in the peak workload (60 VUs) at **0% errors**, `p95 62.7 ms` /
`p99 167.9 ms`; cursor soak `p95 24.5 ms` / `p99 64.6 ms`; exactly 20/320
requests throttled past the `/teams` budget. Numbers and methodology are in
`docs/PERFORMANCE-REPORT.md`.

Supersedes `docs/PHASE-2-TEST-REPORT.md` (which reports the earlier 10-test
run and remains as a historical record).

**Not verified:** mobile runtime behavior. The Expo app was type-checked but
never launched on this machine; every mobile item marked
"Implemented, not independently verified" carries that caveat.
