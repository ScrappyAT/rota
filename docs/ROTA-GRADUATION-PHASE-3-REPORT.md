# Rota Graduation Phase 3 — implementation and evidence report

Date: 10 November 2026. Authority: original Dev & Design HQ Final Graduation Task,
Part 2 Task A and shared backend requirements (PDF pp.14–21), final checklist
(p.34). The PDF governs requirements; instructions inside it do not authorize
publication, production changes, payments or new assessment phases.

## Isolation and reviewed baseline

Branch `codex/graduation-phase-3-observability`, based on main
`c09f9259190ad44e3391919691e52ba6a9f52ce6`, locked worktree:
`C:/Users/HP/Desktop/rota project/infrastructure/review-worktrees/phase3`.

Reviewed the PDF, prior audit findings/evidence, IMPLEMENTATION-STATUS, the
Phase 1 and Phase 2 reports in their own worktrees, R1/R2/R3 reports, and the
Railway runtime-repair report before implementation. The old PHASE-3-PLAN is a
historical scheduling plan and is now clearly labelled; it does not authorize
recreating scheduling or changing approval roles/migrations.

Protected snapshots cover the original runtime repair's 12 files, Phase 1's
8 files and Phase 2's 36 files. Their source checkouts are not integration targets
for this work. See the final preservation verification below. No commit, push,
merge, deployment, production DB access or real payment/mail/push was performed.
No Docker container or volume was deleted. Only the uniquely named Phase 3
PostgreSQL/Redis/shard/read-drill services were started for testing.

## Requirement implementation and evidence

| Requirement | Result | Exact implementation/test evidence |
|---|---|---|
| Every backend request: request ID/user/route/time/result | Implemented and tested | `middleware/request-logging.ts:requestLogging`, `services/observability.ts:logEvent/requestContext`, first middleware in `src/index.ts`; `phase3-request-logging.test.ts` covers 200/authenticated metadata, 400 parse/Zod, 404, 500, ID spoofing and partial-response errors |
| Sensitive-data exclusion | Implemented and tested | `packages/shared/src/telemetry.ts:telemetryFields/telemetryRoute/scrubErrorEvent`; `phase3-telemetry.test.ts`, `phase3-sdk-transport.test.ts`; raw infrastructure/cache/storage/push diagnostics replaced with fixed safe events |
| Observable background attempts | Implemented and tested | `services/job-runtime.ts:processOutboxJob/dispatchOutbox/startJobWorker`, `outbox.ts:enqueueOutbox`, `worker.ts:runWorker`; `phase3-jobs.integration.test.ts` uses real PostgreSQL/Redis/BullMQ for completion/replay/retry/dead/deferral/rollback |
| App and server error tracking | Implemented; local adapter/envelope tests passed; live delivery not tested | `services/error-tracking.ts:initializeErrorTracking/serverErrorTrackingOptions/captureFailure/installFatalErrorHandlers`; mobile `services/errorTracking.ts`, `app/_layout.tsx:ErrorBoundary`; API 5xx/client correlation; mocked SDK, real server SDK memory transport and fatal child-process tests |
| Graceful missing/failed telemetry | Implemented and tested | Optional validated HTTPS DSNs; no native instrumentation loaded with absent mobile configuration; SDK/sink failure tests; expected offline fetch failures remain local |
| Required docs/production billing explanation | Completed locally | README, ARCHITECTURE diagram, SECURITY threat table, SHARDING, LEARNING-LOG, OBSERVABILITY, DEPLOYMENT, PAGINATION, load reports, SUBMISSION and repo case-study draft |
| Pagination/index/10k evidence | Existing implementation and historical plan evidence preserved; regressions rerun | `src/pagination.ts:encodeCursor/decodeCursor/page/parseLimit`, routes activity/shifts/swaps; migration003 composite indexes; large-dataset/cache/phase3 tests. No new EXPLAIN run claimed |
| Sharding/read routing | Preserved and regression tested as simulations | `sharding/router.ts:getShardId`, poolManager/coordinator/migration; 11 sharding tests; `services/read-routing.ts:routedRead/needsPrimary`; R3 lag/fallback tests. Physical WAL replication is not configured/proven |
| 200-VU before/after cache evidence | Existing scripts/reports reviewed; no new load run | `load-tests/activity-200vu.js`, `load-tests/REPORT.md`, `docs/PERFORMANCE-REPORT.md`. p95 1271.55→710.95ms, p99 1530→1020ms; zero HTTP errors; both runs miss harness p95<500/p99<1000 thresholds |
| Financial/security evidence | Existing controls preserved; mocked-provider regressions rerun | R1 financialCalculations, flutterwavePrecision, billing/billing.integration; R2 jobs and R3 auth/policy/routing; combined Phase 1 boundary/authorization and Phase 2 tests specified below |

