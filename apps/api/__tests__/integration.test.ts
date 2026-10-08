import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';

describe('Phase 2 Integration Scenario', () => {
  let userAToken: string;
  let userBToken: string;
  let teamAId: string;
  let teamBId: string;
  let inviteToken: string;
  let userBId: string;

  beforeAll(async () => {
    // Clear relevant tables
    await pool.query('DELETE FROM team_memberships');
    await pool.query('DELETE FROM invitations');
    await pool.query('DELETE FROM teams');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM users');
    await redisClient.connect().catch(() => {});
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  it('1. Register User A', async () => {
    const res = await request(app).post('/auth/register').send({
      firstName: 'Alice', lastName: 'A', email: 'alice@test.com', password: 'password123'
    });
    expect(res.status).toBe(201);
    userAToken = res.body.data.accessToken;
  });

  it('2. Create Team A', async () => {
    const res = await request(app).post('/teams').set('Authorization', `Bearer ${userAToken}`).send({
      name: 'Team A'
    });
    expect(res.status).toBe(201);
    teamAId = res.body.data.id;
  });

  it('3. Register User B', async () => {
    const res = await request(app).post('/auth/register').send({
      firstName: 'Bob', lastName: 'B', email: 'bob@test.com', password: 'password123'
    });
    expect(res.status).toBe(201);
    userBToken = res.body.data.accessToken;
    userBId = res.body.data.user.id;
  });

  it('4. Create Team B', async () => {
    const res = await request(app).post('/teams').set('Authorization', `Bearer ${userBToken}`).send({
      name: 'Team B'
    });
    expect(res.status).toBe(201);
    teamBId = res.body.data.id;
  });

  it('5. Verify User A cannot access Team B', async () => {
    const res = await request(app).get(`/teams/${teamBId}`).set('Authorization', `Bearer ${userAToken}`);
    expect(res.status).toBe(404); // Not found because of tenant isolation middleware
  });

  it('6. Invite User B to Team A as MANAGER', async () => {
    const res = await request(app).post(`/invitations/team/${teamAId}`).set('Authorization', `Bearer ${userAToken}`).send({
      email: 'bob@test.com',
      role: 'MANAGER'
    });
    expect(res.status).toBe(201);
    inviteToken = res.body.data.token;
  });

  it('7. Accept the invitation', async () => {
    const res = await request(app).post('/invitations/accept').set('Authorization', `Bearer ${userBToken}`).send({
      token: inviteToken
    });
    expect(res.status).toBe(200);
  });

  it('8. Confirm User B receives the correct role', async () => {
    const res = await request(app).get(`/teams/${teamAId}`).set('Authorization', `Bearer ${userBToken}`);
    expect(res.status).toBe(200);

    const membersRes = await request(app).get(`/teams/${teamAId}/members`).set('Authorization', `Bearer ${userBToken}`);
    const bobMember = membersRes.body.data.find((m: any) => m.userId === userBId);
    expect(bobMember.role).toBe('MANAGER');
  });

  it('9. Verify restricted operations are rejected (Bob trying to change Alice role)', async () => {
    // Alice is OWNER (the creator). Bob is MANAGER. Bob cannot change Alice's role.
    // Actually our endpoint requires OWNER role to PATCH roles.
    // So Bob trying to patch ANY role will fail.
    const getAliceRes = await request(app).get('/auth/me').set('Authorization', `Bearer ${userAToken}`);
    const aliceId = getAliceRes.body.data.id;

    const res = await request(app).patch(`/teams/${teamAId}/members/${aliceId}/role`).set('Authorization', `Bearer ${userBToken}`).send({
      role: 'STAFF'
    });
    expect(res.status).toBe(403);
  });
});
