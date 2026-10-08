import { HttpError } from './http-error';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

export interface Cursor {
  /** ISO timestamp of the last row value (e.g. created_at or starts_at). */
  t: string;
  /** Row id used as the deterministic tie-breaker. */
  i: string;
}

export interface DecodedCursor {
  /** Parsed timestamp of the last row value. */
  t: Date;
  /** Row id used as the deterministic tie-breaker. */
  i: string;
}

export const encodeCursor = (timestamp: Date | string, id: string): string => {
  const iso = new Date(timestamp).toISOString();
  const raw = JSON.stringify({ t: iso, i: id });
  return Buffer.from(raw, 'utf8').toString('base64url');
};

export const decodeCursor = (cursor: string): DecodedCursor => {
  let parsed: unknown;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    parsed = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
  }

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Cursor).t !== 'string' ||
    typeof (parsed as Cursor).i !== 'string'
  ) {
    throw new HttpError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
  }

  const t = new Date((parsed as Cursor).t);
  if (Number.isNaN(t.getTime())) {
    throw new HttpError(400, 'INVALID_CURSOR', 'Invalid pagination cursor');
  }

  return { t, i: (parsed as Cursor).i };
};

export const parseLimit = (raw: string | undefined): number => {
  const parsed = Number(raw ?? String(DEFAULT_LIMIT));
  if (!Number.isFinite(parsed) || parsed < 1 || Math.floor(parsed) !== parsed) {
    throw new HttpError(400, 'INVALID_LIMIT', 'limit must be a positive integer');
  }
  return Math.min(Math.floor(parsed), MAX_LIMIT);
};

export const parseStatus = (raw: string | undefined, allowed: readonly string[]): string | null => {
  if (!raw) return null;
  if (!allowed.includes(raw)) {
    throw new HttpError(400, 'VALIDATION_ERROR', `status must be one of: ${allowed.join(', ')}`);
  }
  return raw;
};

export interface PageParams<T> {
  rows: T[];
  limit: number;
  /** Extract the (timestamp, id) pair used to order the rows. */
  keyOf: (row: T) => { timestamp: Date | string; id: string };
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * Builds a cursor page. `rows` must be fetched as `limit + 1` so that one row
 * beyond the requested page can be detected without OFFSET.
 */
export const page = <T>({ rows, limit, keyOf }: PageParams<T>): Page<T> => {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    nextCursor: last ? encodeCursor(keyOf(last).timestamp, keyOf(last).id) : null,
    hasMore,
  };
};

/**
 * Resolves a cursor query value, if present, into the array of values needed
 * to reconstruct the WHERE clause: `[timestamp, id]` or null.
 */
export const cursorPosition = (
  cursor: string | undefined
): { timestamp: Date; id: string } | null => {
  if (!cursor) return null;
  const decoded = decodeCursor(cursor);
  return { timestamp: decoded.t, id: decoded.i };
};