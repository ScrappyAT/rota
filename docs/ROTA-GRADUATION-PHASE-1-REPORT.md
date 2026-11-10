# Rota graduation — Phase 1 implementation report

Date: 2026-11-09. Scope: renewal grace at the billing boundary and stale replica
membership authorization only. The original graduation PDF, Part 2 Task A,
requires failed-renewal grace/owner notice/restricted access and server-side
tenant authorization. No mobile, provider replacement or deployment work is included.

## Isolation and preserved work

Original checkout: `C:/Users/HP/Desktop/rota project`, branch
`fix/railway-runtime-dependencies`, HEAD
`c09f9259190ad44e3391919691e52ba6a9f52ce6`.

Phase 1 is isolated in a separate Git worktree:
`C:/Users/HP/Desktop/rota project/.r1-test-cache/phase1-worktree`, branch
`codex/graduation-phase-1-billing-authorization`, from the same clean main commit.
The original checkout was not switched, stashed, reset or committed. Its twelve
runtime-repair files were hashed before work and are checked independently at
completion. No repair file is copied into this feature's diff. Dependency
junctions reuse the existing root/API/shared installations without npm install
or a lockfile change; ignored build/cache output is not part of the change.

## Root causes and behavior changes

### Renewal lifecycle

`initiateBilling` materializes expiry before quoting a renewal. `transitionStatus`
changes ACTIVE to EXPIRED and increments the revision through
`materializeSubscription`. Previously `reconcilePayment` opened grace only from
ACTIVE with the original revision. Therefore at/after-boundary initiation, or a
pending renewal confirmed after passive expiry, could lose grace or incorrectly
be treated as superseded.

The first verified terminal renewal failure can now open grace from ACTIVE or
EXPIRED for the same service configuration, subject to revision safeguards. The
deadline is first verified failure time + configured grace days (default 14).
The first-failure markers prevent a second failure extending/reopening that
window, including after expiry. Scheduled reductions and zero-due changes
preserve these markers; paid recovery retains its prior reset behavior.

For example, a verified failure at 2026-11-09T00:00:00Z gets a deadline of
2026-11-23T00:00:00Z with 14 configured days. A later failed attempt keeps that
deadline. Protected shift creation succeeds during grace and returns 403 at
the exact deadline; reads remain available. A new verified successful renewal
clears the markers and starts the normal configured paid period.

The revision check is not removed. A pending renewal can cross a passive
revision only when append-only ledger STATE rows prove every revision, unchanged
team/plan/seats/period, no scheduled change, and only status-transition or
renewal-failure reasons since its quote. A new paid period/configuration change
or missing evidence remains superseded. Failed legacy changes without a quoted
revision also check for newer paid changes. Currency/amount/reference checks,
payment claiming, idempotency, exact pricing and the existing superseded credit
path remain intact.

Provider transport errors do not settle payments or grant grace. Workers retain
the original intent/reference; no provider initialization is reissued. Failure
state, immutable snapshot, activity/outbox event and deadline job share the
existing settlement transaction. Duplicate terminal events return without
repeating financial or notification effects. Grace expiry uses the existing
protected-write policy; no broader account freeze is added.

### Team membership authorization

Previously GET /teams joined memberships on readQuery, so an unfenced user could
see revoked teams from a lagging replica. Its membership/team join now uses
primary in one statement. Other authorized read endpoints retain replica routing,
primary membership middleware, read-your-own-writes and primary fallback.

## Files changed

| File | Purpose |
|---|---|
| `apps/api/src/billing/service.ts` | `materializeSubscription` (207), `applyChange` (479), `renewalSurvivesLifecycleRevisions` (531), `reconcilePayment` (558): one-window grace, ledger-proven passive revisions and preservation on unpaid changes. |
| `apps/api/src/routes/teams.ts` | GET /teams handler (65): authoritative primary membership join. |
| `apps/api/__tests__/graduation-phase1-billing.integration.test.ts` | Boundary/failure/retry/replay/downgrade/delayed-settlement regression cases with real DB/Redis and mocked providers. |
| `apps/api/__tests__/graduation-phase1-authorization.integration.test.ts` | Real independent read DB containing stale/revoked/replica-only memberships; legitimate read routing and denial cases. |
| `docs/ARCHITECTURE.md` | Endpoint authorization and renewal lifecycle contract. |
| `docs/BILLING.md` | Grace formula, one-window policy and financial revision safeguards. |
| `docs/IMPLEMENTATION-STATUS.md` | Phase 1 verification/status record. |
| `docs/ROTA-GRADUATION-PHASE-1-REPORT.md` | This implementation/verification review. |

