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

2. A test user + team with seeded data. **Never point the seeded/user create at
   production.** A quick local setup using the public API:

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

   Then seed 10,000 activity rows:

   ```
   npm run db:seed:activity -- --team <team-uuid> --count 10000
   ```

   Create a handful of shifts through the API or SQL; the workload mix reads
   `shifts`, `activity`, and `members` only.

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

Ordered from least to most intrusive — run `rate-limit.js` last and on a
dedicated stress instance (it exhausts the source IP's 15-minute budget):

```
k6 run k6/health.js
k6 run k6/workload.js -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<..>
k6 run k6/cursor-walk.js -e USER_EMAIL=<..> -e USER_PASSWORD=<..> -e TEAM_ID=<..>
k6 run k6/rate-limit.js     # last, against a disposable instance
```

Every script is read-only: no harness script creates or mutates records.