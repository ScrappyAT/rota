# Rota — k6 Load-Testing Suite

Grafana k6 scripts for validating the Rota API under load. Full runbook,
thresholds, and expected-results template live in
[`docs/PERFORMANCE-TESTING.md`](../docs/PERFORMANCE-TESTING.md).

## Install k6

k6 is **not** bundled in this repo or available on this dev machine. Install it
first (choose one):

- Windows (choco):  `choco install k6`
- Windows (winget): `winget install k6.k6`
- macOS (brew):     `brew install k6`
- Other: download the binary from <https://grafana.com/docs/k6/latest/get-started/installation/>

Verify: `k6 version`.

## Prerequisites for the authenticated scenarios

1. A running API that has been migrated. Locally:

   ```
   npm run db:start
   npm run db:migrate
   npm run dev:api
   ```

2. A seeded database. `scripts/seed-dataset.ts` builds a deterministic
   multi-tenant world (users, teams, shifts, assignments, swaps, and activity)
   and is the recommended way to produce the large feed the load tests expect.
   **Never point it at production.**

   ```
   npm run db:seed:dataset                 # defaults: 40 users / 5 teams / 500 shifts / 10k activity
   npm run db:seed:dataset -w @rota/api -- --users 40 --teams 5 --shifts 500 --activity 10000
   ```

   (Because npm forwards arguments one level only, passing flags requires the
   workspace-level form above; the bare root script accepts defaults.)

   Seed accounts log in with the password `seed-only-account` (e.g.
   `seed.user.1@loadtest.local`). For a fully API-driven user, register one and
   give them a team using the steps below.

   ```
   curl -s http://localhost:3000/auth/register -H 'Content-Type: application/json' \
     -d '{"firstName":"Load","lastName":"Bot","email":"loadtest@example.com","password":"ChangeMe123!"}'
   curl -s http://localhost:3000/auth/login -H 'Content-Type: application/json' \
     -d '{"email":"loadtest@example.com","password":"ChangeMe123!"}'
   # capture data.accessToken, then:
   curl -s http://localhost:3000/teams -H "Authorization: Bearer $TOKEN" \
     -H 'Content-Type: application/json' -d '{"name":"Load Test Team"}'
   # capture the returned team id.
   ```

## Env vars

| Var | Used by | Purpose |
|---|---|---|
| `BASE_URL` | all | API origin, e.g. `https://rota.up.railway.app`. Default `http://localhost:3000`. |
| `USER_EMAIL`, `USER_PASSWORD` | authenticated scripts | Account with at least one team. |
| `TEAM_ID` | authenticated scripts | Target team UUID; defaults to the user's first team. |
| `PEAK_VUS`, `SPIKE_VUS` | `workload.js` | Defaults 20 / 60. |
| `SOAK_DURATION`, `PAGE_CAP` | `cursor-walk.js` | Defaults `5m` / 100 pages. |
| `ATTEMPTS`, `BUDGET` | `rate-limit.js` | Defaults 320 / 300. |

## Run

Ordered from least to most intrusive; `auth.js` and `rate-limit.js` consume the
request limiter budgets (`/auth` 100 / 15 min; `/teams` 300 / 15 min) so run
them sparingly and late:

```
k6 run k6/health.js
k6 run k6/smoke.js   -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<..>
k6 run k6/baseline.js -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<..>
k6 run k6/workload.js -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<..>
k6 run k6/cursor-walk.js -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<..>
k6 run k6/auth.js    -e USER_EMAIL=<..> -e USER_PASSWORD=<..>   # ~65 /auth requests, one window
k6 run k6/rate-limit.js     # last, against a disposable instance
```

Every script is read-only: no harness script creates or mutates records.

### Running from a machine without k6 (Docker)

k6 is not bundled on this dev machine; run the suite through the official
image instead. The build runs in its own container, so on Windows Docker
Desktop the API host is `host.docker.internal`:

```
docker run --rm -v "$PWD/k6:/scripts" -i grafana/k6 run /scripts/health.js
docker run --rm -v "$PWD/k6:/scripts" -i grafana/k6 run /scripts/smoke.js `
  -e BASE_URL=http://host.docker.internal:3000 `
  -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<..>
# ...same pattern for baseline.js / workload.js / cursor-walk.js / auth.js / rate-limit.js
```