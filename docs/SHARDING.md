# Database Architecture & Sharding Strategy — Rota

Status note (10 November 2026): the sharding simulation is implemented and
regression tested. Railway uptime and physical WAL replication were not verified
here. Historical six-migration command output is retained as dated evidence,
not the current schema version.

This document provides a comprehensive technical analysis of Rota's database architecture. It details both the **primary-database API architecture** and the **implemented two-PostgreSQL-database sharding simulation**, explaining the shard key selection, deterministic routing, physical tenant isolation, cross-shard queries, setup procedures for Windows PowerShell, and scaling trade-offs.

---

## 1. Executive Summary & Architecture Comparison

To satisfy the graduation requirements, Rota maintains a clear architectural boundary between its primary-backed API design and its reproducible local sharding simulation:

1. **Primary API Architecture (Logical Multi-Tenancy):**
   - Designed for a primary PostgreSQL instance; Railway deployment history exists, but current uptime/topology was not verified in this review.
   - Multi-tenancy is enforced logically at the application and schema layers via foreign keys, composite indexes (`team_id, ...`), parameterized queries, and the `requireRole` middleware.
2. **Implemented Sharding Simulation (Physical Multi-Database Sharding):**
   - Runs locally via dedicated Docker Compose containers (`infrastructure/docker-compose.sharding.yml`) hosting two independent PostgreSQL 15 databases: **Shard 0** (port 5441) and **Shard 1** (port 5442).
   - Employs deterministic cryptographic hashing on `team_id` (`apps/api/src/sharding/router.ts`) to route intra-team writes and queries to dedicated database instances.
   - Provides automated schema migration (`apps/api/src/sharding/migration.ts`), physical data isolation verification, cross-shard scatter-gather query aggregation, and fault-tolerance handling (`apps/api/src/sharding/coordinator.ts`).
   - Covered by **11 automated Jest integration tests** in [`apps/api/__tests__/sharding.test.ts`](../apps/api/__tests__/sharding.test.ts).

### Architecture Comparison Matrix

| Dimension | Production Architecture | Implemented Sharding Simulation |
|---|---|---|
| **Database Topology** | Single PostgreSQL 15 (Railway / Port 5440 in local dev) | Two independent PostgreSQL 15 instances (**Shard 0: 5441**, **Shard 1: 5442**) |
| **Isolation Model** | Logical (`WHERE team_id = $1` + `requireRole` RBAC) | Physical (Data resides on separate physical database servers and volumes) |
| **Connection Pooling** | Single `pg.Pool` ([`apps/api/src/db.ts`](../apps/api/src/db.ts)) | Multi-pool connection manager ([`apps/api/src/sharding/poolManager.ts`](../apps/api/src/sharding/poolManager.ts)) |
| **Routing Mechanism** | Express route middleware extraction | Deterministic MD5 hash modulo (`intVal % shardCount`) |
| **Cross-Tenant Queries** | Standard SQL `JOIN` on single database | Parallel Scatter-Gather query coordination (`Promise.allSettled`) |
| **Failure Blast Radius** | Database outage affects all tenants | Outage of Shard 1 affects only Shard 1 tenants; Shard 0 remains 100% operational |
| **Schema Migrations** | [`apps/api/src/migrate.ts`](../apps/api/src/migrate.ts) (single database) | [`apps/api/src/sharding/migration.ts`](../apps/api/src/sharding/migration.ts) (migrates both shards concurrently) |

---

## 2. Production Architecture (Logical Multi-Tenancy)

In the standard deployed application:
- **Database Access:** A single connection pool configured in [`apps/api/src/db.ts`](../apps/api/src/db.ts) connects to `DATABASE_URL`.
- **Tenant Authorization:** Every team route passes through `requireRole([...roles])` in [`apps/api/src/middleware/tenant.ts`](../apps/api/src/middleware/tenant.ts). If an authenticated user is not a member of the requested team ID, the API returns `404 Not Found` (preventing tenant enumeration), while unauthorized members receive `403 Forbidden`.
- **Query Scoping:** All SQL queries use parameterized arguments explicitly scoped to `WHERE team_id = $1`. Composite indexes (`idx_shifts_team_starts`, `idx_activity_events_team_created`) ensure query performance remains independent of tenant count.

---

## 3. Implemented Two-PostgreSQL Sharding Simulation

