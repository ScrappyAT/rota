# Rota — Implementation Status

Single source of truth for what exists, what is verified, and what is missing.
Status categories:

- **Completed & verified** — code exists, tests were executed and observed.
- **Implemented, not independently verified** — code exists but was not
  executed/observed in a test or manual run.
- **Partially implemented** — works in a narrow case; gaps are listed.
- **Not started**
- **Blocked** — cannot proceed until a listed dependency is resolved.

Latest verification: **integrated graduation release,10 November2026**.
Branch `codex/graduation-release-2026-11-10` combines runtime repair + Phase1/2/3.
All478 tests/44 suites passed on this actual integrated tree (136.167s).
TypeScript, lint (zero errors/one existing shared warning), shared/API builds
and the final Docker-image dependency/HTTP/separate-worker smoke passed.
Migrations001–009 are unchanged; only explicitly approved disposable migration
safety tests executed SQL. No application/production migrator ran.

Installable APK build947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf FINISHED successfully; tracked in
[final release report](GRADUATION-RELEASE-REPORT.md). Intended backend health
returned404; no Railway deployment or physical Android execution is claimed.
Original branches/worktrees remain intact. The older status below describes
the preserved pre-integration workstreams, not the current release candidate.

## Current graduation integration status

| Workstream | Local evidence | Integration/deployment boundary |
|---|---|---|
| Railway runtime repair | 12 protected files; prior final-image dependency/HTTP smoke evidence in its report | Separate fix/railway-runtime-dependencies checkout, uncommitted; not deployed |
| Graduation Phase 1 | 8 protected files; 19 billing-boundary/primary-membership cases, historical full 392 tests | Separate phase1 worktree, not integrated here |
| Graduation Phase 2 | 36 protected files; 51 extracted-mobile/API cases; historical combined 443/38 | Separate phase2 worktree; physical Android acceptance remains open |
| Graduation Phase 3 | Structured request/job logs; optional server/mobile JS Sentry; privacy tests; assessment docs | Dedicated phase3 branch/worktree; exact fresh tests/checks in its report |

Final combined verification: **478 tests/44 suites** (373 original +19 Phase1
+51 Phase2 +35 Phase3); restored Phase3 new tests **35/35 across six suites**.
TypeScript, lint (zero errors), shared/API builds and combined Android JS export
passed. Runtime12/Phase1 8/Phase2 36 protected hashes are unchanged; migrations
001–009 have no Git content changes. No physical Android or native build claim.

Phase 3 code is implemented and locally verified as recorded in
[ROTA-GRADUATION-PHASE-3-REPORT.md](ROTA-GRADUATION-PHASE-3-REPORT.md). No live Sentry
project, production log collector/alerts, native crash reporting, current physical
Android testing or provider delivery is claimed. App/server error integration
is present; operation with real configuration needs approved staging acceptance.

Existing pagination, sharding simulation and 200-VU benchmark evidence are
retained. The historical load harness missed its own latency thresholds; this
phase did not re-run k6/EXPLAIN or establish hosted production capacity.
Flutterwave already satisfies the permitted provider choice; no replacement
is needed. Store production considerations are now documented in README.

Submission: demo recording completed 14 October 2026, shareable URL missing;
LinkedIn post published; existing APK URL returns 404; portfolio is published
but a dedicated Rota case-study page remains unverified/missing from supplied
homepage evidence. See the corrected [submission checklist](SUBMISSION.md).

All four local workstreams need an explicit integration/release review. Phase 3 did not change migration files, billing/auth rules or production records.
No commit, push, merge or deployment was performed.

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


## Milestone R1 - Billing and Financial Integrity (2026-10-30)

Approved implementation scope: R1 only. Branch: `codex/r1-billing-financial-integrity`.
No commit, push, merge or deployment. Source: original assignment PDF, Part 2
Task A, page 19. `BILLING.md` now supersedes historical Phase 4 financial rules.

| Requirement | Status | Evidence |
|---|---|---|
| Exact Starter/Team/Business USD prices and allowances | Completed & verified | Additive migration 007, `planMonthlyAmount`; catalog/included/extras tests |
| Separate-floor proration | Completed & verified | `prorationBreakdown`; 8+ calculation scenarios and real-DB ledger amounts |
| End-period plan/seat reductions | Completed & verified | `computeChange`, `materializeSubscription`; before/after boundary and pending-seat tests |
| Currency precision and legacy NGN retention | Completed & verified against mocked provider | Actual adapter unit tests; legacy pending settlement and pre-R1 database preservation test |
| Concurrent seat reservations/acceptance | Completed & verified | Team row locks; duplicate acceptance, final seat, resend and downgrade/invite races |
| Client/server payment idempotency | Completed & verified for shared logic/API | Persisted client intent keys, duplicate requests, lost response, conflict and provider-call counts |
| Append-only financial ledger and reconstruction | Completed & verified | Mutation rejection, duplicate event conflict, projection corruption/rebuild, schedule/totals and refund races |
| Mobile R1 integration | Implemented, not independently verified on device | Shared intent logic unit-tested; mobile TypeScript/lint pass; new expo-crypto requires native rebuild |

