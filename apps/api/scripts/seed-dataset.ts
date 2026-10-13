/**
 * Seed a realistic, multi-tenant load-test dataset.
 *
 * Generates a self-contained world of synthetic users, teams, shifts,
 * assignments, swaps, and at least 10,000 activity-feed records — distributed
 * across users (actors), teams, and event types — so the read paths
 * (shifts, members, swaps, activity feed) can be validated and load-tested
 * against representative data.
 *
 * Safety properties
 * -----------------
 * - **Contains no real data.** Every row belongs to the deterministic
 *   `rota-seed-dataset` uuid namespace and a seed-only email pattern; real
 *   users and teams are never read, modified, or referenced.
 * - **Deterministic and repeatable.** All ids, choices, and timestamps derive
 *   from a fixed PRNG seed and a fixed timestamp anchor. Re-running always
 *   produces the same final dataset (each run first removes the previous seed
 *   rows, then re-inserts identical rows; bulk inserts use
 *   `ON CONFLICT ... DO NOTHING`).
 * - **Cleanup.** Deletion is entirely scoped to the deterministic seed ids and
 *   the `payload->>'source' = 'seed-dataset'` marker, in FK-safe order.
 *
 * Usage (from repo root):
 *   npm run db:seed:dataset [-- --users 40 --teams 5 --shifts 500 --activity 10000]
 *
 * The generated activity timestamps deliberately collide in groups of three so
 * the cursor pagination (created_at, id) tie-breaker is exercised.
 */
import { pool } from '../src/db';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DATASET_DEFAULTS = {
  users: 40,
  teams: 5,
  shifts: 500,
  activity: 10000,
};

export const SEED_SOURCE = 'seed-dataset';

// Weighted (total = 100) event-type mix. Management events act with an
// OWNER/MANAGER; SWAP_* and MEMBER_JOINED events act with ordinary members.
export const EVENT_TYPES: ReadonlyArray<{ type: string; weight: number }> = [
  { type: 'SHIFT_CREATED', weight: 12 },
  { type: 'SHIFT_ASSIGNED', weight: 20 },
  { type: 'SHIFT_UPDATED', weight: 13 },
  { type: 'SHIFT_UNASSIGNED', weight: 8 },
  { type: 'SHIFT_DELETED', weight: 5 },
  { type: 'SWAP_REQUESTED', weight: 11 },
  { type: 'SWAP_APPROVED', weight: 6 },
  { type: 'SWAP_REJECTED', weight: 5 },
  { type: 'SWAP_CANCELLED', weight: 4 },
  { type: 'MEMBER_JOINED', weight: 9 },
  { type: 'SUBSCRIPTION_CHANGED', weight: 3 },
  { type: 'PAYMENT_RECEIVED', weight: 4 },
];

const SHIFT_TITLES = [
  'Morning shift',
  'Evening shift',
  'Weekend brunch',
  'Late night close',
  'Prep shift',
  'Front of house',
  'Kitchen support',
  'Inventory count',
  'Lunch rush',
  'Closing duties',
];

const FIRST_NAMES = [
  'Ada', 'Ben', 'Chioma', 'Dara', 'Emeka', 'Farida', 'Gideon', 'Hauwa',
  'Ijeoma', 'Jide', 'Kelechi', 'Latifa', 'Musa', 'Ngozi', 'Obinna', 'Precious',
  'Quadri', 'Rukayya', 'Seyi', 'Tunde', 'Uche', 'Vera', 'Wale', 'Yemi',
  'Zainab', 'Aisha', 'Bola', 'Chinedu', 'Dami', 'Efe', 'Femi', 'Gloria',
  'Halima', 'Ifeanyi', 'Joy', 'Kunle', 'Lola', 'Amara', 'Nnamdi', 'Oluwaseun',
];

