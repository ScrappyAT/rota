# Rota â€” Final Graduation Load Test & Caching Report

**Execution Date:** 2026-10-15
**Target Environment:** Local Development Environment Only (Docker PostgreSQL 15 on `:5440`, Redis 7 on `:6380`, Node.js Express API on `:3000`).
**Dataset:** Seeded deterministic large dataset (`apps/api/scripts/seed-dataset.ts`): 40 users, 5 teams, 500 shifts, 1,226 assignments, 154 swaps, 10,000 activity rows.
**Load Generator:** `grafana/k6:latest` (Docker container targeting `http://host.docker.internal:3000`).

---

## 1. Executive Summary

To achieve final graduation load-test compliance, the Rota backend was enhanced with a Redis cache-aside layer for team roster, shift calendar, and activity feed reads, backed by explicit cache invalidation on business mutations.

A dedicated load test with **200 virtual users simultaneously loading the activity feed** was executed against the local API, comparing performance **before caching** (`ENABLE_REDIS_CACHE=false`) and **after caching** (`ENABLE_REDIS_CACHE=true`).

### Key Highlights:
- **Throughput:** Increased by **+74.9%** (from 168.61 req/s to 294.93 req/s).
- **Total Requests Handled:** Increased by **+72.2%** (from 7,765 requests to 13,372 requests in the same 45-second test window).
- **Median Latency (p50):** Decreased by **49.9%** (from 932.77 ms down to 467.37 ms).
- **95th Percentile Latency (p95):** Decreased by **44.1%** (from 1,271.55 ms down to 710.95 ms).
- **99th Percentile Latency (p99):** Decreased by **33.3%** (from 1,530.00 ms down to 1,020.00 ms).
- **Reliability:** **0.00% error rate** across both runs with 100% adherence to the `ApiResponse<T>` envelope.
- **Tenant Isolation:** Cache keys are strictly namespaced by `teamId`; mutations in one team never invalidate or leak data to another team.

---

## 2. Benchmark Comparison (200 Simultaneous Virtual Users)

The table below reports the empirical results captured from the dedicated 200-VU activity feed scenario (`load-tests/activity-200vu.js`):

| Metric | Before Caching (PostgreSQL Only) | After Caching (Redis Cache-Aside) | Delta / Improvement |
|:---|:---:|:---:|:---:|
| **Concurrent Virtual Users** | 200 VUs | 200 VUs | Identical concurrency |
| **Test Duration** | 45 seconds (10s ramp, 30s peak, 5s cool) | 45 seconds (10s ramp, 30s peak, 5s cool) | Identical profile |
| **Total HTTP Requests** | **7,765** | **13,372** | **+72.2% (+5,607 reqs)** |
| **Request Throughput** | **168.61 req/s** | **294.93 req/s** | **+74.9% (+126.32 req/s)** |
| **Completed Iterations** | **7,764** | **13,371** | **+72.2%** |
| **HTTP Error Rate** | **0.00%** (0 / 7,765) | **0.00%** (0 / 13,372) | **0 errors (Pass)** |
| **Envelope Integrity (`success:true`)** | **100.00%** | **100.00%** | **100% verified** |
| **Min Latency** | 8.07 ms | 6.90 ms | -14.5% |
| **Median Latency (p50)** | **932.77 ms** | **467.37 ms** | **-49.9% (-465.40 ms)** |
| **Average Latency** | **868.91 ms** | **459.90 ms** | **-47.1% (-409.01 ms)** |
| **90th Percentile (p90)** | **1,139.95 ms** | **653.07 ms** | **-42.7% (-486.88 ms)** |
| **95th Percentile (p95)** | **1,271.55 ms** | **710.95 ms** | **-44.1% (-560.60 ms)** |
| **99th Percentile (p99)** | **1,530.00 ms** | **1,020.00 ms** | **-33.3% (-510.00 ms)** |
| **Max Latency** | 1,701.27 ms | 1,583.61 ms | -6.9% |
| **Data Transferred** | 99 MB (2.2 MB/s) | 172 MB (3.8 MB/s) | +73.7% data volume |

---

## 3. Caching Architecture & Implementation Details

Caching was designed following a cache-aside pattern implemented in `apps/api/src/services/cache.ts`.

### 3.1 Documented TTLs and Key Schemas

| Resource | Route | Cache Key Pattern | TTL |
|:---|:---|:---|:---:|
| **Team Roster** | `GET /teams/:teamId/members` | `cache:roster:${teamId}` | 300 s (5 min) |
| **Shift Calendar** | `GET /teams/:teamId/shifts` | `cache:shifts:${teamId}:${hash(queryParams)}` | 120 s (2 min) |
| **Activity Feed** | `GET /teams/:teamId/activity` | `cache:activity:${teamId}:${hash(queryParams)}` | 60 s (1 min) |

*Parameter Hashing:* For shift queries and activity feed queries that support pagination cursors and filters, query parameters (`from`, `to`, `status`, `assignedTo`, `type`, `cursor`, `limit`) are normalized and hashed into a deterministic 16-character SHA-256 fingerprint.

