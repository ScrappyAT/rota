# Rota graduation — Phase 2 implementation report

Date: 2026-11-09. Scope: mobile requirements only, against the original Dev &
Design HQ PDF, Part 2 Task A (16–21), shared rules (14–16), and submission
checklist (34). Assessment requirements are evidence targets, not permission to
publish, deploy or perform provider operations. The prior audit findings and
Phase 1 implementation report were reviewed against current source.

## Requirements and original defects

| Requirement | Original defect | Current implementation / verification boundary |
|---|---|---|
| Shareable invitations and correct team | Only a manual code entry; auth redirect lost intake and acceptance returned no team. | Existing `rota` scheme, validated link intake in SecureStore, login/registration/magic-link resumption, email prefill, one-use redemption, fresh team list and server-confirmed selection. Core flow and API automated; native launch not exercised. |
| Optimistic swaps | Detail screen waited for the server and did not snapshot/rollback or synchronously claim taps. | Actual TanStack mutation options cancel/snapshot, insert PENDING and disable submission, reconcile ID, rollback errors and invalidate. Session guards cover queued/late work across logout. |
| Offline cold launch | Auth required a network refresh, team selection was globally keyed, cache stored the last all-team page, and empty live results could resurrect old rows. | SecureStore identity read lease plus per-user team selection, complete assigned-only future snapshots, visible last updated and read-only banner, namespace/epoch/tombstone protection. Automated adapter/core tests, not physical persistence proof. |
| Activity list states | Initial loading was blank, errors lacked retry, no end message or concurrent scroll gate. | FlatList states and refresh/retry controls, synchronous request gate and ID deduplication. Backend cursor/index unchanged. Rendering/gestures still need device acceptance. |
| Server state ownership | Teams/roles used component state and settings used a custom controller cache outside Query. | Query owns teams, selected role and settings; Context exposes coordination/results. Settings optimism, rollback, server timestamps and foreground/reconnect refresh remain. |
| Mobile shift operations | Backend could edit title, notes and time but detail UI exposed only assignment/status/delete. Date navigation was absent. | Owner/Manager editor plus previous/next/today/date picker calendar. Existing create/assign/unassign/cancel/reopen/delete retained; API role/input/tenant coverage passed. Native form behavior not exercised. |

No second invitation system, payment gateway, calendar library, persistence
library or state library was introduced. No schema migration is needed. Final full verification passed; native/device
acceptance remains unexecuted and is required before claiming those flows were
observed on Android.

## Decisions and security model

### Invitation flow

`invitationLinks.ts` builds `rota:///teams/accept` with the existing six-digit code,
invited email and expiry. Multi-valued/malformed inputs are rejected. The route
is public only to collect the invitation and offer authentication; redemption
requires the existing authenticated server endpoint, matching email, current
capacity and an unexpired, unaccepted hashed invitation.

The sole API change adds `data.teamId` to a successful acceptance. It discloses no
destination on an error and preserves compatibility with success-only callers.
The client refreshes Query-owned memberships and selects only an allowed team;
link parameters cannot grant membership. A received successful destination is
stored before refreshing teams, so failed synchronization can retry without
redeeming twice. Lost redemption responses remain ambiguous: the reused-code
message offers refreshed My teams rather than treating an error as a new join.
No automatic external email is added; the native share sheet/copy link satisfies
the existing link invitation path. Rollout ordering matters: deploy the reviewed
additive API response before distributing this mobile version. Older clients
remain compatible with the new response; an older server cannot supply the new
client's confirmed destination. My teams provides manual recovery for an already
accepted invitation when the destination response is unavailable.

### Offline identity and upcoming data

An offline read lease lives in native SecureStore alongside existing credentials.
It requires the same stored user ID, a refresh credential, a valid user profile
and a verification age under 24 hours; clock rollback/expiry fails closed.
Transport failure during refresh/profile lookup can restore this identity for
cached viewing. Known invalid/revoked sessions cannot use that fallback.

ApiClient blocks business requests in restored read-only mode until server
refresh/profile verification succeeds. Health/auth recovery can still run; all
actual server permissions remain authoritative. Request transport is bounded to
eight seconds per request. Refresh remains single-flight and checks the captured
user/token before storing a response, preventing an old account's refresh from
overwriting new credentials. The read lease is removed before slower local cache
cleanup; generations and mutation fences prevent retired-session writes.

