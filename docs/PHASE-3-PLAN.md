# Rota — Phase 3 Implementation Plan

Scope: shift management, shift assignment, swap requests, activity feed, cursor
pagination, seed data, and the mobile screens that consume them. **Nothing in
this document is implemented yet.** Follow `AGENTS.md` while building it.

---

## 1. Database migrations

New file: `apps/api/migrations/003_shifts_swaps_activity.sql` (next free
number; never edit `001`/`002`). Runs in one transaction via `npm run db:migrate`.

```sql
CREATE TYPE shift_status AS ENUM ('ACTIVE', 'CANCELLED');
CREATE TYPE swap_status  AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

CREATE TABLE shifts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    starts_at TIMESTAMP WITH TIME ZONE NOT NULL,
    ends_at   TIMESTAMP WITH TIME ZONE NOT NULL,
    status shift_status NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (ends_at > starts_at)
);

CREATE TABLE shift_assignments (
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    assigned_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (shift_id, user_id)
);

CREATE TABLE swap_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shift_id UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
    requested_by UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    offered_to UUID REFERENCES users(id) ON DELETE SET NULL, -- NULL = open to anyone
    status swap_status NOT NULL DEFAULT 'PENDING',
    reason TEXT,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE activity_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
    type VARCHAR(64) NOT NULL,          -- e.g. SHIFT_CREATED, MEMBER_JOINED
    payload JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

### Indexes (match every hot access path and every sort order)

```sql
-- Primary cursor-pagination order for shifts: (team_id, starts_at, id)
CREATE INDEX idx_shifts_team_starts ON shifts (team_id, starts_at, id);
-- Cancelled/past filtering without disturbing the above
CREATE INDEX idx_shifts_team_status_starts ON shifts (team_id, status, starts_at, id);

CREATE INDEX idx_shift_assignments_user ON shift_assignments (user_id);
CREATE INDEX idx_shift_assignments_shift ON shift_assignments (shift_id);

CREATE INDEX idx_swap_requests_shift ON swap_requests (shift_id, status);
CREATE INDEX idx_swap_requests_requester ON swap_requests (requested_by, status, created_at, id);
CREATE INDEX idx_swap_requests_pending_target ON swap_requests (status, created_at) WHERE status = 'PENDING';

