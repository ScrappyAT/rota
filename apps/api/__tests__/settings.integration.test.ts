import crypto from 'crypto';
import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
describe('server-owned multi-device settings', () => {
  let token: string, other: string;
  const get = (bearer = token) => request(app).get('/settings').set('Authorization', `Bearer ${bearer}`);
  const patch = (body: object) => request(app).patch('/settings').set('Authorization', `Bearer ${token}`).send(body);
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.port !== '5540' || url.pathname !== '/rota_r1_test' || url.hostname !== '127.0.0.1')
      throw new Error('Disposable server only');
    await redisClient.connect().catch(() => { });
    for (let i = 0;i < 2;i++) {
      const r = await request(app).post('/auth/register').send({ email: `settings-${crypto.randomUUID()}@test.example`, password: 'password123', firstName: 'Settings', lastName: 'Test' });
      expect(r.status).toBe(201);
      if (i === 0)
        token = r.body.data.accessToken;
      else
        other = r.body.data.accessToken;
    }
  });
  afterAll(async () => { await pool.end(); await redisClient.quit(); });
  it('requires authentication', async () => expect((await request(app).get('/settings')).status).toBe(401));
  it('returns defaults and server timestamps', async () => { const r = await get(); expect(r.status).toBe(200); expect(r.body.data).toMatchObject({ timeZone: 'UTC', theme: 'system', quietHours: { enabled: false }, notificationCategories: { shifts: true, swaps: true, billing: true } }); expect(r.body.data.fieldUpdatedAt).toHaveProperty(['notificationCategories.billing']); });
  it('updates quiet hours,zone,language,theme and categories', async () => {
    const r = await patch({ quietHours: { enabled: true, start: '22:00', end: '06:00' }, timeZone: 'Africa/Lagos', language: 'fr', theme: 'dark', notificationCategories: { billing: false } });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ language: 'fr', timeZone: 'Africa/Lagos', theme: 'dark' });
    expect(r.body.data.fieldUpdatedAt.timeZone).toBe(r.body.data.updatedAt);
    expect((await get()).body.data).toEqual(r.body.data);
  });
  it('does not expose or change another user\'s settings', async () => { expect((await get(other)).body.data.timeZone).toBe('UTC'); expect((await patch({ userId: crypto.randomUUID(), theme: 'light' })).status).toBe(400); });
  it('serializes partial writes without losing independent fields', async () => {
    const before = (await get()).body.data;
    const results = await Promise.all([patch({ theme: 'light' }), patch({ language: 'ha' }), patch({ notificationCategories: { shifts: false } })]);
    expect(results.every(r => r.status === 200)).toBe(true);
    const now = (await get()).body.data;
    expect(now).toMatchObject({ theme: 'light', language: 'ha', notificationCategories: { shifts: false, billing: false } });
    expect(now.fieldUpdatedAt.timeZone).toBe(before.fieldUpdatedAt.timeZone);
  });
  it('last server-received change wins even from an older device snapshot', async () => {
    const first = await patch({ theme: 'dark' }), second = await patch({ theme: 'system' });
    expect((await get()).body.data.theme).toBe('system');
    expect(second.body.data.fieldUpdatedAt.theme > first.body.data.fieldUpdatedAt.theme).toBe(true);
  });
  it('legacy preference endpoints update the same timestamped settings', async () => {
    const r = await request(app).patch('/devices/preferences').set('Authorization', `Bearer ${token}`).send({ swapRequested: false });
    expect(r.status).toBe(200);
    const settings = (await get()).body.data;
    expect(settings.notificationTypes.swapRequested).toBe(false);
    expect(settings.fieldUpdatedAt['notificationTypes.swapRequested']).toBe(settings.updatedAt);
  });
  it.each([{ timeZone: 'Mars/Moon' }, { quietHours: { enabled: true, start: '22:00', end: '22:00' } }, { updatedAt: '2999-01-01' }, {}])('rejects malformed/untrusted writes %#', async (body) => expect((await patch(body)).status).toBe(400));
});