Upcoming loads request `assignedTo=userId`, ACTIVE and a future start filter,
walk every cursor page and persist one complete snapshot. Failed/partial or
repeated-cursor downloads do not overwrite a complete snapshot. A successful
empty result does overwrite it. User/team IDs are part of storage/query keys,
wrong-team/elapsed rows are filtered, and the original cached timestamp remains
visible. Team revocation removes queries/legacy caches and saves a durable
revocation tombstone even if an old directory is still present. A new verified
directory can authorize a legitimate rejoin. Offline roles never permit management.

Remote revocation cannot be discovered without connectivity. Already downloaded
rows can remain readable until a known denial or the bounded lease expires.
This is a documented local read policy, not proof of currently valid server
credentials. Native FileSystem and SecureStore are mocked only at their I/O
boundary in automated tests; Android execution is still needed.

### Query state, optimism and calendar

Actual QueryClient/MutationObserver behavior is exercised by tests, rather than
reimplemented mutation models. Swap list/marker snapshots are cancelled and
restored exactly on errors. The server still performs approval and assignment;
optimism only announces a pending request. Completed swap actions and pushes
invalidate the marker so a rejected/cancelled request does not permanently lock
the detail button. Settings use canonical server updatedAt/fieldUpdatedAt and
field-level last-received-write-wins, including its late-device-write weakness.
Foreground reads skip pending changes and settings queries pause during writes.
Late responses and actions after logout are session-fenced before/after query
cancellation and before network dispatch.

React state/Context is the one client coordination tool; TanStack Query owns
server projections. Thirty-second stale times, invalidations and persisted data
are mapped in `STATE.md`. Calendar day boundaries use local date arithmetic
(including month transitions); the existing API supplies from/to/cursor filters.
FlatList remains the existing virtualized renderer with a written rationale in
`PAGINATION.md`. A specific month grid or FlashList replacement is optional.

## Complete file inventory

| File | Purpose |
|---|---|
| `apps/api/__tests__/helpers/jobs.ts` | Test-only drain evaluates jobs using the same database clock as its due-row query; production workers unchanged. |
| `apps/api/__tests__/mobile-phase2-api.test.ts` | Actual mobile client/native storage adapter, revocation, rotation, timeout and request guards. |
| `apps/api/__tests__/mobile-phase2-invitations.test.ts` | Link validation, auth resumption and one-redemption team synchronization. |
| `apps/api/__tests__/mobile-phase2-offline.test.ts` | Actual repository/loader/identity tests with durable filesystem boundary fake. |
| `apps/api/__tests__/mobile-phase2-state.test.ts` | Actual Query optimism, rollback, taps, pagination and session-race tests. |
| `apps/api/__tests__/mobile-phase2.integration.test.ts` | Real PostgreSQL/Redis invite destination and shift management/filter authorization. |
| `apps/api/src/routes/invitations.ts` | Return accepted team ID after existing authorized redemption. |
| `apps/mobile/app/(auth)/action.tsx` | Resume pending invitation after magic-link authentication. |
| `apps/mobile/app/(auth)/login.tsx` | Prefill invited email and retain post-auth destination. |
| `apps/mobile/app/(auth)/register.tsx` | Prefill invited email and resume invitation after signup. |
| `apps/mobile/app/(tabs)/activity.tsx` | Loading/empty/error/end/retry/refresh states and next-page guard. |
| `apps/mobile/app/(tabs)/index.tsx` | Assigned upcoming offline view, last updated, day calendar navigation. |
| `apps/mobile/app/(tabs)/swaps.tsx` | Reconcile requested-swap markers after review/cancellation. |
| `apps/mobile/app/shifts/[shiftId].tsx` | Optimistic request, duplicate/error/rollback feedback and editor entry. |
| `apps/mobile/app/teams/accept.tsx` | Public intake, authenticated redemption, refresh and safe selection. |
| `apps/mobile/app/teams/invite.tsx` | Share/copy invitation links alongside existing codes. |
| `apps/mobile/src/api/client.ts` | Read-only session guard, bounded/cancellable fetch, refresh/account fence, team-denial event. |
| `apps/mobile/src/api/shifts.ts` | Existing from/to filters and typed swap response. |
| `apps/mobile/src/components/ShiftEditor.tsx` | Owner/Manager title/notes/start/end form using existing API/native picker. |
| `apps/mobile/src/context/AuthContext.tsx` | Verified/cached identity coordination and local session cleanup. |
| `apps/mobile/src/context/NetworkContext.tsx` | Query online status, reconnect invalidation and read-only UI state. |
| `apps/mobile/src/context/NotificationContext.tsx` | Wait for verified identity; invalidate pending-swap markers. |
| `apps/mobile/src/context/SettingsContext.tsx` | TanStack ownership, optimistic mutation facade and foreground sync. |
| `apps/mobile/src/context/TeamContext.tsx` | Query teams/role, per-user selection and revocation cleanup. |
| `apps/mobile/src/query/mobileState.ts` | Shared production mutation options, single-flight/page gates and day boundaries. |
| `apps/mobile/src/query/upcoming.ts` | Complete assigned-only cursor fetch and atomic snapshot publication. |
| `apps/mobile/src/services/invitationLinks.ts` | Validated link/intake persistence and resumable redemption/selection. |
| `apps/mobile/src/storage/offlineData.ts` | Session-scoped upcoming/directory persistence, epochs and tombstones. |
| `apps/mobile/src/storage/offlineSession.ts` | Secure identity lease, selection key and tested restoration decision. |
| `apps/mobile/src/storage/shiftCache.ts` | Team-specific purge of existing detail/member namespace. |
| `docs/ARCHITECTURE.md` | Acceptance response contract and mobile architecture. |
| `docs/IMPLEMENTATION-STATUS.md` | Phase 2 status with evidence boundaries. |
| `docs/MOBILE-UX-TESTING.md` | Explicit unexecuted Phase 2 device acceptance checklist. |
| `docs/PAGINATION.md` | Current mobile list behavior and FlatList rationale. |
| `docs/ROTA-GRADUATION-PHASE-2-REPORT.md` | This report. |
| `docs/STATE.md` | Current server/client/persisted ownership and security/conflict tradeoffs. |