No migration, dependency, environment, Flutterwave configuration, auth/mobile
source or Railway file is changed. Migrations 001–009 remain unchanged.

## Regression coverage

The regression files were written before changing implementation. Billing covers
renewal before/exactly at/after expiry; delayed failure and success across passive
expiry; provider verification outage and safe retry; concurrent duplicate
webhooks; exact grace timestamp/deadline; repeated failures and key replay;
protected writes during grace and restriction at expiry; successful recovery;
newer paid upgrades/renewals; existing grace through scheduled/zero-due changes;
and the lower renewal price after scheduled downgrade.

Authorization uses actual independent PostgreSQL tables with stale membership,
not a mocked database. Tests cover revoked/replica-only team exclusion, 404s for
former-team details/members/shifts/swaps/activity/subscription, empty primary
membership, fresh primary membership missing from replica, continued eligible
detail routing, unauthenticated 401 and malformed-ID 400.

## Verification evidence

The earlier Docker startup blocker is resolved after the user's WSL update and
restart. On 2026-11-09 both `docker version` and `docker info` returned exit 0
with a responsive Linux Server/Engine (29.6.1, Docker Desktop 4.82.0). The first
restricted check returned named-pipe permission denied; the authorized engine
checks passed. No Docker settings or host data were changed.

Docker inventory confirmed the test ports were free before starting only
`rota-phase1-7c208e66-tests`. Its five task-specific services use PostgreSQL 15,
Redis 7 and localhost ports 5540/6480/5541/5542/5543. Existing project containers
were not stopped, restarted or reused. Migrations 001–009 were applied only to
the newly created disposable primary; none was edited. Redis returned PONG.
After verification, only these five task-owned containers were stopped. None
was removed; no Docker volume was deleted. Other project services were left
untouched. The generated Compose file and logs/results remain in ignored cache.

The tests were authored before implementation. The earlier original-source run
could not reach PostgreSQL. With Docker now available, the two original source
files were temporarily restored from HEAD inside the isolated worktree only;
a try/finally restored the exact prepared implementation afterward. This
comparison reproduced 17 failed / 2 passed cases across two suites (36.933 s).
Failures included boundary renewals remaining EXPIRED, delayed success becoming
an unapplied credit, repeated failure markers changing, and stale replica teams
being disclosed. All four authorization cases failed on original source.
No integration test or implementation adjustment was needed on this resumed run.
All 31 original suite files are unchanged; preservation comparisons account for
Git's normal Windows CRLF checkout conversion, not source edits.

| Verification | Observed result |
|---|---|
| Docker Engine connectivity | PASS: version and info, including Server sections. |
| Original-source reproduction | EXPECTED FAIL: 17 failed / 2 passed, two suites; both defects reproduced. |
| New billing + authorization integration | PASS: 19 tests / 2 suites, zero failures, 56.570 s. |
| Relevant existing integration | PASS: 70 tests / 4 suites, zero failures, 65.602 s. Includes billing, R2 durable jobs/failure drills, R3 access policy and read routing/fallback. |
| Full original + new regression | PASS: 392 tests / 33 suites, zero failures, 270.558 s, no detected open handles. All original 373 tests plus 19 new passed. |
| Root workspace test gate | PASS: npm run test:r3 invokes root npm test with pinned disposable credentials; API 392/392 tests across 33 suites (192.138 s), mobile test stub exits 0. No device execution claimed. |
| TypeScript | PASS: API, mobile and shared, rerun after Docker recovery. |
| New integration files' semantic TypeScript check | PASS: ignored config extends the API configuration and includes source plus both new test files. |
| Lint | PASS: zero errors; one pre-existing unused Team warning and Expo legacy-config notice. |
| Shared/API build | PASS: npm run build:api. |
| git diff --check | PASS. |
| SQL migrations 001–009 | Unchanged from HEAD; no additive migration needed. |
| Original runtime repair | All 12 protected SHA-256 hashes match the pre-task snapshot. |
| Staging/publication | Nothing staged, committed, pushed, merged or deployed. |

