import request from 'supertest';
import { app } from '../src/index';

// Mock DB and Redis dependencies since we want to unit test the endpoint itself
jest.mock('../src/db', () => ({
  pool: {
    query: jest.fn().mockResolvedValue({}),
    end: jest.fn(),
  }
}));

jest.mock('../src/redis', () => ({
  redisClient: {
    isReady: true,
    connect: jest.fn(),
    quit: jest.fn(),
  }
}));

describe('GET /health', () => {
  it('should return 200 and success true', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.db).toBe('ok');
    expect(res.body.data.redis).toBe('ok');
  });
});