const LAST_NAMES = [
  'Adebayo', 'Balogun', 'Chukwu', 'Diya', 'Eze', 'Fashola', 'Gbadamosi',
  'Hassan', 'Ibrahim', 'Johnson', 'Kalu', 'Lawal', 'Mohammed', 'Nwachukwu',
  'Okafor', 'Oyelaran', 'Peters', 'Quadri', 'Rahman', 'Suleiman', 'Tella',
  'Umar', 'Vincent', 'Waziri', 'Yakubu', 'Akanbi', 'Bamidele', 'Chikere',
  'Durojaiye', 'Enahoro', 'Folarin', 'Gbolahan', 'Hammed', 'Ibeh', 'Jimoh',
  'Kazeem', 'Ladipo', 'Makinde', 'Nwosu', 'Olabode', 'Ogunleye',
];

// Fixed anchor so reruns reproduce identical rows (nothing depends on the clock).
const ANCHOR = new Date('2026-05-01T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Deterministic generation helpers
// ---------------------------------------------------------------------------

/** md5("rota-seed-dataset:<kind>:<index>") formatted as a uuid. */
export const seedUuid = (kind: string, index: number): string => {
  const digest = crypto
    .createHash('md5')
    .update(`rota-seed-dataset:${kind}:${index}`)
    .digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-${digest.slice(12, 16)}-${digest.slice(16, 20)}-${digest.slice(20)}`;
};

// Mulberry32 — deterministic PRNG so every pseudo-random choice is stable
// across runs and platforms.
const mulberry32 = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pick = <T>(rng: () => number, items: ReadonlyArray<T>): T =>
  items[Math.floor(rng() * items.length)];

export interface DatasetOptions {
  users?: number;
  teams?: number;
  shifts?: number;
  activity?: number;
}

export interface DatasetResult {
  users: number;
  teams: number;
  shifts: number;
  assignments: number;
  swaps: number;
  activityInserted: number;
  totalActivity: number;
}

// ---------------------------------------------------------------------------
// Synthetic world
// ---------------------------------------------------------------------------

interface TeamWorld {
  teamIds: string[];
  ownerIds: string[];
  managerIds: string[][];
  staffIds: string[][];
  /** Every member (owner + managers + staff) per team. */
  memberIds: string[][];
}

interface UserSeedRow {
  id: string;
  email: string;
  first: string;
  last: string;
}

const buildUsers = (count: number, prng: () => number): UserSeedRow[] => {
  const rows: UserSeedRow[] = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      id: seedUuid('user', i),
      email: `seed.user.${i + 1}@loadtest.local`,
      first: FIRST_NAMES[i % FIRST_NAMES.length],
      last: LAST_NAMES[(i * 3) % LAST_NAMES.length],
    });
  }
  return rows;
};

const buildTeams = (opts: { userCount: number; teamCount: number }, prng: () => number): TeamWorld => {
  const teamIds: string[] = [];
  const ownerIds: string[] = [];
  const managerIds: string[][] = [];
  const staffIds: string[][] = [];
  const memberIds: string[][] = [];

  for (let t = 0; t < opts.teamCount; t++) {
    const teamId = seedUuid('team', t);
    const ownerIdx = (t * 5) % opts.userCount;
    const ownerId = seedUuid('user', ownerIdx);

    const used = new Set<number>([ownerIdx]);
    const managers: string[] = [];
    const staff: string[] = [];
    const managerSlots = 1 + Math.floor(prng() * 2);
    const staffSlots = 4 + Math.floor(prng() * 5);

    while (managers.length < managerSlots) {
      const idx = Math.floor(prng() * opts.userCount);
      if (used.has(idx)) continue;
      used.add(idx);
      managers.push(seedUuid('user', idx));
    }
    while (staff.length < staffSlots) {
      const idx = Math.floor(prng() * opts.userCount);
      if (used.has(idx)) continue;
      used.add(idx);
      staff.push(seedUuid('user', idx));
    }

    teamIds.push(teamId);
    ownerIds.push(ownerId);
    managerIds.push(managers);
    staffIds.push(staff);
    memberIds.push([ownerId, ...managers, ...staff]);
  }
  return { teamIds, ownerIds, managerIds, staffIds, memberIds };
};

// ---------------------------------------------------------------------------
// SQL bulk helpers
// ---------------------------------------------------------------------------

const exec = async <T = unknown>(
  sql: string,
  params: unknown[]
): Promise<{ rows: T[]; rowCount: number }> =>
  (await pool.query(sql, params)) as unknown as { rows: T[]; rowCount: number };

const insertUsers = async (userRows: UserSeedRow[], passwordHash: string) => {
  if (userRows.length === 0) return;
  await exec(
    `INSERT INTO users (id, email, first_name, last_name, password_hash, created_at)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::timestamptz[])
     ON CONFLICT (id) DO NOTHING`,
    [
      userRows.map((r) => r.id),
      userRows.map((r) => r.email),
      userRows.map((r) => r.first),
      userRows.map((r) => r.last),
      userRows.map(() => passwordHash),
      userRows.map((_, i) => new Date(ANCHOR.getTime() + i * 60000).toISOString()),
    ]
  );
};

const insertTeams = async (world: TeamWorld) => {
  if (world.teamIds.length === 0) return;
  await exec(
    `INSERT INTO teams (id, name, owner_id, created_at)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::uuid[], $4::timestamptz[])
     ON CONFLICT (id) DO NOTHING`,
    [
      world.teamIds,
      world.teamIds.map((_, t) => `Seed Cafe ${String.fromCharCode(65 + t)}`),
      world.ownerIds,
      world.teamIds.map(() => ANCHOR.toISOString()),
    ]
  );
};

const insertMemberships = async (world: TeamWorld) => {
  const ids: string[] = [];
  const teamIds: string[] = [];
  const userIds: string[] = [];
  const roles: string[] = [];

  world.teamIds.forEach((teamId, t) => {
    world.memberIds[t].forEach((userId, m) => {
      ids.push(seedUuid(`membership-${t}`, m));
      teamIds.push(teamId);
      userIds.push(userId);
      roles.push(userId === world.ownerIds[t] ? 'OWNER' : 'STAFF');
    });
  });

  // Managers override the default STAFF role.
  world.teamIds.forEach((teamId, t) => {
    world.managerIds[t].forEach((managerId) => {
      const i = teamIds.findIndex((tid, idx) => tid === teamId && userIds[idx] === managerId);
      if (i >= 0) roles[i] = 'MANAGER';
    });
  });

  if (ids.length === 0) return;
  await exec(
    `INSERT INTO team_memberships (id, team_id, user_id, role, created_at)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::user_role[], $5::timestamptz[])
     ON CONFLICT (id) DO NOTHING`,
    [ids, teamIds, userIds, roles, ids.map(() => ANCHOR.toISOString())]
  );
};

const insertSubscriptions = async (world: TeamWorld) => {
  if (world.teamIds.length === 0) return;
  await exec(
    `INSERT INTO team_subscriptions (team_id, plan_code, seats, status, period_started_at, period_ends_at)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::int[], $4::subscription_status[], $5::timestamptz[], $6::timestamptz[])
     ON CONFLICT (team_id) DO NOTHING`,
    [
      world.teamIds,
      world.teamIds.map(() => 'FREE'),
      world.teamIds.map((_, t) => world.memberIds[t].length),
      world.teamIds.map(() => 'ACTIVE'),
      world.teamIds.map(() => ANCHOR.toISOString()),
      world.teamIds.map(() => new Date(ANCHOR.getTime() + 30 * DAY_MS).toISOString()),
    ]
  );
};

// ---------------------------------------------------------------------------
// Shifts, assignments, swaps
// ---------------------------------------------------------------------------

interface ShiftRow {
  id: string;
  teamIndex: number;
  shiftIndex: number;
  startsAt: string;
  endsAt: string;
  status: 'ACTIVE' | 'CANCELLED';
  title: string;
  assignees: { userId: string; assignedBy: string }[];
}

const buildShifts = (shiftCount: number, world: TeamWorld, prng: () => number): ShiftRow[] => {
  const shifts: ShiftRow[] = [];
  for (let s = 0; s < shiftCount; s++) {
    const t = s % world.teamIds.length;
    const daysBack = Math.floor(prng() * 120);
    const starts = new Date(ANCHOR.getTime() - daysBack * DAY_MS);
    starts.setUTCHours(prng() < 0.5 ? 8 : 15, 0, 0, 0);
    const ends = new Date(starts.getTime() + (4 + Math.floor(prng() * 6)) * 60 * 60000);

    const members = world.memberIds[t];
    const assignees: { userId: string; assignedBy: string }[] = [];
    const assigneeCount = 1 + Math.floor(prng() * 4);
    const usedIdx = new Set<number>();
    for (let a = 0; a < assigneeCount; a++) {
      let idx = Math.floor(prng() * members.length);
      while (usedIdx.has(idx)) idx = Math.floor(prng() * members.length);
      usedIdx.add(idx);
      assignees.push({ userId: members[idx], assignedBy: world.ownerIds[t] });
    }

    shifts.push({
      id: seedUuid('shift', s),
      teamIndex: t,
      shiftIndex: s,
      startsAt: starts.toISOString(),
      endsAt: ends.toISOString(),
      status: prng() < 0.12 ? 'CANCELLED' : 'ACTIVE',
      title: `${SHIFT_TITLES[s % SHIFT_TITLES.length]} #${s + 1}`,
      assignees,
    });
  }
  return shifts;
};