### 3.2 Invalidation Matrix

Cache invalidation occurs immediately after PostgreSQL transactions commit successfully:

| Mutation | Route | Keys Invalidated |
|:---|:---|:---|
| **Member Role Change** | `PATCH /teams/:teamId/members/:userId/role` | `cache:roster:${teamId}` |
| **Member Removal** | `DELETE /teams/:teamId/members/:userId` | `cache:roster:${teamId}` |
| **Invitation Accept** | `POST /invitations/accept` | `cache:roster:${teamId}`, `cache:activity:${teamId}:*` |
| **Shift Creation** | `POST /teams/:teamId/shifts` | `cache:shifts:${teamId}:*`, `cache:activity:${teamId}:*` |
| **Shift Update** | `PATCH /teams/:teamId/shifts/:shiftId` | `cache:shifts:${teamId}:*`, `cache:activity:${teamId}:*` |
| **Shift Deletion** | `DELETE /teams/:teamId/shifts/:shiftId` | `cache:shifts:${teamId}:*`, `cache:activity:${teamId}:*` |
| **Shift Assignment** | `POST /teams/:teamId/shifts/:shiftId/assignments` | `cache:shifts:${teamId}:*`, `cache:activity:${teamId}:*` |
| **Shift Unassignment**| `DELETE /teams/:teamId/shifts/:shiftId/assignments/:userId`| `cache:shifts:${teamId}:*`, `cache:activity:${teamId}:*` |
| **Swap Request** | `POST /teams/:teamId/shifts/:shiftId/swaps` | `cache:activity:${teamId}:*` |
| **Swap Approval** | `POST /teams/:teamId/swaps/:swapId/approve` | `cache:shifts:${teamId}:*`, `cache:activity:${teamId}:*` |
| **Swap Rejection** | `POST /teams/:teamId/swaps/:swapId/reject` | `cache:activity:${teamId}:*` |
| **Swap Cancellation**| `POST /teams/:teamId/swaps/:swapId/cancel` | `cache:activity:${teamId}:*` |

### 3.3 Security & Non-Negotiable Invariants
- **No Subscription/Billing Caching:** Subscription status checks (`assertSubscriptionActive`, `assertCanGrow`) always query PostgreSQL directly to prevent stale authorization or seat tampering.
- **Tenant Isolation:** Cache keys require a `teamId` prefix. Tests verify that actions in Team 1 never evict or expose keys in Team 2.
- **Resilience / Fallback:** If Redis is down or unreachable, the cache service catches errors gracefully and falls back to PostgreSQL without interrupting HTTP request processing.
- **Controllable Toggle:** The cache is controllable via the `ENABLE_REDIS_CACHE` environment variable (defaults to `true`).

---

## 4. Test Verification

Nine dedicated automated integration tests in `apps/api/__tests__/cache.test.ts` verify:
1. Cache misses query PostgreSQL and populate Redis with expected TTLs.
2. Subsequent reads hit Redis and return identical data.
3. Roster cache is evicted when roles are patched or members are removed.
4. Shift cache is evicted across all filtered views when shifts are created, modified, assigned, or deleted.
5. Swap approvals invalidate affected shift assignment views and the activity feed.
6. Tenant isolation ensures mutations in one team do not invalidate another team's cache.
7. Setting `ENABLE_REDIS_CACHE=false` cleanly bypasses Redis storage.

**Overall test suite status:** 18 test suites passed, 236 tests passed, 0 failures.

---

## 5. How to Reproduce

### Step 1: Start local infrastructure and seed dataset
```powershell
npm.cmd run db:start
npm.cmd run db:migrate
npm.cmd run db:seed:dataset -- --users 40 --teams 5 --shifts 500 --activity 10000
```

### Step 2: Build packages
```powershell
npm.cmd run build:shared
npm.cmd run build:api
```

### Step 3: Run Benchmark with Cache Disabled
```powershell
# Start API with cache disabled in terminal 1
node scripts/run-loadtest-api.js

# In terminal 2, execute the 200-VU k6 run
docker run --rm -v "${PWD}\load-tests:/scripts" -i grafana/k6 run /scripts/activity-200vu.js `
  -e BASE_URL=http://host.docker.internal:3000 `
  -e USER_EMAIL=seed.user.1@loadtest.local `
  -e USER_PASSWORD=seed-only-account `
  -e TEAM_ID=b7ad9c24-d603-a4ea-c7c5-682dceac00e8
```

### Step 4: Run Benchmark with Cache Enabled
```powershell
# Start API with cache enabled in terminal 1
node scripts/run-loadtest-api.js --cache=true

# In terminal 2, execute the 200-VU k6 run
docker run --rm -v "${PWD}\load-tests:/scripts" -i grafana/k6 run /scripts/activity-200vu.js `
  -e BASE_URL=http://host.docker.internal:3000 `
  -e USER_EMAIL=seed.user.1@loadtest.local `
  -e USER_PASSWORD=seed-only-account `
  -e TEAM_ID=b7ad9c24-d603-a4ea-c7c5-682dceac00e8
```
