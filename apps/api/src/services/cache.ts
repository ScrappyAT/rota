import crypto from 'crypto';
import { redisClient } from '../redis';

/**
 * Documented default TTLs (in seconds) for cache-aside resources.
 */
export const CACHE_TTLS = {
  ROSTER: 300,    // 5 minutes for team roster
  SHIFTS: 120,   // 2 minutes for shift calendar queries
  ACTIVITY: 60,   // 1 minute for activity feed
} as const;

/**
 * Returns true if Redis caching is enabled in the current environment.
 * Defaults to true. Can be explicitly disabled via ENABLE_REDIS_CACHE=false.
 */
export const isCacheEnabled = (): boolean => {
  return process.env.ENABLE_REDIS_CACHE !== 'false' && process.env.ENABLE_REDIS_CACHE !== '0';
};

/**
 * Normalize and deterministically hash query parameters for cache keys.
 */
export const hashParams = (params?: Record<string, unknown>): string => {
  if (!params) return 'default';
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') {
      clean[k] = v instanceof Date ? v.toISOString() : v;
    }
  }
  const keys = Object.keys(clean).sort();
  if (keys.length === 0) return 'default';
  const str = keys.map((k) => `${k}=${clean[k]}`).join('&');
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
};

/**
 * Key generation functions scoped strictly by teamId to maintain strict tenant isolation.
 */
export const cacheKeys = {
  roster: (teamId: string) => `cache:roster:${teamId}`,
  shifts: (teamId: string, params?: Record<string, unknown>) =>
    `cache:shifts:${teamId}:${hashParams(params)}`,
  shiftsPattern: (teamId: string) => `cache:shifts:${teamId}:*`,
  activity: (teamId: string, params?: Record<string, unknown>) =>
    `cache:activity:${teamId}:${hashParams(params)}`,
  activityPattern: (teamId: string) => `cache:activity:${teamId}:*`,
};

/**
 * Read from cache-aside. Returns null on miss, when cache is disabled,
 * or when Redis is unavailable/errors.
 */
export const getCache = async <T>(key: string): Promise<T | null> => {
  if (!isCacheEnabled()) return null;
  try {
    if (!redisClient.isReady) return null;
    const raw = await redisClient.get(key);
    if (!raw) return null;
    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn(`[cache] Error reading key ${key}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
};

/**
 * Write to cache with TTL. No-op if cache is disabled or Redis fails.
 */
export const setCache = async <T>(key: string, data: T, ttlSeconds: number): Promise<void> => {
  if (!isCacheEnabled()) return;
  try {
    if (!redisClient.isReady) return;
    await redisClient.setEx(key, ttlSeconds, JSON.stringify(data));
  } catch (err) {
    console.warn(`[cache] Error setting key ${key}:`, err instanceof Error ? err.message : String(err));
  }
};

/**
 * Delete a specific cache key.
 */
export const deleteCache = async (key: string): Promise<void> => {
  if (!isCacheEnabled()) return;
  try {
    if (!redisClient.isReady) return;
    await redisClient.del(key);
  } catch (err) {
    console.warn(`[cache] Error deleting key ${key}:`, err instanceof Error ? err.message : String(err));
  }
};

/**
 * Delete all keys matching a wildcard pattern (e.g. cache:shifts:${teamId}:*).
 */
export const deleteCachePattern = async (pattern: string): Promise<void> => {
  if (!isCacheEnabled()) return;
  try {
    if (!redisClient.isReady) return;
    const keys: string[] = [];
    for await (const key of redisClient.scanIterator({ MATCH: pattern, COUNT: 100 })) {
      keys.push(key as string);
    }
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } catch (err) {
    console.warn(`[cache] Error deleting pattern ${pattern}:`, err instanceof Error ? err.message : String(err));
  }
};

/**
 * Explicit invalidation helpers
 */
export const invalidateRoster = async (teamId: string): Promise<void> => {
  await deleteCache(cacheKeys.roster(teamId));
};

export const invalidateShifts = async (teamId: string): Promise<void> => {
  await deleteCachePattern(cacheKeys.shiftsPattern(teamId));
};

export const invalidateActivity = async (teamId: string): Promise<void> => {
  await deleteCachePattern(cacheKeys.activityPattern(teamId));
};
