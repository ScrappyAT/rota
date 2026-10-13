import crypto from 'crypto';
import { redisClient } from '../redis';

/**
 * 6-Digit Numeric Invitation Configuration
 *
 * - Code length: 6 numeric digits (000000 - 999999).
 * - Expiration: 15 minutes.
 * - Brute force limit: 5 failed attempts per user/IP within 15 minutes.
 * - Storage: SHA-256 hash.
 */
export const INVITATION_EXPIRATION_MS = 15 * 60 * 1000; // 15 minutes
export const MAX_FAILED_ATTEMPTS = 5;
export const FAILED_ATTEMPTS_WINDOW_SECONDS = 15 * 60; // 15 minutes

// In-memory fallback map for tracking failed attempts when Redis is offline or in test environments
const memoryFailedAttempts = new Map<string, { count: number; expiresAt: number }>();

/**
 * Generates a cryptographically secure random 6-digit invitation code,
 * preserving leading zeros.
 */
export function generateInvitationCode(): string {
  const num = crypto.randomInt(0, 1000000);
  return num.toString().padStart(6, '0');
}

/**
 * Computes the SHA-256 hex hash of an invitation code or token.
 */
export function hashInvitationCode(code: string): string {
  return crypto.createHash('sha256').update(code.trim()).digest('hex');
}

/**
 * Validates whether an input matches the 6-digit numeric format
 * (or legacy 64-character hex format for backward compatibility).
 */
export function isValidInvitationCodeFormat(code: string): boolean {
  if (!code || typeof code !== 'string') return false;
  const trimmed = code.trim();
  return /^\d{6}$/.test(trimmed) || /^[0-9a-f]{64}$/i.test(trimmed);
}

/**
 * Checks whether an identifier (user ID or IP) is currently blocked due to
 * exceeding maximum failed redemption attempts.
 */
export async function isAttemptBlocked(identifier: string): Promise<boolean> {
  const attempts = await getFailedAttempts(identifier);
  return attempts >= MAX_FAILED_ATTEMPTS;
}

/**
 * Retrieves the current number of failed redemption attempts for an identifier.
 */
export async function getFailedAttempts(identifier: string): Promise<number> {
  const key = `invite:fail:${identifier}`;
  try {
    if (redisClient.isReady) {
      const val = await redisClient.get(key);
      if (val !== null) {
        return parseInt(val, 10) || 0;
      }
    }
  } catch {
    // Failover to in-memory store
  }

  // Memory fallback check
  const entry = memoryFailedAttempts.get(identifier);
  if (entry) {
    if (Date.now() > entry.expiresAt) {
      memoryFailedAttempts.delete(identifier);
      return 0;
    }
    return entry.count;
  }
  return 0;
}

/**
 * Records a failed redemption attempt and returns the updated attempt count.
 */
export async function recordFailedAttempt(identifier: string): Promise<number> {
  const key = `invite:fail:${identifier}`;
  let count = 0;

  try {
    if (redisClient.isReady) {
      const res = await redisClient.incr(key);
      if (res === 1) {
        await redisClient.expire(key, FAILED_ATTEMPTS_WINDOW_SECONDS);
      }
      count = res;
    }
  } catch {
    // Failover to in-memory store
  }

  // Also record in memory store
  const now = Date.now();
  const entry = memoryFailedAttempts.get(identifier);
  if (!entry || now > entry.expiresAt) {
    count = Math.max(count, 1);
    memoryFailedAttempts.set(identifier, {
      count,
      expiresAt: now + FAILED_ATTEMPTS_WINDOW_SECONDS * 1000,
    });
  } else {
    entry.count += 1;
    count = Math.max(count, entry.count);
  }

  return count;
}

/**
 * Clears failed attempts upon a successful redemption.
 */
export async function clearFailedAttempts(identifier: string): Promise<void> {
  const key = `invite:fail:${identifier}`;
  try {
    if (redisClient.isReady) {
      await redisClient.del(key);
    }
  } catch {
    // ignore
  }
  memoryFailedAttempts.delete(identifier);
}

/**
 * Resets the in-memory store (used for test teardown).
 */
export function resetMemoryFailedAttempts(): void {
  memoryFailedAttempts.clear();
}
