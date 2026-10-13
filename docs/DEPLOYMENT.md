# Deployment (Production)

How the Rota API is packaged and stood up in production, and what to configure
per environment. The mobile app is shipped separately via EAS (see
`apps/mobile/AGENTS.md`); this page covers the API.

Status: **prepared, not yet deployed.** No infrastructure has been provisioned.

## Artifact

A single self-contained Docker image, built from the repo-root `Dockerfile`:

- Multi-stage (build then runtime) on `node:24-bookworm-slim` (glibc so the
  native `bcrypt@6` prebuilds load without a compiler in the runtime image).
- `npm ci` installs every workspace; `packages/shared` is compiled **before**
  `apps/api` (the API resolves `@rota/shared` from `packages/shared/dist`).
- `npm prune --omit=dev` keeps only production deps.
- SQL migrations are copied into the image and run on boot
  (`node apps/api/dist/migrate.js && node apps/api/dist/index.js`); the
  migrations runner is idempotent and records applied files in a `migrations`
  table.
- Runs as the unprivileged `node` user. Exposes `PORT=3000` with an HTTP
  `HEALTHCHECK` against `/health`.

Build locally:

```bash
npm run build      # already builds shared -> api; equivalent to the image stage 1
docker build -t rota-api .
```

`railway.json` (repo root) tells Railway to build with this Dockerfile and to
flap on `/health`. The `.dockerignore` keeps the build context small (no
`node_modules`, `dist`, `.git`, docs, or test files).

## Postgres & Redis

- **PostgreSQL 15** — used as a managed service on the host (Railway
  Postgres). Schema is created by boot migrations; nothing manual beyond the
  service itself.
- **Redis 7** — required. Used by the `/health` probe and the shared `/devices`
  rate limiter (`rl:devices:<ip>`).
- Both must be reachable from the API. Production never assumes the local
  ports **5440/6380** — those are the docker-compose dev surfaces only.

## Environment variables

Set every one of these in the deployed service. Secrets are marked `[secret]`;
never commit them or put them in logs.

| Variable | Required in prod | Notes |
|---|---|---|
| `PORT` | no | Default `3000`. |
| `NODE_ENV` | **yes** | `production`. |
| `DATABASE_URL` | **yes** | e.g. `postgres://user:pass@host:5432/rota`. |
| `REDIS_URL` | **yes** | e.g. `redis://host:6379`. |
| `JWT_SECRET` | **yes** [secret] | Enforced non-default when `NODE_ENV=production`. |
| `JWT_REFRESH_SECRET` | no | Currently unused (refresh tokens are opaque); kept for parity. |
| `CORS_ORIGIN` | **yes** | Comma-separated origin allow-list (aliases `CORS_ORIGINS`, `ALLOWED_ORIGINS` supported); `*` is refused in production. Include `http://localhost:8081` to allow local Expo web development against the deployed API. |
| `FLW_SECRET_KEY` | **yes** [secret] | Flutterwave secret key (test key for sandbox). |
| `FLW_SECRET_HASH` | **yes** [secret] | Flutterwave webhook `verif-hash` value. |
| `FLW_PUBLIC_KEY` | yes for checkout | Public key passed to hosted checkout. |
| `FLW_ENV` | no | `sandbox` or `live` (default `sandbox`). |
| `FLW_BASE_URL` | no | Defaults to the Flutterwave API base. |
| `BILLING_CURRENCY`, `BILLING_PERIOD_DAYS`, `SUBSCRIPTION_GRACE_DAYS` | no | Defaults `NGN`, `30`, `14`. |
| `EXPO_PUSH_URL` | no | Defaults to Expo's push service. |

`.env.example` documents the same list for local development.

## Railway walkthrough

1. Create a Railway project and add **Postgres** and **Redis** services.
2. Add the API service pointing at this repo (or `railway up` from the root).
   `railway.json` selects the Dockerfile builder.
3. Set the environment variables above from the service → Variables panel.
   Reference the Postgres/Redis internal connection strings (`${{ .Postgres.PGHOST }}`
   etc.) rather than public URLs.
4. Deploy. The container runs migrations on boot, then serves. `/health`
   reports `{ success, data: { status, db, redis } }` — Railway's
   `healthcheckPath` uses it to gate the deployment.
5. (Optional) `railway domain` to attach a custom hostname, then point
   `EXPO_PUBLIC_API_URL` at `https://<host>` for mobile builds.

## Mobile (EAS) build configuration

The app reads `EXPO_PUBLIC_API_URL` at build time (`apps/mobile/src/api/client.ts`).
The bundled fallback `http://192.168.0.101:3000` must **not** be used in
production; set the real HTTPS host for every EAS build:

```bash
EXPO_PUBLIC_API_URL=https://<railway-host> npx eas-cli build --profile production --platform android
```

## Health, scaling, and limits

- Each API instance keeps an in-memory rate-limit budget for `/auth` (100),
  `/teams` (300), and `/invitations` (300) per 15 min / IP; the `/devices`
  limiter (200 per 15 min / IP) is shared via Redis, so horizontal scaling
  keeps that one accurate while the in-memory ones are per-instance. Budgets
  default via `AUTH_RATE_LIMIT_MAX` / `TEAMS_RATE_LIMIT_MAX` /
  `INVITATIONS_RATE_LIMIT_MAX` (100/300/300) and are overridable for
  load-test instances — see `docs/PERFORMANCE-REPORT.md` §5.
- Multi-replica: memory limiters become per-POD. Single rail is fine for the
  graduation demo; scale out only after load-testing (see
  `docs/PERFORMANCE-TESTING.md`).

## Validation before/after deploy

```bash
npm run typecheck
npm run lint
docker build -t rota-api .          # must succeed
# after deploy:
curl -s https://<host>/health        # expect { "success": true, "data": { "status": "ok", "db": "ok", "redis": "ok" } }
k6 run k6/health.js -e BASE_URL=https://<host>
```