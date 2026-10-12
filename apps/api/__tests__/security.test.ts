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
  const miniApp = (originConfig: string) => {
    const mini = express();
    mini.use(cors(createCorsMiddleware(originConfig)));
    mini.get('/x', (_req, res) => res.json({ ok: true }));
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