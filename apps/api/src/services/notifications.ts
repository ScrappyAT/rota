import { pool } from '../db';
import { env } from '../env';

export type NotificationType =
  | 'SHIFT_ASSIGNED'
  | 'SWAP_REQUESTED'
  | 'SWAP_APPROVED'
  | 'SWAP_REJECTED';

export interface NotificationEvent {
  teamId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Deterministic dedupe key (retries of the same business action never double-send). */
  eventKey: string;
}

export interface ExpoSendResult {
  okCount: number;
  /** Tokens rejected permanently (DeviceNotRegistered / InvalidPushToken), to prune locally. */
  invalidTokens: string[];
}

const EXPO_MAX_TOKENS_PER_REQUEST = 100;
const PERMANENT_TOKEN_ERRORS = new Set(['DeviceNotRegistered', 'InvalidPushToken']);

export type NotificationLedgerStatus = 'new' | 'duplicate' | 'retry';

const PREF_COLUMN: Record<NotificationType, string> = {
  SHIFT_ASSIGNED: 'shift_assigned',
  SWAP_REQUESTED: 'swap_requested',
  SWAP_APPROVED: 'swap_approved',
  SWAP_REJECTED: 'swap_rejected',
};

// --- Pure helpers (unit-tested) ------------------------------------------------

/** Maps a notification type to its `notification_preferences` column. */
export const prefColumn = (type: NotificationType): string => PREF_COLUMN[type];

/** Masks device push tokens for safe diagnostic logging without leaking credentials. */
export const maskToken = (token: string): string => {
  if (!token) return '***';
  return token.length > 12 ? `${token.slice(0, 10)}...` : '***';
};

/** Builds an Expo Push API message body for the event's devices. */
export const buildExpoMessage = (event: NotificationEvent, tokens: string[]) => ({
  to: tokens.slice(0, EXPO_MAX_TOKENS_PER_REQUEST),
  title: event.title,
  body: event.body,
  data: event.data ?? {},
  sound: 'default',
  channelId: 'shifts',
});

/**
 * Classifies an Expo Push API batch response against the tokens that were sent.
 * Permanent token errors are returned so callers can prune them; transient or
 * message-specific errors are counted but keep the token registered.
 */
export const classifyExpoResponse = (payload: unknown, tokens: string[]): ExpoSendResult => {
  const root = payload as { data?: unknown } | null;
  const entries: Array<{ status?: string; details?: { error?: string } }> = Array.isArray(
    root?.data
  )
    ? (root.data as Array<{ status?: string; details?: { error?: string } }>)
    : [];

  let okCount = 0;
  const invalidTokens: string[] = [];

  tokens.forEach((token, index) => {
    const entry = entries[index];
    if (!entry) {
      return;
    }
    if (entry.status === 'ok') {
      okCount += 1;
      return;
    }
    const error = entry.details?.error ?? '';
    log('warn', `expo ticket error for device [${maskToken(token)}]: ${error || 'UnknownError'}`);
    if (PERMANENT_TOKEN_ERRORS.has(error)) {
      invalidTokens.push(token);
    }
  });

  return { okCount, invalidTokens };
};

/** Human-friendly shift date for notification bodies ('' for invalid input). */
export const formatShiftDate = (iso: string | Date): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
};

// --- Purely internal logging (never logs raw tokens or message bodies) -----

const log = (level: 'error' | 'warn' | 'info', message: string) => {
  const line = `[notifications] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
};

// --- Delivery ----------------------------------------------------------------

/**
 * Records a notification ledger row. Idempotent per `event_key`: returns
 * 'new' the first time, 'duplicate' when a previous attempt already delivered,
 * or 'retry' when a prior attempt failed and delivery may be re-attempted.
 */
export const persistNotification = async (
  event: NotificationEvent
): Promise<NotificationLedgerStatus> => {
  const inserted = await pool.query(
    `INSERT INTO notifications (team_id, user_id, type, title, body, data, event_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      event.teamId,
      event.userId,
      event.type,
      event.title,
      event.body,
      JSON.stringify(event.data ?? {}),
      event.eventKey,
    ]
  );
  if (inserted.rows.length === 1) return 'new';

  const existing = await pool.query('SELECT delivered_at FROM notifications WHERE event_key = $1', [
    event.eventKey,
  ]);
  return existing.rows[0]?.delivered_at ? 'duplicate' : 'retry';
};

