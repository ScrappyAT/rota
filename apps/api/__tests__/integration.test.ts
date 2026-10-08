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

  it('10. Last-Owner protection: the last owner cannot demote themselves', async () => {
    const meRes = await request(app).get('/auth/me').set('Authorization', `Bearer ${userAToken}`);
    const aliceId = meRes.body.data.id;

    const res = await request(app).patch(`/teams/${teamAId}/members/${aliceId}/role`).set('Authorization', `Bearer ${userAToken}`).send({
      role: 'STAFF'
    });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Cannot demote the last owner');
  });

  it('11. Last-Owner protection: the last owner cannot be removed', async () => {
    const meRes = await request(app).get('/auth/me').set('Authorization', `Bearer ${userAToken}`);
    const aliceId = meRes.body.data.id;

    const res = await request(app).delete(`/teams/${teamAId}/members/${aliceId}`).set('Authorization', `Bearer ${userAToken}`);
    expect(res.status).toBe(403);
    expect(res.body.error.message).toBe('Cannot remove the last owner');

    // A manager cannot remove an owner either
    const managerRes = await request(app).delete(`/teams/${teamAId}/members/${aliceId}`).set('Authorization', `Bearer ${userBToken}`);
    expect(managerRes.status).toBe(403);
  });

  it('12. Invitation is single-use: the same token cannot be accepted twice', async () => {
    const res = await request(app).post('/invitations/accept').set('Authorization', `Bearer ${userBToken}`).send({
      token: inviteToken
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });

  it('13. Invitation expires: an expired token cannot be accepted', async () => {
    const expiredEmail = `expired-${Date.now()}@test.com`;

    const inviteRes = await request(app).post(`/invitations/team/${teamBId}`).set('Authorization', `Bearer ${userBToken}`).send({
      email: expiredEmail,
      role: 'STAFF'
    });
    expect(inviteRes.status).toBe(201);
    const expiredToken = inviteRes.body.data.token;

    const registerRes = await request(app).post('/auth/register').send({
      firstName: 'Eve', lastName: 'E', email: expiredEmail, password: 'password123'
    });
    expect(registerRes.status).toBe(201);
    const eveToken = registerRes.body.data.accessToken;

    await pool.query(
      "UPDATE invitations SET expires_at = NOW() - INTERVAL '1 day' WHERE team_id = $1 AND email = $2",
      [teamBId, expiredEmail]
    );

    const res = await request(app).post('/invitations/accept').set('Authorization', `Bearer ${eveToken}`).send({
      token: expiredToken
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
  });
});

describe('Refresh token rotation, reuse protection, and error handling', () => {
  const uniqueEmail = `refresh-${Date.now()}@test.com`;
  let firstRefreshToken = '';
  let secondRefreshToken = '';

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  it('registers a new user and returns a refresh token', async () => {
    const res = await request(app).post('/auth/register').send({
      firstName: 'Rita', lastName: 'R', email: uniqueEmail, password: 'password123'
    });
    expect(res.status).toBe(201);
    firstRefreshToken = res.body.data.refreshToken;
    expect(firstRefreshToken).toBeTruthy();
  });

  it('rotates the refresh token on use', async () => {
    const loginRes = await request(app).post('/auth/login').send({
      email: uniqueEmail, password: 'password123'
    });
    expect(loginRes.status).toBe(200);
    const userId = loginRes.body.data.user.id;

    const res = await request(app).post('/auth/refresh').send({
      refreshToken: firstRefreshToken, userId
    });
    expect(res.status).toBe(200);
    secondRefreshToken = res.body.data.refreshToken;
    expect(secondRefreshToken).toBeTruthy();
    expect(secondRefreshToken).not.toBe(firstRefreshToken);
  });

  it('rejects reuse of the rotated token and revokes the session family', async () => {
    const loginRes = await request(app).post('/auth/login').send({
      email: uniqueEmail, password: 'password123'
    });
    expect(loginRes.status).toBe(200);
    const userId = loginRes.body.data.user.id;

    const reuse = await request(app).post('/auth/refresh').send({
      refreshToken: firstRefreshToken, userId
    });
    expect(reuse.status).toBe(401);

    // Reuse detection revokes every active token for the user
    const subsequent = await request(app).post('/auth/refresh').send({
      refreshToken: secondRefreshToken, userId
    });
    expect(subsequent.status).toBe(401);
  });

  it('returns 400 (not 500) for schema validation failures', async () => {
    const res = await request(app).post('/auth/register').send({
      firstName: 'Bad', lastName: 'Input', email: 'not-an-email', password: 'short'
    });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unauthenticated access to protected routes', async () => {
    const res = await request(app).get('/teams');
    expect(res.status).toBe(401);
  });

  it('rejects invitation acceptance without a token', async () => {
    const login = await request(app).post('/auth/login').send({
      email: uniqueEmail, password: 'password123'
    });
    expect(login.status).toBe(200);
    const res = await request(app)
      .post('/invitations/accept')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
