import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { env } from '../src/env';
import { seedDataset, seedUuid, SEED_SOURCE } from '../scripts/seed-dataset';

interface FeedItem {
  id: string;
  teamId: string;
  actorId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface Page {
  items: FeedItem[];
  nextCursor: string | null;
  hasMore: boolean;
}

// The API authenticates by jwt.verify(token, env.JWT_SECRET) and trusts the
// signed payload as the user; minting tokens directly avoids the /auth rate
// limiter and lets us impersonate seeded (not login-live) accounts.
const tokenFor = (id: string, email: string): string =>
  jwt.sign(
    { id, email, firstName: 'Seed', lastName: 'User', createdAt: new Date('2026-05-01T00:00:00Z').toISOString() },
    env.JWT_SECRET,
    { expiresIn: '15m' }
  );

const getPage = async (token: string, teamId: string, query: string): Promise<Page> => {
  const res = await request(app)
    .get(`/teams/${teamId}/activity?${query}`)
    .set('Authorization', `Bearer ${token}`);
  expect(res.status).toBe(200);
  return res.body.data as Page;
};

const walkActivity = async (token: string, teamId: string, type?: string, limit = 50) => {
  const collected: FeedItem[] = [];
  let cursor: string | null = null;
  let pageCount = 0;
  do {
    const params = new URLSearchParams({ limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    if (type) params.set('type', type);
    const page = await getPage(token, teamId, params.toString());
    collected.push(...page.items);
    cursor = page.nextCursor;
    pageCount += 1;
  } while (cursor);

  expect(pageCount).toBeGreaterThan(1); // the dataset genuinely spans several pages
  return collected;
};

const assertStrictlyDescending = (items: FeedItem[]) => {
  for (let i = 1; i < items.length; i++) {
    const prevT = new Date(items[i - 1].createdAt).getTime();
    const nextT = new Date(items[i].createdAt).getTime();
    const after = prevT > nextT || (prevT === nextT && items[i - 1].id > items[i].id);
    expect(after).toBe(true);
  }
};

describe('Large-dataset validation (seeded multi-team world, 10k+ activity)', () => {
  let owner0Token: string;
  let staff0Id: string;
  let staff0Token: string;
  let outsider0Token: string;

  const team0 = seedUuid('team', 0);
  const team1 = seedUuid('team', 1);

  const dbActivityCount = async (teamId: string, type?: string) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS total
       FROM activity_events
       WHERE team_id = $1${type ? ' AND type = $2' : ''}`,
      type ? [teamId, type] : [teamId]
    );
    return rows[0].total;
  };

  beforeAll(async () => {
    const result = await seedDataset({ users: 40, teams: 5, shifts: 500, activity: 10000 });
    expect(result.totalActivity).toBeGreaterThanOrEqual(10000);
    expect(result.teams).toBe(5);
    expect(result.users).toBe(40);
    expect(result.swaps).toBeGreaterThan(0);

    const owner0 = seedUuid('user', 0);
    owner0Token = tokenFor(owner0, 'seed.user.1@loadtest.local');

    // Pick a team-0 member who is NOT a member of team 1 (used for tenant isolation).
    const outsider = await pool.query(
      `SELECT user_id, email FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1
         AND tm.user_id NOT IN (SELECT user_id FROM team_memberships WHERE team_id = $2)
       LIMIT 1`,
      [team0, team1]
    );
    expect(outsider.rows.length).toBeGreaterThan(0);
    outsider0Token = tokenFor(outsider.rows[0].user_id, outsider.rows[0].email);

    // A plain STAFF member of team 0 for swaps scoping.
    const staff = await pool.query(
      `SELECT user_id, email FROM team_memberships tm
       JOIN users u ON u.id = tm.user_id
       WHERE tm.team_id = $1 AND tm.role = 'STAFF' LIMIT 1`,
      [team0]
    );
    expect(staff.rows.length).toBeGreaterThan(0);
    staff0Id = staff.rows[0].user_id;
    staff0Token = tokenFor(staff0Id, staff.rows[0].email);

    await redisClient.connect().catch(() => {});
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await redisClient.quit().catch(() => {});
  });

  it('1. seed contains >=10,000 activity rows spread across every team and event type', async () => {
    const total = await pool.query(
      `SELECT count(*)::int AS total FROM activity_events WHERE payload->>'source' = $1`,
      [SEED_SOURCE]
    );
    expect(total.rows[0].total).toBeGreaterThanOrEqual(10000);

    const perTeam = await pool.query(
      `SELECT team_id, count(*)::int AS total FROM activity_events
       WHERE payload->>'source' = $1 GROUP BY team_id`,
      [SEED_SOURCE]
    );
    expect(perTeam.rows).toHaveLength(5);
    for (const row of perTeam.rows) {
      expect(row.total).toBeGreaterThan(1000);
    }

    const types = await pool.query(
      `SELECT type, count(*)::int AS total FROM activity_events
       WHERE payload->>'source' = $1 GROUP BY type`,
      [SEED_SOURCE]
    );
    expect(types.rows).toHaveLength(12);
  });

  it('2. re-seeding is deterministic and leaves an identical dataset (idempotent)', async () => {
    const fingerprint = async () =>
      pool.query(
        `SELECT count(*)::int AS rows, coalesce(sum(hashtext(id || created_at::text)), 0)::bigint AS sum
         FROM activity_events WHERE payload->>'source' = $1`,
        [SEED_SOURCE]
      );
    const before = (await fingerprint()).rows[0];

    const result = await seedDataset({ users: 40, teams: 5, shifts: 500, activity: 10000 });
    expect(result.totalActivity).toBe(before.rows);

    const after = (await fingerprint()).rows[0];
    expect(after.rows).toBe(before.rows);
    expect(after.sum).toBe(before.sum);

    // No duplicated users, teams, or memberships after a rebuild.
    const users = await pool.query(
      `SELECT count(*)::int AS total, count(DISTINCT email)::int AS uniq FROM users
       WHERE email LIKE 'seed.user.%@loadtest.local'`
    );
    expect(users.rows[0].total).toBe(users.rows[0].uniq);
    expect(users.rows[0].total).toBe(40);

    const teams = await pool.query(
      `SELECT count(*)::int AS total FROM teams WHERE id = ANY($1::uuid[])`,
      [Array.from({ length: 5 }, (_, i) => seedUuid('team', i))]
    );
    expect(teams.rows[0].total).toBe(5);
  });

  it('3. tenant isolation holds at scale: outsider gets 404 on every team-1 read', async () => {
    for (const path of ['/activity', '/members', '/shifts', '/swaps']) {
      const res = await request(app)
        .get(`/teams/${team1}${path}`)
        .set('Authorization', `Bearer ${outsider0Token}`);
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    }
  });

  it('4. activity walk over team 0 is gapless, strictly ordered, and complete', async () => {
    const collected = await walkActivity(owner0Token, team0);
    const expected = await dbActivityCount(team0);

    expect(collected).toHaveLength(expected);
    expect(new Set(collected.map((e) => e.id)).size).toBe(collected.length);
    assertStrictlyDescending(collected);
    for (const item of collected) {
      expect(item.teamId).toBe(team0);
    }
    // The shared-timestamp tie-breaker was genuinely exercised.
    let sawCollision = false;
    for (let i = 1; i < collected.length; i++) {
      if (
        new Date(collected[i].createdAt).getTime() ===
        new Date(collected[i - 1].createdAt).getTime()
      ) {
        sawCollision = true;
        break;
      }
    }
    expect(sawCollision).toBe(true);
  });

  it('5. type filter returns only that type and remains gapless', async () => {
    const collected = await walkActivity(owner0Token, team0, 'SHIFT_ASSIGNED');
    const expected = await dbActivityCount(team0, 'SHIFT_ASSIGNED');

    expect(collected).toHaveLength(expected);
    for (const item of collected) {
      expect(item.type).toBe('SHIFT_ASSIGNED');
    }
    assertStrictlyDescending(collected);
  });

  it('6. invalid cursor is rejected with 400 INVALID_CURSOR', async () => {
    const garbage = Buffer.from('not-a-cursor').toString('base64url');
    const res = await request(app)
      .get(`/teams/${team0}/activity?cursor=${encodeURIComponent(garbage)}`)
      .set('Authorization', `Bearer ${owner0Token}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
  });

  it('7. limit is clamped to 50 and non-positive limits are rejected', async () => {
    const big = await request(app)
      .get(`/teams/${team0}/activity?limit=500`)
      .set('Authorization', `Bearer ${owner0Token}`);
    expect(big.status).toBe(200);
    expect(big.body.data.items.length).toBe(50);
    expect(big.body.data.hasMore).toBe(true);

    for (const bad of ['0', '-1', 'abc']) {
      const res = await request(app)
        .get(`/teams/${team0}/activity?limit=${bad}`)
        .set('Authorization', `Bearer ${owner0Token}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_LIMIT');
    }
  });

  it('8. single-row pages preserve the same total order as bulk pages', async () => {
    // Follow a bounded window of limit=1 pages (a full walk of 2000 rows would
    // legitimately trip the /teams request limiter, which this suite respects).
    const first = await getPage(owner0Token, team0, 'limit=1');
    expect(first.items).toHaveLength(1);
    expect(first.hasMore).toBe(true);

    const collected: FeedItem[] = [...first.items];
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor && pages < 5) {
      const page = await getPage(owner0Token, team0, `limit=1&cursor=${encodeURIComponent(cursor)}`);
      collected.push(...page.items);
      cursor = page.nextCursor;
      pages += 1;
    }

    // All five rows agree with the head of the same feed fetched at limit=50.
    const bulk = await getPage(owner0Token, team0, 'limit=50');
    for (let i = 0; i < collected.length; i++) {
      expect(collected[i].id).toBe(bulk.items[i].id);
    }
    assertStrictlyDescending(collected);
    expect(new Set(collected.map((e) => e.id)).size).toBe(collected.length);
  });

  it('9. members endpoint returns the exact seed membership at scale', async () => {
    const res = await request(app)
      .get(`/teams/${team0}/members`)
      .set('Authorization', `Bearer ${owner0Token}`);
    expect(res.status).toBe(200);

    const db = await pool.query(
      `SELECT count(*)::int AS total FROM team_memberships WHERE team_id = $1`,
      [team0]
    );
    expect(res.body.data).toHaveLength(db.rows[0].total);
    expect(res.body.data.some((m: any) => m.role === 'OWNER')).toBe(true);
  });

  it('10. swaps paginate gaplessly and STAFF only see their own requests', async () => {
    const swapWalk = async (token: string) => {
      const collected: any[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const params = new URLSearchParams({ limit: '50' });
        if (cursor) params.set('cursor', cursor);
        const res = await request(app)
          .get(`/teams/${team0}/swaps?${params.toString()}`)
          .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        collected.push(...res.body.data.items);
        cursor = res.body.data.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(200);
      } while (cursor);
      return collected;
    };

    const ownerSwaps = await swapWalk(owner0Token);
    const dbOwner = await pool.query(
      `SELECT count(*)::int AS total FROM swap_requests sr JOIN shifts s ON s.id = sr.shift_id
       WHERE s.team_id = $1`,
      [team0]
    );
    expect(ownerSwaps).toHaveLength(dbOwner.rows[0].total);

    const staffSwaps = await swapWalk(staff0Token);
    const dbStaff = await pool.query(
      `SELECT count(*)::int AS total FROM swap_requests sr JOIN shifts s ON s.id = sr.shift_id
       WHERE s.team_id = $1 AND sr.requested_by = $2`,
      [team0, staff0Id]
    );
    expect(staffSwaps).toHaveLength(dbStaff.rows[0].total);
    for (const swap of staffSwaps) {
      expect(swap.requestedBy).toBe(staff0Id);
    }
  });

  it('11. shifts paginate gaplessly ordered by (starts_at, id) descending', async () => {
    const collected: any[] = [];
    let cursor: string | null = null;
    do {
      const params = new URLSearchParams({ limit: '50' });
      if (cursor) params.set('cursor', cursor);
      const res = await request(app)
        .get(`/teams/${team0}/shifts?${params.toString()}`)
        .set('Authorization', `Bearer ${owner0Token}`);
      expect(res.status).toBe(200);
      collected.push(...res.body.data.items);
      cursor = res.body.data.nextCursor;
    } while (cursor);

    const db = await pool.query(
      `SELECT count(*)::int AS total FROM shifts WHERE team_id = $1`,
      [team0]
    );
    expect(collected).toHaveLength(db.rows[0].total);

    for (let i = 1; i < collected.length; i++) {
      const prevT = new Date(collected[i - 1].startsAt).getTime();
      const nextT = new Date(collected[i].startsAt).getTime();
      const after = prevT > nextT || (prevT === nextT && collected[i - 1].id > collected[i].id);
      expect(after).toBe(true);
    }
  });
});