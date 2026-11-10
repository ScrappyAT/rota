# Rota

Rota is a mobile shift-scheduling application for small businesses such as restaurants, clinics, and retail stores.

## Technology Stack

- **Mobile**: Expo, React Native, TypeScript, Expo Router, React Native StyleSheet
- **Backend**: Node.js, Express, TypeScript, Zod, PostgreSQL, Redis
- **Infrastructure**: Docker Compose for local development

## Repository Structure

- `apps/mobile`: Expo mobile application
- `apps/api`: Express backend API
- `packages/shared`: Shared TypeScript types and Zod schemas
- `infrastructure`: Docker Compose file for local services
- `docs`: Architecture and documentation

## Prerequisites

- Node.js 24 LTS (verified locally with 24.16; the server SDK requires a supported Node 20.19+/22.12+/23.2+ release)
- Docker and Docker Compose (for local database and Redis)

## Local Setup

1. Copy `.env.example` to `.env` in the root directory.
2. Run `npm ci` to install dependencies across workspaces.
3. Build shared types: `npm run build:shared`. Start the databases: `npm run db:start`
4. Run migrations: `npm run db:migrate`
5. Start the backend: `npm run dev:api`
6. Start the mobile app: `npm run dev:mobile`
7. In a separate terminal, start background processing: `npm run worker:dev`.
   R2 checkout, verification and notification requests persist work for this worker.

## Available Scripts

- `npm run dev:api`: Starts the API server in development mode.
- `npm run dev:mobile`: Starts the Expo app.
- `npm run build`: Compiles `packages/shared` first, then the API (same order
  the production Docker build uses).
- `npm run db:start`: Starts PostgreSQL and Redis using Docker Compose.
- `npm run db:stop`: Existing script uses Compose down (removes containers). During
  graduation verification use `docker compose -f <test-compose-file> stop` to retain them.
- `npm run db:migrate`: Runs database migrations in the API workspace.
- `npm run db:seed:activity`: Seed the activity feed with 10,000 rows for a
  team. Usage: `npm run db:seed:activity -- --team <team-uuid> [--count 10000]
  [--reset]`. Reruns are idempotent; `--reset` removes only previously seeded
  rows.
- `npm run lint`: Runs ESLint across all workspaces.
- `npm run typecheck`: Runs TypeScript checks across all workspaces.
- `npm run test`: Runs tests across all workspaces. Integration suites mutate their configured database.
- `npm run test:r1`: Runs migrations and the complete API regression suite against
  disposable R1 services only (5540/6480/5541/5542). See `docs/BILLING.md` for setup.

## R2 background workers and isolated verification

The API accepts durable intents; a separate `npm run worker:dev` process handles
push delivery/receipts, Flutterwave initialization and verification, webhook
settlement, cache invalidation and scheduled billing rechecks. For a built app,
run `npm run build:api`, then `npm run worker` alongside the existing API process.
Redis should use AOF persistence and `maxmemory-policy noeviction`. This is a
runtime setup description; no deployment was performed for R2.

```powershell
docker compose -f infrastructure/docker-compose.r2-tests.yml up -d --wait
npm run build:shared
npm run test:r2
npm run typecheck
npm run lint
npm run build:api
```

The disposable services use 5540/6480/5541/5542 and separate container names.
The database names retain the R1 test guard names; they are disposable, not the
normal development database. The test runner pins dummy keys and local endpoints
for Flutterwave and both Expo APIs; tests mock providers and keep Jest serial.
Do not start the normal API/worker with real credentials to verify R2.

Operator inspection: `npm run jobs:status`; explicit dead-job replay after review:
`npm run jobs:retry -- <outbox-uuid>`. The CLI uses configured database credentials,
never calls a payment provider, and refuses uncertain push replays. A changed
payment attempt must never be invented to recover an ambiguous checkout.

Details, API changes, conflict policy, failure drills and limitations:
`docs/R2-IMPLEMENTATION-REPORT.md`.

## Current implementation and review boundaries

R1, R2 and R3 are merged into main at `c09f925`. They provide the versioned USD
catalog and immutable ledger; durable outbox/worker processing and settings;
and reset/magic-link authentication, revocation, Redis quotas and read routing.
Historical NGN records remain in their original currency.

