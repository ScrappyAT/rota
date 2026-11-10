# Railway Docker runtime repair — local review

Branch: `fix/railway-runtime-dependencies` from clean main merge `c09f925`.
Date: 2026-11-02. No commit, push, merge or Railway operation is authorized here.
The user reported main crashed on `Cannot find module redis` from the compiled
API. No production database, provider credentials or Railway service was accessed.

## Root cause and intended correction

`apps/api/package.json` correctly declares redis as a production dependency.
`package-lock.json` lockfile version 3 explicitly installs redis **4.7.1** at
`apps/api/node_modules/redis`; there is no root node_modules/redis entry.
Most other backend modules (BullMQ, pg, bcrypt, Express) are hoisted into the
root node_modules tree. Workspaces and their private dependency directories
remain part of the installed graph; a production declaration does not guarantee
root hoisting.

The old Dockerfile installed all workspaces, built shared/API and ran
`npm prune --omit=dev`. Its final stage copied `/app/node_modules` and shared
workspace contents, plus API package.json/dist/migrations. It omitted
`/app/apps/api/node_modules`. Consequently a valid declared private dependency
could exist after pruning but be absent from the final filesystem. The API's
Node require search then cannot find redis anywhere above dist/redis.js.
This is a runtime copy-boundary defect, not a reason to move redis to root,
remove pruning, install devDependencies in production or regenerate the lock.

The minimal dependency fix adds the private directory to final-stage COPY.
`mkdir -p` after pruning guarantees COPY's source exists even if a future locked
graph hoists every API dependency. The shared workspace copy already preserves
its own private modules. Dependency ranges, package-lock and business logic are
unchanged. Dockerignore additionally excludes local test caches/agent metadata.

The original production Docker build completed successfully. Offline probes
then reproduced MODULE_NOT_FOUND for redis in its final image. The original
pruned build stage resolved redis at
`/app/apps/api/node_modules/redis/dist/index.js` (4.7.1), with no root redis.
The original final image had neither private nor root redis. The private
TypeScript devDependency was absent in the pruned build stage, confirming
pruning itself worked. Native bcrypt and the other production dependencies
passed the same probe. The comprehensive original-image smoke failed only redis.

Environment: local Docker Engine 29.6.1, Linux amd64, image Node v24.22.2 /
npm 11.19.1. The resolved node:24-bookworm-slim base was
`sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c`.
The original final image manifest-list digest was
`sha256:79ca695eb14af4bad72306789c5cea34ea9b432fc1954524f34f6b1b1eeb864a`.
This is observed local evidence; nothing here claims Railway was fixed.

## Repeatable runtime checks

`scripts/runtime-dependencies.cjs` resolves and loads every declared API/shared
production dependency with `createRequire` anchored at each package.json,
exercises native bcrypt hashing/comparison and a compiled shared schema, checks
compiled API/worker/migrator/job CLI and nine migration artifacts, then imports
API/worker without starting either. It sets dummy production config and confirms
Redis has not connected. The migrator is never imported/executed by this test.
The final image runs this smoke with network disabled during its build.

`scripts/test-docker-runtime.ps1` builds the real final image (or accepts an
already-built local tag), repeats the dependency test with `--network none`,
asserts unprivileged node user/API-only CMD/PORT=8080, and runs an isolated
Compose integration drill. The disposable internal network blocks provider
access. No test services publish host ports; a separate HTTP client checks api:8080
on the internal network. All provider URLs are localhost non-serving and all keys are test-only.
The runner refuses to delete a pre-existing same-name stack it did not create.
It always cleans its own containers/volumes on exit.

The integration drill checks /health from a peer container on port 8080, checks there are
zero public tables after API startup (no automatic migration), explicitly runs
migrate.js against its own disposable DB, checks nine applied migrations, starts
a separate real BullMQ worker, inserts one harmless no-team DOMAIN_EVENT, and
waits for SQL COMPLETED. This job has no recipients, payments or provider work.
The ordinary 373-case regression suite uses the separate guarded R3 test stack.

## Deployment and migration changes

The old default `migrate.js && index.js` applied schema changes on every restart.
It also risked simultaneous migration runners because the existing check/insert
runner has no cross-process global migration lock. This repair leaves that
runner and every SQL file unchanged, but the Docker default now starts only
`node apps/api/dist/index.js`. This is an intentional operational change: schema
preparation is required separately before a future authorized rollout.