Paths in the table are relative to `apps/api/src` or `apps/api/__tests__` unless
prefixed with packages/apps/docs/load-tests. They refer to this worktree's code;
Phase 1/2 corrections are included only in the temporary combined snapshot.

## Architecture and behavior boundaries

Request IDs are generated on the server (caller IDs ignored) and exposed by CORS.
One finish/abort event logs the post-auth user UUID when available, normalized
route/method, monotonic duration, status and status-based outcome. A success
HTTP status is not a financial-settlement claim. Bodies/headers/query values,
raw errors/SQL, provider payloads, emails, cache keys and token fragments are
never deliberately passed to the new sinks. Partial-response errors forwarded
to Express contain fixed text so its default handler cannot print the original.

Outbox logs correlate requestId to jobId but explicitly say uncommitted; rollback
can remove the row. No request metadata was added to job payloads or dedupe keys.
Durable attempt logs include type/attempt/duration/retry/dead/deferred/skipped;
BullMQ attempt logs separately cover pre-claim/DB connection failures. Existing
PostgreSQL job_attempts persists interrupted/completed/failed state. Dispatch
failure logs check returned update rows, so a concurrent completion is not
falsely reported as a newly dead job. SQL changes add observation-only RETURNING,
not new state transitions or retry rules.

Sentry Node 11.11.0 and Expo-recommended React Native 7.11.0 are new production
dependencies. Existing locked package versions were unchanged. Server default
automatic integrations/data collection are disabled; mobile enables only explicit
JS error handling plus root/Router render boundaries. The shared beforeSend
allowlist rebuilds events with fixed text and safe tags; attachment-bearing
events are dropped. No arbitrary stacks/locals/source, breadcrumbs, screenshots,
replays, native transport, SDK console logs, source-map upload or performance
tracing is enabled. Fatal server handlers preserve exit-on-failure with bounded
best-effort flush rather than recovery. SDK failures never settle/retry payments.

Trade-off: stack-level diagnostics and native crash coverage are intentionally
limited. Safe UUIDs/route/job type + controlled reproduction support diagnosis;
live Sentry ingestion, log retention/search and alert operation remain unverified.
See OBSERVABILITY.md for the exact schema and read-only payment tracing procedure.

## Database and protected behavior

No migration was added or edited; 001–009 have no Git diff and canonical SQL matches main. Windows checkouts have existing CRLF/LF differences across worktrees; no migration line endings were rewritten. No billing formula,
authentication/authorization decision, sharding key, durable claim/replay fence,
payment initialization rule or provider endpoint changed. USD and historical
NGN records are not converted; immutable ledger and session data are untouched.
Test SQL runs only on fresh disposable infrastructure, never production or the
ordinary development database. Existing Docker volumes were retained.

## Verification

| Check | Observed result |
|---|---|
| First targeted observability run | 30/30 tests, 4 suites, 15.923s |
| Intermediate full Phase3/base run | 404/404, 36 suites, 101.863s (before adding the final fatal/partial-response/attachment cases) |
| First successful combined snapshot | 476/476, 44 suites, 110.263s |
| **Final combined snapshot** | **478/478, 44 suites, 96.367s**; no failures/skips |
| Restored Phase3-only targeted run | **35/35 new tests, 6 suites, 8.445s** using the final named-stack safety guard |
| Shared/API builds | Passed in final combined snapshot and again after restoration |
| Root TypeScript | Passed combined and restored Phase3 tree |
| Semantic checking of new test files | Passed with a separate ignored ES2021 test config (Jest transpilation alone is not a typecheck) |
| Root lint | Passed, 0 errors. Restored tree: one pre-existing shared/types.ts unused Team warning. Combined: that warning plus one unused catch variable in temporary composed mobile client |
| Android JavaScript export | Passed for combined source: 3,314 modules, 8.2MB Hermes bundle, 47 assets, 74.655s bundle step; no native build/device run |
| Diff and intended paths | git diff --check passed; new files checked for whitespace; no staged files, real env files, dumps, build/cache/test-output artifacts or detected private-key/token patterns among intended paths |
| Preservation | SHA256: runtime12/12, Phase1 8/8, Phase2 36/36 unchanged; migrations001–009 have no Git diff and canonical SQL matches main |

