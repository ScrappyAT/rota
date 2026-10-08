# Phase 3 Test Report

Executed **2026-10-08** against the live local Docker PostgreSQL 15 (host port
5440) and Redis 7 (6380). Database migrated to `003`; live data seeded to
10,000 activity rows before the run.

## Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | PASS (api, mobile, shared — 0 errors) |
| Lint | `npm run lint` | PASS — 0 errors, 5 pre-existing unused-import warnings |
| Tests | `npm test` | PASS — **4 suites, 43 tests** |

Note: `apps/api/jest.config.js` sets `maxWorkers: 1` so the two live-DB suites
never race on shared tables (each clears tables in `beforeAll`).

## New in this phase: `phase3.test.ts` (22 tests, live DB)

### Setup (`01`)
Registers six users, builds two teams, and populates Team A with a MANAGER and
three STAFF via the invitation flow — exercising `MEMBER_JOINED` activity.

### Shifts
| Test | Covers |
|---|---|
| `02` | Owner creates a shift with two assignees (201, assignments echoed) |
| `03` | Manager can create; STAFF create → 403 |
| `04` | `endsAt <= startsAt` → 400 `VALIDATION_ERROR` (create and patch) |
| `05` | Cross-team denial: shifts/activity/swaps/detail → 404 for non-members |
| `06` | Bad `teamId` → 400; malformed cursor → 400 `INVALID_CURSOR` |
| `07` | Assigning a non-member → 400 `INVALID_ASSIGNEE`, transaction rolled back (list length and assignments unchanged) |
| `08` | Detail includes assignments; `?assignedTo=` filter served |
| `09` | STAFF patch/delete → 403 |
| `10` | STAFF unassign self → 200; unassign others → 403; owner unassign → 200 |
| `11` | PATCH updates + status change; DELETE removes; feed shows `SHIFT_UPDATED`, `SHIFT_DELETED`, `SHIFT_CREATED`, `MEMBER_JOINED` |

### Swap workflow
| Test | Covers |
|---|---|
| `12` | Assigned STAFF requests swap (201, PENDING); duplicate request → 409 `SWAP_EXISTS` |
| `13` | Non-assigned request → 403; cross-team offeredTo → 400 `INVALID_ASSIGNEE`; cross-team detail → 404 |
| `14` | Owner approves → 200; assignment transferred (requester removed, offered user added); second approve → 409 `SWAP_NOT_PENDING` |
| `15` | Reject → 200; assignments unchanged |
| `16` | Non-requester cancel → 403; requester cancel → 200; second cancel → 409 |
| `17` | STAFF list sees only their requests; MANAGER list sees the team's |

### Activity + pagination
| Test | Covers |
|---|---|
| `18` | Feed team-isolated (404 across tenants; 200 for members) |
| `19` | 45 rows sharing an identical `created_at`: gapless walk, no duplicate ids, strict descending `(created_at, id)` order on every adjacent pair, and the id tie-break actually engaged |
| `20` | Mid-walk insert stability: no duplicates and every pre-existing row still present |
| `21` | `limit=9999` capped to ≤ 50 |
| `22` | Seed script: ≥ 10,000 rows inserted; rerun inserts 0 (idempotent); `--reset` restores 10,000 and touches no non-seed rows |

## Seed script (`scripts/seed-activity.ts`)

- Deterministic ids via `md5(team_id || ':' || index)::uuid` with
  `ON CONFLICT (id) DO NOTHING` — repeated runs insert nothing new.
- Timestamps anchored at `2026-01-01T00:00:00Z` with deliberate 3-row
  collisions (`index/3` seconds) so cursor tie-breaking is exercised.
- `--reset` deletes only rows whose `payload->>'source' = 'seed'`.
- Verified live: `inserted: 10000`, rerun `inserted: 0`, reset → 10,000 again.

## Verification environment

Seed team rows live in the dev database (team
`9cb9139e-4ba6-4e3d-b371-c933a6573636`, "Seed Demonstration Team").
EXPLAIN ANALYZE evidence in `docs/PAGINATION.md`.

## Not verified

Mobile screens (shifts/swaps/activity, shift detail/create) are
type-checked against the new API types but were not run on a device; mark them
"Implemented, not independently verified" in `docs/IMPLEMENTATION-STATUS.md`.