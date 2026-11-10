import crypto from 'crypto';
import request from 'supertest';
import { Pool } from 'pg';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { replicaPool } from '../src/services/read-routing';

jest.mock('../src/env', () => {
  const actual = jest.requireActual('../src/env');
  return { ...actual, env: { ...actual.env, READ_DATABASE_URL: 'postgres://postgres:r3-disposable-only@127.0.0.1:5543/rota_r1_test' } };
});
const replica = new Pool({ connectionString: 'postgres://postgres:r3-disposable-only@127.0.0.1:5543/rota_r1_test', max: 2 });
interface Actor { id: string; token: string }
const register = async (): Promise<Actor> => {
  const r = await request(app).post('/auth/register').send({ email: `phase1-authz-${crypto.randomUUID()}@example.test`, password: 'Password123', firstName: 'Phase1', lastName: 'Membership' });
  expect(r.status).toBe(201); return { id: r.body.data.user.id, token: r.body.data.accessToken };
};
const createTeam = async (owner: Actor, name: string): Promise<string> => {
  const r = await request(app).post('/teams').set('Authorization', `Bearer ${owner.token}`).send({ name }); expect(r.status).toBe(201); return r.body.data.id;
};
const list = (actor: Actor) => request(app).get('/teams').set('Authorization', `Bearer ${actor.token}`);
const staleTeam = async (team: string, user: Actor, owner: Actor, name: string) => {
  await replica.query('INSERT INTO teams(id,name,owner_id) VALUES($1,$2,$3)', [team, name, owner.id]);
  await replica.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'STAFF')", [team, user.id]);
};
beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('127.0.0.1:5540/rota_r1_test') || process.env.REDIS_URL !== 'redis://127.0.0.1:6480') throw new Error('Disposable Phase 1 primary/Redis required');
  expect(new URL(replicaPool!.options.connectionString!).port).toBe('5543');
  await redisClient.connect();
  // Real independent read DB tables reproduce the production list/detail query.
  await replica.query(`CREATE TABLE IF NOT EXISTS teams(id UUID PRIMARY KEY,name VARCHAR(255) NOT NULL,owner_id UUID NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS team_memberships(team_id UUID NOT NULL,user_id UUID NOT NULL,role TEXT NOT NULL,PRIMARY KEY(team_id,user_id));`);
});
afterAll(async () => { await replica.end(); await redisClient.quit(); await pool.end(); });

it('does not disclose a removed membership or replica-only team while still returning legitimate teams', async () => {
  const owner = await register(), user = await register();
  const revoked = await createTeam(owner, 'Primary revoked secret'), legitimate = await createTeam(owner, 'Primary legitimate'), replicaOnly = crypto.randomUUID();
  for (const team of [revoked, legitimate]) await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'STAFF')", [team, user.id]);
  await staleTeam(revoked, user, owner, 'Replica revoked secret'); await staleTeam(legitimate, user, owner, 'Replica legitimate'); await staleTeam(replicaOnly, user, owner, 'Replica-only secret');
  await pool.query('DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2', [revoked, user.id]);
  await pool.query('DELETE FROM user_write_fences WHERE user_id=$1', [user.id]);
  const r = await list(user); expect(r.status).toBe(200); expect(r.body.data.map((t: { id: string }) => t.id)).toEqual([legitimate]);
  expect(JSON.stringify(r.body)).not.toContain('revoked secret'); expect(JSON.stringify(r.body)).not.toContain(replicaOnly);
  for (const path of ['', '/members', '/shifts', '/swaps', '/activity', '/subscription']) {
    const denied = await request(app).get(`/teams/${revoked}${path}`).set('Authorization', `Bearer ${user.token}`); expect(denied.status).toBe(404);
  }
  expect((await replica.query('SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2', [revoked, user.id])).rows).toHaveLength(1);
});

it('returns an empty list when only the stale replica claims membership', async () => {
  const owner = await register(), user = await register(), revoked = await createTeam(owner, 'Hidden former team');
  await staleTeam(revoked, user, owner, 'Stale hidden former team');
  const r = await list(user); expect(r.status).toBe(200); expect(r.body.data).toEqual([]);
});

it('lists a newly authorized team even when the replica has not received it', async () => {
  const owner = await register(), user = await register(), fresh = await createTeam(owner, 'New primary team');
  await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'STAFF')", [fresh, user.id]);
  const r = await list(user); expect(r.status).toBe(200); expect(r.body.data.map((t: { id: string }) => t.id)).toEqual([fresh]);
});

it('preserves replica reads for authorized team details while list authorization stays primary', async () => {
  const owner = await register(), user = await register(), team = await createTeam(owner, 'Authoritative primary name');
  await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'STAFF')", [team, user.id]);
  await staleTeam(team, user, owner, 'Replica detail marker');
  const details = await request(app).get(`/teams/${team}`).set('Authorization', `Bearer ${user.token}`);
  expect(details.status).toBe(200); expect(details.body.data.name).toBe('Replica detail marker');
  expect((await list(user)).body.data[0].name).toBe('Authoritative primary name');
  expect((await request(app).get('/teams')).status).toBe(401);
  expect((await request(app).get('/teams/not-a-uuid').set('Authorization', `Bearer ${user.token}`)).status).toBe(400);
});
