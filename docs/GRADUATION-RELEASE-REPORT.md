# Rota — final graduation release and submission report

November 2026 (Updated 18 November 2026). Scope: deliver the completed work,
reflecting live production deployment, end-to-end Flutterwave sandbox payment
verification, and physical Android mobile acceptance. Original assessment PDF Part 2
Task A / shared backend requirements and final submission checklist remain authoritative.

## Release candidate and production deployment

Branch: `codex/graduation-release-2026-11-10`.
Worktree: `C:/Users/HP/Desktop/rota project/infrastructure/review-worktrees/release-candidate`.
Base: main c09f9259190ad44e3391919691e52ba6a9f52ce6.
Live Railway Deployment: `https://rota-production-84ef.up.railway.app` (combined supervisor).

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

**Build FINISHED** 10 November 2026 at 11:46:41 UTC (12:46:41 WAT).
[Download installable APK](https://expo.dev/artifacts/eas/r197ay-RMlQSdm-zTC_w1I4b_gD85C3_c0NBXPBYi8w.apk)
[Expo build details](https://expo.dev/accounts/scrappy4rls-team/projects/rota/builds/947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf).
Build duration 878.026s; EAS artifact URL retention is 30 days (~10 December 2026).
Physical Android device acceptance testing was completed and confirmed on 18 November 2026.

The APK profile is preview/internal/android.buildType=apk, SDK 57, package
com.scrappy4rlsteam.rota, version 1.0.0 / versionCode 1. Firebase client config matches
that package and remains ignored by Git. Existing Expo Android signing credentials
were used; no keystore or provider secret was printed or committed.

Backend embedded in the build is the confirmed production endpoint
https://rota-production-84ef.up.railway.app. Preview Sentry DSN/auth-upload values
are deliberately invalid "disabled" sentinels (EAS rejects empty env values),
SENTRY_DISABLE_AUTO_UPLOAD=1; no preview cloud env variables were found.

Physical Android acceptance testing on 18 November 2026 on a physical Samsung device
confirmed:
1. Authentication: Account login, session persistence in SecureStore, profile fetch.
2. Team Management: Team switcher, member roster, role rendering (Owner / Manager / Staff).
3. Shift Lifecycle: Owner/manager shift creation, staff assignment, real-time update in staff schedule.
4. Shift Swaps: Staff-initiated swap requests, manager-only approval workflow, atomic assignment transfer.
5. Activity History: Keyset cursor-paginated activity feed with pull-to-refresh and infinite scroll.
6. Push & Settings: Notification delivery, server-owned timezone settings, quiet-hours suppression.

## Railway deployment and live verification (18 November 2026)

The Rota backend is deployed and active on Railway:
- Endpoint: `https://rota-production-84ef.up.railway.app`
- Service: `dynamic-tenderness` (production environment)
- Architecture: Single-container combined deployment via `apps/api/src/combined-server.ts` (PR #5), running both Express API (PORT 8080) and BullMQ background worker under active supervision. If either critical child process terminates unexpectedly, the supervisor exits immediately so Railway restarts the container.
- Health Check: `GET https://rota-production-84ef.up.railway.app/health` returns HTTP 200 OK:
  `{"success":true,"data":{"status":"ok","db":"ok","redis":"ok","timestamp":"2026-11-18T..."}}`.
- Database & Redis: Managed PostgreSQL and Redis connections verified healthy.

### End-to-end Flutterwave USD sandbox subscription payment

On 18 November 2026, the full subscription upgrade lifecycle was verified live:
1. Team Mayo selected the Starter subscription plan ($20 USD/month, 5 seats).
2. The client generated an idempotency key and called `POST /teams/:teamId/subscriptions/checkout`.
3. The server claimed payment initialization, recorded a `payment_transactions` intent, and opened the Flutterwave hosted checkout modal.
4. Payment authorization succeeded using the official Flutterwave test card and OTP verification.
5. The payment was settled and reconciled via `reconcilePayment`:
   - Subscription transitioned from FREE to `ACTIVE` on `STARTER_USD_V1`.
   - Subscription history recorded `FREE → STARTER_USD_V1` as `PAID`.
   - The $20 USD invoice was marked `PAID`.
   - The append-only financial ledger recorded the immutable `CHARGE` entry.
6. PR #6 merged essential reconciliation safeguards:
   - Preserves gateway HTTP status codes and classifies errors into sanitized internal categories without leaking credentials.
   - Treats unverified gateway transactions as pending instead of immediately failing.
   - Defers `QUEUED` checkout reconciliation for 5 minutes to allow background initialization to complete.
   - Accurately measures claim age from `updated_at` (claim time) rather than `created_at` (payment creation time) to avoid premature timeout of in-flight checkouts.

## Submission evidence and priority

| Priority / status | Current status / Exact next action |
|---|---|
| P0 backend | **Verified live**: Railway combined container active at `https://rota-production-84ef.up.railway.app`; `/health` returns 200 OK (`db: ok`, `redis: ok`). |
| P0 APK & physical testing | **Verified on device**: Build `947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf` installed; shifts, swaps, activity, notifications, quiet-hours tested on physical Samsung device. (Note EAS 30-day link expiry). |
| P0 billing | **Verified live**: Flutterwave sandbox $20 USD Starter upgrade completed; card + OTP verified; invoice marked PAID; financial ledger updated. |
| P0 demo video | **Recording completed 14 October 2026**; **public shareable URL missing** (awaiting user link). |
| P0 portfolio case study | Draft in `docs/ROTA-CASE-STUDY.md`; portfolio live at `https://samuel-emmanuel-portfolio.vercel.app/`; **dedicated published Rota page URL still needed**. |
| Completed | Existing LinkedIn post `https://lnkd.in/p/edPwxhTV` remains published (HTTP 200 confirmed). |
| Completed | Automated tests: 478 tests / 44 suites passed across API, shared, and mobile logic; Docker supervisor smoke tests passed. |
| Ready | Architecture docs, security docs, sharding simulation docs, load test reports, and central submission updated locally. |

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
- `apps/api/__tests__/combined-server.test.ts`
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
- `apps/api/src/combined-server.ts`
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

## Final release and submission state

Dedicated release branch `codex/graduation-release-2026-11-10` is deployed on Railway
with the combined supervisor running API and BullMQ background worker. Live production
verification confirmed `/health` 200 OK, Flutterwave sandbox USD $20 checkout and
settlement, and physical Android device acceptance across all scheduling and swap flows.
The local central submission file (`final-task-samuel-emmanuel/SUBMISSION.md`) is updated
with matching evidence.

Remaining actions for final graduation submission:
1. Insert publicly shareable URL for the already-recorded 14 October 2026 demo video.
2. Publish dedicated Rota case-study page to portfolio website and insert link.
3. Submit central graduation form.

## Downloaded APK integrity

HTTP 200 download verified; 110,055,035 bytes. APK ZIP contains
AndroidManifest.xml, classes.dex and 100 native shared libraries.
SHA256: `4b5a559f44191286cbf961b1d92b599c610fb45f7b988dbf871291dfc3aaf7d1`.
Local file: `.r1-test-cache/rota-graduation-2026-11-10.apk` (ignored, not committed).
Physical-device execution on a physical Samsung test phone confirmed on 18 November 2026.
Expo's signing step used the existing remote keystore. (Note: EAS artifact URL expires ~10 December 2026).
