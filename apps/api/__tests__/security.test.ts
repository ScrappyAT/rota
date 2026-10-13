import request from 'supertest';
import express from 'express';
import cors from 'cors';
import { app } from '../src/index';
import { createCorsMiddleware } from '../src/cors';
import { redisRateLimit } from '../src/middleware/rate-limit-redis';
import { errorHandler } from '../src/error-handler';

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({}),
    end: jest.fn(),
  },
}));

jest.mock('../src/redis', () => ({
  redisClient: {
    isReady: true,
    connect: jest.fn(),
    quit: jest.fn(),
    incr: jest.fn(),
    expire: jest.fn(),
  },
}));

import { redisClient } from '../src/redis';

describe('Helmet security headers', () => {
  it('returns common hardening headers on every response', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBeDefined();
    expect(res.headers['strict-transport-security']).toBeDefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('CORS middleware', () => {
  const miniApp = (originConfig: string, extraOrigins: string[] = []) => {
    const mini = express();
    const middleware = cors(createCorsMiddleware(originConfig, extraOrigins));
    mini.use(middleware);
    mini.options('*', middleware);
    mini.get('/x', (_req, res) => res.json({ ok: true }));
    mini.post('/x', (_req, res) => res.json({ created: true }));
    mini.use(errorHandler);
    return mini;
  };

  it('allows any origin when configured as *', async () => {
    const res = await request(miniApp('*'))
      .get('/x')
      .set('Origin', 'http://evil.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('allows listed origins and echoes them', async () => {
    const res = await request(miniApp('https://app.rota.example,https://staff.rota.example'))
      .get('/x')
      .set('Origin', 'https://app.rota.example');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('https://app.rota.example');
  });

  it('blocks unlisted origins with a CORS_BLOCKED error', async () => {
    const res = await request(miniApp('https://app.rota.example'))
      .get('/x')
      .set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('CORS_BLOCKED');
  });

  it('allows same-origin / no-Origin requests', async () => {
    const res = await request(miniApp('https://app.rota.example')).get('/x');
    expect(res.status).toBe(200);
  });

  it('allows http://localhost:8081 development origin and blocks unauthorized origin', async () => {
    const appWithDev = miniApp('https://rota-production-84ef.up.railway.app,http://localhost:8081');

    // Allowed development origin
    const devRes = await request(appWithDev)
      .get('/x')
      .set('Origin', 'http://localhost:8081');
    expect(devRes.status).toBe(200);
    expect(devRes.headers['access-control-allow-origin']).toBe('http://localhost:8081');

    // Unauthorized origin remains blocked
    const blockedRes = await request(appWithDev)
      .get('/x')
      .set('Origin', 'http://unauthorized.example');
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.success).toBe(false);
    expect(blockedRes.body.error.code).toBe('CORS_BLOCKED');
  });

  it('handles OPTIONS preflight correctly for http://localhost:8081 with required headers and methods', async () => {
    const appWithDev = miniApp('https://rota-production-84ef.up.railway.app,http://localhost:8081');

    const preflightRes = await request(appWithDev)
      .options('/x')
      .set('Origin', 'http://localhost:8081')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

    expect(preflightRes.status).toBe(204);
    expect(preflightRes.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(preflightRes.headers['access-control-allow-methods']).toContain('POST');
    expect(preflightRes.headers['access-control-allow-methods']).toContain('GET');
    expect(preflightRes.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(preflightRes.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('rejects preflight OPTIONS requests from unauthorized origins with CORS_BLOCKED', async () => {
    const appWithDev = miniApp('https://rota-production-84ef.up.railway.app,http://localhost:8081');

    const preflightBlocked = await request(appWithDev)
      .options('/x')
      .set('Origin', 'http://evil.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

    expect(preflightBlocked.status).toBe(403);
    expect(preflightBlocked.body.success).toBe(false);
    expect(preflightBlocked.body.error.code).toBe('CORS_BLOCKED');
  });

  it('handles OPTIONS preflight on /auth/register and API routes in the main application', async () => {
    // Development preflight on /auth/register
    const preflight = await request(app)
      .options('/auth/register')
      .set('Origin', 'http://localhost:8081')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-origin']).toBe('http://localhost:8081');
    expect(preflight.headers['access-control-allow-headers']).toContain('Content-Type');
    expect(preflight.headers['access-control-allow-headers']).toContain('Authorization');

    // Unauthorized origin preflight on /auth/register
    const unauthorizedPreflight = await request(app)
      .options('/auth/register')
      .set('Origin', 'http://unauthorized.example')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Content-Type, Authorization');

    expect(unauthorizedPreflight.status).toBe(403);
    expect(unauthorizedPreflight.body.success).toBe(false);
    expect(unauthorizedPreflight.body.error.code).toBe('CORS_BLOCKED');
  });
});

describe('Redis-backed rate limiter', () => {
  const limiterApp = () => {
    const mini = express();
    mini.use(redisRateLimit({ windowSeconds: 60, max: 2, keyPrefix: 'rl:test' }));
    mini.get('/x', (_req, res) => res.json({ ok: true }));
    mini.use(errorHandler);
    return mini;
  };

  it('returns 429 after the budget is exhausted', async () => {
    let counter = 0;
    (redisClient.incr as jest.Mock).mockImplementation(async () => {
      counter += 1;
      return counter;
    });
    (redisClient.expire as jest.Mock).mockResolvedValue(1);

    const mini = limiterApp();
    await request(mini).get('/x');
    await request(mini).get('/x');
    const blocked = await request(mini).get('/x');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
  });

  it('fails open when Redis is unavailable', async () => {
    (redisClient.incr as jest.Mock).mockRejectedValue(new Error('redis down'));
    (redisClient.expire as jest.Mock).mockResolvedValue(1);

    const mini = limiterApp();
    const res = await request(mini).get('/x');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});