The preserved source checkouts originally held separate graduation corrections: Railway runtime
repair (12 files), Phase 1 billing-boundary/primary-membership fixes (8 files),
Phase 2 mobile completion (36 files), and Phase 3 observability/documentation.
They are now integrated locally on `codex/graduation-release-2026-11-10`;
remote main is unchanged and no deployment is claimed. The original checkouts
remain intact. See [final release report](docs/GRADUATION-RELEASE-REPORT.md). Read
[implementation status](docs/IMPLEMENTATION-STATUS.md) and the phase reports
before treating local test results as release evidence.

The mobile test script is a stub; API-hosted tests exercise extracted mobile
state/storage modules with native adapters mocked. Typechecking and an Android
JavaScript bundle do not establish physical-device behavior.

## Production & Performance

- **Deployment**: `Dockerfile` + `railway.json` produce a self-contained API
  image. The separate runtime-repair worktree corrects private workspace dependencies,
  API-only startup and container port 8080; integrate it before rollout. Runbook and env
  reference in `docs/DEPLOYMENT.md`.
- **Redis Caching**: Redis cache-aside layer for team roster (`GET /teams/:teamId/members`),
  shift calendar reads (`GET /teams/:teamId/shifts`), and activity feed reads
  (`GET /teams/:teamId/activity`), with explicit invalidation upon shift mutations,
  membership changes, and swap approvals.
- **Load Testing**: Dedicated 200-VU simultaneous activity feed benchmark and
  k6 suite in `load-tests/`. Empirical results before and after caching are
  documented in `load-tests/REPORT.md` and `docs/PERFORMANCE-REPORT.md`.
- **Graduation checklist**: `docs/SUBMISSION.md`.


## R3 authentication, security and read routing

R3 is merged; its original report records the pre-publication verification. See [R3 implementation report](docs/R3-IMPLEMENTATION-REPORT.md)
for verification, compatibility and operational boundaries.

After reviewing migration 009, migrate your intended development environment
using the existing migration command. Existing migrations 001–008 are unchanged.
Upgrade all workers before enabling new auth routes (old workers cannot process
AUTH_EMAIL). Run the separate worker (`npm run worker:dev`, or build then `npm run worker`)
for password-reset and magic-link mail. Configure server-only `AUTH_MAIL_KEY`
(32 random bytes as 64 hex characters), `MAIL_API_KEY`, `MAIL_FROM`,
`MAIL_API_URL` (default Resend), and `AUTH_LINK_BASE` (default `rota://action`).
Do not place these secrets in Expo variables. Without mail configuration the
request fails uniformly or delivery remains queued; no raw link is returned.
The app's login page requests either link and the account-action screen requires
an explicit tap before consuming it. Production startup requires configured
HTTPS mail delivery and a verified sender; no live delivery was exercised here.

`READ_DATABASE_URL` optionally routes roster, calendar and activity SELECTs to a
read endpoint. Without it, the primary handles reads. `DB_POOL_MAX=10` bounds
each pool. Authentication, permissions, settings, subscriptions, payments and
workers always use the primary. A durable per-user five-minute primary lease is
created before mutations; cached reads are bypassed during that lease. See
[sharding and replication](docs/SHARDING.md) for topology and lag limitations.

Isolated checks (never run destructive tests against the ordinary dev database):

```powershell
docker compose -f infrastructure/docker-compose.r3-tests.yml up -d --wait
npm run test:r3
npm run typecheck
npm run lint
npm run build:api
```

R3 uses disposable ports 5540/6480, shard ports 5541/5542 and read-drill port
5543. The runner pins fake payment, push and mail settings to localhost and runs
Jest serially. Its normal read connection uses the disposable primary through a
separate pool; routing drills use a second independent PostgreSQL database to
simulate lag and failure, not physical WAL replication. It raises only outer
load budgets; dedicated sensitive-route limits remain active. Each test clears
only limiter keys on the disposable Redis to prevent cross-test quota leakage.
Mobile runtime, live emails, deployment and R4 are not verified by these commands.

## Graduation Phase 3: observability and isolated verification

Backend request logs include a generated `X-Request-ID`, authenticated UUID when
available, normalized route/method, duration, HTTP status and outcome. Worker
logs include job UUID/type, attempt, duration, deferral, retry and terminal state.
See [observability and payment tracing](docs/OBSERVABILITY.md).