-- Activity feed cursor order: (team_id, created_at, id)
CREATE INDEX idx_activity_team_created ON activity_events (team_id, created_at, id);
CREATE INDEX idx_activity_team_type_created ON activity_events (team_id, type, created_at, id);
CREATE INDEX idx_activity_actor ON activity_events (actor_id);
```

Migration rules (from `AGENTS.md`): UUID PKs, `TIMESTAMP WITH TIME ZONE`,
parameterized SQL only, never edit an applied migration.

---

## 2. API endpoints

All routes mount under `router.use(authenticate)` and every team-scoped route
uses `requireRole([...])`. All list endpoints use cursor pagination. Every
response uses the `ApiResponse<T>` envelope. Request bodies are validated with
Zod schemas added to `packages/shared/src/schemas.ts` (**rebuild `dist/` after
editing**).

### Shifts

| Method & path | Roles | Body / query | Notes |
|---|---|---|---|
| `GET /teams/:teamId/shifts` | OWNER, MANAGER, STAFF | `cursor`, `limit` (≤50, default 20), `from`, `to`, `status` | Cursor-paginated, ordered `starts_at DESC, id DESC` |
| `POST /teams/:teamId/shifts` | OWNER, MANAGER | `{ title, description?, startsAt, endsAt, assigneeIds? }` | Validates `endsAt > startsAt`; assignees must be team members; writes `SHIFT_CREATED` activity in the same transaction |
| `GET /teams/:teamId/shifts/:shiftId` | OWNER, MANAGER, STAFF | — | Includes assignments joined to `users` |
| `PATCH /teams/:teamId/shifts/:shiftId` | OWNER, MANAGER | `{ title?, description?, startsAt?, endsAt?, status? }` | Writes `SHIFT_UPDATED` |
| `DELETE /teams/:teamId/shifts/:shiftId` | OWNER, MANAGER | — | Hard delete; writes `SHIFT_DELETED`; pending swaps for the shift are cancelled in the same transaction |
| `POST /teams/:teamId/shifts/:shiftId/assignments` | OWNER, MANAGER | `{ userIds: uuid[] }` | Batch assign; rejects non-members with 400; writes `SHIFT_ASSIGNED` |
| `DELETE /teams/:teamId/shifts/:shiftId/assignments/:userId` | OWNER, MANAGER **or self** | — | Staff may unassign themselves only; writes `SHIFT_UNASSIGNED` |

### Swaps

| Method & path | Roles | Body | Notes |
|---|---|---|---|
| `GET /teams/:teamId/swaps` | OWNER, MANAGER, STAFF | `cursor`, `limit`, `status` | Staff see their own requests; owners/managers see all (team-scoped) |
| `POST /teams/:teamId/shifts/:shiftId/swaps` | self must be assigned | `{ offeredTo?, reason? }` | Only a current assignee may request; rejects duplicate PENDING request for the same shift (409 `SWAP_EXISTS`); writes `SWAP_REQUESTED` |
| `POST /teams/:teamId/swaps/:swapId/approve` | OWNER, MANAGER, or the `offered_to` user | — | Transaction: re-check status is PENDING, move assignment from requester → approver (if `offered_to` set) or mark approved for manual reassignment, set `reviewed_*`, write `SWAP_APPROVED` |
| `POST /teams/:teamId/swaps/:swapId/reject` | OWNER, MANAGER, or the `offered_to` user | `{ reason? }` | PENDING → REJECTED; writes `SWAP_REJECTED` |
| `POST /teams/:teamId/swaps/:swapId/cancel` | requester only | — | PENDING → CANCELLED |

Approval must be idempotent-safe: perform the status transition with
`UPDATE swap_requests SET status = ... WHERE id = $1 AND status = 'PENDING'`
and return 409 `SWAP_NOT_PENDING` when 0 rows are updated.

### Activity feed

| Method & path | Roles | Notes |
|---|---|---|
| `GET /teams/:teamId/activity` | OWNER, MANAGER, STAFF | Cursor-paginated `created_at DESC, id DESC`; optional `type` filter; payload contains denormalized display fields (`actorName`, `shiftTitle`, …) so the feed needs no N+1 joins |

**Activity write rule:** insert `activity_events` inside the *same* transaction
as the mutation that caused it, so the feed can never disagree with the data.
Required types for Phase 3: `SHIFT_CREATED`, `SHIFT_UPDATED`, `SHIFT_DELETED`,
`SHIFT_ASSIGNED`, `SHIFT_UNASSIGNED`, `SWAP_REQUESTED`, `SWAP_APPROVED`,
`SWAP_REJECTED`, `SWAP_CANCELLED`, plus `MEMBER_JOINED` (hook into invitation
accept) as a low-cost extra.

---

## 3. Permission rules (matrix)

| Action | OWNER | MANAGER | STAFF |
|---|---|---|---|
| View shifts / activity / swaps (team member) | yes | yes | yes |
| Create / edit / delete shift | yes | yes | no |
| Assign anyone / unassign anyone | yes | yes | no |
| Unassign self | yes | yes | yes |
| Request a swap | only if assigned | only if assigned | only if assigned |
| Approve / reject swap | yes | yes | only when they are the offered recipient |
| Cancel own swap request | yes | yes | yes |

Enforcement rules:

1. Membership first (`requireRole` → 404 for non-members, 403 for wrong role).
2. Resource-level checks (e.g. "requester must be assigned to this shift",
   "approver must be manager or the offered user") run inside the handler, in
   the same transaction as the write, always re-read from the DB — never trust
   client-supplied user IDs for authorization.
3. Assignee IDs supplied by the client are validated against
   `team_memberships` for the same `team_id`; a cross-team ID is a 400, never a
   silent assignment.

---

## 4. Cursor pagination design

- Cursor = `base64url(JSON.stringify({ t: <ISO timestamp of last row>, i: <id of last row> }))`.
  Opaque to clients; reject malformed cursors with 400 `INVALID_CURSOR`.
- Query pattern (example for shifts, same shape for activity and swaps):

```sql
SELECT ... FROM shifts
WHERE team_id = $1
  AND ($2::timestamptz IS NULL OR (starts_at, id) < ($2, $3::uuid))
  AND ($4::timestamptz IS NULL OR starts_at >= $4)
  AND ($5::timestamptz IS NULL OR starts_at <  $5)
  AND status = COALESCE($6, status)
