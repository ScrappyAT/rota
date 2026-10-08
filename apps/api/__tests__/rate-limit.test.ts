import request from 'supertest';
import { app } from '../src/index';

jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end: jest.fn(),
  },
}));

jest.mock('../src/redis', () => ({
  redisClient: {
    isReady: true,
    connect: jest.fn(),
    quit: jest.fn(),
  },
}));

describe('Authentication rate limiting', () => {
  it('returns 429 after exceeding the auth request budget', async () => {
    let sawRateLimit = false;

    for (let i = 0; i < 110; i++) {
      const res = await request(app).get('/auth/me');
      if (res.status === 429) {
        sawRateLimit = true;
        expect(res.body.error.code).toBe('TOO_MANY_REQUESTS');
        break;
      }
    }

    expect(sawRateLimit).toBe(true);
  }, 30000);
});