Final gates: 22 suites / 278 tests passed; typecheck and API/shared builds passed;
lint passed with zero errors and five pre-existing warnings. Mobile test script
is still a stub; no device runtime validation is claimed.
All database tests use isolated services on 5540/6480/5541/5542, with mocked
financial providers. Normal development databases and production records are
untouched. Migration 001-006 files are unchanged. The migration preservation
suite verifies original prices/subscription/payment/invoice values survive 007.

Remaining boundaries: existing paid NGN subscriptions need a separately reviewed
currency transition; ambiguous checkout initialization has no automatic recovery;
scheduled changes use existing lazy materialization; refunds are accounting-only,
not a new provider refund feature. Live checkout/device runtime, durable jobs and
R2-R4 were not performed. Details: `R1-IMPLEMENTATION-REPORT.md`.


## Milestone R2 - durable jobs and server settings (2026-11-02)

R1 is merged as PR #1. R2 branch `codex/r2-durable-jobs-settings` starts at
synchronized main `bd149a2`. R2 remains uncommitted for review; no push, merge,
deployment, production migration or real provider operation was performed.

| Requirement | Status | Evidence |
|---|---|---|
| Transactional business/notification outbox | Completed & verified | Migration 008, activity and notification persistence on the business transaction; rollback/no-worker drills |
| Redis/BullMQ workers and bounded retries | Completed & verified | Separately runnable worker, SQL attempt/dead tracking, explicit replay and real Redis retry tests |
| Restart recovery and replay guards | Completed & verified | Killed child workers before work/after SENDING, SQL lock recovery, Redis queue-loss reconstruction, per-device replay checks |
| Safe ambiguous payment reconciliation | Completed & verified with mocked provider | Original reference GET verification; no second checkout POST; R1 financial tests retained |
| Server settings and field timestamps | Completed & verified | Authenticated GET/PATCH, strict inputs, legacy compatibility, per-field receive-time LWW and concurrent-write tests |
| Quiet hours/IANA zones/preferences | Completed & verified | Overnight/same-day/DST cases, deferral, real delayed jobs, current-preference suppression |
| Push receipt/token handling | Completed & verified with mocked provider | Separate per-device receipt jobs, late invalid-token pruning, partial-success retry |
| Owner renewal notices and grace rechecks | Completed & verified | Failed-renewal notice, cached FAILED status and deadline EXPIRED transition |
| Correct team/destination resolution | Implemented; API/shared logic verified | Membership check, explicit route team IDs, exact authorized swap detail, malformed/cross-tenant denial |
| Mobile settings lifecycle and UI | Implemented, not verified on device | Actual shared optimistic/rollback controller tested; foreground binding, UI, routing and navigation theme compile/lint |

Final verification: 340 tests across 27 suites passed, including the complete
--detectOpenHandles run with zero detected handles. Typecheck, lint and
API/shared builds passed; lint has zero errors and five pre-existing warnings.

R1 prices, proration math, immutable ledger, idempotency mapping, revisions and
late-settlement safeguards are preserved. SQL migrations 001-007 are unchanged.
Existing PAST_DUE write gates are preserved; the grace access-policy limitation
is explicitly reported. Unknown external push outcomes require review, and dead
jobs after prolonged outages need operator action. Language/theme values sync,
but a full translated/dark-palette UI is not claimed. R3/R4 and submission
artifacts have not been reopened. See `R2-IMPLEMENTATION-REPORT.md` for all
files, migration guarantees, failure evidence, audit findings and limitations.


## Milestone R3 — auth, security and routing (2026-11-02)

R1/R2 are merged. R3 starts from synchronized main 1c5be5d on
`codex/r3-auth-security-routing`; changes remain local for review.

| Requirement | Status | Evidence |
|---|---|---|
| Single-use reset and magic-link backend | Completed & verified with mocked mail | r3-auth.integration: expiry, purpose, replay, concurrent consumption, encrypted queue, provider retry |
| Global/session revocation and safe refresh | Completed & verified | User locks, auth_version, session checks, concurrent refresh/logout-all, legacy upgrade |
| Manager/owner approval | Completed & verified | r3-policy concurrent approval, staff/requester/replacement 403, outsider 404; push regression now uses owner |
| Strict inputs and Redis sensitive quotas | Completed & verified | Strict body schemas, request bounds, cursor UUID checks, shared IP/user counters, Redis outage and concurrency tests |
| Read routing and own-write consistency | Completed & verified as a connection-string simulation | Primary auth/financial reads, durable per-user fence, cache bypass, independent read DB lag/error drills |
| Existing team-hash sharding | Preserved & regression tested | Unchanged sharding code and 11 tests |
| Grace access correction | Completed & verified | PAST_DUE remains usable within grace; protected shift creation/invites block after grace |
| Mobile auth actions/logout-all/session handling | Implemented; typechecked/linted | Device execution, actual email/deep-link delivery remain unverified |
| Dependency remediation | Partially completed | Four compatible patches; production audit 24→20; remaining major-version/toolchain findings tracked |

Final verification: 373 tests across 31 suites passed in the complete API
run with zero detected open handles, and again through the root workspace test
gate. Typecheck, lint (zero errors, one existing warning), shared/API builds
passed. Mobile tests remain a stub. Full details and risk disposition are in
`R3-IMPLEMENTATION-REPORT.md`.
Migrations 001–008 and R1/R2 financial/delivery invariants are preserved.
No commit, push, merge, deployment, real payment/push/email or R4 work performed.
Existing published demo/post completion evidence has not been reopened.
