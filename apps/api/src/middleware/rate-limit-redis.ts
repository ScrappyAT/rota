import { NextFunction, Request, Response } from 'express';
import { redisClient } from '../redis';

export interface RedisRateLimitOptions {
  /** Fixed-window length in seconds. */
  windowSeconds: number;
  /** Maximum requests permitted per window per client. */
  max: number;
  /** Prefix for Redis keys (the client key suffix is the request IP). */
  keyPrefix: string;
}

const RATE_LIMITED_RESPONSE = {
  success: false,
  error: { code: 'TOO_MANY_REQUESTS', message: 'Try again later' },
};

/**
 * Fixed-window rate limiter backed by Redis (INCR + EXPIRE). Shared across
 * process instances so limits hold when the API scales horizontally.
 *
 * Fail-open on Redis errors: a cache outage must never lock every user out.
 * (Production already requires a reachable Redis for the /health check.)
 */
export const redisRateLimit = (options: RedisRateLimitOptions) => {
  const { windowSeconds, max, keyPrefix } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    const clientIp = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const key = `${keyPrefix}:${clientIp}`;

    try {
      const count = await redisClient.incr(key);
      if (count === 1) {
        await redisClient.expire(key, windowSeconds);
      }
      if (count > max) {
        return res.status(429).json(RATE_LIMITED_RESPONSE);
      }
      return next();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[rate-limit] Redis error on ${keyPrefix}; allowing request`, reason);
      return next();
    }
  };
};