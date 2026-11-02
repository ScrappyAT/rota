import { pool } from '../db';
import { PoolClient } from 'pg';
import { enqueueOutbox } from './outbox';

export type NotificationType =
  | 'SHIFT_ASSIGNED'
  | 'SWAP_REQUESTED'
  | 'SWAP_APPROVED'
  | 'SWAP_REJECTED'
  | 'SHIFT_CHANGED'
  | 'SHIFT_DELETED'
  | 'BILLING';

export interface NotificationEvent {
  teamId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  /** Deterministic dedupe key (retries of the same business action never double-send). */
  eventKey: string;
  urgent?: boolean;
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
  SHIFT_CHANGED: 'shift_assigned', SHIFT_DELETED: 'shift_assigned', BILLING: 'billing',
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
  data: { ...event.data, teamId: event.teamId, event: event.data?.event ?? event.type.toLowerCase() },
  sound: 'default',
  channelId: event.type === 'BILLING' ? 'billing' : 'shifts',
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

// Persistence only. External delivery is exclusively a background-worker concern.
export const persistNotification = async (event: NotificationEvent, client?: PoolClient): Promise<NotificationLedgerStatus> => {
  const query = client ?? pool;
  const result = await query.query(`INSERT INTO notifications(team_id,user_id,type,title,body,data,event_key)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO NOTHING RETURNING id`,
    [event.teamId,event.userId,event.type,event.title,event.body,JSON.stringify({...event.data,teamId:event.teamId,event:event.data?.event??event.type.toLowerCase(),urgent:event.urgent===true}),event.eventKey]);
  if (result.rows.length) return 'new';
  const old = await query.query('SELECT delivered_at FROM notifications WHERE event_key=$1',[event.eventKey]);
  return old.rows[0]?.delivered_at ? 'duplicate' : 'retry';
};
export const notify = async (event: NotificationEvent, transaction?: PoolClient): Promise<void> => {
  const client = transaction ?? await pool.connect();
  try {
    if (!transaction) await client.query('BEGIN');
    await persistNotification(event,client);
    const row = await client.query('SELECT id FROM notifications WHERE event_key=$1',[event.eventKey]);
    await enqueueOutbox(client,{key:'push:'+event.eventKey,kind:'NOTIFICATION',teamId:event.teamId,payload:{notificationId:row.rows[0].id}});
    if (!transaction) await client.query('COMMIT');
  } catch(error) { if (!transaction) await client.query('ROLLBACK'); throw error; }
  finally { if (!transaction) client.release(); }
};