/** Marks a ledger row terminal (SENT/SKIPPED) or retryable (FAILED). */
export const markNotificationStatus = async (
  eventKey: string,
  status: 'SENT' | 'SKIPPED' | 'FAILED',
  detail?: string | null
): Promise<void> => {
  await pool.query(
    `UPDATE notifications
     SET status = $1,
         delivered_at = CASE WHEN $1 = 'FAILED'::notification_status THEN NULL ELSE CURRENT_TIMESTAMP END,
         last_error = $3
     WHERE event_key = $2`,
    [status, eventKey, detail ?? null]
  );
};

const pruneInvalidTokens = async (userId: string, tokens: string[]): Promise<void> => {
  if (tokens.length === 0) return;
  await pool.query('DELETE FROM device_tokens WHERE user_id = $1 AND token = ANY($2)', [
    userId,
    tokens,
  ]);
  log('warn', `pruned ${tokens.length} permanently rejected device token(s)`);
};

const postToExpo = async (message: Record<string, unknown>, eventKey: string): Promise<ExpoSendResult> => {
  const tokens = Array.isArray(message.to) ? (message.to as string[]) : [];
  log('info', `posting to expo for ${eventKey} with ${tokens.length} token(s) [${tokens.map(maskToken).join(', ')}]`);
  const response = await fetch(env.EXPO_PUSH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(message),
  });
  if (!response.ok) {
    // HTTP-level rejection (429/5xx) is transient; tokens stay registered.
    log('warn', `expo push HTTP ${response.status} for ${eventKey}`);
    const text = await response.text().catch(() => '');
    if (text) log('warn', `expo push body (truncated): ${text.slice(0, 200)}`);
    return { okCount: 0, invalidTokens: [] };
  }
  const payload = (await response.json()) as unknown;
  const result = classifyExpoResponse(payload, tokens);
  log('info', `expo push result for ${eventKey}: ${result.okCount} ok, ${result.invalidTokens.length} invalid`);
  return result;
};

/**
 * Attempts push delivery for a recorded event. Never throws: notification
 * failures must never fail the caller's shift/swap transaction. Respects the
 * user's notification preferences and prunes permanently rejected tokens.
 */
export const deliverNotification = async (event: NotificationEvent): Promise<void> => {
  try {
    log('info', `dispatching ${event.type} for recipient ${event.userId} (eventKey: ${event.eventKey})`);
    const prefs = await pool.query(
      `SELECT shift_assigned, swap_requested, swap_approved, swap_rejected
       FROM notification_preferences
       WHERE user_id = $1`,
      [event.userId]
    );
    const enabled =
      prefs.rows.length === 0 ? true : prefs.rows[0][prefColumn(event.type)] === true;
    if (!enabled) {
      log('info', `notification ${event.eventKey} skipped: disabled in preferences for user ${event.userId}`);
      await markNotificationStatus(event.eventKey, 'SKIPPED', 'disabled by user preference');
      return;
    }

    const tokensRes = await pool.query(
      `SELECT token FROM device_tokens WHERE user_id = $1 AND push_enabled = TRUE LIMIT ${EXPO_MAX_TOKENS_PER_REQUEST}`,
      [event.userId]
    );
    const tokens: string[] = tokensRes.rows.map((row) => row.token);
    if (tokens.length === 0) {
      log('info', `notification ${event.eventKey} skipped: no registered device tokens for user ${event.userId}`);
      await markNotificationStatus(event.eventKey, 'SKIPPED', 'no registered device');
      return;
    }

    const result = await postToExpo(buildExpoMessage(event, tokens), event.eventKey);

    if (result.invalidTokens.length > 0) {
      await pruneInvalidTokens(event.userId, result.invalidTokens);
    }

    if (result.okCount > 0) {
      await markNotificationStatus(event.eventKey, 'SENT');
    } else {
      await markNotificationStatus(
        event.eventKey,
        'FAILED',
        `expo rejected ${tokens.length} token(s)`
      );
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('error', `delivery failed for ${event.eventKey}: ${reason}`);
    try {
      await markNotificationStatus(event.eventKey, 'FAILED', 'delivery exception');
    } catch {
      // ledger write is best-effort; never mask the original failure channel
    }
  }
};

/**
 * Records a notification (idempotent per `event_key`) and attempts delivery.
 * Never throws. Await it inside routes so the ledger is written before the
 * response; a previous FAILED attempt is re-attempted, a SENT attempt is not.
 */
export const notify = async (event: NotificationEvent): Promise<void> => {
  try {
    const outcome = await persistNotification(event);
    if (outcome === 'duplicate') {
      log('warn', `duplicate delivery blocked for ${event.eventKey}`);
      return;
    }
    if (outcome === 'retry') {
      log('warn', `re-attempting delivery for ${event.eventKey}`);
    }
    await deliverNotification(event);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    log('error', `notify failed for ${event.eventKey}: ${reason}`);
  }
};