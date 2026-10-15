# Rota — k6 Load-Testing Suite

Grafana k6 scripts for validating the Rota API under load.
Full report with before/after caching metrics lives in [`load-tests/REPORT.md`](./REPORT.md) and [`docs/PERFORMANCE-REPORT.md`](../docs/PERFORMANCE-REPORT.md).

## Scenarios in this folder

| Script | Path exercised | Scenario / Concurrency |
|---|---|---|
| `activity-200vu.js` | `GET /teams/:teamId/activity` | **Graduation benchmark: 200 VUs simultaneous (45s)** |
| `health.js` | `/health` (+ DB & Redis probes) | 1 VU, 30 s |
| `smoke.js` | shifts list → shift detail, members, swaps list, activity feed, filtered feed | 1 VU, 20 iters |
| `baseline.js` | shifts / activity / swaps / filtered activity / members | 5 VUs, 2 min |
| `workload.js` | shifts, activity, swaps, members mix | ramp 0→20, steady 3 min, spike→60, recover |
| `cursor-walk.js` | activity feed drained via `nextCursor` | 2 VUs, 3 min soak |
| `auth.js` | `POST /auth/login`, `GET /auth/me`, `POST /auth/refresh` | 1 VU, 30 iters |
| `rate-limit.js` | unauthenticated `GET /teams` budget test | 1 VU, 320 attempts |

## Prerequisites for the authenticated scenarios

1. Start local infrastructure and apply migrations:
   ```powershell
   npm run db:start
   npm run db:migrate
   ```

2. Seed the 10k-record deterministic dataset:
   ```powershell
   npm run db:seed:dataset -- --users 40 --teams 5 --shifts 500 --activity 10000
   ```

3. Build packages:
   ```powershell
   npm run build:shared
   npm run build:api
   ```

## Running the 200-VU Graduation Load Test

To compare response times before and after caching:

### 1) Run Benchmark with Cache Disabled (PostgreSQL only)
```powershell
# In terminal 1:
node scripts/run-loadtest-api.js

# In terminal 2:
docker run --rm -v "${PWD}\load-tests:/scripts" -i grafana/k6 run /scripts/activity-200vu.js `
  -e BASE_URL=http://host.docker.internal:3000 `
  -e USER_EMAIL=seed.user.1@loadtest.local `
  -e USER_PASSWORD=seed-only-account `
  -e TEAM_ID=b7ad9c24-d603-a4ea-c7c5-682dceac00e8
```

### 2) Run Benchmark with Cache Enabled (Redis Cache-Aside)
```powershell
# In terminal 1 (Ctrl+C first, then restart with cache):
node scripts/run-loadtest-api.js --cache=true

# In terminal 2:
docker run --rm -v "${PWD}\load-tests:/scripts" -i grafana/k6 run /scripts/activity-200vu.js `
  -e BASE_URL=http://host.docker.internal:3000 `
  -e USER_EMAIL=seed.user.1@loadtest.local `
  -e USER_PASSWORD=seed-only-account `
  -e TEAM_ID=b7ad9c24-d603-a4ea-c7c5-682dceac00e8
```

Detailed results and comparison table are available in [`REPORT.md`](./REPORT.md).