const insertShifts = async (shifts: ShiftRow[], world: TeamWorld) => {
  if (shifts.length === 0) return;
  await exec(
    `INSERT INTO shifts (id, team_id, created_by, title, description, starts_at, ends_at, status, created_at, updated_at)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::timestamptz[], $7::timestamptz[], $8::shift_status[], $9::timestamptz[], $10::timestamptz[])
     ON CONFLICT (id) DO NOTHING`,
    [
      shifts.map((s) => s.id),
      shifts.map((s) => world.teamIds[s.teamIndex]),
      shifts.map((s) => world.ownerIds[s.teamIndex]),
      shifts.map((s) => s.title),
      shifts.map((s) => `Synthetic load-test shift ${s.shiftIndex + 1}`),
      shifts.map((s) => s.startsAt),
      shifts.map((s) => s.endsAt),
      shifts.map((s) => s.status),
      shifts.map(() => new Date(ANCHOR.getTime() - 100 * DAY_MS).toISOString()),
      shifts.map(() => new Date(ANCHOR.getTime() - 95 * DAY_MS).toISOString()),
    ]
  );
};

const insertAssignments = async (shifts: ShiftRow[]): Promise<number> => {
  const shiftIds: string[] = [];
  const userIds: string[] = [];
  const assignedBy: string[] = [];
  const createdAt: string[] = [];

  shifts.forEach((s) => {
    s.assignees.forEach((a) => {
      shiftIds.push(s.id);
      userIds.push(a.userId);
      assignedBy.push(a.assignedBy);
      createdAt.push(new Date(ANCHOR.getTime() - 100 * DAY_MS).toISOString());
    });
  });

  if (shiftIds.length === 0) return 0;
  const res = await exec(
    `INSERT INTO shift_assignments (shift_id, user_id, assigned_by, created_at)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::timestamptz[])
     ON CONFLICT (shift_id, user_id) DO NOTHING`,
    [shiftIds, userIds, assignedBy, createdAt]
  );
  return res.rowCount ?? 0;
};

