# Performance Testing (k6)

This page documents the load-testing harness in [`k6/`](../k6), how to run it,
and what the thresholds assert. Results are recorded below (last section).

## Scope

The suite measures the read paths the mobile app exercises most and the shipped
rate-limit behavior:

| Script | Endpoint mix | Scenario shape |
|---|---|---|
| `k6/health.js` | `GET /health` | smoke — 1 VU, 30 s |
| `k6/smoke.js` | shifts list → shift detail, members, swaps, activity, filtered activity, one cursor page | 1 VU, 20 iters |
| `k6/baseline.js` | shifts / activity / swaps / filtered activity / members (weighted) | constant 5 VUs, 2 min |
| `k6/workload.js` | `GET /teams/:teamId/shifts`, `/activity`, `/swaps`, `/members` (weighted) | ramp → steady → spike → cool down |
| `k6/cursor-walk.js` | `GET /teams/:teamId/activity` following `nextCursor` | soak — 2 VUs, 3 min |
| `k6/auth.js` | `POST /auth/login`, `GET /auth/me`, occasional `POST /auth/refresh` | 1 VU, 30 iters |
| `k6/rate-limit.js` | `GET /teams` with **no** credentials | exhaust the 300/15 min/IP budget |

Every script is **read-only** — none creates or mutates records. The activity
feeds use the 10,000-row dataset seed
(`npm run db:seed:dataset -w @rota/api -- --users 40 --teams 5 --shifts 500 --activity 10000`).

## Before you run

See [`k6/README.md`](../k6/README.md) for installation and local data setup.
Prerequisite shape:

1. k6 installed (`k6 version`), or Docker (`docker run --rm -i grafana/k6`).
2. API running and migrated (`npm run db:start`, `npm run db:migrate`,
   `npm run dev:api`).
3. **Large dataset**: seed it with
   `npm run db:seed:dataset -w @rota/api -- --users 40 --teams 5 --shifts 500 --activity 10000`.
   (Seeded accounts log in with password `seed-only-account`, e.g.
   `seed.user.1@loadtest.local`.) **Create the test account/team/seed data on a
   dedicated stress instance, never on production.**

> The `/teams` and `/auth` rate-limit budgets are env-configurable for
> load-test instances (`TEAMS_RATE_LIMIT_MAX`, `INVITATIONS_RATE_LIMIT_MAX`,
> `AUTH_RATE_LIMIT_MAX`; defaults 300/300/100). For a sustained HTTP scenario
> start the API with `TEAMS_RATE_LIMIT_MAX=100000` and `AUTH_RATE_LIMIT_MAX=2000`
> so the harness measures server latency, not the limiter. Production defaults
> are unchanged.

### Targets

- Local: `BASE_URL` defaults to `http://localhost:3000`.
- Deployed: `-e BASE_URL=https://<railway-host>`. Use HTTPS; k6 treats
  `localhost` specially for TLS.

## Running

Ordered least → most intrusive. Run `auth.js` before `rate-limit.js`, and run
`rate-limit.js` **last** against a disposable instance — it intentionally
exhausts the 15-minute rate budget for its source IP:

