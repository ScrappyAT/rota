# Rota

Rota is a mobile shift-scheduling application for small businesses such as restaurants, clinics, and retail stores.

## Technology Stack

- **Mobile**: Expo, React Native, TypeScript, Expo Router, NativeWind
- **Backend**: Node.js, Express, TypeScript, Zod, PostgreSQL, Redis
- **Infrastructure**: Docker Compose for local development

## Repository Structure

- `apps/mobile`: Expo mobile application
- `apps/api`: Express backend API
- `packages/shared`: Shared TypeScript types and Zod schemas
- `infrastructure`: Docker Compose file for local services
- `docs`: Architecture and documentation

## Prerequisites

- Node.js (v18+)
- Docker and Docker Compose (for local database and Redis)

## Local Setup

1. Copy `.env.example` to `.env` in the root directory.
2. Run `npm install` to install dependencies across workspaces.
3. Start the databases: `npm run db:start`
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
- `npm run db:stop`: Stops the Docker Compose services.
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

## Current Implementation Status

Milestone R1 corrects assignment USD pricing, separate-floor proration, scheduled
reductions, payment idempotency and the append-only financial ledger. Legacy NGN
records remain intact. See `docs/R1-IMPLEMENTATION-REPORT.md`; the Phase 4 counts
below describe the earlier implementation.


- **Phase 1** — Monorepo, shared package, Express bootstrap, Docker Compose,
  Expo shell: complete.
- **Phase 2** — Auth (JWT + rotating refresh tokens with reuse detection),
  teams, role-based access control, invitations: complete and verified.
- **Phase 3** — Shifts, shift assignments, swap requests/approvals, activity
  feed, cursor pagination, 10k seed script, and mobile shift/swap/activity
  screens: implemented. API behavior is covered by 43 automated tests
  (including a live-DB suite); mobile screens type-check but have not been
  exercised on a device.
- **Phase 4** — Seat-based subscriptions and Flutterwave billing: plan catalog,
  per-team subscriptions with lazy ACTIVE/PAST_DUE/EXPIRED states, prorated
  upgrades and seat changes, renewal, payment verification and a deduplicating
  webhook, plus owner-only mobile screens (summary, plans, history). Covered by
  50 new automated tests (93 total); the live card flow is unverified because
  no Flutterwave sandbox credentials were available.
- **Push notifications** — device registration/preferences API, notification
  ledger with deterministic dedupe, Expo push delivery, and mobile
  registration + handlers: complete. See `docs/ARCHITECTURE.md`.
- See `docs/IMPLEMENTATION-STATUS.md` for the full breakdown.

## Production & Performance

- **Deployment**: `Dockerfile` + `railway.json` produce a self-contained API
  image (shared package built first, migrations run on boot). Runbook and env
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

R3 changes remain local for review. See [R3 implementation report](docs/R3-IMPLEMENTATION-REPORT.md)
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
