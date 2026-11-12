# Rota API — production image.
#
# Two-stage build:
#   1. `build`  — npm ci (all workspaces), compile packages/shared FIRST, then
#                 apps/api, then prune development dependencies.
#   2. `runtime` — slim glibc Node with only production deps, built output, and
#                 SQL migration files. Starts the API; migrations run separately.
#
# Kept on a glibc base (bookworm-slim) so the native `bcrypt@6` module can use
# prebuilt binaries instead of requiring a full toolchain in the runtime image.
#
# Build (from repo root):
#   docker build -t rota-api .
# Run (requires DATABASE_URL + REDIS_URL + secrets, see docs/DEPLOYMENT.md):
#   docker run --rm -p 8080:8080 \
#     -e DATABASE_URL=postgres://... -e REDIS_URL=redis://... \
#     -e JWT_SECRET=... -e JWT_REFRESH_SECRET=... \
#     -e FLW_SECRET_KEY=... -e FLW_SECRET_HASH=... \
#     rota-api

# ---------------------------------------------------------------------------
# Stage 1: build
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS build

# Native-compile fallback for `bcrypt` (only if a prebuilt binary is missing).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace manifests first for layer caching. npm ci requires the manifests
# of every workspace referenced by package-lock.json (including apps/mobile).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/mobile/package.json apps/mobile/package.json

RUN npm ci --include=dev

# Shared package must compile before the API (the API resolves
# packages/shared/dist as its type + runtime source).
COPY packages/shared/ packages/shared/
RUN npm run build -w @rota/shared

COPY apps/api/ apps/api/
RUN npm run build -w @rota/api \
  && npm prune --omit=dev \
  && mkdir -p apps/api/node_modules

# ---------------------------------------------------------------------------
# Stage 2: runtime
# ---------------------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime

# Install PostgreSQL client tools for logical backup capabilities
RUN apt-get update \
  && apt-get install -y --no-install-recommends postgresql-client \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /app

# Preserve both hoisted and workspace-local production dependencies. The lockfile
# places redis in apps/api/node_modules; copying only the root tree loses it.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api/package.json apps/api/package.json
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/api/dist apps/api/dist
# SQL migrations are read at deploy time by apps/api/dist/migrate.js
# (path.join(__dirname, '../migrations')).
COPY --from=build /app/apps/api/migrations apps/api/migrations
COPY scripts/runtime-dependencies.cjs scripts/runtime-dependencies.cjs

# Run as an unprivileged user (the base image provides `node`).
USER node

# Exercise the actual final filesystem/native modules without network access.
RUN node scripts/runtime-dependencies.cjs

EXPOSE 8080

# Liveness/readiness probe: hits the same /health used by Railway's
# healthcheckPath and by k6 health.js.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run migrations once as an explicitly approved release job before API/workers.
# Never apply schema changes automatically on API restart or horizontal scale-out.
CMD ["node", "apps/api/dist/index.js"]