The combined snapshot includes the original **373 R1/R2/R3 tests**, **19 Phase1**
billing/authorization cases, **51 Phase2** extracted-mobile/API cases, and **35
Phase3** cases: 373+19+51+35=478. It runs the full root workspace gate; the mobile
workspace test script still prints a stub, so these are API-hosted suites with
native adapters mocked, not 478 physical mobile tests.

Composition copied only Phase1/2 source/tests into Phase3 temporarily, kept the
Phase2 DB-clock drain helper, and composed Phase3 diagnostics into overlapping
mobile client/NotificationContext/shiftCache files. No assertions were removed,
timeout budgets widened, or tests excluded. Jest was serial; --silent suppressed
routine log noise only. A finally block restored every overlaid Phase3 file;
no preserved worktree was written. The runtime repair's image/container files
were **not** part of this source regression snapshot; its prior Docker results
remain historical, and a new integrated final-image smoke is still required.

Isolated services: project rota-phase3-observability-tests, containers
rota-phase3-obs-postgres/redis/shard-0/shard-1/replica on
5540/6480/5541/5542/5543. Provider URLs were localhost port9, credentials dummy,
DSNs/upload token empty; the real SDK test used an in-memory transport.
All five containers were stopped and retained after testing; no container,
network or volume was deleted. The same eleven other-project containers remained
running. No normal development/production database was used.

Failures investigated and resolved: initial SDK typechecks rejected obsolete
Node11/mobile7 option names; installed types supplied the correct dataCollection
and privacy callbacks. A first combined lint run rejected the synchronous
optional native require; a documented one-line Metro-specific exception fixed
it. An added Docker ownership guard initially failed because Windows PowerShell
stripped Go-template quotes; it failed **before migration/test access**, then a
JSON-based inspect guard passed the final 35-test run. The guard remains enabled.
No EPERM test/process problem recurred. No final automated failure remains.

Warnings/limits: legacy Expo lint configuration and NO_COLOR/FORCE_COLOR notices
were emitted. The JS bundle is larger than Phase2's historical 4.8MB (now 8.2MB);
startup/memory/scroll effects require physical-device measurement. The export
uses a dummy API address and is not a distributable APK or live-provider check.
No k6 load run, fresh EXPLAIN, real Sentry ingestion, native crash, real payment,
mail or push delivery was performed. The Docker smoke was intentionally not run
because its cleanup would remove containers, prohibited by this phase.


## Dependency/security findings

Read-only `npm audit --omit=dev --json` on both the untouched main lockfile and
the Phase 3 lockfile with today's registry: **15 production entries** each
(5 high, 9 moderate, 1 low; 0 critical). No Sentry-named advisory entry appeared,
and no existing locked package version changed. R3's 20 is a historical result;
the difference is not claimed as five remediations in this phase.

High chains include @expo/cli and expo-router/query-string/decode-uri-component;
Zod3 remains high. Major Expo58/Zod4 upgrades are not forced. Existing byte/depth/
collection caps mitigate Zod exposure but do not eliminate its advisory. Review
compatible Expo toolchain fixes, decode-path exposure and major-upgrade testing
before release. No audit/security check was disabled. Complete details remain
in ignored local audit JSON; no cache/log output is intended for publication.

## Outstanding requirements and risks

1. Review/integrate the four local workstreams. This branch does not silently
   contain the Railway repair or all Phase 1/2 source. Their exact combined
   snapshot demonstrates compatibility, not a merge or released artifact.