Optional `SENTRY_DSN` enables API/worker error reporting; optional
`EXPO_PUBLIC_SENTRY_DSN` enables mobile JavaScript reporting. Missing/malformed
values disable delivery. The mobile DSN is a public ingestion identifier;
**never** bundle mail/payment keys, `AUTH_MAIL_KEY`, JWT secrets or
`SENTRY_AUTH_TOKEN`. Native crash reporting, replays, screenshots, breadcrumbs,
SDK console capture and performance tracing are disabled. Source-map upload is
not configured. No live Sentry event has been sent/verified in this phase.

```powershell
# Disposable ports 5540/6480/5541/5542/5543 must be free.
docker compose -f infrastructure/docker-compose.phase3-tests.yml up -d --wait
npm ci
npm run build:api
npm run test:graduation:phase3
npm run typecheck
npm run lint
# Stop this stack only; retain its containers and volumes.
docker compose -f infrastructure/docker-compose.phase3-tests.yml stop
```

The runner pins dummy credentials, non-serving localhost provider URLs and empty
telemetry DSNs. Never run destructive suites against the normal development or
production database. Other workstreams' test stacks use these same ports; do
not run them concurrently. Local checks and exact combined-workstream coverage
are recorded in [the Phase 3 report](docs/ROTA-GRADUATION-PHASE-3-REPORT.md).

## Production app-store billing considerations (assessment page 14)

Flutterwave is explicitly allowed by the assignment and remains the sandbox
payment provider. Replacing it is unnecessary for graduation. A sandbox/demo
integration does not establish app-store production compliance.

Rota sells digital team scheduling access. Store distribution normally requires
evaluating the applicable digital-subscription billing rules. Apple's enterprise
services provision may permit access to subscriptions sold directly to
organizations for employees; this requires an eligible distribution/purchase
flow, not an assumption based on the word B2B. Google Play generally requires
Play Billing for digital features unless a current exception/program applies.
Choose store billing or a qualifying arrangement before enabling production
checkout, including region-specific linking and subscription disclosure rules.

Matinee sells cinema attendance, a physical service consumed outside the app.
The physical-goods/services rules generally permit external payment processing
(and Apple requires non-IAP payment for that category). Digital content or
subscriptions added later need a separate review. This section documents both
products as requested by the brief; no Matinee code is changed.

Policy references checked 10 November 2026:
[Apple App Review Guidelines, 3.1](https://developer.apple.com/app-store/review/guidelines/),
[Google Play Payments policy](https://support.google.com/googleplay/android-developer/answer/9858738?hl=en).
Recheck eligibility and current regional terms at the actual release date.

## November 10 graduation release candidate

The release candidate integrates the Railway runtime repair and all reviewed
Graduation Phase1/2/3 source, tests and docs. No new product phase was started.
Use the repaired API-only Docker CMD (PORT8080), and a separate worker process.
`railway.worker.json` prepares worker startup with no Railway HTTP health check;
set each service's configuration path explicitly only during an approved rollout.

The intended mobile backend is https://rota-production-84ef.up.railway.app.
Its /health returned404 during release preparation; a built APK does not imply
that backend is online. The user reports Railway trial expiry11 November2026;
remaining credit and live service configuration are unverified. No paid changes
or new deployment were made.

Release verification reuses the already-migrated disposable Phase3 stack:
`npm run test:release -- -IncludeMigrationSafetyTests`. The explicit switch
allows only the existing tests' temporary migration-safety databases. The runner
never invokes the application migration command. Without the switch, four
migration-invoking suites are excluded and the output must not be called a full
478-test run. `scripts/test-release-runtime.ps1` clones the disposable database,
checks final-image imports/HTTP/worker execution, and retains all resources.
No migrations run on API/worker startup. Do not run the older runtime-smoke script
under a no-deletion/no-migration restriction: its historical cleanup and migrator
are intentionally not used for this release.

See [release report](docs/GRADUATION-RELEASE-REPORT.md) for observed checks, the
new APK build/artifact, exact dashboard prerequisites and submission actions.

Installable Android APK (integrated preview,10 November2026):
[Download APK](https://expo.dev/artifacts/eas/r197ay-RMlQSdm-zTC_w1I4b_gD85C3_c0NBXPBYi8w.apk).
Physical-device behavior and backend availability remain unverified.
