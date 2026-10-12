import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { notify, NotificationEvent } from '../src/services/notifications';

describe('Push Notifications Integration', () => {
  let aliceToken: string;
  let aliceId: string;
  let bobToken: string;
  let bobId: string;
  let charlieToken: string;
  let charlieId: string;
  let teamAId: string;
  let shift1Id: string;
  let shift2Id: string;

  const aliceDevice = 'ExponentPushToken[test-alice-0001]';
  const bobDevice = 'ExponentPushToken[test-bob-0001]';
  const charlieDevice = 'ExponentPushToken[test-charlie-0001]';

  const fetchMock = jest.spyOn(globalThis, 'fetch') as jest.Mock;
  const lastPushBody = (): { to: string[]; title: string; body: string; data: Record<string, unknown> } =>
    JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body as string);

  beforeAll(async () => {
    // Fetch must be real enough to inspect; the app only calls it for Expo Push.
    fetchMock.mockImplementation(async () =>
      ({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) } as never)
    );

    // Child-first clear of every table the scenario touches.
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM device_tokens');
    await pool.query('DELETE FROM notification_preferences');
    await pool.query('DELETE FROM swap_requests');
    await pool.query('DELETE FROM shift_assignments');
    await pool.query('DELETE FROM shifts');
    await pool.query('DELETE FROM activity_events');
    await pool.query('DELETE FROM invitations');
    await pool.query('DELETE FROM team_memberships');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM teams');
    await pool.query('DELETE FROM users');
    await redisClient.connect().catch(() => {});
    fetchMock.mockClear();
  });

  afterAll(async () => {
    await pool.query('DELETE FROM notifications');
    await pool.query('DELETE FROM device_tokens');
    await pool.query('DELETE FROM notification_preferences');
    await pool.query('DELETE FROM swap_requests');
    await pool.query('DELETE FROM shift_assignments');
    await pool.query('DELETE FROM shifts');
    await pool.query('DELETE FROM activity_events');
    await pool.query('DELETE FROM invitations');
    await pool.query('DELETE FROM team_memberships');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM teams');
    await pool.query('DELETE FROM users');
    await pool.end();
    await redisClient.quit();
    fetchMock.mockRestore();
  });

  it('1. Alice registers, creates a team, and registers her device', async () => {
    const reg = await request(app).post('/auth/register').send({
      firstName: 'Alice', lastName: 'Push', email: 'push-alice@test.com', password: 'password123',
    });
    expect(reg.status).toBe(201);
    aliceToken = reg.body.data.accessToken;
    aliceId = reg.body.data.user.id;

    const team = await request(app).post('/teams').set('Authorization', `Bearer ${aliceToken}`).send({ name: 'Team A' });
    expect(team.status).toBe(201);
    teamAId = team.body.data.id;

    const regDevice = await request(app).post('/devices').set('Authorization', `Bearer ${aliceToken}`).send({
      token: aliceDevice, platform: 'android',
    });
    expect(regDevice.status).toBe(200);
    expect(regDevice.body.data.pushEnabled).toBe(true);

    const list = await request(app).get('/devices').set('Authorization', `Bearer ${aliceToken}`);
    expect(list.status).toBe(200);
    expect(list.body.data.tokens.map((t: { token: string }) => t.token)).toContain(aliceDevice);
  });

  it('2. Bob and Charlie join as STAFF and register devices', async () => {
    const bobReg = await request(app).post('/auth/register').send({
      firstName: 'Bob', lastName: 'Push', email: 'push-bob@test.com', password: 'password123',
    });
    bobToken = bobReg.body.data.accessToken;
    bobId = bobReg.body.data.user.id;

    const charlieReg = await request(app).post('/auth/register').send({
      firstName: 'Charlie', lastName: 'Push', email: 'push-charlie@test.com', password: 'password123',
    });
    charlieToken = charlieReg.body.data.accessToken;
    charlieId = charlieReg.body.data.user.id;

    for (const [token, email] of [[bobToken, 'push-bob@test.com'], [charlieToken, 'push-charlie@test.com']] as const) {
      const invite = await request(app).post(`/invitations/team/${teamAId}`).set('Authorization', `Bearer ${aliceToken}`).send({ email, role: 'STAFF' });
      expect(invite.status).toBe(201);
      const accept = await request(app).post('/invitations/accept').set('Authorization', `Bearer ${token}`).send({ token: invite.body.data.token });
      expect(accept.status).toBe(200);
    }

    await request(app).post('/devices').set('Authorization', `Bearer ${bobToken}`).send({ token: bobDevice });
    await request(app).post('/devices').set('Authorization', `Bearer ${charlieToken}`).send({ token: charlieDevice });
  });

  it('3. Device endpoints require auth and reject malformed tokens', async () => {
    const anon = await request(app).post('/devices').send({ token: aliceDevice, platform: 'ios' });
    expect(anon.status).toBe(401);

    const invalid = await request(app).post('/devices').set('Authorization', `Bearer ${bobToken}`).send({ token: 'short' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error.code).toBe('VALIDATION_ERROR');

    const noToggles = await request(app).patch('/devices/preferences').set('Authorization', `Bearer ${bobToken}`).send({});
    expect(noToggles.status).toBe(400);
  });

  it('4. Preferences default to true and allow partial updates', async () => {
    const before = await request(app).get('/devices/preferences').set('Authorization', `Bearer ${bobToken}`);
    expect(before.status).toBe(200);
    expect(before.body.data).toEqual({ shiftAssigned: true, swapRequested: true, swapApproved: true, swapRejected: true });

    const patch = await request(app).patch('/devices/preferences').set('Authorization', `Bearer ${bobToken}`).send({ swapRequested: false });
    expect(patch.status).toBe(200);
    expect(patch.body.data.swapRequested).toBe(false);
    expect(patch.body.data.shiftAssigned).toBe(true);

    const undo = await request(app).patch('/devices/preferences').set('Authorization', `Bearer ${bobToken}`).send({ swapRequested: true });
    expect(undo.body.data.swapRequested).toBe(true);
  });

  it('5. Creating a shift notifies newly assigned staff with a push', async () => {
    const created = await request(app).post(`/teams/${teamAId}/shifts`).set('Authorization', `Bearer ${aliceToken}`).send({
      title: 'Morning shift',
      startsAt: '2026-10-12T09:00:00.000Z',
      endsAt: '2026-10-12T17:00:00.000Z',
      assigneeIds: [bobId],
    });
    expect(created.status).toBe(201);
    shift1Id = created.body.data.id;

    const { rows } = await pool.query(
      `SELECT status, delivered_at, title, body FROM notifications WHERE user_id = $1 AND type = 'SHIFT_ASSIGNED'`,
      [bobId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SENT');
    expect(rows[0].delivered_at).toBeTruthy();
    expect(String(rows[0].body)).toContain('Morning shift');

    const last = lastPushBody();
    expect(last.to).toEqual([bobDevice]);
    expect(last.title).toBe('New shift assigned');
    expect(last.data).toMatchObject({ teamId: teamAId, shiftId: shift1Id, event: 'shift_assigned' });
  });

  it('6. Re-assigning an existing member does not re-notify', async () => {
    const callsBefore = fetchMock.mock.calls.length;

    const res = await request(app).post(`/teams/${teamAId}/shifts/${shift1Id}/assignments`).set('Authorization', `Bearer ${aliceToken}`).send({ userIds: [bobId] });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(0); // ON CONFLICT DO NOTHING → nothing inserted

    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND type = 'SHIFT_ASSIGNED'`,
      [bobId]
    );
    expect(rows[0].n).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(callsBefore);
  });

  it('7. Assigning a new member via the assignments endpoint notifies them', async () => {
    const callsBefore = fetchMock.mock.calls.length;

    const res = await request(app).post(`/teams/${teamAId}/shifts/${shift1Id}/assignments`).set('Authorization', `Bearer ${aliceToken}`).send({ userIds: [charlieId] });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(1);

    const { rows } = await pool.query(
      `SELECT status FROM notifications WHERE user_id = $1 AND type = 'SHIFT_ASSIGNED'`,
      [charlieId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SENT');
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
    expect(lastPushBody().to).toEqual([charlieDevice]);
  });

  it('8. A targeted swap request notifies the offered user', async () => {
    const bobShift = await request(app).post(`/teams/${teamAId}/shifts`).set('Authorization', `Bearer ${aliceToken}`).send({
      title: 'Night shift',
      startsAt: '2026-10-13T18:00:00.000Z',
      endsAt: '2026-10-13T23:00:00.000Z',
      assigneeIds: [bobId],
    });
    shift2Id = bobShift.body.data.id;

    const swap = await request(app).post(`/teams/${teamAId}/shifts/${shift2Id}/swaps`).set('Authorization', `Bearer ${bobToken}`).send({
      offeredTo: charlieId, reason: 'Doctor appointment',
    });
    expect(swap.status).toBe(201);

    const { rows } = await pool.query(
      `SELECT status, body FROM notifications WHERE user_id = $1 AND type = 'SWAP_REQUESTED'`,
      [charlieId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SENT');
    expect(String(rows[0].body)).toContain('Bob Push');
    expect(String(rows[0].body)).toContain('Night shift');
    expect(lastPushBody().to).toEqual([charlieDevice]);
  });

  it('9. Rejecting a targeted swap notifies the requester', async () => {
    const callsBefore = fetchMock.mock.calls.length;
    const { rows } = await pool.query('SELECT id FROM swap_requests WHERE shift_id = $1', [shift2Id]);
    const swapId = rows[0].id;

    const res = await request(app).post(`/teams/${teamAId}/swaps/${swapId}/reject`).set('Authorization', `Bearer ${charlieToken}`).send({});
    expect(res.status).toBe(200);

    const { rows: notifs } = await pool.query(
      `SELECT status FROM notifications WHERE user_id = $1 AND type = 'SWAP_REJECTED'`,
      [bobId]
    );
    expect(notifs).toHaveLength(1);
    expect(notifs[0].status).toBe('SENT');
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
    expect(lastPushBody().to).toEqual([bobDevice]);
  });

  it('10. Approving a targeted swap notifies the requester and transfers the shift', async () => {
    const freshSwap = await request(app).post(`/teams/${teamAId}/shifts/${shift2Id}/swaps`).set('Authorization', `Bearer ${bobToken}`).send({
      offeredTo: charlieId,
    });
    expect(freshSwap.status).toBe(201);
    const swapId = freshSwap.body.data.id;

    const callsBefore = fetchMock.mock.calls.length;
    const res = await request(app).post(`/teams/${teamAId}/swaps/${swapId}/approve`).set('Authorization', `Bearer ${charlieToken}`).send();
    expect(res.status).toBe(200);

    const { rows: notifs } = await pool.query(
      `SELECT status FROM notifications WHERE user_id = $1 AND type = 'SWAP_APPROVED'`,
      [bobId]
    );
    expect(notifs).toHaveLength(1);
    expect(notifs[0].status).toBe('SENT');
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
    expect(lastPushBody().to).toEqual([bobDevice]);
  });

  it('11. A disabled preference marks the notification SKIPPED without a push', async () => {
    const undoPatch = await request(app).patch('/devices/preferences').set('Authorization', `Bearer ${bobToken}`).send({ swapRejected: false });
    expect(undoPatch.body.data.swapRejected).toBe(false);

    const callsBefore = fetchMock.mock.calls.length;
    await notify({
      teamId: teamAId, userId: bobId, type: 'SWAP_REJECTED',
      title: 'Swap request rejected', body: 'Your swap request for "X" was rejected.',
      data: { teamId: teamAId, event: 'swap_rejected' },
      eventKey: 'swap_rejected:pref-off:bob',
    });

    const { rows } = await pool.query(`SELECT status, last_error FROM notifications WHERE event_key = $1`, ['swap_rejected:pref-off:bob']);
    expect(rows[0].status).toBe('SKIPPED');
    expect(rows[0].last_error).toBe('disabled by user preference');
    expect(fetchMock.mock.calls.length).toBe(callsBefore);

    await request(app).patch('/devices/preferences').set('Authorization', `Bearer ${bobToken}`).send({ swapRejected: true });
  });

  it('12. Permanently invalid Expo tokens are pruned', async () => {
    const badDevice = 'ExponentPushToken[test-charlie-invalid]';
    await request(app).delete('/devices').set('Authorization', `Bearer ${charlieToken}`).send({ token: charlieDevice });
    await request(app).post('/devices').set('Authorization', `Bearer ${charlieToken}`).send({ token: badDevice, platform: 'ios' });

    fetchMock.mockResolvedValueOnce(
      ({ ok: true, json: async () => ({ data: [{ status: 'error', details: { error: 'DeviceNotRegistered' } }] }) } as never)
    );
    await notify({
      teamId: teamAId, userId: charlieId, type: 'SWAP_REQUESTED',
      title: 'Shift swap offer', body: 'TeamMate offered you "X".',
      data: { teamId: teamAId, event: 'swap_requested' },
      eventKey: 'swap_requested:invalid-token:charlie',
    });

    const { rows } = await pool.query(`SELECT status, last_error FROM notifications WHERE event_key = $1`, ['swap_requested:invalid-token:charlie']);
    expect(rows[0].status).toBe('FAILED');

    const { rows: remaining } = await pool.query('SELECT token FROM device_tokens WHERE user_id = $1', [charlieId]);
    expect(remaining).toHaveLength(0);

    await request(app).post('/devices').set('Authorization', `Bearer ${charlieToken}`).send({ token: charlieDevice, platform: 'ios' });
  });

  it('13. Retrying the same event_key never double-sends', async () => {
    const callsBefore = fetchMock.mock.calls.length;
    const event: NotificationEvent = {
      teamId: teamAId, userId: bobId, type: 'SHIFT_ASSIGNED',
      title: 'New shift assigned', body: 'You have a shift.',
      data: { teamId: teamAId, event: 'shift_assigned' },
      eventKey: 'shift_assigned:manual:bob',
    };
    await notify(event);
    await notify(event);

    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE event_key = $1`, ['shift_assigned:manual:bob']);
    expect(rows[0].n).toBe(1);
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
  });

  it('14. Expo delivery failure never fails the shift transaction', async () => {
    const callsBefore = fetchMock.mock.calls.length;
    fetchMock.mockRejectedValueOnce(new Error('network down'));

    const created = await request(app).post(`/teams/${teamAId}/shifts`).set('Authorization', `Bearer ${aliceToken}`).send({
      title: 'Doomed push shift',
      startsAt: '2026-10-14T09:00:00.000Z',
      endsAt: '2026-10-14T17:00:00.000Z',
      assigneeIds: [bobId],
    });
    expect(created.status).toBe(201);

    const { rows } = await pool.query(
      `SELECT status, last_error FROM notifications WHERE user_id = $1 AND type = 'SHIFT_ASSIGNED' AND title = 'New shift assigned'
       AND body LIKE '%Doomed push shift%'`,
      [bobId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('FAILED');
    expect(rows[0].last_error).toBe('delivery exception');
    expect(fetchMock.mock.calls.length).toBe(callsBefore + 1);
  });
});