Recommended future deployment: review the image and migration/backups plan,
serialize exactly one approved migration release job, stop on failure, upgrade
all workers, then enable the API. A Railway pre-deploy command is a possible
execution mechanism for the API service only; it is not automatic approval and
does not inherently serialize API and worker deployments. No preDeployCommand
was added to railway.json. No production migration was run. Existing applied
migrations must not be edited or reinterpreted; a rollback is a separate plan.

Docker now sets/exposes **8080** and its health probe uses PORT (fallback 8080).
The application still reads env.PORT and local npm development remains 3000.
The user-reported Railway public target is 8080, so an explicit remote PORT
override must also match. Existing root railway.json remains Dockerfile builder,
/health, timeout 180 and On Failure/10. Actual remote overrides are unverified
and unchanged. A healthy local container is not proof of live Railway readiness.

## Separate worker requirement

R2's API only persists outbox work. `node apps/api/dist/worker.js` must run in a
separate always-running service from the same reviewed image, using the same
primary DB, Redis endpoint/DB, queue name and AUTH_MAIL_KEY. It handles push/
receipts, payment initialization/webhooks/reconciliation, billing rechecks and
R3 email. No worker means durable jobs accumulate even when API health is green.

The worker must not inherit the API-specific /health expectation: it exposes no
HTTP port and needs no public domain. Use a worker-specific Railway config path
or verified service overrides, disable the image HTTP health check where honored,
and monitor process/job progress. Budget pool connections across services and
retain Redis noeviction/durability plus R2 dead-job and uncertain-delivery rules.
Old pre-R3 workers must be replaced before new AUTH_EMAIL jobs are emitted.

## R3 mail and other runtime requirements

Existing env.ts validation is unchanged. Production currently requires
AUTH_MAIL_KEY (64 hex characters encoding 32 bytes), nonempty MAIL_API_KEY and
MAIL_FROM, and HTTPS MAIL_API_URL. It also requires explicit JWT_SECRET,
FLW_SECRET_KEY/FLW_SECRET_HASH and an explicit CORS allow-list. Both API and worker
load this shared validation, even when a process does not itself send mail.
Fixing redis will not fix absent R3 mail configuration. MAIL_FROM existence
checks do not prove provider sender verification; that requires a future
separately authorized provider setup.

Keep AUTH_MAIL_KEY identical across API/workers and stable while encrypted jobs
exist. Do not rotate it casually or put it/provider credentials in EXPO_PUBLIC
variables. AUTH_LINK_BASE defaults to rota://action; actual device/mail delivery
remains untested. The smoke uses dummy keys and localhost:9 endpoints, never real
credentials or recipients. No mail, payment or push delivery was invoked.

## Verification results

Final observed results:

- Original production Docker build passed, but offline final-image Redis
  resolution and comprehensive smoke failed with MODULE_NOT_FOUND (expected).
- Original pruned stage retained Redis 4.7.1 privately; final stage omitted it.
- Corrected final-stage offline smoke passed all 12 API production dependencies,
  shared Zod, native bcrypt, shared schema, compiled artifacts and API/worker
  imports (18 checks). Corrected production build/export completed successfully.
- `npm run test:docker:runtime -- -SkipBuild` passed against the actual final
  image: offline imports, unprivileged node/API-only command/default 8080,
  HTTP readiness from a separate peer container, zero public schema tables
  after API startup, all nine explicit disposable migrations, and one durable
  DOMAIN_EVENT completed by the separate BullMQ worker. Profile-aware shutdown
  removed API/worker before DB/Redis, with no leftover test containers/volumes.
- Corrected image manifest-list digest:
  `sha256:7ae55c82ea0d13c3c05d55fb1f9e1f42fa0b0affa6a314ea6732040dc154b9eb`
  (Linux amd64, local tag `rota-runtime-repair:local`).
- Offline image integrity inspection confirms Redis is present, actual root/API
  .env files are absent, and all nine copied SQL files match workspace hashes.
- Full existing regression: **373 tests across 31 suites passed** in 103.924s;
  root workspace runner also completed the mobile stub. Shared has no separate
  test runner. No mobile runtime verification is claimed.
- `npm run typecheck` passed API/mobile/shared. `npm run lint` passed with zero
  errors and one pre-existing unused Team warning, plus Expo legacy-config note.
- The production image compiled shared/API with TypeScript successfully.
- New CJS/PowerShell syntax and Compose configuration checks passed.
- `git diff --check` passed. Migrations 001–009, API/shared/mobile application
  source, package-lock and railway.json are unchanged.

