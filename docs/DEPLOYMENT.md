# Deployment and Railway runtime preparation

The user reports an existing Railway main deployment crashed with missing redis.
This runbook describes the local repair; it does not claim a successful Railway
deployment. Do not deploy, run production migrations or configure real providers
until separately authorized. See [runtime repair report](RAILWAY-RUNTIME-REPAIR-REPORT.md); its changes are now integrated locally.

## Production image

The contract below now applies to the integrated local release candidate.
It is not evidence of a successful Railway deployment.

The root Dockerfile installs the locked npm workspace graph, builds shared then
API, and prunes dev dependencies. The repaired integrated image copies both
`/app/node_modules` and `/app/apps/api/node_modules`, plus the shared workspace,
compiled API and migrations. The lockfile deliberately places redis 4.7.1 under
the API workspace; root-only copying omitted it even though it is a production
dependency. Do not force dependency hoisting or add a duplicate root dependency.

An offline final-stage smoke checks every declared API/shared production module,
native bcrypt and compiled API/worker imports. Failure blocks the image build.
The image remains unprivileged (`node`) and starts only:

```text
node apps/api/dist/index.js
```

It does **not** apply migrations automatically on API restart/scale-out.
`PORT` defaults to 8080 in the image; ordinary npm development stays at 3000.
Railway's public domain target was reported as 8080. Any explicit Railway PORT
variable must also be 8080, or the domain target must be adjusted in a future
approved configuration task. EXPOSE is metadata; it does not configure Railway's
proxy. Existing Express startup listens on env.PORT; smoke verifies reachability
from a separate HTTP client container on the isolated network at api:8080. Docker HEALTHCHECK also
uses PORT; Railway health path remains /health, timeout 180, restart On Failure/10.
Railway dashboard overrides are not inspected or changed by this repair.

## Reproducible local verification

```powershell
npm run typecheck
npm run lint
npm run test:docker:runtime
```

The Docker test builds `rota-runtime-repair:local`, runs dependency imports with
`--network none`, then starts a dedicated `rota-runtime-smoke` Compose project.
It uses dummy credentials and an internal network, with no production URLs,
volumes or provider access. No test service ports are exposed to the host. A peer HTTP client checks
api:8080 on the internal network. It proves API startup creates zero
schema tables, then explicitly migrates the disposable DB and starts a separate
worker to complete one harmless DOMAIN_EVENT. It cleans only its own stack and
volumes. It refuses to delete an existing same-name stack it did not start.

To test an image already built:

```powershell
powershell -NoProfile -File scripts/test-docker-runtime.ps1 -Image rota-runtime-repair:local -SkipBuild
```

The existing full regression runner remains `npm run test:r3`, after starting
`infrastructure/docker-compose.r3-tests.yml`. It pins 5540/6480/5541/5542/5543,
fake provider keys and localhost delivery URLs; never use production/dev DBs.
Mobile test is a stub. No device/EAS build is claimed by these commands.

## Migrations are a separate release step

The previous CMD chained `migrate.js && index.js`. That runs DDL on every API
restart, and concurrent replicas can race because the existing migration runner
checks applied files without a global migration lock. Migration 009 also needs
reviewed mail/session rollout preparation. The repaired image keeps the migrator
available but removes it from normal startup.

Recommended future procedure, **not executed against production here**:

1. Review the exact image digest, migration diff 001-009 and backup/restore plan.
2. Configure required server variables without exposing secrets. Serialize one
   approved release job using `node apps/api/dist/migrate.js` with the intended
   DB access. Stop on failure; do not let API/worker services both run migrations.
3. Upgrade every worker before allowing new R3 API mail jobs. Old workers cannot
   process AUTH_EMAIL. Existing financial/push kinds and recovery rules remain.
4. Start/restart the API without a migration command, then validate runtime.

Railway pre-deploy commands run in a separate container with private networking
and can block rollout on failure. They are an option for the API service only,
with an appropriate timeout and external release serialization. They are not
an implicit approval to migrate and do not inherently serialize independent
service deployments. Do not add a pre-deploy migration to both API and worker.
The root railway.json deliberately adds no automatic migration command.
The current migrator still needs its normal shared env validation, including
R3 mail variables, even though it does not itself send email.

## A separate worker service is required

R2's API persists SQL outbox rows and returns; it does not start BullMQ workers.
Deploying only the API leaves durable work pending (payment initialization and
webhooks/reconciliation, push delivery/receipts, expiry rechecks and auth email).

