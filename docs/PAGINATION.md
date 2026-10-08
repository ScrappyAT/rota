# Cursor Pagination

All list endpoints that can grow unbounded use **keyset (seeker) pagination**
over a stable total order. There is no `OFFSET` anywhere in Phase 3.

## Ordering

Every paginated list orders by a timestamp and a UUID tie-breaker:

| Endpoint | Order |
|---|---|
| `GET /teams/:teamId/shifts` | `starts_at DESC, id DESC` |
| `GET /teams/:teamId/activity` | `created_at DESC, id DESC` |
| `GET /teams/:teamId/swaps` | `created_at DESC, id DESC` |

The `id` tie-break makes the order **total** even when many rows share a
timestamp (recurring schedule, seed data, same-second writes), so pagination
cannot skip or repeat rows between pages.

## Cursor Format

A cursor is opaque to clients: `base64url(JSON.stringify({ t, i }))` where `t`
is the last row's timestamp as ISO 8601 and `i` is the last row's id (UUID).
Produced by `encodeCursor` in `apps/api/src/pagination.ts`, decoded safely by
`decodeCursor`; malformed cursors return 400 `INVALID_CURSOR`.

The WHERE clause for "rows after the cursor" is written explicitly as:

```sql
WHERE (created_at < $ts OR (created_at = $ts AND id < $uuid))
```

(The explicit tuple form is used instead of `(created_at, id) < ($ts, $uuid)`
record comparison to avoid null/degenerate behavior and keep plans simple.)

## Page Shape

Every paginated endpoint returns:

```ts
{
  items: T[],
  nextCursor: string | null,
  hasMore: boolean
}
```

The where-clause fetches `limit + 1` rows; `page()` in `pagination.ts` drops
the extra row, sets `nextCursor` from the last returned row when more exist,
and reports `hasMore`. Default `limit` is 20, maximum enforced is 50; larger
requests are silently capped. Stability: because the cursor only moves
backward in the total order, rows inserted during a walk do not disturb
pages already fetched (new rows sit "above" the cursor). Verified by an
integration test that inserts rows mid-walk and asserts no gaps or duplicates.

## Measured Plans (10,000 rows)

Seeded `activity_events` for a single team (10,000 rows) and ran the feed
query (`WHERE team_id = … ORDER BY created_at DESC, id DESC LIMIT 21`) on the
live Docker Postgres. "Index disabled" simulates the pre-index plan without
dropping the index (`SET enable_indexscan=off; SET enable_bitmapscan=off;`).

### Without index (seq scan + sort)

```
Limit  (cost=781.63..781.68 rows=21 width=142) (actual … rows=21 loops=1)
  Buffers: shared hit=393
  -> Sort  (cost=781.63..806.63 rows=10000 …) (actual … rows=21 loops=1)
       Sort Key: created_at DESC, id DESC
       Sort Method: top-N heapsort  Memory: 30kB
       Buffers: shared hit=393
       -> Seq Scan on activity_events a  (cost=0.00..512.01 rows=10000 …)
            Filter: (team_id = '<uuid>'::uuid)
            Rows Removed by Filter: 1
            Buffers: shared hit=387
Planning Time: 1.566 ms
Execution Time: 3.536 ms
```

### With `idx_activity_team_created (team_id, created_at, id)`

```
Limit  (cost=0.29..4.71 rows=21 …) (actual … rows=21 loops=1)
  Buffers: shared hit=5
  -> Index Scan Backward using idx_activity_team_created on activity_events a
       Index Cond: (team_id = '<uuid>'::uuid)
       Buffers: shared hit=5
Planning Time: 2.578 ms
Execution Time: 0.299 ms
```

The composite index removes the sort entirely: the planner walks the index
backwards (matching `DESC` order) and stops after 21 rows. ~12× faster wall
time (3.54 ms → 0.30 ms) and 393 → 5 buffers. Shifts use
`idx_shifts_team_starts (team_id, starts_at, id)`, swaps use
`idx_swaps_team_created (team_id, created_at, id)`, and the activity `type`
filter is served by `idx_activity_team_type_created (team_id, type,
created_at, id)` — all defined in `apps/api/migrations/003_*.sql`.

## Mobile

`useInfiniteQuery` (`@tanstack/react-query`) drives list screens with
`getNextPageParam: (p) => p.nextCursor`, `onEndReached` fetching the next page,
and pull-to-refresh clearing the query. Lists use the core `FlatList` today;
migrating to FlashList is a large-roster follow-up (FlatList was chosen first
because it requires no additional native module, keeping the app compatible
with Expo Go — FlashList needs a development build).