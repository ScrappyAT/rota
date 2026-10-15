import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { cacheKeys } from '../src/services/cache';
import { Roles } from '@rota/shared';

describe('Redis Cache-Aside, Invalidation, and Tenant Isolation', () => {
  let ownerToken: string;
  let ownerId: string;
  let staffToken: string;
  let staffId: string;
  let otherTeamOwnerToken: string;
  let teamId: string;
  let otherTeamId: string;

  beforeAll(async () => {
    // Clean tables
    await pool.query('DELETE FROM activity_events');
    await pool.query('DELETE FROM swap_requests');
    await pool.query('DELETE FROM shift_assignments');
    await pool.query('DELETE FROM shifts');
    await pool.query('DELETE FROM team_subscriptions');
    await pool.query('DELETE FROM team_memberships');
    await pool.query('DELETE FROM invitations');
    await pool.query('DELETE FROM teams');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM users');

    await redisClient.connect().catch(() => {});
    if (redisClient.isReady) {
      await redisClient.flushAll();
    }

    // Register primary owner
    const ownerRes = await request(app).post('/auth/register').send({
      firstName: 'Cache',
      lastName: 'Owner',
      email: 'cache.owner@example.com',
      password: 'password123',
    });
    ownerToken = ownerRes.body.data.accessToken;
    ownerId = ownerRes.body.data.user.id;

    // Register staff member
    const staffRes = await request(app).post('/auth/register').send({
      firstName: 'Cache',
      lastName: 'Staff',
      email: 'cache.staff@example.com',
      password: 'password123',
    });
    staffToken = staffRes.body.data.accessToken;
    staffId = staffRes.body.data.user.id;

    // Register other team owner
    const otherOwnerRes = await request(app).post('/auth/register').send({
      firstName: 'Other',
      lastName: 'Owner',
      email: 'other.owner@example.com',
      password: 'password123',
    });
    otherTeamOwnerToken = otherOwnerRes.body.data.accessToken;

    // Create Team 1
    const teamRes = await request(app)
      .post('/teams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Caching Team' });
    teamId = teamRes.body.data.id;

    // Create Team 2 (for tenant isolation test)
    const otherTeamRes = await request(app)
      .post('/teams')
      .set('Authorization', `Bearer ${otherTeamOwnerToken}`)
      .send({ name: 'Isolated Team' });
    otherTeamId = otherTeamRes.body.data.id;

    // Add staff to Team 1 directly
    await pool.query(
      'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)',
      [teamId, staffId, Roles.STAFF]
    );
  });

  afterAll(async () => {
    // Restore process env
    delete process.env.ENABLE_REDIS_CACHE;
    await redisClient.quit().catch(() => {});
  });

  describe('Team Roster Caching & Invalidation', () => {
    it('populates Redis on cache miss and serves subsequent read from cache', async () => {
      const rosterKey = cacheKeys.roster(teamId);
      // Ensure key doesn't exist yet
      await redisClient.del(rosterKey);

      // First call: Cache miss -> queries DB -> sets cache
      const res1 = await request(app)
        .get(`/teams/${teamId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data.length).toBe(2);

      // Verify key is in Redis
      const cachedRaw = await redisClient.get(rosterKey);
      expect(cachedRaw).not.toBeNull();
      const parsed = JSON.parse(cachedRaw!);
      expect(parsed.length).toBe(2);

      // Second call: Cache hit
      const res2 = await request(app)
        .get(`/teams/${teamId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toEqual(parsed);
    });

    it('invalidates roster cache when a member role is updated', async () => {
      const rosterKey = cacheKeys.roster(teamId);
      expect(await redisClient.get(rosterKey)).not.toBeNull();

      // Update staff to MANAGER
      const patchRes = await request(app)
        .patch(`/teams/${teamId}/members/${staffId}/role`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ role: Roles.MANAGER });
      expect(patchRes.status).toBe(200);

      // Cache should be evicted
      const cachedAfter = await redisClient.get(rosterKey);
      expect(cachedAfter).toBeNull();

      // Subsequent read repopulates with the updated role
      const res = await request(app)
        .get(`/teams/${teamId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.status).toBe(200);
      const updatedMember = res.body.data.find((m: any) => m.userId === staffId);
      expect(updatedMember.role).toBe(Roles.MANAGER);

      // Re-check redis
      expect(await redisClient.get(rosterKey)).not.toBeNull();
    });

    it('invalidates roster cache when a member is removed', async () => {
      const rosterKey = cacheKeys.roster(teamId);
      expect(await redisClient.get(rosterKey)).not.toBeNull();

      // Remove staff member
      const delRes = await request(app)
        .delete(`/teams/${teamId}/members/${staffId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(delRes.status).toBe(200);

      // Cache key must be gone
      expect(await redisClient.get(rosterKey)).toBeNull();

      // Read returns only owner now
      const res = await request(app)
        .get(`/teams/${teamId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.body.data.length).toBe(1);

      // Re-add staff for subsequent tests
      await pool.query(
        'INSERT INTO team_memberships (team_id, user_id, role) VALUES ($1, $2, $3)',
        [teamId, staffId, Roles.STAFF]
      );
      await redisClient.del(rosterKey);
    });
  });

  describe('Shift Calendar Caching & Invalidation', () => {
    let createdShiftId: string;

    it('caches shift calendar queries with query parameter hashing', async () => {
      // Query shifts for team
      const res1 = await request(app)
        .get(`/teams/${teamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res1.status).toBe(200);

      // Check that a shift cache key exists for this team
      const keys = await redisClient.keys(`cache:shifts:${teamId}:*`);
      expect(keys.length).toBeGreaterThanOrEqual(1);

      // Second call returns cached data
      const res2 = await request(app)
        .get(`/teams/${teamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res2.status).toBe(200);
      expect(res2.body.data).toEqual(res1.body.data);
    });

    it('invalidates all team shift and activity cache keys upon shift creation', async () => {
      // Ensure cache exists
      await request(app)
        .get(`/teams/${teamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);
      await request(app)
        .get(`/teams/${teamId}/activity?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);

      expect((await redisClient.keys(`cache:shifts:${teamId}:*`)).length).toBeGreaterThan(0);
      expect((await redisClient.keys(`cache:activity:${teamId}:*`)).length).toBeGreaterThan(0);

      // Create a new shift
      const createRes = await request(app)
        .post(`/teams/${teamId}/shifts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Morning Shift',
          startsAt: new Date(Date.now() + 3600000).toISOString(),
          endsAt: new Date(Date.now() + 7200000).toISOString(),
        });
      expect(createRes.status).toBe(201);
      createdShiftId = createRes.body.data.id;

      // Both shift and activity cache for teamId must be evicted
      const shiftKeysAfter = await redisClient.keys(`cache:shifts:${teamId}:*`);
      const activityKeysAfter = await redisClient.keys(`cache:activity:${teamId}:*`);
      expect(shiftKeysAfter.length).toBe(0);
      expect(activityKeysAfter.length).toBe(0);
    });

    it('invalidates shift cache upon shift update and assignment', async () => {
      // Warm up cache
      await request(app)
        .get(`/teams/${teamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect((await redisClient.keys(`cache:shifts:${teamId}:*`)).length).toBeGreaterThan(0);

      // Update shift
      const updateRes = await request(app)
        .patch(`/teams/${teamId}/shifts/${createdShiftId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ title: 'Updated Morning Shift' });
      expect(updateRes.status).toBe(200);

      // Evicted
      expect((await redisClient.keys(`cache:shifts:${teamId}:*`)).length).toBe(0);

      // Warm up cache again
      await request(app)
        .get(`/teams/${teamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect((await redisClient.keys(`cache:shifts:${teamId}:*`)).length).toBeGreaterThan(0);

      // Assign staff to shift
      const assignRes = await request(app)
        .post(`/teams/${teamId}/shifts/${createdShiftId}/assignments`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ userIds: [staffId] });
      expect(assignRes.status).toBe(201);

      // Evicted again
      expect((await redisClient.keys(`cache:shifts:${teamId}:*`)).length).toBe(0);
    });

    it('invalidates shift cache upon shift deletion', async () => {
      // Warm up cache
      await request(app)
        .get(`/teams/${teamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect((await redisClient.keys(`cache:shifts:${teamId}:*`)).length).toBeGreaterThan(0);

      // Delete shift
      const delRes = await request(app)
        .delete(`/teams/${teamId}/shifts/${createdShiftId}`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(delRes.status).toBe(200);

      // Shift cache evicted
      expect((await redisClient.keys(`cache:shifts:${teamId}:*`)).length).toBe(0);
    });
  });

  describe('Tenant Cache Isolation', () => {
    it('mutations in Team 1 never invalidate or leak into Team 2 cache', async () => {
      // Warm up Team 2 cache
      const otherRes = await request(app)
        .get(`/teams/${otherTeamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${otherTeamOwnerToken}`);
      expect(otherRes.status).toBe(200);

      const otherKeysBefore = await redisClient.keys(`cache:shifts:${otherTeamId}:*`);
      expect(otherKeysBefore.length).toBeGreaterThan(0);

      // Perform a mutation in Team 1 (create shift)
      await request(app)
        .post(`/teams/${teamId}/shifts`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          title: 'Team 1 Only Shift',
          startsAt: new Date(Date.now() + 10000000).toISOString(),
          endsAt: new Date(Date.now() + 14000000).toISOString(),
        });

      // Team 2 cache must remain untouched
      const otherKeysAfter = await redisClient.keys(`cache:shifts:${otherTeamId}:*`);
      expect(otherKeysAfter.length).toBe(otherKeysBefore.length);
      expect(otherKeysAfter).toEqual(otherKeysBefore);
    });
  });

  describe('Cache Bypass Flag (ENABLE_REDIS_CACHE=false)', () => {
    it('bypasses Redis entirely when ENABLE_REDIS_CACHE is set to false', async () => {
      process.env.ENABLE_REDIS_CACHE = 'false';

      // Clear all keys first
      await redisClient.flushAll();

      // Query roster and shifts
      const rosterRes = await request(app)
        .get(`/teams/${teamId}/members`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(rosterRes.status).toBe(200);

      const shiftsRes = await request(app)
        .get(`/teams/${teamId}/shifts?limit=20`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(shiftsRes.status).toBe(200);

      // Redis must have 0 keys because cache is disabled
      const allKeys = await redisClient.keys('*');
      expect(allKeys.length).toBe(0);

      // Re-enable
      process.env.ENABLE_REDIS_CACHE = 'true';
    });
  });
});
