import express from 'express';
import request from 'supertest';
import { z } from 'zod';
import { requestLogging } from '../src/middleware/request-logging';
import { errorHandler } from '../src/error-handler';
import type { AuthRequest } from '../src/middleware/auth';
import type { Request, Response } from 'express';

const secret = 'NeverLog-password-token-payment-credential';
describe('Phase 3 request logging through HTTP middleware', () => {
  const records: Record<string, unknown>[] = [];
  const app = express();
  app.use(requestLogging, express.json());
  app.get('/teams/:teamId/activity', (req: AuthRequest, res) => {
    req.user = { id: '58da4c16-f125-4c5f-8f9c-6dcd4ac20b66', email: secret, firstName: secret, lastName: secret, createdAt: '' };
    res.json({ success: true });
  });
  app.post('/auth/login', (req, res, next) => {
    try { z.object({ password: z.string().min(8) }).parse(req.body); res.json({ success: true }); } catch (e) { next(e); }
  });
  app.get('/billing/verify', (_req, _res, next) => next(new Error(secret)));
  app.use(errorHandler);
  let logs: jest.SpyInstance, errors: jest.SpyInstance;
  beforeEach(() => {
    records.length = 0;
    logs = jest.spyOn(console, 'log').mockImplementation(line => records.push(JSON.parse(String(line))));
    errors = jest.spyOn(console, 'error').mockImplementation(line => records.push(JSON.parse(String(line))));
  });
  afterEach(() => { logs.mockRestore(); errors.mockRestore(); });
  it('generates an unspoofable ID and records user, normalized route, duration, status and outcome exactly once', async () => {
    const response = await request(app).get('/teams/sensitive-team-name/activity?token=' + secret).set('X-Request-ID', secret).set('Authorization', secret);
    expect(response.status).toBe(200);
    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ event: 'request.finished', requestId: response.headers['x-request-id'], userId: '58da4c16-f125-4c5f-8f9c-6dcd4ac20b66', route: '/teams/:id/activity', status: 200, outcome: 'success' });
    expect(records[0].durationMs).toEqual(expect.any(Number));
    expect(JSON.stringify(records)).not.toContain(secret);
    expect(JSON.stringify(records)).not.toContain('sensitive-team-name');
  });
  it.each([['/auth/login', { password: '' }], ['/auth/login', '{invalid-json']])('logs validation/parse failures without body values', async (path, body) => {
    const response = await request(app).post(path as string).set('Content-Type', 'application/json').send(body);
    expect(response.status).toBe(400);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ status: 400, outcome: 'client_error' });
    expect(records[0]).not.toHaveProperty('body');
  });
  it('reports a server failure without its original error and preserves the API envelope', async () => {
    const response = await request(app).get('/billing/verify?credential=' + secret);
    expect(response.status).toBe(500);
    expect(response.body.error.code).toBe('INTERNAL_SERVER_ERROR');
    expect(records.map(r => r.event)).toEqual(['request.error', 'request.finished']);
    expect(records[0].requestId).toBe(records[1].requestId);
    expect(JSON.stringify(records)).not.toContain(secret);
  });
  it('also logs unmatched routes without revealing arbitrary URL segments', async () => {
    const response = await request(app).get('/' + secret);
    expect(response.status).toBe(404);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ route: '/:id', status: 404, outcome: 'client_error' });
  });
  it('forwards only a fixed error to Express when a partial response must be closed', () => {
    const next = jest.fn();
    errorHandler(new Error(secret), { originalUrl: '/health', method: 'GET' } as Request, { headersSent: true } as Response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0].message).toBe('Response stream failed');
    expect(next.mock.calls[0][0].stack).toBeUndefined();
    expect(JSON.stringify(records)).not.toContain(secret);
  });
});