Use the same reviewed image for a private, continuously running worker service:

```text
node apps/api/dist/worker.js
```

It must use the same DATABASE_URL, REDIS_URL (including Redis DB number),
JOB_QUEUE_NAME and AUTH_MAIL_KEY as the API. Keep Redis durable with noeviction;
PostgreSQL remains the durable outbox authority. JOB_ATTEMPTS, JOB_BACKOFF_MS,
JOB_POLL_MS and JOB_CONCURRENCY use existing bounded defaults. Budget primary
connections for API + workers, and preserve R1/R2 operator handling of dead jobs
and uncertain external delivery. The worker needs no public domain or API port.

Use a worker-specific Railway config path/overrides with no HTTP /health probe;
the root railway.json is for the API and must not impose its HTTP health path
on a process that exposes no HTTP server. Disable the image's HTTP health check
where the worker host honors it, and use worker/job progress monitoring instead.
No worker service or remote health configuration was created in this repair.

## Server configuration requirements

| Variable | Requirement / scope |
|---|---|
| NODE_ENV | production for both API/worker |
| PORT | API must match public target 8080; worker has no public port |
| DATABASE_URL | Correct managed PostgreSQL/private pooled endpoint; writes/auth/financial reads are primary |
| REDIS_URL | Same Redis endpoint/database for API/worker; required for quotas and jobs |
| JWT_SECRET | Explicit strong secret; never EXPO_PUBLIC |
| CORS_ORIGIN | Explicit trusted origins; production rejects wildcard-only config |
| FLW_SECRET_KEY / FLW_SECRET_HASH | Currently required at production startup; use the intended sandbox configuration for the assessment |
| FLW_PUBLIC_KEY | Needed for actual sandbox checkout; no provider flow tested here |
| AUTH_MAIL_KEY | Required 64 hexadecimal characters encoding 32 random bytes, identical and stable across API/workers |
| MAIL_API_KEY | Required nonempty server-only Resend-compatible provider credential |
| MAIL_FROM | Required nonempty sender; verify sender/domain with provider before future authorized live delivery |
| MAIL_API_URL | HTTPS in production; defaults to Resend. The provider must honor the documented idempotency contract |
| AUTH_LINK_BASE | Defaults rota://action; validate intended deep-link destination in a later device test |
| JOB_QUEUE_NAME | Same namespace for API/workers; defaults rota-jobs |
| READ_DATABASE_URL | Optional read endpoint; never use a team-hash shard as a replica |
| DB_POOL_MAX | Defaults 10 per pool; account for replicas and worker processes |

JWT_REFRESH_SECRET is retained but unused for opaque refresh tokens. Legacy
BILLING_CURRENCY=NGN must not reinterpret historical rows; R1 USD plans are
stored explicitly. FLW_ENV stays sandbox for assessment work. Provider URLs,
push receipt endpoint and other optional settings retain existing defaults.
No credentials were inspected, generated for production or installed remotely.

AUTH_MAIL_KEY encrypts outbox recipients/token payloads. Changing it strands
existing jobs; coordinate key retention/rotation separately. API/worker startup
will fail current R3 validation if mail key, provider credential or sender are
missing, or the endpoint is not HTTPS. Fixing redis alone cannot satisfy missing
configuration. Existing custom-scheme links, actual mail and push/device delivery
remain unverified. See SECURITY.md and R3 report for remaining advisory risks.