The earlier database-free run also passed 103 tests / 7 suites (11.624 s);
these are part of the full API inventory, not additional unique tests. Earlier
setup failures were resolved: shared's missing private TypeScript junction had
selected root TS6 (TS5107), and an initial narrowed-array includes type error
was corrected with explicit status comparison. No checks were disabled. No
EPERM occurred; prior connectivity failures were infrastructure failures.

Ignored artifacts: `.r1-test-cache/phase1-red-results.json`,
`phase1-targeted-results.json`, `phase1-regression-results.json`,
`phase1-full-results.json`, `phase1-preservation-check.json` and
`phase1-workspace.log`. No test output, caches or generated builds are intended
changes.

### Repeatable verification

From this Phase 1 worktree, with the disposable ports free:

1. Start only this task's stack:
   `docker compose -f .r1-test-cache/docker-compose.phase1-tests.yml up -d --wait --wait-timeout 40`.
   The generated configuration copies the R3 test topology with unique project
   and container names. Inspect ownership before using the pinned ports.
2. Targeted:
   `powershell -NoProfile -File scripts/test-r3.ps1 --runTestsByPath __tests__/graduation-phase1-billing.integration.test.ts __tests__/graduation-phase1-authorization.integration.test.ts`.
3. Relevant existing suites: use the same runner with billing.integration,
   r2-jobs.integration, r3-policy.integration and r3-routing.integration paths.
4. Full API with leak detection:
   `powershell -NoProfile -File scripts/test-r3.ps1 --detectOpenHandles --silent --json --outputFile=../../.r1-test-cache/phase1-full-results.json`.
5. Root workspace gate: `npm run test:r3` (pins disposable connections before
   invoking root npm test). Never use unguarded development/production credentials.
6. Run `npm run typecheck`, `npm run lint`, `npm run build:api` and `git diff --check`.

Tests use real PostgreSQL/Redis, serialized Jest and mocked providers with dummy
keys/local non-serving URLs. Read-replica authorization fixtures use an actual
independent PostgreSQL database, not physical WAL replication. No external
provider delivery is required or performed.

## Final Git status and diff summary

Phase 1 branch: `codex/graduation-phase-1-billing-authorization`, HEAD c09f925.
Eight intended files: five tracked modifications, two new integration suites
and this new report. The tracked diff is 144 insertions / 23 deletions across
the two source fixes and three documentation updates. The two new tests and
this report are additional untracked files.
New-file contents do not appear in ordinary git diff --stat until staged.
There are no staged changes. All 31 baseline tests, SQL migrations, package-lock,
mobile/shared sources, scripts, infrastructure, Dockerfile and railway.json are
unchanged in this feature worktree. No actual env, credential, generated build,
test output, dump or cache file is included among intended changes.

The original checkout remains on fix/railway-runtime-dependencies with its same
eight modified and four untracked repair files; its twelve file hashes are
unchanged. Phase 1 documentation has its own worktree copy of
IMPLEMENTATION-STATUS.md. Future integration of these separate documentation
changes requires normal review; no merge or copying over the repair was performed.

## Risks and release boundary

- No production database, real payment, email, push or Railway operation is
  authorized/performed. Providers remain mocked and test connection strings are pinned.
- Missing/inconsistent immutable state evidence fails closed to the existing
  manual credit path. No historical ledger repair or automatic refund is attempted.
- Distinct client UUIDs remain distinct authorized intents; same-key replay and
  ambiguous initialization retain their existing no-second-POST safeguards.
- Read authorization is authoritative at the SQL statement snapshot. This is
  not a claim of cancellation of an already-running read after later revocation.
- Physical WAL replication and live provider/device checks remain outside scope.
- Already-terminal FAILED payments remain terminal; pending delayed confirmations
  and a new successful retry are covered without resurrecting terminal intents.
- No Phase 1 implementation or automated-test blocker remains. The Docker blocker
  is resolved and both full API and root workspace gates passed. No release or
  provider verification is implied by disposable integration tests.
- No commit, push, merge or deployment is performed. Stop after Phase 1 review.