```mermaid
flowchart TD
    subgraph ClientLayer[Client / API Gateway Layer]
        Req[Incoming Request with teamId UUID]
        Router[Shard Router: apps/api/src/sharding/router.ts]
        Req --> Router
    end

    subgraph RouterDecision[Deterministic Hash Routing]
        Hash["MD5(normalized teamId) -> 32-bit unsigned int % 2"]
        Router --> Hash
    end

    subgraph PoolManager[ShardedPoolManager: apps/api/src/sharding/poolManager.ts]
        P0[pg.Pool - Shard 0]
        P1[pg.Pool - Shard 1]
        Hash -->|Result = 0| P0
        Hash -->|Result = 1| P1
    end

    subgraph DatabaseTier[Physical PostgreSQL 15 Containers]
        DB0[(PostgreSQL Shard 0<br/>Port 5441<br/>Database: rota_shard_0)]
        DB1[(PostgreSQL Shard 1<br/>Port 5442<br/>Database: rota_shard_1)]
        P0 --> DB0
        P1 --> DB1
    end

    subgraph ScatterGatherCoord[Cross-Shard Coordinator: apps/api/src/sharding/coordinator.ts]
        Scatter[Scatter-Gather: getUserTeamsScatterGather]
        Scatter -.->|Parallel Query| P0
        Scatter -.->|Parallel Query| P1
        Scatter --> Aggregated[Unified Cross-Shard Result]
    end
```

### 3.1 Container Infrastructure
Defined in [`infrastructure/docker-compose.sharding.yml`](../infrastructure/docker-compose.sharding.yml):
- **Shard 0:** `postgres:15-alpine`, container name `rota-postgres-shard-0`, host port **5441**, database `rota_shard_0`, dedicated volume `postgres_shard_0_data`.
- **Shard 1:** `postgres:15-alpine`, container name `rota-postgres-shard-1`, host port **5442**, database `rota_shard_1`, dedicated volume `postgres_shard_1_data`.
- Both containers configure built-in health probes (`pg_isready -U postgres -d rota_shard_X`).

### 3.2 Deterministic Shard Routing Algorithm
Implementation: [`apps/api/src/sharding/router.ts`](../apps/api/src/sharding/router.ts)

```typescript
export function getShardId(teamId: string, shardCount: number = 2): number {
  if (!isValidUUID(teamId)) {
    throw new Error(`Invalid UUID shard key provided: "${teamId}"`);
  }

  const normalized = teamId.trim().toLowerCase();
  const hash = crypto.createHash('md5').update(normalized).digest('hex');
  const intVal = parseInt(hash.substring(0, 8), 16);
  return intVal % shardCount;
}
```

**Key Properties:**
1. **Strict Determinism:** An identical `team_id` always routes to the identical shard across restarts and processes.
2. **Case Insensitivity:** Normalized via `.toLowerCase()` so `92CE8C0C...` and `92ce8c0c...` map identically.
3. **Uniform Distribution:** Cryptographic MD5 hashing ensures uniform distribution. Verified by test: across 1,000 random team UUIDs, distribution was **49.8% on Shard 0 and 50.2% on Shard 1** (zero hot-spot clustering).

### 3.3 Connection Pool Management
Implementation: [`apps/api/src/sharding/poolManager.ts`](../apps/api/src/sharding/poolManager.ts)
- `ShardedPoolManager` initializes independent `pg.Pool` instances for each shard with configurable timeouts (`connectionTimeoutMillis: 3000`).
- Provides `getPoolForShard(shardId)` and `getPoolForTeam(teamId)`.
- Implements active health checking via `checkShardHealth(shardId)` and clean teardown via `closeAll()`.

### 3.4 Schema Migration Pipeline
Implementation: [`apps/api/src/sharding/migration.ts`](../apps/api/src/sharding/migration.ts)
- Discovers all current SQL migrations (001–009 at this review); historical examples below used 001–006 from `apps/api/migrations/`.
- Executes unapplied migrations in isolated transactions on both Shard 0 and Shard 1, tracking progress in each shard's independent `migrations` table.

