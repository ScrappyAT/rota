# Rota — final graduation release and submission report

10 November2026. Scope: deliver the completed work, not a new implementation
phase. Original assessment PDF Part2 TaskA/shared backend requirements and final
submission checklist remain authoritative. No paid Railway change, push,
remote-main merge, deployment or production-data operation is authorized/performed.

## Release candidate

Branch: `codex/graduation-release-2026-11-10`.
Worktree: `C:/Users/HP/Desktop/rota project/infrastructure/review-worktrees/release-candidate`.
Base: main c09f9259190ad44e3391919691e52ba6a9f52ce6.

Integrated permanently into this candidate: Railway runtime repair12 files,
Phase1 8, Phase2 36 and Phase3 56 (counts overlap). Original branches, locked
worktrees and uncommitted changes remain intact, checked by SHA256 manifests.
Migrations001–009 have no Git diff/canonical-content change against main.

Integration decisions:
- Preserve root + API-private production node_modules after pruning. Redis
  resolves from /app/apps/api/node_modules; @sentry/node resolves from root.
- Use Phase1 billing-boundary/ledger-proof and primary-membership fixes; preserve
  R1 USD/legacy NGN data, immutable ledger/revisions/idempotency safeguards.
- Retain all Phase2 mobile/offline/optimistic/invitation changes and its test-only
  DB-clock helper. Compose Phase3 telemetry into api/client, NotificationContext
  and shiftCache; do not replace those files with older single-phase versions.
- Keep Phase3 Sentry dependencies/lockfile and reviewed structured logging, safe
  optional initialization and redaction. All original locked package versions
  remain unchanged except the already-reviewed SDK additions.
- Reconcile architecture/pagination/state/billing/docs and preserve original phase
  reports as historical evidence. The release section in IMPLEMENTATION-STATUS
  is current; older “not integrated” wording in phase reports is historical.
- Add release-only verification scripts/config, not product features. Remove only
  an unused catch binding introduced by composing the two mobile client variants.

## Observed final verification

| Check | Result |
|---|---|
| Root shared/API build | Passed |
| Root TypeScript | Passed |
| Root lint | Passed: zero errors, one pre-existing shared/types.ts unused Team warning; Expo legacy-config notice |
| Full integrated root regression | **478/478 tests across44 suites**,136.167s; 373 original +19 Phase1 +51 Phase2 +35 Phase3 |
| Production Docker build | Passed; local image rota-graduation-release:2026-11-10 |
| Final runtime dependency smoke | Passed19 checks: all13 API deps including @sentry/node/redis/bullmq/pg/bcrypt, shared Zod, bcrypt native roundtrip, compiled schema/entry points and API/worker imports |
| Peer-container HTTP health | Passed on API port8080; JSON DB and Redis statuses both ok |
| Separate BullMQ worker | Passed harmless BILLING_RECHECK outbox job against cloned disposable DB |
| Startup migration safeguard | API-only CMD, unprivileged node user, PORT8080; migration metadata digest identical before/after API/worker startup; no application migrator invoked |
| Protected histories | Runtime12/Phase1 8/Phase2 36/Phase3 56 hashes unchanged; original branches/worktrees preserved |

Docker image ID:
`sha256:5a117dcb72cd2f915c027a11806ade1b89f239a5d6bd18c0c53040ba0f79e68c`.
Observed image size1,262,769,268 bytes. No registry push occurred.

Earlier release attempt: pending clarification of the no-migration rule, the
four migration-invoking suites were excluded. That partial run passed463/464
across40 suites; one real-worker test exceeded its unchanged5s budget while
image build/install activity was concurrent. The complete approved rerun passed
all478, including the same worker test, without changing its assertion/timeout.
This establishes a passing final run, not proof of a root cause for the timing
failure. No EPERM occurred. Initial EAS metadata checks ran before dependency
installation completed, then failed validation of empty env overrides; both
were corrected before submitting the one APK build. No second build was started.

Migration scope: user explicitly approved **disposable migration-safety tests**.
Those existing tests execute old SQL only in temporary test DBs. The release
runner uses retained pre-migrated ports5540/6480/5541/5542/5543 and never invokes
src/migrate.ts on the application/test-primary schema. The Docker smoke clones
rota_r1_test into rota_release_smoke_20261110, quarantines copied pending jobs
only in that clone, and executes one harmless job. No production DB is accessed.

No real payment, mail, push or Sentry ingestion occurs. Dummy values/local port9
providers are enforced; the native Sentry adapter is mocked in API-hosted mobile
tests. The mobile workspace test script is still a stub:478 is not a count of
physical-device tests. Historical k6/EXPLAIN evidence was not rerun here.

