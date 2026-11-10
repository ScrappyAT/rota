import { logEvent } from './services/observability';
import { createClient } from 'redis';
import { env } from './env';

export const redisClient = createClient({
  url: env.REDIS_URL,
});

redisClient.on('error', () => {
  logEvent('redis.error', { outcome: 'unexpected' }, 'warn');
});
