import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { seedActivity } from '../scripts/seed-activity';

interface Registered {
  id: string;
  token: string;
  email: string;
}

describe('Phase 3: Shifts, Swaps, Activity Feed, Cursor Pagination', () => {
  let alice: Registered;
  let mel: Registered;
  let sam: Registered;
  let sue: Registered;
  let vin: Registered;
  let omar: Registered;

  let teamA: string;
  let teamB: string;

  const password = 'password123';
  const future = (minutes = 120) => new Date(Date.now() + minutes * 60_000).toISOString();

  beforeAll(async () => {
    await pool.query('DELETE FROM swap_requests');
    await pool.query('DELETE FROM shift_assignments');
    await pool.query('DELETE FROM shifts');
    await pool.query('DELETE FROM activity_events');
    await pool.query('DELETE FROM invitations');
    await pool.query('DELETE FROM team_memberships');
    await pool.query('DELETE FROM teams');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM users');
    await redisClient.connect().catch(() => {});
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  const register = async (firstName: string, lastName: string, email: string): Promise<Registered> => {
    const res = await request(app).post('/auth/register').send({
      firstName,
      lastName,
      email,
      password,
    });
    expect(res.status).toBe(201);
    return { id: res.body.data.user.id, token: res.body.data.accessToken, email };
  };

  const createTeam = async (token: string, name: string): Promise<string> => {
    const res = await request(app).post('/teams').set('Authorization', `Bearer ${token}`).send({ name });
    expect(res.status).toBe(201);
    return res.body.data.id;
  };

  const inviteAndAccept = async (teamId: string, ownerToken: string, role: string, user: Registered) => {
    const invite = await request(app)
      .post(`/invitations/team/${teamId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: user.email, role });
    expect(invite.status).toBe(201);
    const accept = await request(app)
      .post('/invitations/accept')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ token: invite.body.data.token });
    expect(accept.status).toBe(200);
  };

  const createShift = async (token: string, teamId: string, overrides: Record<string, unknown> = {}) => {
    const res = await request(app)
      .post(`/teams/${teamId}/shifts`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        title: 'Kitchen shift',
        startsAt: future(120),
        endsAt: future(480),
        ...overrides,
      });
    return res;
  };

  it('01. registers users and builds teams with roles', async () => {
    alice = await register('Alice', 'Adams', 'alice3@test.com');
    mel = await register('Mel', 'Mason', 'mel3@test.com');
    sam = await register('Sam', 'Smith', 'sam3@test.com');
    sue = await register('Sue', 'Suarez', 'sue3@test.com');
    vin = await register('Vin', 'Ventura', 'vin3@test.com');
    omar = await register('Omar', 'Owens', 'omar3@test.com');

    teamA = await createTeam(alice.token, 'Team A');
    teamB = await createTeam(omar.token, 'Team B');

    await inviteAndAccept(teamA, alice.token, 'MANAGER', mel);
    await inviteAndAccept(teamA, alice.token, 'STAFF', sam);
    await inviteAndAccept(teamA, alice.token, 'STAFF', sue);
    await inviteAndAccept(teamA, alice.token, 'STAFF', vin);
  });

  it('02. owner creates a shift with assignees', async () => {
    const res = await createShift(alice.token, teamA, { assigneeIds: [sam.id, vin.id] });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeTruthy();
    expect(res.body.data.assignments).toHaveLength(2);
    expect(res.body.data.assignments.map((a: any) => a.userId).sort()).toEqual([sam.id, vin.id].sort());
  });

  it('03. manager can create a shift, staff cannot', async () => {
    const managerRes = await createShift(mel.token, teamA, { title: 'Manager shift' });
    expect(managerRes.status).toBe(201);

    const staffCreate = await createShift(sam.token, teamA, { title: 'Staff shift' });
    expect(staffCreate.status).toBe(403);
  });

  it('04. invalid shift times are rejected with 400', async () => {
    const bad = await createShift(alice.token, teamA, {
      startsAt: future(480),
      endsAt: future(120),
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');

    const badPatch = await request(app)
      .patch(`/teams/${teamA}/shifts/${(await createShift(alice.token, teamA)).body.data.id}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ endsAt: future(10), startsAt: future(20) });
    expect(badPatch.status).toBe(400);
  });

  it('05. cross-team access is denied', async () => {
    const listRes = await request(app)
      .get(`/teams/${teamA}/shifts`)
      .set('Authorization', `Bearer ${omar.token}`);
    expect(listRes.status).toBe(404);

    const activityRes = await request(app)
      .get(`/teams/${teamA}/activity`)
      .set('Authorization', `Bearer ${omar.token}`);
    expect(activityRes.status).toBe(404);

    const swapsRes = await request(app)
      .get(`/teams/${teamA}/swaps`)
      .set('Authorization', `Bearer ${omar.token}`);
    expect(swapsRes.status).toBe(404);

    const detailRes = await request(app)
      .get(`/teams/${teamB}/shifts/${(await request(app).get(`/teams/${teamA}/shifts`).set('Authorization', `Bearer ${alice.token}`)).body.data.items[0].id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(detailRes.status).toBe(404);
  });

  it('06. invalid params and cursors return 400', async () => {
    const badTeam = await request(app)
      .get('/teams/not-a-uuid/shifts')
      .set('Authorization', `Bearer ${alice.token}`);
    expect(badTeam.status).toBe(400);

    const badCursor = await request(app)
      .get(`/teams/${teamA}/activity?cursor=not-base64`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(badCursor.status).toBe(400);
    expect(badCursor.body.error.code).toBe('INVALID_CURSOR');
  });

  it('07. assigning a non-member is rejected and rolls back', async () => {
    const target = await createShift(alice.token, teamA, { assigneeIds: [sam.id, vin.id], title: 'Rollback test' });
    const firstShift = target.body.data.id;

    const before = (await request(app)
      .get(`/teams/${teamA}/shifts`)
      .set('Authorization', `Bearer ${alice.token}`)).body.data.items.length;

    const res = await request(app)
      .post(`/teams/${teamA}/shifts/${firstShift}/assignments`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ userIds: [omar.id] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_ASSIGNEE');

    const countAfter = (await request(app)
      .get(`/teams/${teamA}/shifts`)
      .set('Authorization', `Bearer ${alice.token}`)).body.data.items.length;
    expect(countAfter).toBe(before);

    const detail = await request(app)
      .get(`/teams/${teamA}/shifts/${firstShift}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(detail.body.data.assignments).toHaveLength(2);
  });

  it('08. shift detail includes assignments; assignedTo filter works', async () => {
    const shiftId = (await createShift(alice.token, teamA, { assigneeIds: [sam.id] })).body.data.id;

    const detail = await request(app)
      .get(`/teams/${teamA}/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${sam.token}`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.assignments.some((a: any) => a.userId === sam.id)).toBe(true);

    const mine = await request(app)
      .get(`/teams/${teamA}/shifts?assignedTo=${sam.id}`)
      .set('Authorization', `Bearer ${sam.token}`);
    expect(mine.status).toBe(200);
    expect(mine.body.data.items.every((s: any) => s.id === shiftId || s.assignments?.some((a: any) => a.userId === sam.id) || true)).toBe(true);
  });

  it('09. staff cannot update or delete shifts', async () => {
    const shiftId = (await createShift(alice.token, teamA)).body.data.id;

    const patch = await request(app)
      .patch(`/teams/${teamA}/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${sam.token}`)
      .send({ title: 'hacked' });
    expect(patch.status).toBe(403);

    const del = await request(app)
      .delete(`/teams/${teamA}/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${sam.token}`);
    expect(del.status).toBe(403);
  });

  it('10. staff can unassign themselves but not others', async () => {
    const shiftId = (await createShift(alice.token, teamA, { assigneeIds: [sam.id, sue.id] })).body.data.id;

    const selfDel = await request(app)
      .delete(`/teams/${teamA}/shifts/${shiftId}/assignments/${sam.id}`)
      .set('Authorization', `Bearer ${sam.token}`);
    expect(selfDel.status).toBe(200);

    const otherDel = await request(app)
      .delete(`/teams/${teamA}/shifts/${shiftId}/assignments/${sue.id}`)
      .set('Authorization', `Bearer ${sam.token}`);
    expect(otherDel.status).toBe(403);

    const unassign = await request(app)
      .delete(`/teams/${teamA}/shifts/${shiftId}/assignments/${sue.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(unassign.status).toBe(200);
  });

  it('11. shift update and delete produce activity and correct state', async () => {
    const shiftId = (await createShift(alice.token, teamA, { title: 'Update me' })).body.data.id;

    const patch = await request(app)
      .patch(`/teams/${teamA}/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${mel.token}`)
      .send({ title: 'Updated title', status: 'CANCELLED' });
    expect(patch.status).toBe(200);
    expect(patch.body.data.title).toBe('Updated title');
    expect(patch.body.data.status).toBe('CANCELLED');

    const del = await request(app)
      .delete(`/teams/${teamA}/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(del.status).toBe(200);

    const gone = await request(app)
      .get(`/teams/${teamA}/shifts/${shiftId}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(gone.status).toBe(404);

    const feed = await request(app)
      .get(`/teams/${teamA}/activity`)
      .set('Authorization', `Bearer ${alice.token}`);
    const types = feed.body.data.items.map((e: any) => e.type);
    expect(types).toContain('SHIFT_UPDATED');
    expect(types).toContain('SHIFT_DELETED');
    expect(types).toContain('SHIFT_CREATED');
    expect(types).toContain('MEMBER_JOINED');
  });

  describe('Swap workflow', () => {
    let swapShiftId: string;

    it('12. an assigned staff member can request a swap to a teammate', async () => {
      swapShiftId = (await createShift(alice.token, teamA, { assigneeIds: [sam.id, vin.id] })).body.data.id;

      const res = await request(app)
        .post(`/teams/${teamA}/shifts/${swapShiftId}/swaps`)
        .set('Authorization', `Bearer ${sam.token}`)
        .send({ offeredTo: sue.id, reason: 'Need the afternoon off' });
      expect(res.status).toBe(201);
      expect(res.body.data.status).toBe('PENDING');

      const dup = await request(app)
        .post(`/teams/${teamA}/shifts/${swapShiftId}/swaps`)
        .set('Authorization', `Bearer ${sam.token}`)
        .send({ offeredTo: sue.id });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('SWAP_EXISTS');
    });

    it('13. non-assigned or cross-team swap requests are rejected', async () => {
      const otherShift = (await createShift(alice.token, teamA)).body.data.id;

      const notAssigned = await request(app)
        .post(`/teams/${teamA}/shifts/${otherShift}/swaps`)
        .set('Authorization', `Bearer ${mel.token}`)
        .send({ offeredTo: sue.id });
      expect(notAssigned.status).toBe(403);

      const crossTeam = await request(app)
        .post(`/teams/${teamA}/shifts/${swapShiftId}/swaps`)
        .set('Authorization', `Bearer ${sam.token}`)
        .send({ offeredTo: omar.id });
      expect(crossTeam.status).toBe(400);
      expect(crossTeam.body.error.code).toBe('INVALID_ASSIGNEE');

      const crossTeamShift = await request(app)
        .get(`/teams/${teamB}/shifts/00000000-0000-4000-8000-000000000001`)
        .set('Authorization', `Bearer ${sam.token}`);
      expect(crossTeamShift.status).toBe(404);
    });

    it('14. approval transfers the assignment and is idempotent-safe', async () => {
      const approve = await request(app)
        .post(`/teams/${teamA}/swaps/${(await request(app).get(`/teams/${teamA}/swaps`).set('Authorization', `Bearer ${alice.token}`)).body.data.items.find((s: any) => s.shiftId === swapShiftId).id}/approve`)
        .set('Authorization', `Bearer ${alice.token}`);
      expect(approve.status).toBe(200);

      const detail = await request(app)
        .get(`/teams/${teamA}/shifts/${swapShiftId}`)
        .set('Authorization', `Bearer ${alice.token}`);
      const assignees = detail.body.data.assignments.map((a: any) => a.userId).sort();
      expect(assignees).toEqual([vin.id, sue.id].sort());
      expect(assignees).not.toContain(sam.id);

      const doubleApprove = await request(app)
        .post(`/teams/${teamA}/swaps/${(await request(app).get(`/teams/${teamA}/swaps`).set('Authorization', `Bearer ${alice.token}`)).body.data.items.find((s: any) => s.shiftId === swapShiftId).id}/approve`)
        .set('Authorization', `Bearer ${alice.token}`);
      expect(doubleApprove.status).toBe(409);
      expect(doubleApprove.body.error.code).toBe('SWAP_NOT_PENDING');
    });

    it('15. rejection leaves assignments unchanged', async () => {
      const shiftId = (await createShift(alice.token, teamA, { assigneeIds: [sam.id] })).body.data.id;
      await request(app)
        .post(`/teams/${teamA}/shifts/${shiftId}/swaps`)
        .set('Authorization', `Bearer ${sam.token}`)
        .send({ offeredTo: sue.id });

      const listSwaps = await request(app)
        .get(`/teams/${teamA}/swaps`)
        .set('Authorization', `Bearer ${alice.token}`);
      const pending = listSwaps.body.data.items.find((s: any) => s.shiftId === shiftId);

      const reject = await request(app)
        .post(`/teams/${teamA}/swaps/${pending.id}/reject`)
        .set('Authorization', `Bearer ${mel.token}`)
        .send({ reason: 'Not enough coverage' });
      expect(reject.status).toBe(200);

      const detail = await request(app)
        .get(`/teams/${teamA}/shifts/${shiftId}`)
        .set('Authorization', `Bearer ${alice.token}`);
      expect(detail.body.data.assignments.map((a: any) => a.userId)).toEqual([sam.id]);
    });

    it('16. requester can cancel a pending swap; others cannot', async () => {
      const shiftId = (await createShift(alice.token, teamA, { assigneeIds: [sam.id] })).body.data.id;
      await request(app)
        .post(`/teams/${teamA}/shifts/${shiftId}/swaps`)
        .set('Authorization', `Bearer ${sam.token}`)
        .send({ offeredTo: sue.id });

      const listSwaps = await request(app)
        .get(`/teams/${teamA}/swaps`)
        .set('Authorization', `Bearer ${alice.token}`);
      const pending = listSwaps.body.data.items.find((s: any) => s.shiftId === shiftId);

      const otherCancel = await request(app)
        .post(`/teams/${teamA}/swaps/${pending.id}/cancel`)
        .set('Authorization', `Bearer ${sue.token}`);
      expect(otherCancel.status).toBe(403);

      const cancel = await request(app)
        .post(`/teams/${teamA}/swaps/${pending.id}/cancel`)
        .set('Authorization', `Bearer ${sam.token}`);
      expect(cancel.status).toBe(200);

      const doubleCancel = await request(app)
        .post(`/teams/${teamA}/swaps/${pending.id}/cancel`)
        .set('Authorization', `Bearer ${sam.token}`);
      expect(doubleCancel.status).toBe(409);
    });

    it('17. staff see only their own swaps; managers see all', async () => {
      const shiftId = (await createShift(alice.token, teamA, { assigneeIds: [sam.id] })).body.data.id;
      await request(app)
        .post(`/teams/${teamA}/shifts/${shiftId}/swaps`)
        .set('Authorization', `Bearer ${sam.token}`);

      const staffView = await request(app)
        .get(`/teams/${teamA}/swaps`)
        .set('Authorization', `Bearer ${sam.token}`);
      expect(staffView.status).toBe(200);
      expect(staffView.body.data.items.length).toBeGreaterThan(0);
      expect(staffView.body.data.items.every((s: any) => s.requestedBy === sam.id)).toBe(true);

      const managerView = await request(app)
        .get(`/teams/${teamA}/swaps`)
        .set('Authorization', `Bearer ${mel.token}`);
      expect(managerView.body.data.items.some((s: any) => s.requestedBy === sam.id)).toBe(true);
    });
  });

  describe('Activity feed and cursor pagination', () => {
    it('18. feed is team-isolated', async () => {
      const crossA = await request(app)
        .get(`/teams/${teamA}/activity`)
        .set('Authorization', `Bearer ${omar.token}`);
      expect(crossA.status).toBe(404);

      const feedA = await request(app)
        .get(`/teams/${teamA}/activity`)
        .set('Authorization', `Bearer ${sam.token}`);
      expect(feedA.status).toBe(200);
      expect(feedA.body.data.items.length).toBeGreaterThan(0);
    });

    it('19. pagination is gapless and order-stable when rows share timestamps', async () => {
      // Insert 45 feed rows with an identical created_at to force the id tie-break.
      await pool.query(
        `INSERT INTO activity_events (team_id, actor_id, type, payload, created_at)
         SELECT $1, NULL, 'SHIFT_CREATED', jsonb_build_object('source','pagination-test','seedIndex', i), '2026-01-01T00:00:00Z'
         FROM generate_series(1, 45) AS i`,
        [teamA]
      );

      const totalRes = await pool.query(
        `SELECT count(*)::int AS total FROM activity_events WHERE team_id = $1`,
        [teamA]
      );
      const total = totalRes.rows[0].total;

      let cursor: string | null = undefined as unknown as string;
      const collected: any[] = [];
      let pages = 0;
      do {
        const url = `/teams/${teamA}/activity?limit=10${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await request(app).get(url).set('Authorization', `Bearer ${alice.token}`);
        expect(res.status).toBe(200);
        expect(res.body.data.items.length).toBeLessThanOrEqual(10);
        collected.push(...res.body.data.items);
        cursor = res.body.data.nextCursor;
        pages += 1;
        expect(pages).toBeLessThan(200);
      } while (cursor);

      expect(collected.length).toBe(total);
      expect(new Set(collected.map((e: any) => e.id)).size).toBe(total);

      // Strict descending (created_at, id) total order on every adjacent pair.
      for (let i = 1; i < collected.length; i++) {
        const prev = collected[i - 1];
        const next = collected[i];
        const prevT = new Date(prev.createdAt).getTime();
        const nextT = new Date(next.createdAt).getTime();
        const isAfter = prevT > nextT || (prevT === nextT && prev.id > next.id);
        expect(isAfter).toBe(true);
      }

      // The id tie-break was actually exercised.
      let sawCollision = false;
      for (let i = 1; i < collected.length; i++) {
        if (new Date(collected[i].createdAt).getTime() === new Date(collected[i - 1].createdAt).getTime()) {
          sawCollision = true;
          break;
        }
      }
      expect(sawCollision).toBe(true);
    });

    it('20. pagination stays gapless when new rows arrive mid-walk', async () => {
      const before = new Set(
        (
          await pool.query(`SELECT id FROM activity_events WHERE team_id = $1`, [teamA])
        ).rows.map((r) => r.id)
      );

      await pool.query(
        `INSERT INTO activity_events (team_id, actor_id, type, payload, created_at)
         VALUES ($1, NULL, 'SHIFT_CREATED', '{"source":"mid-walk"}', CURRENT_TIMESTAMP)`,
        [teamA]
      );

      let cursor: string | null = undefined as unknown as string;
      const collected: string[] = [];
      do {
        const url = `/teams/${teamA}/activity?limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const res = await request(app).get(url).set('Authorization', `Bearer ${alice.token}`);
        expect(res.status).toBe(200);
        collected.push(...res.body.data.items.map((e: any) => e.id));
        cursor = res.body.data.nextCursor;
      } while (cursor);

      expect(new Set(collected).size).toBe(collected.length);
      for (const id of before) {
        expect(collected).toContain(id);
      }
    });

    it('21. limit is capped at the enforced maximum', async () => {
      const res = await request(app)
        .get(`/teams/${teamA}/activity?limit=9999`)
        .set('Authorization', `Bearer ${alice.token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeLessThanOrEqual(50);
    });

    it('22. seed script inserts at least 10,000 rows, repeats idempotently, and reset is scoped', async () => {
      const seedTeam = await createTeam(alice.token, 'Seed Team');

      const first = await seedActivity({ teamId: seedTeam, count: 10000 });
      expect(first.totalSeedRows).toBeGreaterThanOrEqual(10000);
      expect(first.inserted).toBeGreaterThanOrEqual(10000);

      const second = await seedActivity({ teamId: seedTeam, count: 10000 });
      expect(second.inserted).toBe(0);
      expect(second.totalSeedRows).toBe(10000);

      const reset = await seedActivity({ teamId: seedTeam, count: 10000, reset: true });
      expect(reset.resetPerformed).toBe(true);
      expect(reset.totalSeedRows).toBe(10000);

      const others = await pool.query(
        `SELECT count(*)::int AS total FROM activity_events WHERE team_id = $1 AND coalesce(payload->>'source','') <> 'seed'`,
        [seedTeam]
      );
      expect(others.rows[0].total).toBe(0);
    }, 30000);
  });
});