```bash
# 0. (dev machine only) docker fallback: export k6 args via -e BASE_URL=http://host.docker.internal:3000
#    and mount with: docker run --rm -v "PWD\k6:/scripts" -i grafana/k6 run /scripts/<name>.js -e ...

# 1. Health smoke + single-user full read path smoke
k6 run k6/health.js
k6 run k6/smoke.js \
  -e USER_EMAIL=seed.user.1@loadtest.local -e USER_PASSWORD=seed-only-account \
  -e TEAM_ID=<team-uuid>

# 2. Main workload (ramp/steady/spike)
k6 run k6/baseline.js \
  -e USER_EMAIL=seed.user.1@loadtest.local -e USER_PASSWORD=seed-only-account \
  -e TEAM_ID=<team-uuid>
k6 run k6/workload.js \
  -e USER_EMAIL=seed.user.1@loadtest.local -e USER_PASSWORD=seed-only-account \
  -e TEAM_ID=<team-uuid>

# 4. Cursor pagination soak (drains the 10k feed repeatedly)
k6 run k6/cursor-walk.js \
  -e USER_EMAIL=seed.user.1@loadtest.local -e USER_PASSWORD=seed-only-account \
  -e TEAM_ID=<team-uuid>

# 5. Auth + refresh chain
k6 run k6/auth.js \
  -e USER_EMAIL=seed.user.1@loadtest.local -e USER_PASSWORD=seed-only-account

# 6. Rate-limit proof — last, on a dedicated instance with default budgets
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
| `smoke.js` | `p(95) < 150 ms`, `p(99) < 300 ms` | full read path |
| `baseline.js` | `p(95) < 250 ms`, `p(99) < 500 ms` | constant 5-VU mix |
| `rate-limit.js` | `rota_rate_limited > 1` | limiter demonstrably engaged (any 429 past the budget) |

These are starting points, not product SLAs; tune against the deployment's
resources (single-rail vs multi-replica, Postgres size) and record the final
values in the results table.

## Rate-limit note

`/auth/*` is limited to 100 req / 15 min / IP; `/teams`, `/invitations` to
300; `/devices` to 200 via a shared Redis store. Budgets default to
`AUTH_RATE_LIMIT_MAX=100`, `TEAMS_RATE_LIMIT_MAX=300`,
`INVITATIONS_RATE_LIMIT_MAX=300` and are overridable via env for load-test
instances. `rate-limit.js` only asserts the `/teams` limiter (it runs before
auth, so it works without credentials). Because the limiters are fixed-window
and tracked per origin IP, a burst test that exceeds the budget locks out that
IP for the remainder of the window — hence the "run last / disposable instance"
rule.

## Results (last full local run, 2026-10-13)

Environment: local Docker Desktop (Postgres 15 :5440, Redis 7 :6380), API
:3000, load from a local `grafana/k6` container over
`host.docker.internal`. HTTP scenarios ran with raised dev budgets
(`TEAMS_RATE_LIMIT_MAX=100000`, `AUTH_RATE_LIMIT_MAX=2000`); `auth.js` and
`rate-limit.js` ran at default budgets. Full narrative in
`docs/PERFORMANCE-REPORT.md`.

| Run | Target | Scenario | Peak VUs | p95 (ms) | p99 (ms) | Error rate | Result |
|---|---|---|---|---|---|---|---|
| 1 | local :3000 | health | 1 | 4.78 | — (max 34.8) | 0% | pass |
| 2 | local :3000 | smoke | 1 | 14.74 | — | 0% | pass |
| 3 | local :3000 | baseline | 5 | 79.63 | 302 (max) | 0% | pass |
| 4 | local :3000 | workload | 60 | 62.73 | 167.86 | 0% | pass |
| 5 | local :3000 | cursor-walk | 2 | 24.45 | 64.57 | 0% | pass |
| 6 | local :3000 | auth | 1 | 179.38 (login) / 21.18 (me) | 222.25 | 0% | pass |
| 7 | local :3000 | rate-limit | 1 | — | — | intentional 429 | pass (20/320) |
| 8 | staging | workload | — | — | — | — | **not run — no staging target** |

Workload headline: 30,115 requests / 71.6 req/s, avg 18.59 ms, med 9.76 ms,
p90 31.25 ms, p99 167.86 ms, max 612 ms, 0% failed. Rate-limit proof: exactly
20 of 320 attempts throttled on a fresh window (300 budget), 100% on a follow-up
run from the still-throttled origin.

## Related

- `docs/PAGINATION.md` — cursor design and the measured 10k-row plans.
- `docs/DEPLOYMENT.md` — standing up the target instance.
- `docs/SUBMISSION.md` — graduation checklist that this evidence feeds into.