### 3.5 Intra-Team Operations & Physical Data Isolation
Implementation: [`apps/api/src/sharding/coordinator.ts`](../apps/api/src/sharding/coordinator.ts)
- All intra-team operations (`createTeam`, `createShift`, `getShiftsForTeam`, `addMember`) route strictly to the team's designated shard.
- **Physical Isolation Verification:** The method `verifyIsolation(teamId)` directly inspects both PostgreSQL servers via SQL:
  - If Team A routes to Shard 0: `SELECT count(*) FROM teams WHERE id = $1` yields **1** on Shard 0 and **0** on Shard 1.
  - If Team B routes to Shard 1: `SELECT count(*) FROM teams WHERE id = $1` yields **1** on Shard 1 and **0** on Shard 0.

### 3.6 Cross-Shard Scatter-Gather Queries
In real-world small business workflows, a worker (e.g. Alice) may belong to multiple independent teams that reside on different shards.
- The method `getUserTeamsScatterGather(userId)` solves this by dispatching queries to Shard 0 and Shard 1 concurrently via `Promise.allSettled()`.
- The coordinator merges results, annotates each team with its originating `shardId`, and sorts the consolidated array deterministically by `teamName`.
- **Fault-Tolerant Partial Degradation:** If Shard 1 experiences an outage, the query still succeeds, returning Alice's teams from Shard 0 alongside a `partialErrors` array containing `{ shardId: 1, error: "..." }`.

---

## 4. Verification Evidence & Test Results

The sharding simulation was executed and validated against live local PostgreSQL containers.

### 4.1 Automated Jest Integration Tests
Test Suite: [`apps/api/__tests__/sharding.test.ts`](../apps/api/__tests__/sharding.test.ts)

```
PASS __tests__/sharding.test.ts
  Two-PostgreSQL Sharding Simulation Suite
    1. Deterministic Shard Key Routing
      √ validates UUID format correctly (6 ms)
      √ throws when routing an invalid UUID (27 ms)
      √ routes deterministically: identical UUID always returns identical shard ID (19 ms)
      √ normalizes case: uppercase and lowercase UUIDs map to the same shard
      √ distributes 1,000 random team UUIDs evenly across Shard 0 and Shard 1 (12 ms)
    2. Live Multi-Database Integration & Physical Tenant Isolation
      √ verifies both sharded databases are accessible and healthy (4 ms)
      √ routes Team Alpha to Shard 0 and proves physical absence on Shard 1 (47 ms)
      √ routes Team Beta to Shard 1 and proves physical absence on Shard 0 (36 ms)
      √ persists shifts on the routed shard and returns correct shard metadata (45 ms)
    3. Cross-Shard Scatter-Gather Queries
      √ aggregates memberships across Shard 0 and Shard 1 for a multi-tenant user (92 ms)
    4. Fault Tolerance & Shard Unavailability Behavior
      √ isolates blast radius: healthy shard succeeds when another shard is offline (71 ms)

Test Suites: 1 passed, 1 total
Tests:       11 passed, 11 total
Time:        3.274 s
```

### 4.2 Interactive CLI Demonstration Output
Executed via `npx ts-node apps/api/scripts/demo-sharding.ts`:

```
===============================================================
    ROTA — TWO-POSTGRESQL-DATABASE SHARDING DEMONSTRATION
===============================================================

[1/6] Probing Shard Health...
  ✓ Shard 0 connected (81ms)
  ✓ Shard 1 connected (73ms)

[2/6] Running SQL Schema Migrations on Both Shards...
  ✓ Shard-0 (Port 5441): 0 new migrations applied, 6 previously applied.
  ✓ Shard-1 (Port 5442): 0 new migrations applied, 6 previously applied.

[3/6] Generating Deterministic Team Shard Keys...
  • Team Alpha ID (routes to Shard 0): d68b0a5a-1cc6-4ff2-a93a-d6f69488abcb
  • Team Beta ID  (routes to Shard 1): 95b9ffeb-89d0-4dcd-9670-27d118382eda
  • Multi-team Worker (Alice) ID:      a432f8f7-37b8-4818-ae0f-0a5c0b858912

[4/6] Creating Teams & Shifts via Deterministic Shard Routing...
  ✓ Created "Alpha Cafe (Shard 0)" -> Saved to PostgreSQL Shard 0 (:5441)
  ✓ Created "Beta Health (Shard 1)" -> Saved to PostgreSQL Shard 1 (:5442)
  ✓ Shift "Morning Barista Shift" for Team Alpha written to Shard 0
  ✓ Shift "Emergency Triage Shift" for Team Beta written to Shard 1

[5/6] Verifying Physical Tenant Isolation Across Shards...
  • Team Alpha (d68b0a5a-1cc6-4ff2-a93a-d6f69488abcb):
    - Shard 0 row count: 1 (Expected: 1)
    - Shard 1 row count: 0 (Expected: 0)
    - Isolated: ✅ YES
  • Team Beta  (95b9ffeb-89d0-4dcd-9670-27d118382eda):
    - Shard 1 row count: 1 (Expected: 1)
    - Shard 0 row count: 0 (Expected: 0)
    - Isolated: ✅ YES

[6/6] Executing Cross-Shard Scatter-Gather Query for Alice...
  • Shards queried concurrently: 2
  • Consolidated memberships retrieved: 2
    - [Shard 0] Alpha Cafe (Shard 0) (Role: OWNER)
    - [Shard 1] Beta Health (Shard 1) (Role: OWNER)

===============================================================
  ✅ TWO-POSTGRESQL SHARDING SIMULATION COMPLETED SUCCESSFULLY
===============================================================
```