interface SwapRow {
  id: string;
  shiftId: string;
  requestedBy: string;
  offeredTo: string | null;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
}

const buildSwaps = (shifts: ShiftRow[], prng: () => number): SwapRow[] => {
  const swaps: SwapRow[] = [];
  shifts.forEach((s) => {
    if (s.status !== 'ACTIVE' || s.assignees.length === 0) return;
    if (prng() >= 0.35) return; // ~35% of active shifts have a swap request
    const requester = s.assignees[0].userId;
    const status: SwapRow['status'] =
      prng() < 0.4 ? 'PENDING' : pick(prng, ['APPROVED', 'REJECTED', 'CANCELLED'] as const);
    const reviewed = status !== 'PENDING';
    swaps.push({
      id: seedUuid('swap', swaps.length),
      shiftId: s.id,
      requestedBy: requester,
      offeredTo: null,
      status,
      reason: prng() < 0.4 ? 'Personal errand' : null,
      reviewedBy: reviewed ? s.assignees[0].assignedBy : null,
      reviewedAt: reviewed ? new Date(ANCHOR.getTime() - 95 * DAY_MS).toISOString() : null,
    });
  });
  return swaps;
};

const insertSwaps = async (swaps: SwapRow[]): Promise<number> => {
  if (swaps.length === 0) return 0;
  const res = await exec(
    `INSERT INTO swap_requests (id, shift_id, requested_by, offered_to, status, reason, reviewed_by, reviewed_at, created_at)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::swap_status[], $6::text[], $7::uuid[], $8::timestamptz[], $9::timestamptz[])
     ON CONFLICT (id) DO NOTHING`,
    [
      swaps.map((s) => s.id),
      swaps.map((s) => s.shiftId),
      swaps.map((s) => s.requestedBy),
      swaps.map((s) => s.offeredTo),
      swaps.map((s) => s.status),
      swaps.map((s) => s.reason),
      swaps.map((s) => s.reviewedBy),
      swaps.map((s) => s.reviewedAt),
      swaps.map(() => new Date(ANCHOR.getTime() - 96 * DAY_MS).toISOString()),
    ]
  );
  return res.rowCount ?? 0;
};