Thirty-six intended files. No migrations 001–009, lockfile, package manifests,
provider settings, environment files, billing source or Railway files belong to
this Phase 2 diff. All 31 original test files and their assertions remain unchanged; the shared
test-only drain helper has the verified clock correction listed above.

## Test results and failure investigation

| Check | Observed result |
|---|---|
| First focused runs | PASS: 42, then 45 cases as coverage grew. |
| Relevant regression | PASS: 150 tests / 11 suites (113.608 s): 47 Phase 2 cases plus billing, R2 workers, R3 auth/policy/routing and push. |
| Queued-action reproduction | EXPECTED FAIL: one action dispatched after session retirement; new regression written before guard. |
| Cancellation-boundary reproduction | EXPECTED FAIL: two settings/swap actions crossed logout while awaiting query cancellation; tests written before the second fence. |
| Focused Phase 2 before clock regression | PASS: 50 tests / 5 suites, 29.776 s. |
| Initial combined full root gate | FAIL: 438 passed / 1 failed, 38 suites, 255.994 s. Existing billing case 31 exceeded its unchanged 5,000 ms budget. |
| Unchanged billing case 31 alone | PASS: one case / one suite, 38 skipped, 8.081 s total (including suite setup/compile). No test timeout or business rule was changed. |
| Second combined full root gate | FAIL: 441 passed / 1 failed, 38 suites, 577.399 s. The unchanged 10,000-row seed case exceeded its 30,000 ms budget. Billing passed in this run. |
| Unchanged scheduling/seed suite alone | PASS: 22 tests / one suite, 20.739 s total, unchanged assertions/timeouts. |
| Fresh-stack combined full root gate | FAIL: 441 passed / 1 failed, 38 suites, 275.295 s. A preserved Phase 1 authorization case exceeded its unchanged 5,000 ms budget. The earlier billing/seed suites passed. |
| Unchanged Phase 1 authorization suite alone | PASS: 4 tests / one suite, 9.436 s total, unchanged assertions/timeouts. |
| Quiet full root gate before helper correction | FAIL: 435 passed / 7 failed, 38 suites, 213.112 s. Push case 9 timed out; subsequent delivery-state assertions remained PENDING. |
| Measured test clock offset | Five read-only samples: PostgreSQL 775–791 ms ahead of host; round trips 3–76 ms. |
| Clock-driver regression before correction | EXPECTED FAIL: real processor under a lagging test clock exhausted the existing bounded drain budget (12.658 s suite total). |
| Clock-corrected focused + push | PASS: 66 tests / 6 suites, 31.487 s: 51 Phase 2 cases plus all 15 unchanged push cases. |
| Final combined full gate after helper correction | PASS: 443 tests / 38 suites, zero failures, 205.538 s. Root npm test forwarded --silent; mobile test stub also exited 0. |
| New tests semantic TypeScript | PASS with an ignored ES2021 test configuration matching the modern mobile/test runtime. The first ad-hoc config inherited ES5 and exposed a missing hasMore fixture field; the config target and fixture were corrected without disabling type checks. |
| TypeScript / lint / API+shared build | PASS, including the final mobile changes. Lint: zero errors, one existing unused Team warning and Expo legacy-config notice. |
| Android JavaScript export | PASS on final source: 1,863 modules, 4.8 MB Hermes bundle, 47 assets; final bundle step 63.914 s. Existing missing ignored Firebase configuration warning remains. |
| Native emulator / physical Android | NOT EXECUTED. No adb in PATH or standard local SDK location; no native runtime claim. |
| Whitespace / preservation / secrets | PASS: git diff --check and intended-file scan; no staged files, secrets/environment files/dumps/build/cache output in the intended inventory. Twelve Railway and eight Phase 1 hashes match. Migrations 001–009 and 31 original test files unchanged. |