2. Production telemetry is not operated yet: no real DSNs, live events, log
   collector/retention, alerts or on-call validation. Hard kills/early module-load
   failures can lose final logs; DB attempt state remains authoritative.
3. Native crash reporting is disabled and no native/device execution was done.
   Source maps/replay are not required additions to this scope; enabling native
   capture later needs its own privacy/device review and build configuration.
4. Re-run the repaired final Docker image smoke after integration, extending
   its dependency inventory to @sentry/node. The existing smoke cleanup deletes
   its own stack, so it was not run under this phase's no-deletion safeguard.
5. Live sandbox USD checkout/account eligibility, mail/push delivery, link
   handling on physical devices and current Railway uptime remain unverified.
   Flutterwave is allowed by the PDF; another provider is not a genuine gap.
6. Old 200-VU/EXPLAIN numbers are retained historical summaries, not fresh runs
   or production performance. Harness latency thresholds were missed. The PDF
   does not impose those local numeric thresholds as a graduation SLA.
7. Submission evidence: APK URL returns 404; demo recording is completed but
   share URL missing; published LinkedIn remains complete; portfolio homepage
   is reachable but contains no Rota reference. A repository draft is supplied,
   not a published portfolio case-study page. Central Rota test total is stale.
8. Redis/DB clocks, pool budgets, proxy trust, encryption-key retention and
   serialized migration operations need rollout review. Independent read DBs
   demonstrate routing behavior, not physical replication or automated failover.

## Integration checklist — no action performed

- [ ] Review runtime repair12, Phase1 8, Phase2 36 and this inventory separately.
- [ ] Integrate runtime packaging first, preserving both root and API private
      node_modules, API-only CMD, PORT8080 and separate release migrations.
- [ ] Integrate Phase1 billing service + primary team-membership read and its tests.
- [ ] Integrate Phase2 invitation teamId response, mobile changes and DB-clock
      test-drain helper. Keep known-revocation/offline and optimistic guards.
- [ ] Integrate Phase3 telemetry/dependencies/docs; compose overlapping mobile
      client/NotificationContext/shiftCache diagnostics without losing Phase2.
- [ ] Reconcile README/ARCHITECTURE/DEPLOYMENT/IMPLEMENTATION-STATUS rather than
      overwriting another workstream's reviewed changes. New dependency lock
      includes both SDKs and must remain consistent with workspace manifests.
- [ ] Re-run the serial combined suite, TS, lint, shared/API builds and final
      image dependency/HTTP smoke; verify migration001–009 and protected history.
- [ ] Obtain explicit approval before commit, push, merge or deployment. Recheck
      Railway production autodeploy/PR-environment settings before publication.

## Deployment checklist — separately authorized future work

- [ ] Back up intended DB; review/serialize any pending migration001–009 release
      job. Phase3 adds none; never run migrations on every API start.
- [ ] Configure API PORT8080/public target8080 and health check; run a separate
      BullMQ worker with matching primary DB, Redis, queue and AUTH_MAIL_KEY.
      Worker service must not use API HTTP health checks.
- [ ] Set bounded connection budgets, Redis AOF/noeviction, clock synchronization,
      trusted proxy/CORS, stable mail encryption key and verified provider config.
- [ ] Use staging/sandbox credentials only until production operations are
      separately approved; never automatically reinitialize ambiguous payments.
- [ ] Decide store distribution/billing eligibility using README's Rota/Matinee
      section; test-mode Flutterwave does not establish store compliance.
- [ ] Configure optional approved DSNs, least-privilege log/Sentry access,
      retention, budgets and alerts. Verify a synthetic sanitized staging event
      and request→outbox→attempt trace without customer credentials.
- [ ] Prove API + worker health and rollback procedure; do not treat these local
      checks as a deployment or successful external delivery.

## Physical Android checklist — not executed in this phase

- [ ] Build/install the integrated revision for physical Android; adding the
      Sentry native package may require a fresh development build despite native
      capture being disabled. Supply Firebase/EAS config through approved means.
- [ ] Verify normal login, refresh/logout-all, reset/magic links and invitation
      cold/warm launch, including auth resumption and correct team selection.