The Linux npm 11.19.1 build reported 49 full-graph advisory entries and 19 after
pruning (1 low,13 moderate,5 high). It also warned about deprecated packages and
bcrypt/msgpackr-extract install scripts not yet covered by allowScripts. No
forced upgrade, audit suppression configuration or script-approval weakening
was applied. Native bcrypt actually passed. These tool/platform graph counts do
not rewrite R3's earlier host audit or claim vulnerabilities were remediated.
The first baseline download/build and image exports were slow on this host.
No passing runtime result was inferred from compilation alone.

Failure history: the original final image failed Redis resolution as intended
for reproduction. The first new integration harness reached healthy API 8080
inside Docker but its host-side HTTP mapping was inaccessible on the fully
internal network; that attempt failed and cleaned its active services. The probe
now runs in a peer container with no host ports. A subsequent cleanup inspection
found an exited profiled worker omitted by default Compose down; cleanup and
ownership checks now include worker/tools profiles and assert no leftovers.
The final repeat passed every phase and removed all test services. No production
source or permission behavior was changed to make these tests pass. No EPERM
occurred. Logs/results remain ignored under .r1-test-cache.

Reproduction artifacts retained locally: runtime-before-build.log,
runtime-before-stage.log, runtime-before-resolution.log, runtime-before-smoke.log,
runtime-fixed-build.log, runtime-smoke-verified.log, runtime-regression.log,
runtime-typecheck.log, runtime-lint.log and runtime-image-integrity.json in that
ignored directory. Before/build/fixed image tags remain local for review;
no registry publication or Docker system prune was performed.

## Changed files

12 modified/created files:

| File | Purpose |
|---|---|
| `.dockerignore` | Exclude local verification caches and agent metadata from build context. |
| `.env.example` | Clarify development 3000 versus Docker/Railway 8080. |
| `AGENTS.md` | Record packaging, smoke, migration and worker safety rules. |
| `Dockerfile` | Copy private pruned API modules; guard final image; API-only startup and port 8080. |
| `README.md` | Expose repeatable smoke command and current deployment boundaries. |
| `docs/DEPLOYMENT.md` | Replace stale boot-migration instructions with separate release/worker/mail configuration. |
| `docs/IMPLEMENTATION-STATUS.md` | Record the verified local repair and preserved application behavior. |
| `docs/RAILWAY-RUNTIME-REPAIR-REPORT.md` | This root-cause, verification, inventory and risk report. |
| `infrastructure/docker-compose.runtime-smoke.yml` | Private disposable API/PostgreSQL/Redis/migrator/worker topology. |
| `package.json` | Add test:docker:runtime convenience script; no dependency changes. |
| `scripts/runtime-dependencies.cjs` | Actual final-image module/native/compiled-entry smoke. |
| `scripts/test-docker-runtime.ps1` | Build/offline imports/peer HTTP/no-auto-migration/worker/cleanup drill. |

Application API/shared/mobile source, migrations 001–009, package-lock.json and
railway.json are unchanged. No actual env, secret, dump, generated output, cache
or test result is included among intended files. Nothing is staged or committed.

## Remaining risks and release boundary

- This local repair is not a deployment authorization. Railway runtime settings,
  migration ownership, same-image worker rollout and required mail config need
  a separate approved release preparation step.
- The API-only CMD requires an already prepared schema. /health currently checks
  DB connectivity, not migration version; a green probe alone cannot prove schema
  readiness. The current API also returns a JSON health result without changing
  HTTP status for dependency errors, while Docker's probe tests HTTP status.
  The smoke verifies the body too; production readiness improvements are not
  part of this packaging change. Do not infer migrations may be skipped.
- The existing migrator requires external serialization. No migration locking,
  financial/auth/notification logic or SQL rewrite is included.
- Existing R3 dependency advisories and frontend packages retained by the
  all-workspace production graph are not remediated by copying the correct tree.
- Native runtime smoke proves the tested Linux architecture/base image; other
  architectures need the same build/smoke. node:24-bookworm-slim remains a moving
  tag; use the exact reviewed image digest for any future release.
- No new live provider/device/physical-replica evidence, published demo changes
  or R4 work is claimed. Existing submission artifacts remain completed as before.

Sources: [npm workspace linking](https://docs.npmjs.com/cli/v11/using-npm/workspaces/),
[npm prune omission semantics](https://docs.npmjs.com/cli/v11/commands/npm-prune/),
[Railway pre-deploy containers](https://docs.railway.com/deployments/pre-deploy-command),
[Railway PORT/target matching](https://docs.railway.com/networking/troubleshooting/application-failed-to-respond).