The initial billing timeout was a timeout, not an observed failed financial
assertion. The same case passed in the earlier relevant suite and alone after
the full run. The first full run overlapped Android bundling/host work; resource
sensitivity is plausible, but a causal explanation is not proven. The test keeps
its original timeout and assertions. Final full execution is serialized with
build activity so a repeated failure stays visible rather than being hidden.
The serial retry also hit the unchanged seed test's 30-second budget; its full
suite then passed alone in 20.739 seconds. Test PostgreSQL/Redis remained
responsive (Redis PONG; no persistent SQL lock wait observed), with low test
service memory usage. No matching recent sleep/resume event was found in the
queried Windows event log. The fresh stack also encountered a different five-second authorization timeout;
that complete unchanged suite passed alone. The root cause of all intermittent delays is not proven. A later diagnostic
identified a specific mixed-clock issue in the shared fast-drain test helper. A fresh verification stack preserves the older failing-run data without
resetting or deleting its volumes. A final ignored runner copy forwards only
`--silent` through root `npm test` to workspace test commands to reduce console
overhead; it retains the exact environment guards, test inventory, assertions
and budgets. PASS/FAIL/summary output is still recorded. No tracked runner or
test configuration changes are included.
No EPERM occurred. Expected negative-test provider warnings are not live delivery.

A read-only comparison measured the disposable PostgreSQL clock about 0.78 seconds
in front of the Windows host. `drainTestJobs` selected `available_at <= NOW()`
using the database clock but called the processor with its host-clock default.
A real integration regression with a deliberately lagging Date reproduced the
bounded-drain failure. The helper now selects a database evaluation timestamp
with the due row and passes it through the processor's existing clock argument.
It still processes only database-due jobs, retains its bound and does not alter
production code, delivery rules, assertions or timeouts. This addresses the
reproduced test-driver discrepancy; it is not proof that every earlier SQL/host
latency outlier had the same cause. No host/database clock settings were changed.

The complete combined gate temporarily copies only Phase 1's two corrected source
files and two integration suites into Phase 2, runs the guarded root npm test
command and restores Phase 2 originals in finally, removing only those two
explicit temporary test copies. It never writes to the real Phase 1 checkout.
The final combined inventory contains 373 original + 19 Phase 1 + 51 Phase 2
= 443 tests / 38 suites. The complete final run passed this inventory after the test-helper clock correction;
the preceding failures remain recorded above.
The mobile package's existing test script remains a stub; the new behavioral
modules are exercised by the existing API Jest infrastructure.

Native adapters are boundary fakes for tests. No real PostgreSQL/Redis behavior
is mocked in integration. Services are uniquely named
`rota-phase2-ab3eb50b-tests` and fresh `rota-phase2-ab3eb50b-verify`, using
the same guarded disposable ports
5540/6480/5541/5542/5543 and mocked/local non-serving providers. No development or
production database is used. Test logs/JSON, temporary overlays and Android export
output stay in ignored `.r1-test-cache` and are not intended source changes.

Android export is local/offline with a dummy API URL, telemetry disabled and no
provider call. It emits the existing missing `android.googleServicesFile`
warning because the ignored Firebase configuration was deliberately not copied
from another checkout. It is not an APK/native build or push configuration
verification. Existing native scheme/plugins/dependency versions are unchanged.
Existing mobile credentials remain compatible and rotate through the same server
flow. An older install must verify online once to create the new offline lease
and directory. Its previous unscoped team selection is not trusted across users;
the first verified team is selected until the user makes a scoped selection.