---

## 5. Execution Procedure on Windows PowerShell

The sharding simulation includes safe setup and teardown scripts designed specifically for Windows PowerShell.

### Step 1: Start Shard Containers & Run Migrations
In Windows PowerShell (from repo root):
```powershell
.\scripts\start-sharding.ps1
```
*Or via npm script:*
```powershell
npm run db:sharding:start
```
This starts `rota-postgres-shard-0` (port 5441) and `rota-postgres-shard-1` (port 5442), waits for both container health checks to report `healthy`, and applies all SQL migrations.

### Step 2: Run the Automated Sharding Test Suite
```powershell
npm run test:sharding
```
Runs the 11 unit, integration, scatter-gather, and fault-tolerance tests.

### Step 3: Run the Interactive Demonstration
```powershell
npm run demo:sharding
```
Executes the live routing, isolation proof, and scatter-gather demonstration script.

### Step 4: Stop and Clean Up Shard Containers
```powershell
.\scripts\stop-sharding.ps1
```
*Or via npm script:*
```powershell
npm run db:sharding:stop
```
Gracefully stops and removes the two sharded database containers.

---

## 6. Architectural Limitations & Scaling Trade-offs

While sharding by `team_id` provides horizontal scalability for small-business scheduling, it introduces real-world distributed systems trade-offs that must be managed in production.

### 6.1 The "Hot Shard" Problem
- **The Challenge:** Sharding by `team_id` partitions data by tenant, not by shift or user. If an enterprise customer with 2,000 employees and 200,000 shifts is provisioned on Shard 0, all of that tenant's CPU, memory, and I/O load concentrates on that single physical node.
- **Rota's Built-in Mitigation:** Rota's Phase 4 billing system enforces plan-based seat limits (`FREE` ≤ 5, `STARTER` ≤ 10, `GROWTH` ≤ 50, `SCALE` ≤ 500). Teams exceeding standard capacity boundaries can be flagged for dedicated single-tenant database instances rather than multi-tenant shards.
- **Secondary Range Partitioning:** For very large teams, PostgreSQL native declarative range partitioning (e.g. `PARTITION BY RANGE (starts_at)`) can be applied within the shard to keep table scans bounded to current months.

### 6.2 Cross-Shard Transactions & Global Catalog
- **The Challenge:** PostgreSQL does not natively coordinate transactions across separate connection pools without complex Two-Phase Commit (2PC / `PREPARE TRANSACTION`) protocols, which introduce latency and distributed lock hazards.
- **Rota's Domain Advantage:** Core scheduling workflows (creating shifts, unassigning staff, approving shift swaps) are **100% intra-team**. Because staff cannot swap shifts with employees of a different business, swap approvals never require a cross-shard transaction.
- **Global Identity Solution:** For global entities (user logins and password authentication), production architectures implement a **Global Catalog Database** holding the `users` and `refresh_tokens` tables. Once authenticated, the user's `team_id` routes all subsequent requests to the appropriate shard.