// ---------------------------------------------------------------------------
// Activity feed (the 10k+ bulk)
// ---------------------------------------------------------------------------

const buildActivity = (
  count: number,
  world: TeamWorld,
  shifts: ShiftRow[],
  swaps: SwapRow[],
  prng: () => number
) => {
  const weightsTotal = EVENT_TYPES.reduce((sum, t) => sum + t.weight, 0);
  const ids: string[] = [];
  const teamIds: string[] = [];
  const actorIds: string[] = [];
  const eventTypes: string[] = [];
  const payloads: string[] = [];
  const createdAt: string[] = [];

  for (let i = 0; i < count; i++) {
    const t = i % world.teamIds.length;
    const teamId = world.teamIds[t];
    const members = world.memberIds[t];
    const managers = [world.ownerIds[t], ...world.managerIds[t]];
    const shift = shifts[i % shifts.length];
    const swap = swaps.length ? swaps[i % swaps.length] : null;

    let roll = prng() * weightsTotal;
    let chosen = EVENT_TYPES[0];
    for (const entry of EVENT_TYPES) {
      roll -= entry.weight;
      if (roll <= 0) {
        chosen = entry;
        break;
      }
    }

    // Management events act as an owner/manager; SWAP/MEMBER events act as a
    // regular member.
    const isManagement = chosen.type.startsWith('SHIFT_') ||
      chosen.type === 'SUBSCRIPTION_CHANGED' || chosen.type === 'PAYMENT_RECEIVED';
    const actor = isManagement
      ? managers[i % managers.length]
      : members[i % members.length];
    const actorName = `${FIRST_NAMES[i % FIRST_NAMES.length]} ${LAST_NAMES[(i * 3) % LAST_NAMES.length]}`;

    let payload: Record<string, unknown> = { source: SEED_SOURCE, seedIndex: i, actorName };
    switch (chosen.type) {
      case 'SHIFT_CREATED':
        payload = { ...payload, shiftId: shift.id, shiftTitle: shift.title };
        break;
      case 'SHIFT_ASSIGNED':
        payload = {
          ...payload,
          shiftId: shift.id,
          assigneeIds: shift.assignees.slice(0, 2).map((a) => a.userId),
          assigneeNames: shift.assignees.slice(0, 2).map(() => actorName),
        };
        break;
      case 'SHIFT_UPDATED':
        payload = { ...payload, shiftId: shift.id, shiftTitle: shift.title, changes: ['startsAt'] };
        break;
      case 'SHIFT_UNASSIGNED':
        payload = {
          ...payload,
          shiftId: shift.id,
          shiftTitle: shift.title,
          userId: shift.assignees.length ? shift.assignees[0].userId : null,
          userName: actorName,
        };
        break;
      case 'SHIFT_DELETED':
        payload = { ...payload, shiftId: shift.id, shiftTitle: shift.title };
        break;
      case 'SWAP_REQUESTED':
        payload = {
          ...payload,
          swapId: swap ? swap.id : null,
          shiftId: swap ? swap.shiftId : shift.id,
          shiftTitle: shift.title,
          offeredTo: null,
          reason: swap ? swap.reason : null,
        };
        break;
      case 'SWAP_APPROVED':
      case 'SWAP_REJECTED':
      case 'SWAP_CANCELLED':
        payload = {
          ...payload,
          swapId: swap ? swap.id : null,
          shiftId: swap ? swap.shiftId : shift.id,
          shiftTitle: shift.title,
        };
        break;
      case 'MEMBER_JOINED':
        payload = { ...payload, userId: actor, userName: actorName };
        break;
      case 'SUBSCRIPTION_CHANGED':
        payload = { ...payload, planCode: 'GROWTH', seats: members.length };
        break;
      case 'PAYMENT_RECEIVED':
        payload = { ...payload, amountMinor: 1200000, currency: 'NGN' };
        break;
    }

    ids.push(seedUuid('activity', i));
    teamIds.push(teamId);
    actorIds.push(actor);
    eventTypes.push(chosen.type);
    payloads.push(JSON.stringify(payload));
    // 3 rows per team share one 1-hour bucket so the (created_at, id)
    // tie-breaker is exercised within every feed, not just across teams.
    const withinTeam = Math.floor(i / world.teamIds.length);
    createdAt.push(
      new Date(ANCHOR.getTime() + Math.floor(withinTeam / 3) * 3600 * 1000).toISOString()
    );
  }

  return { ids, teamIds, actorIds, eventTypes, payloads, createdAt };
};