Primary references: [Railway target port/PORT](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond),
[pre-deploy lifecycle](https://docs.railway.com/deployments/pre-deploy-command),
[npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces/),
[npm prune](https://docs.npmjs.com/cli/v11/commands/npm-prune/).


## Graduation Phase 3 release preparation (local implementation only)

The runtime repair is integrated in the release candidate; review its original report as history. Preserve both
root and API-workspace production dependencies after prune, including the new
Sentry dependency graph. Extend the final-image dependency smoke inventory to
include `@sentry/node` during integration, and re-run the Docker smoke test after
approval using disposable infrastructure. It was not re-run in Phase 3 because
its current cleanup removes containers, which this phase explicitly forbids.

No migration is added by Phase 3. Existing 001–009 have no Git content changes. A
separately approved, serialized release migration must precede normal API/worker
startup; never restore automatic migrations to every API boot. Image API PORT
8080 matches the user-confirmed Railway public target. Local development stays
3000 with PG/Redis 5440/6380. Worker services share DB/Redis/queue/AUTH_MAIL_KEY;
run `node apps/api/dist/worker.js` without the API HTTP health check.

Optional `SENTRY_DSN` belongs on API and worker; `EXPO_PUBLIC_SENTRY_DSN` belongs
in the mobile build only if error reporting is approved. DSNs are ingestion
identifiers, not private API tokens. No source-map upload or native crash
reporting is configured. Configure collector access/retention and alerts on
5xx, job.dead, dispatch failures and stale RUNNING rows before claiming operated
observability. Test privacy using an approved synthetic event in staging first.

R3 mail requires a stable 64-hex AUTH_MAIL_KEY, verified MAIL_FROM and server-only
MAIL_API_KEY/HTTPS MAIL_API_URL. Do not rotate the encryption key while jobs need
it without a migration/key-retention strategy. Live mail, push, payments, device
links, physical replication and current Railway runtime remain unverified here.

Remote Railway settings were not inspected/changed in this phase. Before any
future push/PR, re-confirm production autodeploy and automatic PR-environment
behavior; previously supplied settings are not a guarantee of today's state.

## November10 controlled Railway rollout — approval required

Intended URL: https://rota-production-84ef.up.railway.app; /health returned404.
User confirms trial expires11 November2026 and will not upgrade. Exact remaining
credit is unknown; do not spend, upgrade, create or change live services here.

Verify these dashboard details before any deployment:
1. Workspace/project/environment IDs and trial expiry/remaining dollar allowance;
   resource-hour limits and what happens to existing services after expiry.
2. API service exists, connected repository ScrappyAT/rota, branch/source revision,
   automatic deployments setting, PR environments, root directory and config path.
3. API Dockerfile builder/root Dockerfile, start command `node apps/api/dist/index.js`,
   PORT8080, public target8080, domain mapping, /health timeout180s and restart
   On Failure/max10. Confirm no pre-deploy/boot command automatically runs migrations.
4. Separate worker service exists, uses the same approved image/source, config
   path railway.worker.json, start `node apps/api/dist/worker.js`, **no Railway
   HTTP healthcheck path**, shared queue/DB/Redis and bounded concurrency.
5. PostgreSQL/Redis services, private connectivity, persistence, non-eviction/AOF,
   connection limits and backups. Confirm READ_DATABASE_URL is a replica/simulation
   endpoint or omitted; never point it at a team-hash shard.
6. Variable **names/presence only**: NODE_ENV, DATABASE_URL, REDIS_URL, JWT_SECRET,
   CORS_ORIGIN, FLW_ENV=sandbox and test-provider settings; stable AUTH_MAIL_KEY,
   MAIL_FROM/MAIL_API_URL/MAIL_API_KEY; JOB_QUEUE_NAME; optional SENTRY_DSN.
   Do not paste secrets into chat, docs, Expo or test tools. This review does not
   use real payment/mail/push credentials or attempt external delivery.
7. Current migration metadata001–009, deployment/restart logs, errors, resource
   health and a public /health response. Settings supplied in earlier chats do
   not prove today's deployment health or the worker's existence.

Controlled migration procedure, **not executed on Railway**:
- Back up/verify restoration for the intended environment. First inspect only
  `SELECT name,executed_at FROM migrations ORDER BY name;` with approved read-only
  access and compare against repository001–009.
- If all nine are already applied, do not rerun the migrator. Phase1/2/3 and this
  release add no migration, so no new SQL should be necessary in that case.
- If some are missing, obtain explicit approval for those exact pending files
  and run one serialized operator-controlled release job before API/workers.
  The existing runner is per-file transactional, not a multi-replica migration
  coordinator. Never start two migration jobs or put them in normal startup.
- Preserve historical NGN/USD ledger/auth/outbox records. Do not reset/reseed
  production; no rollback may rewrite immutable financial history.
- After separately approved rollout, verify API readiness + worker heartbeat/job
  progress and only approved sandbox/device flows. A health response alone does
  not prove mail, push, settlement, native behavior or long-term trial availability.

Public grading access after11 November is a genuine availability risk. A local
Docker image/APK/demo is useful evidence but does not guarantee a reachable API
after the trial expires. No alternative paid hosting or new architecture is
created by this release preparation.