- [ ] Check calendar navigation/editing, paginated lists, loading/empty/error,
      scroll behavior, optimistic settings/swaps and rollback on denied/failing API.
- [ ] Verify offline force-close/reopen using a valid cached read lease, last
      updated labels, no protected API writes, user/team isolation and revocation.
- [ ] Verify two-device server settings, foreground refresh, IANA zone/quiet
      hours suppression/deferred delivery and correct notification team/deep link.
- [ ] With separate authorization, verify sanitized JS error reporting enabled
      and absent/malformed DSN operation; no raw credentials or native crash claim.
- [ ] Test sandbox checkout return/reconciliation/double submission without real
      charges and actual mail/push only under separately approved acceptance.

## Final submission checklist

- [ ] Working Android download and reachable approved backend endpoint.
- [ ] Public source/docs/diagram, final regression and load-test report links.
- [ ] Insert the existing 14 October recorded demo's public share URL and check
      access/required flow coverage; do not mark the recording as unrecorded.
- [x] LinkedIn post published: https://lnkd.in/p/edPwxhTV (redirect HTTP200 checked).
- [ ] Publish/link a dedicated Rota portfolio case study; repo draft is provided.
- [ ] Update Rota evidence in the central SUBMISSION.md, preserving completed
      posts/demos and other assessment parts. Validate links without sign-in.

## Complete intended file inventory

56 intended files (actual content additions/changes; ignored verification artifacts excluded).

- `.env.example`
- `AGENTS.md`
- `README.md`
- `apps/api/__tests__/phase3-error-tracking.test.ts`
- `apps/api/__tests__/phase3-fatal-errors.test.ts`
- `apps/api/__tests__/phase3-jobs.integration.test.ts`
- `apps/api/__tests__/phase3-request-logging.test.ts`
- `apps/api/__tests__/phase3-sdk-transport.test.ts`
- `apps/api/__tests__/phase3-telemetry.test.ts`
- `apps/api/package.json`
- `apps/api/src/cors.ts`
- `apps/api/src/db.ts`
- `apps/api/src/env.ts`
- `apps/api/src/error-handler.ts`
- `apps/api/src/index.ts`
- `apps/api/src/middleware/request-logging.ts`
- `apps/api/src/migrate.ts`
- `apps/api/src/redis.ts`
- `apps/api/src/services/cache.ts`
- `apps/api/src/services/error-tracking.ts`
- `apps/api/src/services/job-runtime.ts`
- `apps/api/src/services/notifications.ts`
- `apps/api/src/services/observability.ts`
- `apps/api/src/services/outbox.ts`
- `apps/api/src/sharding/poolManager.ts`
- `apps/api/src/worker.ts`
- `apps/mobile/app/_layout.tsx`
- `apps/mobile/package.json`
- `apps/mobile/src/api/client.ts`
- `apps/mobile/src/context/NotificationContext.tsx`
- `apps/mobile/src/services/errorTracking.ts`
- `apps/mobile/src/services/pushNotifications.ts`
- `apps/mobile/src/storage/asyncStorage.ts`
- `apps/mobile/src/storage/authStorage.ts`
- `apps/mobile/src/storage/shiftCache.ts`
- `apps/mobile/src/utils/clipboard.ts`
- `docs/ARCHITECTURE.md`
- `docs/DEPLOYMENT.md`
- `docs/IMPLEMENTATION-STATUS.md`
- `docs/LEARNING-LOG.md`
- `docs/OBSERVABILITY.md`
- `docs/PAGINATION.md`
- `docs/PERFORMANCE-REPORT.md`
- `docs/PHASE-3-PLAN.md`
- `docs/ROTA-CASE-STUDY.md`
- `docs/ROTA-GRADUATION-PHASE-3-REPORT.md`
- `docs/SECURITY.md`
- `docs/SHARDING.md`
- `docs/SUBMISSION.md`
- `infrastructure/docker-compose.phase3-tests.yml`
- `load-tests/REPORT.md`
- `package-lock.json`
- `package.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/telemetry.ts`
- `scripts/test-phase3.ps1`

Stop after local review. No commits, pushes, merges, deployments, production
migrations or real provider operations are part of this report.