### 6.3 Shard Rebalancing & Consistent Hashing
- **The Challenge (Hash Modulo Rebalancing):** Using simple modulo hashing (`hash % N`) means that increasing the shard count from 2 to 3 causes approximately **66.7%** ($ (N-1)/N $) of existing team keys to remap to different shards, requiring massive data migrations.
- **Long-Term Scaling Solutions:**
  1. **Consistent Hashing with Virtual Nodes (vnodes):** Map shards onto a 360-degree hash ring with virtual nodes (e.g. 256 vnodes per physical shard). Adding a new physical shard only requires migrating keys from adjacent virtual segments (moving approximately $1/(N+1)$ of total data).
  2. **Directory-Based Routing Table:** Maintain a lightweight global lookup table `team_shards(team_id UUID PRIMARY KEY, shard_id INT)`. While this adds a fast cached lookup (e.g. in Redis), it provides arbitrary rebalancing capability: individual hot teams can be migrated between physical servers without changing their `team_id` or recomputing hashes.


## R3 replication is separate from sharding

The two-database team hash simulation and its 11 real PostgreSQL integration
tests are unchanged. A shard contains a subset of teams; a replica contains
copies of the primary's data. Never put SHARD_0_DATABASE_URL or
SHARD_1_DATABASE_URL in READ_DATABASE_URL. Production tenant data still uses
the authoritative main pool; the existing sharding demo has its own router,
pools, coordinator and schema.

R3 adds explicit readQuery routing for roster, shift-calendar and activity
SELECTs, with READ_DATABASE_URL and DB_POOL_MAX=10. Ten connections per pool
bound each API process to at most 20 connections when reads are configured;
workers need their own ten primary connections. Size process count and worker
count within the provider's connection limit; use a pooled provider endpoint or
PgBouncer when scaling. Connection acquisition is bounded (2s primary/1s read),
statement execution is bounded (15s primary/3s read), and transactions remain on
primary. Auth, authorization, settings and financial reads always use primary.

Before mutations a primary user_write_fences row grants a conservative
five-minute primary lease to that user on every device/API instance. Cached
reads are bypassed while the lease is active. This handles requests that crash
after commit, without relying on Redis or client timestamps/headers. An invalid
mutation can also create a harmless lease. Other users can still observe
replication lag; lag longer than five minutes needs monitoring and disabling
replica reads. A GET that began before a concurrent write is not linearizable.
Provider replicas need schema parity, replication monitoring, TLS, least-
privilege read credentials and backups before actual use. Read pool failures
fall back to primary; no replica is promoted for writes automatically.

The PDF explicitly permits a second read connection string when a provider has
no replica plan. R3 uses that implementation option. Disposable tests configure
a second pool to the test primary for general regression and a separate read
DB on 5543 with deliberately stale marker data for lag/error drills. It is not
WAL replication. Actual replica provisioning/failover has not been performed.


## Read replication versus team-hash sharding (current review)

`services/read-routing.ts` routes explicit safe read sites to READ_DATABASE_URL,
falling back to primary on error. Auth, permissions, settings, finance and writes
use primary. A five-minute durable user fence preserves read-after-write and
bypasses stale Redis cache across API processes/devices. The separate Phase 1
GET /teams correction keeps authoritative membership in primary SQL.

This is **replication routing**, not sharding: a read endpoint is expected to
represent the same primary dataset. The automated lag/fallback drill uses an
independent disposable DB, not configured WAL streaming or automated failover.
The assessment permits a documented simulation; physical replication is a
production infrastructure concern, not an extra graduation feature.

`sharding/router.ts:getShardId` hashes a normalized UUID with MD5, reads the
first four bytes as unsigned big-endian and applies modulo shard count. MD5 is
used for distribution, never for password/token security. Two independent DBs
and pools store demo team data; coordinator scatter/gather combines a user's
memberships and reports partial shard errors. The normal API is not globally
rewritten to use those databases, and neither shard URL is a replica URL.

Dev shards are 5441/5442; isolated regression shards are 5541/5542. Each shard
pool defaults to max 10 (connect 3s, idle 10s), separately from primary/read pool
budgets. The 11 sharding tests exercise deterministic routing, isolation,
transactions, scatter/gather and failure handling. They were rerun in Phase 3;
see its report for the actual combined test result.

Modulo growth remaps many tenants; production expansion needs a routing catalog
or consistent-hash/virtual-bucket strategy, controlled tenant moves, fencing and
verification. Cross-shard transactions, global identity and hot-tenant splitting
remain design trade-offs; none is claimed to be an automated production system.