const insertActivity = async (rows: ReturnType<typeof buildActivity>): Promise<number> => {
  if (rows.ids.length === 0) return 0;
  const res = await exec(
    `INSERT INTO activity_events (id, team_id, actor_id, type, payload, created_at)
     SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::jsonb[], $6::timestamptz[])
     ON CONFLICT (id) DO NOTHING`,
    [rows.ids, rows.teamIds, rows.actorIds, rows.eventTypes, rows.payloads, rows.createdAt]
  );
  return res.rowCount ?? 0;
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Removes every row this dataset owns, in foreign-key-safe order. */
export const resetSeedDataset = async (options: DatasetOptions = {}): Promise<void> => {
  const u = options.users ?? DATASET_DEFAULTS.users;
  const t = options.teams ?? DATASET_DEFAULTS.teams;
  const s = options.shifts ?? DATASET_DEFAULTS.shifts;

  const userIds = Array.from({ length: u }, (_, i) => seedUuid('user', i));
  const teamIds = Array.from({ length: t }, (_, i) => seedUuid('team', i));
  const shiftIds = Array.from({ length: s }, (_, i) => seedUuid('shift', i));

  if (shiftIds.length) {
    await pool.query('DELETE FROM swap_requests WHERE shift_id = ANY($1::uuid[])', [shiftIds]);
    await pool.query('DELETE FROM shift_assignments WHERE shift_id = ANY($1::uuid[])', [shiftIds]);
  }
  await pool.query(`DELETE FROM activity_events WHERE payload->>'source' = $1`, [SEED_SOURCE]);
  if (shiftIds.length) {
    await pool.query('DELETE FROM shifts WHERE id = ANY($1::uuid[])', [shiftIds]);
  }
  if (teamIds.length) {
    await pool.query('DELETE FROM team_subscriptions WHERE team_id = ANY($1::uuid[])', [teamIds]);
    await pool.query('DELETE FROM team_memberships WHERE team_id = ANY($1::uuid[])', [teamIds]);
    await pool.query('DELETE FROM teams WHERE id = ANY($1::uuid[])', [teamIds]);
  }
  if (userIds.length) {
    await pool.query('DELETE FROM users WHERE id = ANY($1::uuid[])', [userIds]);
  }
};

/**
 * Rebuilds the deterministic dataset: removes any existing seed rows, then
 * inserts users → teams → memberships → subscriptions → shifts → assignments →
 * swaps → activity. Re-running produces the identical dataset.
 */
export const seedDataset = async (options: DatasetOptions = {}): Promise<DatasetResult> => {
  const users = options.users ?? DATASET_DEFAULTS.users;
  const teams = options.teams ?? DATASET_DEFAULTS.teams;
  const shifts = options.shifts ?? DATASET_DEFAULTS.shifts;
  const activity = options.activity ?? DATASET_DEFAULTS.activity;

  const prng = mulberry32(42);
  // One shared low-cost hash: these accounts are synthetic and not intended to
  // be logged into (the k6 harness uses an API-registered user for login).
  const passwordHash = await bcrypt.hash('seed-only-account', 4);

  const userRows = buildUsers(users, prng);
  const world = buildTeams({ userCount: users, teamCount: teams }, prng);

  await resetSeedDataset({ users, teams, shifts });
  await insertUsers(userRows, passwordHash);
  await insertTeams(world);
  await insertMemberships(world);
  await insertSubscriptions(world);

  const shiftRows = buildShifts(shifts, world, prng);
  await insertShifts(shiftRows, world);
  const assignmentInserted = await insertAssignments(shiftRows);

  const swapRows = buildSwaps(shiftRows, prng);
  const swapInserted = await insertSwaps(swapRows);

  const activityRows = buildActivity(activity, world, shiftRows, swapRows, prng);
  const activityInserted = await insertActivity(activityRows);

  const totalActivity = await pool.query(
    `SELECT count(*)::int AS total FROM activity_events WHERE payload->>'source' = $1`,
    [SEED_SOURCE]
  );

  return {
    users,
    teams: world.teamIds.length,
    shifts: shiftRows.length,
    assignments: assignmentInserted,
    swaps: swapInserted,
    activityInserted,
    totalActivity: totalActivity.rows[0].total,
  };
};

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const parseArgs = (argv: string[]): DatasetOptions => {
  const out: Record<string, number> = {};
  const read = (flag: string): string | undefined => {
    const inline = argv.find((a) => a.startsWith(`${flag}=`));
    if (inline) return inline.slice(flag.length + 1);
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : undefined;
  };
  for (const flag of ['--users', '--teams', '--shifts', '--activity']) {
    const raw = read(flag);
    if (raw !== undefined) out[flag.slice(2)] = Number(raw);
  }
  return out;
};

const runCli = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.teams !== undefined && (args.teams < 1 || args.teams > 20)) {
    console.error('--teams must be between 1 and 20');
    process.exit(1);
  }
  if (args.users !== undefined && (args.users < 1 || args.users > 200)) {
    console.error('--users must be between 1 and 200');
    process.exit(1);
  }
  if (args.activity !== undefined && (args.activity < 1 || args.activity > 1000000)) {
    console.error('--activity must be between 1 and 1000000');
    process.exit(1);
  }

  try {
    console.log(JSON.stringify(await seedDataset(args), null, 2));
    process.exit(0);
  } catch (e) {
    console.error('Seeding failed:', (e as Error).message);
    process.exit(1);
  }
};

if (require.main === module) {
  runCli();
}