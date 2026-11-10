import crypto from 'crypto';
import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { hashInvitationCode } from '../src/services/invitation';
import { drainTestJobs } from './helpers/jobs';
import { enqueueOutbox } from '../src/services/outbox';
const actor = async () => {
  const email = `phase2-${crypto.randomUUID()}@example.test`;
  const result = await request(app).post('/auth/register').send({ email, password: 'Password123', firstName: 'Phase2', lastName: 'Mobile' });
  expect(result.status).toBe(201); return { email, id: result.body.data.user.id as string, token: result.body.data.accessToken as string };
};
type Actor = Awaited<ReturnType<typeof actor>>;
const call = (user: Actor) => ({ Authorization: `Bearer ${user.token}` });
const fixture = async () => {
  const owner = await actor(), staff = await actor();
  const result = await request(app).post('/teams').set(call(owner)).send({ name: 'Phase 2 invitation' }); expect(result.status).toBe(201);
  const team = result.body.data.id as string;
  const invite = await request(app).post(`/invitations/team/${team}`).set(call(owner)).send({ email: staff.email, role: 'STAFF' }); expect(invite.status).toBe(201);
  return { owner, staff, team, code: invite.body.data.code as string };
};
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('127.0.0.1:5540/rota_r1_test') || process.env.REDIS_URL !== 'redis://127.0.0.1:6480') throw new Error('Disposable Phase 2 services required');
  await redisClient.connect();
});
afterAll(async () => { await redisClient.quit(); await pool.end(); });
it('returns the authenticated redeemed team and exposes it on membership refresh', async () => {
  const f = await fixture();
  const result = await request(app).post('/invitations/accept').set(call(f.staff)).send({ code: f.code });
  expect(result.status).toBe(200); expect(result.body.data).toEqual({ teamId: f.team });
  const teams = await request(app).get('/teams').set(call(f.staff)); expect(teams.body.data.map((t: { id: string }) => t.id)).toEqual([f.team]);
});
it('does not disclose a destination on replay, expiry or invalid invitation', async () => {
  const f = await fixture(); await request(app).post('/invitations/accept').set(call(f.staff)).send({ code: f.code }).expect(200);
  const replay = await request(app).post('/invitations/accept').set(call(f.staff)).send({ code: f.code }); expect(replay.status).toBe(400); expect(replay.body.data).toBeUndefined();
  const expired = await fixture(); await pool.query('UPDATE invitations SET expires_at=NOW()-INTERVAL \'1 minute\' WHERE token_hash=$1', [hashInvitationCode(expired.code)]);
  const result = await request(app).post('/invitations/accept').set(call(expired.staff)).send({ code: expired.code }); expect(result.status).toBe(400); expect(result.body.data).toBeUndefined();
});
it('rejects a different email, unauthenticated redemption and malformed input', async () => {
  const f = await fixture(), outsider = await actor();
  await request(app).post('/invitations/accept').set(call(outsider)).send({ code: f.code }).expect(403);
  await request(app).post('/invitations/accept').send({ code: f.code }).expect(401);
  await request(app).post('/invitations/accept').set(call(f.staff)).send({ code: '123', extra: true }).expect(400);
  expect((await pool.query('SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2', [f.team, outsider.id])).rows).toHaveLength(0);
});
it.each(['OWNER', 'MANAGER'] as const)('permits %s to edit the exact details exposed by the mobile editor', async role => {
  const f = await fixture();
  await request(app).post('/invitations/accept').set(call(f.staff)).send({ code: f.code }).expect(200);
  if (role === 'MANAGER') await pool.query("UPDATE team_memberships SET role='MANAGER' WHERE team_id=$1 AND user_id=$2", [f.team, f.staff.id]);
  const user = role === 'OWNER' ? f.owner : f.staff;
  const created = await request(app).post(`/teams/${f.team}/shifts`).set(call(user)).send({ title: 'Before', startsAt: '2027-01-01T09:00:00Z', endsAt: '2027-01-01T17:00:00Z' }); expect(created.status).toBe(201);
  const edited = await request(app).patch(`/teams/${f.team}/shifts/${created.body.data.id}`).set(call(user)).send({ title: 'After', description: 'New notes', startsAt: '2027-01-02T10:00:00Z', endsAt: '2027-01-02T18:00:00Z' });
  expect(edited.status).toBe(200); expect(edited.body.data).toMatchObject({ title: 'After', description: 'New notes' });
  const outsider = await actor();
  await request(app).patch(`/teams/${f.team}/shifts/${created.body.data.id}`).set(call(outsider)).send({ title: 'Denied' }).expect(404);
  await request(app).patch(`/teams/${f.team}/shifts/${created.body.data.id}`).set(call(user)).send({ startsAt: '2027-01-03T10:00:00Z', endsAt: '2027-01-01T09:00:00Z' }).expect(400);
});
it('continues to reject staff shift edits', async () => {
  const f = await fixture(); await request(app).post('/invitations/accept').set(call(f.staff)).send({ code: f.code }).expect(200);
  const created = await request(app).post(`/teams/${f.team}/shifts`).set(call(f.owner)).send({ title: 'Owner shift', startsAt: '2027-01-01T09:00:00Z', endsAt: '2027-01-01T17:00:00Z' });
  await request(app).patch(`/teams/${f.team}/shifts/${created.body.data.id}`).set(call(f.staff)).send({ title: 'Denied' }).expect(403);
});
it('supports the mobile assigned-upcoming and date-calendar queries without leaking other teams', async () => {
  const f = await fixture(); await request(app).post('/invitations/accept').set(call(f.staff)).send({ code: f.code }).expect(200);
  const make = (title: string, day: string, assigneeIds?: string[]) => request(app).post(`/teams/${f.team}/shifts`).set(call(f.owner)).send({ title, startsAt: `${day}T09:00:00Z`, endsAt: `${day}T17:00:00Z`, assigneeIds });
  const assigned = await make('Assigned upcoming', '2027-01-01', [f.staff.id]); expect(assigned.status).toBe(201);
  await make('Not assigned', '2027-01-01'); await make('Next day', '2027-01-02');
  const mine = await request(app).get(`/teams/${f.team}/shifts`).query({ assignedTo: f.staff.id, status: 'ACTIVE', from: '2027-01-01T00:00:00Z', to: '2027-01-01T23:59:59Z' }).set(call(f.staff));
  expect(mine.status).toBe(200); expect(mine.body.data.items.map((s: { id: string }) => s.id)).toEqual([assigned.body.data.id]);
  const calendar = await request(app).get(`/teams/${f.team}/shifts`).query({ from: '2027-01-02T00:00:00Z', to: '2027-01-02T23:59:59Z' }).set(call(f.staff));
  expect(calendar.status).toBe(200); expect(calendar.body.data.items.map((s: { title: string }) => s.title)).toEqual(['Next day']);
  await request(app).get(`/teams/${f.team}/shifts?assignedTo=invalid`).set(call(f.staff)).expect(400);
  await request(app).get(`/teams/${f.team}/shifts`).set(call(await actor())).expect(404);
});
it('drains a database-due recheck even when the test host clock lags the database', async () => {
  const f = await fixture();
  const client = await pool.connect();
  let jobId: string;
  try {
    jobId = await enqueueOutbox(client, { key: `phase2-clock:${crypto.randomUUID()}`, kind: 'BILLING_RECHECK', teamId: f.team, payload: { teamId: f.team } });
  } finally { client.release(); }
  const databaseNow = (await pool.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
  jest.useFakeTimers({ now: new Date(databaseNow.getTime() - 30_000), doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'] });
  try {
    await drainTestJobs(['BILLING_RECHECK']);
    expect((await pool.query('SELECT status FROM job_outbox WHERE id=$1', [jobId])).rows[0].status).toBe('COMPLETED');
  } finally { jest.useRealTimers(); }
}, 15000);
