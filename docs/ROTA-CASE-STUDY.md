# Rota — Team Shift Scheduling Mobile App with Financial and Operational Integrity

> **Portfolio Case Study**  
> **Author**: Samuel Emmanuel  
> **Repository**: [github.com/ScrappyAT/rota](https://github.com/ScrappyAT/rota)  
> **Live API**: [rota-production-84ef.up.railway.app](https://rota-production-84ef.up.railway.app/health)  
> **Android Preview**: [Download APK (Expo Build 947dc9d2)](https://expo.dev/artifacts/eas/r197ay-RMlQSdm-zTC_w1I4b_gD85C3_c0NBXPBYi8w.apk)  
> **LinkedIn Post**: [Engineering Write-up](https://lnkd.in/p/edPwxhTV)

---

## Executive Summary

Rota is a production-grade, multi-tenant mobile shift-scheduling application built for shift-based businesses such as restaurants, retail shops, and medical clinics. The system pairs an **Expo / React Native** mobile client with a high-performance **Node.js, Express, PostgreSQL, and Redis** backend.

In shift-based workplaces, scheduling mistakes, missed swaps, and untracked billing lead to operational friction and revenue loss. Rota solves this by coupling strict tenant isolation and role-based access control with an atomic shift-swap state machine, cursor-paginated activity auditing, an append-only financial ledger, and a transactional background job outbox.

---

## Technical Stack & Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Mobile Client (Expo)                     │
│    React Native 0.86 · Expo Router · SecureStore · Query    │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS (REST + JWT)
                               ▼
┌─────────────────────────────────────────────────────────────┐
│             Railway Production Single Container             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │     Process Supervisor (combined-server.ts)           │  │
│  │   ┌─────────────────────┐   ┌──────────────────────┐  │  │
│  │   │  Express 4 REST API │   │ BullMQ Worker Daemon │  │  │
│  │   │     (Port 8080)     │   │ (Outbox Processor)   │  │  │
│  │   └──────────┬──────────┘   └──────────┬───────────┘  │  │
│  └──────────────┼─────────────────────────┼──────────────┘  │
└─────────────────┼─────────────────────────┼─────────────────┘
                  │                         │
                  ▼                         ▼
   ┌─────────────────────────┐   ┌────────────────────────┐
   │ PostgreSQL 15 (Primary) │   │ Redis 7 (Cache/Queues) │
   │  - Row-level isolation  │   │  - Cache-aside layer   │
   │  - Immutable ledger     │   │  - Sensitive limiters  │
   │  - Transactional outbox │   │  - BullMQ job stream   │
   └─────────────────────────┘   └────────────────────────┘
```

- **Frontend**: Expo SDK 57, React Native 0.86, Expo Router, TypeScript, React Query (TanStack v5), Expo SecureStore for encrypted token persistence.
- **Backend API**: Node.js, Express 4, TypeScript strict mode, Zod validation, `pg` connection pool.
- **Data & Caching**: PostgreSQL 15, Redis 7 (cache-aside, atomic rate limiters, BullMQ streams).
- **Background Workers**: BullMQ 5 worker daemon backed by a transactional PostgreSQL `job_outbox`.
- **Payment Gateway**: Flutterwave (hosted checkout, webhooks, idempotency keys, and reconciliation).
- **Testing & Quality**: 478 automated Jest/Supertest tests across 44 suites, k6 load testing harness, ESLint, TypeScript strict compiler checks.

---

## Key Engineering Challenges & Solutions

### 1. Multi-Tenant Isolation & Role Hierarchy
- **Challenge**: Users frequently belong to multiple teams with different responsibilities (e.g., Owner of a restaurant, Staff at a clinic). Leaking cross-tenant data or unauthorized actions violates business isolation.
- **Solution**: Role assignments (`OWNER`, `MANAGER`, `STAFF`) are strictly scoped per team in `team_memberships`. All team-scoped endpoints execute an `authenticate` and `requireRole([...])` middleware gate. Non-members receive a generic 404 to prevent team enumeration, while unauthorized members receive a 403. Last-owner protection ensures a business can never accidentally orphan or lock out its account.

### 2. Atomic Shift Swaps & Keyset Cursor Pagination
- **Challenge**: Concurrent shift swaps can lead to double-assignment races. Furthermore, reading high-volume team activity feeds using traditional SQL `OFFSET` causes performance degradation and pagination drift when new events occur mid-scroll.
- **Solution**:
  - **Atomic Swaps**: Shift swap requests follow a strict state machine (`PENDING` → `APPROVED` / `REJECTED` / `CANCELLED`). Approval executes within an explicit database transaction with `SELECT ... FOR UPDATE`, atomically swapping assignments and publishing a corresponding activity record.
  - **Keyset Pagination**: Pagination utilizes a deterministic `(created_at, id)` composite keyset cursor with matching composite indexes. In benchmarking against a 10,000-row activity dataset, queries remain sub-millisecond without page drift or duplicate items.

### 3. Financial Integrity & Subscription Billing
- **Challenge**: Recurring subscription upgrades and seat expansions require proration without floating-point inaccuracies, duplicate payment charges, or inconsistent subscription states during webhook delivery delays.
- **Solution**:
  - **Exact Money Math**: All currency calculations operate in integer minor units (cents) with separate-floor proration calculation.
  - **Idempotency**: All billing endpoints enforce a client UUID `Idempotency-Key`, caching and returning matching responses to prevent double-charging over spotty mobile networks.
  - **Append-Only Ledger**: Subscriptions utilize an append-only financial ledger (`financial_ledger`). Financial adjustments require new compensating records rather than destructive in-place mutations.
  - **Reconciliation Safeguards**: In PR #6, Flutterwave verification was hardened with sanitized error categorization, bounded retry backoffs, a 5-minute deferral on still-`QUEUED` checkouts, and precise claim-age measurement via `updated_at` to eliminate race conditions between initialization and reconciliation.

### 4. Durable Outbox & Single-Container Supervision
- **Challenge**: Sending push notifications or calling third-party payment APIs inside HTTP request lifecycles creates latency, potential timeout failures, and data inconsistency if the server restarts before the call finishes. In addition, Railway resource constraints restricted deployment to a single container.
- **Solution**:
  - **Transactional Outbox**: Business mutations commit notifications and payment tasks directly into `job_outbox` in the same transaction. If the database rolls back, no orphan job is created.
  - **BullMQ Workers**: Background workers pull jobs from Redis/BullMQ, check server-owned quiet hours and user notification preferences, and execute bounded retries.
  - **Process Supervision**: Created `apps/api/src/combined-server.ts` to manage both the Express HTTP server and the BullMQ worker inside a single Railway container. The supervisor monitors both child processes; if either encounters an unhandled fatal exception, the supervisor shuts down gracefully with non-zero exit so Railway's container orchestrator can cleanly restart the instance.

### 5. Redis Cache-Aside & Load Performance
- **Challenge**: Mobile shift calendars and activity feeds experience read-heavy traffic spikes during shift handoffs.
- **Solution**: Implemented cache-aside caching on team rosters (300s TTL), shift calendars (120s TTL), and activity feeds (60s TTL) with explicit invalidation upon mutations.
- **Measured Results**: Tested with a 200-virtual-user k6 load harness against a 10,000-row database seed:
  - Throughput increased by **+74.9%**.
  - Median response time (p50) dropped by **-49.9%**.
  - p95 latency improved from **1,271.55 ms to 710.95 ms** with **0% HTTP error rate**.

---

## Production Verification & Acceptance Results

On **18 November 2026**, Rota completed end-to-end production verification across infrastructure, billing, and mobile runtime:

1. **Railway Cloud Backend**:
   - Live URL: `https://rota-production-84ef.up.railway.app`
   - Healthcheck `/health` returns HTTP 200 OK (`status: ok`, `db: ok`, `redis: ok`).
   - Combined supervisor runs Express API (port 8080) and BullMQ worker concurrently.

2. **Flutterwave USD Subscription Flow**:
   - Verified live in sandbox: Team "Mayo" upgraded from FREE to Starter plan ($20 USD/mo, 5 seats) via `POST /teams/:teamId/subscription/checkout`.
   - Test card authorized and OTP verification completed.
   - Subscription transitioned to `ACTIVE`.
   - Invoice marked `PAID`.
   - Application logic commits the corresponding `CHARGE` entry to the append-only `financial_ledger` table upon settlement (not independently queried in production DB).

3. **Physical Android Device Acceptance**:
   - Verified on a physical Samsung device with installable preview APK (Build `947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf`, reported expiry **24 November 2026**).
   - User-confirmed manual flows: shift creation and assignment, assigned shift visibility in staff account schedule, staff shift-swap request and manager-only approval, activity feed updates, and push notification delivery/settings.
   - Automated regression test coverage (not claimed as manually observed on device): keyset cursor pagination gaplessness and boundary stability across equal timestamps, quiet-hours suppression calculation logic, and SecureStore session persistence across cold app restarts.

4. **Automated Testing Suite**:
   - Historical 10 November 2026 integrated release baseline: **478 tests across 44 suites** passing in Jest/Supertest (136.167s).
   - Subsequent test suites: added supervisor process tests (`combined-server.test.ts`, 3 tests) and payment reconciliation safeguards (`paymentReconciliation.test.ts`, 14 tests) with zero regressions.
   - 0 TypeScript compiler errors in strict mode.
   - 0 ESLint errors across all workspaces.

---

## Architecture Links & Source Artifacts

- **GitHub Repository**: [ScrappyAT/rota](https://github.com/ScrappyAT/rota) (Branch: `codex/graduation-release-2026-11-10`)
- **Graduation Demo Video**: [Watch on Google Drive](https://drive.google.com/file/d/1-39i6l2UYL1paP3qimbb0Ga-dg96-V2e/view?usp=sharing) (public access verified HTTP 200)
- **System Architecture**: [docs/ARCHITECTURE.md](ARCHITECTURE.md)
- **Security & RBAC**: [docs/SECURITY.md](SECURITY.md)
- **Financial & Money Model**: [docs/BILLING.md](BILLING.md)
- **Database Sharding Simulation**: [docs/SHARDING.md](SHARDING.md)
- **Load Testing Report**: [load-tests/REPORT.md](../load-tests/REPORT.md)
- **Performance Analysis**: [docs/PERFORMANCE-REPORT.md](PERFORMANCE-REPORT.md)
- **Graduation Release Report**: [docs/GRADUATION-RELEASE-REPORT.md](GRADUATION-RELEASE-REPORT.md)