Resources: no Docker container/network/volume was deleted. The new dependency,
API, worker and peer smoke containers are retained. Compose emitted an orphan
warning for the intentionally retained peer container; cleanup was not run.
Test-service shutdown is recorded at final sign-off. Original project containers
are not stopped/restarted/deleted.

## Android APK

**Build FINISHED**10 November2026 at11:46:41UTC (12:46:41WAT).
[Download installable APK](https://expo.dev/artifacts/eas/r197ay-RMlQSdm-zTC_w1I4b_gD85C3_c0NBXPBYi8w.apk)
[Expo build details](https://expo.dev/accounts/scrappy4rls-team/projects/rota/builds/947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf).
Build duration878.026s; reported artifact expiry24 November2026. Physical-device
execution was not performed. Local download/checksum verification is recorded
at final sign-off below. This replaces the expired previous artifact link.

The APK profile is preview/internal/android.buildType=apk, SDK57, package
com.scrappy4rlsteam.rota, version1.0.0/versionCode1. Firebase client config matches
that package and remains ignored by Git. Existing Expo Android signing credentials
were found and used; no keystore or provider secret was printed or committed.
No local Android SDK/Java/adb was found on PATH, so the requested native APK is
built by the existing Expo project, not claimed from a JavaScript export.

Backend embedded in the build is the user-confirmed
https://rota-production-84ef.up.railway.app. Preview Sentry DSN/auth-upload values
are deliberately invalid “disabled” sentinels (EAS rejects empty env values),
SENTRY_DISABLE_AUTO_UPLOAD=1; no preview cloud env variables were found. No
source-map upload/native crash reporting/real provider test is performed.
Build archives exclude node_modules, real env files and local verification
caches; Firebase client config is deliberately included only for the build.

EAS's Git metadata names base c09f925 because upload occurred before a local
integration commit. The build uses the **uncommitted integrated source archive**,
not published main. Fingerprint7b72d421cf7f99912ba99b0f951aa912686209fd and the
215-file local source snapshot track its provenance; source hashes are rechecked
before final sign-off. A local integration commit does not retroactively change
that metadata. APK success does not establish startup, navigation, push, payment,
deep-link, settings or offline behavior on a physical phone.

## Railway preparation — no live changes

User confirms intended URL and email stating trial expiry **11 November2026**;
exact remaining credit is unknown. Public /health returned **HTTP404**, so the
backend is not reported healthy/deployed. Browser inspection was blocked by the
computer-use URL safety check; no settings/secret values were read or changed.
The user cannot yet confirm separate API/worker services exist.

Prepared locally:
- Root Dockerfile: locked workspaces, both dependency locations, API-only CMD,
  unprivileged runtime, PORT8080. API config railway.json: /health,180s, OnFailure10.
- New railway.worker.json: same Dockerfile, explicit worker command, no Railway
  HTTP healthcheck path. A worker still needs an actual approved service and
  its own config-file path selected in Railway.
- Full controlled procedure and exact dashboard checklist in DEPLOYMENT.md.

**Dashboard details still needed from the user before deployment:**
1. Project/environment IDs, remaining dollar allowance, exact trial expiry/time,
   service/resource limits and behavior after expiry; no upgrade/paid change.
2. API and worker service existence; connected repo/branch/revision, autodeploy
   and automatic PR environments, root directories and config-file paths.
3. API start command, PORT/public target8080, domain mapping, /health timeout,
   restart policy. Worker command and absence of HTTP health checks.
4. Database/Redis private connectivity, persistent storage/backups, connection
   budgets and Redis AOF/noeviction; optional read endpoint distinct from shards.
5. Required variable names/presence only: NODE_ENV, DATABASE_URL, REDIS_URL,
   JWT_SECRET, CORS_ORIGIN, sandbox FLW settings, stable AUTH_MAIL_KEY,
   MAIL_FROM/MAIL_API_URL/MAIL_API_KEY, matching JOB_QUEUE_NAME; optional SENTRY_DSN.
   Never paste secret values into chat or build configuration.
6. Current001–009 migration metadata, deployment/runtime logs, absence of an
   automatic pre-deploy/startup migrator and a successful public health JSON.

Migration procedure: inspect metadata read-only and back up first. If001–009
already applied, no migration is necessary for these corrections. If missing,
obtain explicit approval for exact pending files and use one serialized manual
release job before API/worker startup; never multiple runners or normal boot
migrations. No historical financial/auth/outbox records may be reset/reseeded.

After an approved deployment verify health **body** DB/Redis values, not only
HTTP200; the existing health endpoint can return200 with an error status body.
Worker processing and delivery need their own evidence. Trial expiry threatens
public grading access even if a deployment succeeds today; no availability after
11 November is promised, and no paid hosting/upgrade is initiated.

## Submission evidence and priority

| Priority / status | Exact next action |
|---|---|
| P0 user approval | Review this local candidate; authorize Git publication and Railway rollout separately. Nothing was pushed/deployed |
| P0 backend | Verify the dashboard details and remaining allowance; repair/approve API+worker deployment and health today. API404 and trial expiry are genuine availability blockers |
| P0 APK | Use the final APK status/link above; install on physical Android and exercise login, shift/swap flow, links/settings/offline behavior. Build alone is not device verification |
| P0 submission | Supply a publicly shareable URL for the **already-recorded14 October demo**; confirm permissions and required flow coverage. Recording is completed, not pending |
| P0 portfolio | Locate or publish a dedicated Rota case study and supply its URL. Published homepage is reachable but no Rota reference was found; local docs/ROTA-CASE-STUDY.md is ready text, not portfolio publication |
| Ready / publication needed | Rota repository/docs/architecture diagram, load evidence, final478/44 checks and central Rota SUBMISSION.md are updated locally; publish only after approval |
| Completed | Existing LinkedIn post https://lnkd.in/p/edPwxhTV remains published; no replacement post required |
| Not a new blocker | Flutterwave is explicitly allowed; no replacement payment provider is needed |
| Optional / operational hardening | Physical WAL replication, alternate list/calendar libraries, replay/native crash analytics, source-map automation, larger-scale benchmarks or new architecture are not new graduation phases |

Historical load evidence remains load-tests/REPORT.md and PERFORMANCE-REPORT.md:
200 VUs before/after cache, p95 1271.55→710.95ms, p99 1530→1020ms and zero HTTP
errors. Its harness p95<500/p99<1000 thresholds were missed; the PDF asks for the
comparison, not these extra numeric targets. The60-VU report is a separate run.
README contains the production Rota/Matinee app-store billing considerations.

Central submission checkout: C:/Users/HP/Desktop/final-task-samuel-emmanuel.
Only Rota's section and Rota checklist cells are changed; Matinee/Relay/Grounded
and other assessment text are retained. The central file is local/unpublished
and uncommitted. Existing APK404 and published-demo/post distinctions are corrected.
New report/case-study links cannot point to public main until Git publication.
No submission has been sent and no other person's message/post was published.

Remaining unverified: live hosted API/worker topology, post-trial reachability,
physical Android/device flows, sandbox-account USD checkout, actual push/mail,
live telemetry ingestion/alerts. Regressions use mocked providers. Production
advisory baseline remains15 entries (5high/9moderate/1low,0critical) from the
Phase3 same-lockfile review; no forced major upgrade or audit suppression was done.

## Intended release file inventory

107 intended release files, reconciled across overlapping workstreams:

- `.dockerignore`
- `.easignore`
- `.env.example`
- `AGENTS.md`
- `Dockerfile`
- `README.md`
- `apps/api/__tests__/graduation-phase1-authorization.integration.test.ts`
- `apps/api/__tests__/graduation-phase1-billing.integration.test.ts`
- `apps/api/__tests__/helpers/jobs.ts`
- `apps/api/__tests__/mobile-phase2-api.test.ts`
- `apps/api/__tests__/mobile-phase2-invitations.test.ts`
- `apps/api/__tests__/mobile-phase2-offline.test.ts`
- `apps/api/__tests__/mobile-phase2-state.test.ts`
- `apps/api/__tests__/mobile-phase2.integration.test.ts`
- `apps/api/__tests__/phase3-error-tracking.test.ts`
- `apps/api/__tests__/phase3-fatal-errors.test.ts`
- `apps/api/__tests__/phase3-jobs.integration.test.ts`
- `apps/api/__tests__/phase3-request-logging.test.ts`
- `apps/api/__tests__/phase3-sdk-transport.test.ts`
- `apps/api/__tests__/phase3-telemetry.test.ts`
- `apps/api/package.json`
- `apps/api/src/billing/service.ts`
- `apps/api/src/cors.ts`
- `apps/api/src/db.ts`
- `apps/api/src/env.ts`
- `apps/api/src/error-handler.ts`
- `apps/api/src/index.ts`
- `apps/api/src/middleware/request-logging.ts`
- `apps/api/src/migrate.ts`
- `apps/api/src/redis.ts`
- `apps/api/src/routes/invitations.ts`
- `apps/api/src/routes/teams.ts`
- `apps/api/src/services/cache.ts`
- `apps/api/src/services/error-tracking.ts`
- `apps/api/src/services/job-runtime.ts`
- `apps/api/src/services/notifications.ts`
- `apps/api/src/services/observability.ts`
- `apps/api/src/services/outbox.ts`
- `apps/api/src/sharding/poolManager.ts`
- `apps/api/src/worker.ts`
- `apps/mobile/.easignore`
- `apps/mobile/app/(auth)/action.tsx`
- `apps/mobile/app/(auth)/login.tsx`
- `apps/mobile/app/(auth)/register.tsx`
- `apps/mobile/app/(tabs)/activity.tsx`
- `apps/mobile/app/(tabs)/index.tsx`
- `apps/mobile/app/(tabs)/swaps.tsx`
- `apps/mobile/app/_layout.tsx`
- `apps/mobile/app/shifts/[shiftId].tsx`
- `apps/mobile/app/teams/accept.tsx`
- `apps/mobile/app/teams/invite.tsx`
- `apps/mobile/eas.json`
- `apps/mobile/package.json`
- `apps/mobile/src/api/client.ts`
- `apps/mobile/src/api/shifts.ts`
- `apps/mobile/src/components/ShiftEditor.tsx`
- `apps/mobile/src/context/AuthContext.tsx`
- `apps/mobile/src/context/NetworkContext.tsx`
- `apps/mobile/src/context/NotificationContext.tsx`
- `apps/mobile/src/context/SettingsContext.tsx`
- `apps/mobile/src/context/TeamContext.tsx`
- `apps/mobile/src/query/mobileState.ts`
- `apps/mobile/src/query/upcoming.ts`
- `apps/mobile/src/services/errorTracking.ts`
- `apps/mobile/src/services/invitationLinks.ts`
- `apps/mobile/src/services/pushNotifications.ts`
- `apps/mobile/src/storage/asyncStorage.ts`
- `apps/mobile/src/storage/authStorage.ts`
- `apps/mobile/src/storage/offlineData.ts`
- `apps/mobile/src/storage/offlineSession.ts`
- `apps/mobile/src/storage/shiftCache.ts`
- `apps/mobile/src/utils/clipboard.ts`
- `docs/ARCHITECTURE.md`
- `docs/BILLING.md`
- `docs/DEPLOYMENT.md`
- `docs/GRADUATION-RELEASE-REPORT.md`
- `docs/IMPLEMENTATION-STATUS.md`
- `docs/LEARNING-LOG.md`
- `docs/MOBILE-UX-TESTING.md`
- `docs/OBSERVABILITY.md`
- `docs/PAGINATION.md`
- `docs/PERFORMANCE-REPORT.md`
- `docs/PHASE-3-PLAN.md`
- `docs/RAILWAY-RUNTIME-REPAIR-REPORT.md`
- `docs/ROTA-CASE-STUDY.md`
- `docs/ROTA-GRADUATION-PHASE-1-REPORT.md`
- `docs/ROTA-GRADUATION-PHASE-2-REPORT.md`
- `docs/ROTA-GRADUATION-PHASE-3-REPORT.md`
- `docs/SECURITY.md`
- `docs/SHARDING.md`
- `docs/STATE.md`
- `docs/SUBMISSION.md`
- `infrastructure/docker-compose.phase3-tests.yml`
- `infrastructure/docker-compose.release-smoke.yml`
- `infrastructure/docker-compose.runtime-smoke.yml`
- `load-tests/REPORT.md`
- `package-lock.json`
- `package.json`
- `packages/shared/src/index.ts`
- `packages/shared/src/telemetry.ts`
- `railway.worker.json`
- `scripts/runtime-dependencies.cjs`
- `scripts/test-docker-runtime.ps1`
- `scripts/test-phase3.ps1`
- `scripts/test-release-runtime.ps1`
- `scripts/test-release.ps1`
- `scripts/verify-release-test-schema.cjs`

## Final local state

Dedicated local release branch; originals/locked worktrees remain intact.
All test/API/worker smoke services have been stopped and retained, including
containers and volumes. No paid change, registry/Git push, remote-main merge,
Railway deployment, production migration or real provider operation occurred.
The local central submission has only its Rota evidence modified, uncommitted.
A local integration commit may record this reviewed candidate; its hash is
returned with the final delivery. APK download integrity is recorded below.


## Downloaded APK integrity

HTTP200 download verified; 110055035 bytes. APK ZIP contains
AndroidManifest.xml, classes.dex and 100 native shared libraries.
SHA256: `4b5a559f44191286cbf961b1d92b599c610fb45f7b988dbf871291dfc3aaf7d1`.
Local file: `.r1-test-cache/rota-graduation-2026-11-10.apk` (ignored, not committed).
This verifies download/structure, not cryptographic signature validation or
physical-device execution. Expo's signing step used the existing remote keystore.

One final permission review timed out before a read-only build-log inspection
ran. The allowed retry of build status succeeded and confirmed FINISHED. No
Railway action was attempted as a workaround. Browser URL safety also blocked
live dashboard inspection; settings/credit remain explicitly unverified.
