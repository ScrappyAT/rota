# Performance Testing (k6)

This page documents the load-testing harness in [`k6/`](../k6), how to run it,
and what the thresholds assert. Results are recorded below (last section).

## Scope

The suite measures the read paths the mobile app exercises most and the shipped
rate-limit behavior:

| Script | Endpoint mix | Scenario shape |
|---|---|---|
| `k6/health.js` | `GET /health` | smoke — 1 VU, 30 s |
| `k6/workload.js` | `GET /teams/:teamId/shifts`, `/activity`, `/members` (weighted) | ramp → steady → spike → cool down |
| `k6/cursor-walk.js` | `GET /teams/:teamId/activity` following `nextCursor` | soak — 2 VUs, 5 min |
| `k6/rate-limit.js` | `GET /teams` with **no** credentials | exhaust the 300/15 min/IP budget |

Every script is **read-only** — none creates or mutates records. The activity
feed spells use the 10,000-row seed (`npm run db:seed:activity`).

## Before you run

See [`k6/README.md`](../k6/README.md) for installation and local data setup.
Prerequisite shape:

1. k6 installed (`k6 version`).
2. API running and migrated (`npm run db:start`, `npm run db:migrate`,
   `npm run dev:api`).
3. A test account with at least one team, activity seeded to 10,000 rows, and
   a handful of shifts. **Create the test account/team/seed data on a
   dedicated stress instance, never on production.**

### Targets

- Local: `BASE_URL` defaults to `http://localhost:3000`.
- Deployed: `-e BASE_URL=https://<railway-host>`. Use HTTPS; k6 treats
  `localhost` specially for TLS.

## Running

Ordered least → most intrusive. Run `rate-limit.js` **last** and against a
disposable instance — it intentionally exhausts the 15-minute rate budget for
its source IP:

```bash
# 1. Health smoke
k6 run k6/health.js

# 2. Main workload (ramp/steady/spike)
k6 run k6/workload.js \
  -e USER_EMAIL=loadtest@example.com \
  -e USER_PASSWORD='...' \
  -e TEAM_ID=<team-uuid>

# 3. Cursor pagination soak (drains the 10k feed repeatedly)
k6 run k6/cursor-walk.js \
  -e USER_EMAIL=loadtest@example.com \
  -e USER_PASSWORD='...' \
  -e TEAM_ID=<team-uuid>

# 4. Rate-limit proof — last, on a dedicated instance
k6 run k6/rate-limit.js -e BASE_URL=https://<disposable-host>
```

Optional overrides: `PEAK_VUS`, `SPIKE_VUS`, `SOAK_DURATION`, `PAGE_CAP`,
`ATTEMPTS`. All documented in `k6/README.md`.

## Thresholds (as shipped)

Applied through `k6/common.js#defaultThresholds` unless noted:

| Metric | Threshold | Meaning |
|---|---|---|
| `http_req_failed` | `< 1%` | error budget for all HTTP |
| `http_req_duration` | `p(95) < 300 ms`, `p(99) < 800 ms` | latency at the 95th/99th percentile |
| `rota_successful_requests` | `> 99%` | reads returned `{ success: true }` |
| `health.js` | `p(95) < 150 ms` | health probe budget |
| `rate-limit.js` | `rota_rate_limited > 33` | limiter demonstrably engaged |

These are starting points, not product SLAs; tune against the deployment's
resources (single-rail vs multi-replica, Postgres size) and record the final
values in the results table.

## Rate-limit note

`/auth/*` is limited to 100 req / 15 min / IP; `/teams`, `/invitations` to
300; `/devices` to 200 via a shared Redis store. `rate-limit.js` only asserts
the `/teams` limiter (it runs before auth, so it works without credentials).
Because the limiters are fixed-window and tracked per origin IP, a burst test
that exceeds the budget locks out that IP for the remainder of the window —
hence the "run last / disposable instance" rule.

## Results (pending execution)

k6 is not installed on the graduation build machine, so **no load run has been
executed in this environment yet**. Nothing below is fabricated. Record real
output here once a run happens (typically `k6 run ...` prints each threshold
pass/fail in its summary):

| Run | Target | Scenario | Peak VUs | p95 (ms) | p99 (ms) | Error rate | Result |
|---|---|---|---|---|---|---|---|
| 1 | local :3000 | workload | 20 | — | — | — | pending |
| 2 | local :3000 | cursor-walk | 2 | — | — | — | pending |
| 3 | local :3000 | health | 1 | — | — | — | pending |
| 4 | staging | workload | 20 | — | — | — | pending |

## Related

- `docs/PAGINATION.md` — cursor design and the measured 10k-row plans.
- `docs/DEPLOYMENT.md` — standing up the target instance.
- `docs/SUBMISSION.md` — graduation checklist that this evidence feeds into.