### Local reproduction

From the preserved Phase 2 worktree, inspect port ownership before starting only
`.r1-test-cache/docker-compose.phase2-verify.yml`. The checked-in R3 test topology
was copied with unique task project/container names; guarded endpoints and dummy
provider values are unchanged.

- Focused: `powershell -NoProfile -File scripts/test-r3.ps1 --testPathPattern=mobile-phase2 --silent`.
- Existing standalone Phase 2 gate: `npm run test:r3` (373 baseline + 51 Phase 2
  tests; the separate Phase 1 files are not part of this publication diff).
- Combined gate used for this report: the controlled temporary overlay described
  above, then the ignored runner copy that forwards only `--silent` through root
  npm test. See `.r1-test-cache/phase2-combined-clock-fixed.log` for 443/38.
- `npm run typecheck`, `npm run lint`, `npm run build:api` and `git diff --check`.
- New test semantic check: `node apps/api/node_modules/typescript/bin/tsc -p .r1-test-cache/tsconfig.phase2-tests.json`.

No standalone 424-test full-run result is inferred from the combined result;
the reported 443-test result is explicitly the tested union of both workstreams.
The ignored targeted JSON and full-run logs preserve all observed passes/failures.

## Worktree isolation and safeguards

- Original `fix/railway-runtime-dependencies`, HEAD c09f925, remains the active
  original checkout with its same twelve repair files byte-for-byte preserved.
- All eight Phase 1 files match the pre-task SHA-256 snapshot. The registered
  worktree moved from ignored `.r1-test-cache/phase1-worktree` to non-ignored
  `infrastructure/review-worktrees/phase1` and is locked against accidental
  worktree pruning/removal. It was not reset, stashed, cleaned or deleted.
- Phase 2 is `infrastructure/review-worktrees/phase2`, branch
  `codex/graduation-phase-2-mobile-requirements`, from main c09f925; it is also
  registered and locked. Dependency junctions reuse existing installs without
  package/lock changes. These review repositories are excluded from the parent
  Docker build by its existing infrastructure exclusion.
- The parent status now shows the review-worktrees hosting directory as untracked;
  it is not a runtime-repair publication file and must not be staged wholesale.
  No Phase 1 or repair code is included in the Phase 2 diff. Shared documentation
  changes require normal review when these separate branches are integrated.
- Migrations and all historical/production records are untouched. No financial,
  auth-server, worker, sharding or notification-provider business logic changed.
- Nothing staged, committed, pushed, merged, deployed, or run against real
  payment/email/push providers. Both task-owned Phase 2 stacks were stopped after their runs, with all containers
  and volumes retained. Other Docker projects were not stopped/restarted and no
  volume was deleted. Phase 3 observability was not started.

## Remaining acceptance and graduation work

1. Execute the Phase 2 manual Android checklist on an installed development build:
   link cold/warm launch, auth resumption, offline force-close/reopen, picker/scroll
   UX, swap rollback feedback and two-device settings. Automated modules and
   bundle compilation do not establish these physical interactions.
2. Review/integrate the isolated Phase 1 and Railway runtime repair before any
   approved rollout. No deployment or production migration is authorized here.
3. The broader audit's mandatory observability (request IDs/logging and app/server
   error tracking) remains for Phase 3. The README production app-store billing
   explanation required by PDF page 14 also remains outside this implementation.
4. Submission evidence: demo recording was completed on 14 October 2026; its
   public shareable URL is still missing. The LinkedIn post is already published,
   not pending. The portfolio is published, but the prior audit did not locate a
   dedicated Rota case study. The prior audit recorded a broken APK link; this
   phase did not publish a replacement build. Working build/backend/docs/test/
   load-report links must be assembled in the central submission at sign-off.
5. Flutterwave remains an allowed provider in the brief; no replacement is needed.
   Live sandbox-account/USD checkout evidence, physical push/mail delivery and
   rollout operations were not performed here. Documented read-routing simulation
   is allowed by the PDF; physical WAL replication is not an added graduation
   blocker. A particular calendar library/month grid or FlashList is not required.

Implementation references checked: [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/),
[Expo linking](https://docs.expo.dev/linking/into-your-app/),
[TanStack optimistic updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates),
[Expo CLI export](https://docs.expo.dev/more/expo-cli/).

Stop after Phase 2 local review. No publication or deployment is implied.