ORDER BY starts_at DESC, id DESC
LIMIT $7;               -- fetch limit + 1 rows; `hasMore = rows.length > limit`
```

- The `(value, id)` tuple comparison gives a **total order**, so rows never
  duplicate or get skipped when new records are inserted mid-pagination —
  plain `timestamp`-only cursors are not sufficient because timestamps collide.
- Never use `OFFSET`. Never expose page numbers.
- Index `(team_id, starts_at, id)` (already listed) lets Postgres do a backward
  index scan; verify with `EXPLAIN (ANALYZE, BUFFERS)` once seeded data exists.
- Shared helper: `apps/api/src/pagination.ts` — `encodeCursor`,
  `decodeCursor`, `parseLimit` so all three lists behave identically.

---

## 5. Seed script (10,000 activity records)

- File: `apps/api/scripts/seed-activity.ts`, run with
  `npx ts-node apps/api/scripts/seed-activity.ts --team <uuid> --count 10000`
  (also add an npm script `db:seed:activity` at the root).
- Use a single `INSERT ... SELECT generate_series(...)` statement with
  deterministic values (team fixed, actor rotating through the team's members,
  `created_at` spread backwards from `now()` at 1–90 second intervals) so the
  cursor order has realistic timestamp collisions and the id tie-break is
  exercised.
- Idempotency: `--reset` flag deletes previously seeded rows for that team
  (tagged in `payload.source = 'seed'`) before inserting. Never truncate
  tables, never delete rows it did not create.
- Success criterion: `SELECT count(*) FROM activity_events WHERE team_id = ...`
  ≥ 10,000, and `EXPLAIN ANALYZE` of the first and last feed page shows an
  index scan, not a sort.

---

## 6. Mobile (Phase 3 screens)

- **Shifts tab** (`app/(tabs)/index.tsx`): `FlatList` grouped by day;
  `onEndReached` loads the next page from `data[data.length-1]` cursor,
  `RefreshControl` re-requests page 1 and replaces the list. Keep
  `{ items, cursor, hasMore, refreshing }` in one `useShifts(teamId)` hook;
  ignore stale responses with a request-id guard.
- **Swaps tab** (`app/(tabs)/swaps.tsx`): same infinite-scroll pattern;
  approve/reject buttons shown only when the current user's role (from team
  membership) or `offeredTo` allows it.
- **Activity tab** (`app/(tabs)/activity.tsx`): infinite scroll + pull to
  refresh, plain list rows rendered from the denormalized payload.
- **Shift detail/creation**: add `app/teams/[id]/shifts/new.tsx` and
  `app/teams/[id]/shifts/[shiftId].tsx` using the existing `teams/` stack
  conventions (see `apps/mobile/app/teams/invite.tsx` for the pattern).
- API calls go through `src/api/client.ts` (it already attaches the bearer
  token and refreshes once on 401). Add typed methods rather than scattering
  raw `request(...)` calls.
- Offline/10k-record performance notes: render only the loaded window,
  `initialNumToRender` ≈ 10, `windowSize` ≈ 7, stable `keyExtractor` on ids.

---

## 7. Tests required for Phase 3

Integration (live DB, in `apps/api/__tests__/`, same style as Phase 2):

1. Happy path: create shift → appears in `GET /teams/:teamId/shifts` →
   assignment → activity entries exist.
2. Cross-tenant denial: non-member gets 404 on every new endpoint; member
   without role gets 403 (staff creating a shift, staff approving a swap).
3. Invalid input denial: `endsAt <= startsAt` → 400; non-UUID params → 400;
   assigning a user from another team → 400.
4. Swap lifecycle: request → approve moves the assignment; request → reject
   leaves it unchanged; double-approve → 409; cancel by non-requester → 403.
5. Pagination: seed 60+ rows with colliding timestamps; walk every page and
   assert no duplicates and no gaps; insert new rows between page fetches and
   assert the walk is still gapless; malformed cursor → 400.
6. Seed script: run against a scratch team, assert count ≥ 10,000.
7. Last-page behavior: `hasMore` false when fewer than `limit` rows remain.

Gates before any Phase 3 task is called done: `npm run typecheck`,
`npm run lint`, `npm test` — all green, plus `docs/IMPLEMENTATION-STATUS.md`
updated.

---

## 8. Suggested build order

1. Migration `003` + shared Zod schemas/types (rebuild `@rota/shared`).
2. `pagination.ts` helper + shifts CRUD endpoints + tests.
3. Assignments + permission matrix tests.
4. Swap endpoints + lifecycle tests.
5. Activity writes (hooked into 2–4) + feed endpoint + pagination tests.
6. Seed script + `EXPLAIN ANALYZE` verification.
7. Mobile: shifts → activity → swaps screens, then the new detail/creation
   routes in `teams/`.
8. Update `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION-STATUS.md`.
