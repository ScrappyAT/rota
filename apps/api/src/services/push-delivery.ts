import { PoolClient } from 'pg';
import { UnrecoverableError } from 'bullmq';
import { env } from '../env';
import { buildExpoMessage, NotificationEvent, NotificationType } from './notifications';
import { readSettings } from './settings';
import { nextPermittedDelivery } from './quiet-hours';
import { DeferJob, enqueueOutbox } from './outbox';
/** Per-device claims survive worker death. Unknown provider outcomes are never resent automatically. */
export const deliverPush = async (client: PoolClient, notificationId: string, now = new Date()): Promise<void> => {
  const startedAt = Date.now();
  const row = (await client.query('SELECT * FROM notifications WHERE id=$1', [notificationId])).rows[0];
  if (!row || row.delivered_at)
    return;
  const settings = await readSettings(client, row.user_id);
  const type = row.type as NotificationType;
  const category = type === 'BILLING' ? 'billing' : type.startsWith('SWAP_') ? 'swaps' : 'shifts';
  const specific = type === 'SWAP_REQUESTED' ? settings.notificationTypes.swapRequested
    : type === 'SWAP_APPROVED' ? settings.notificationTypes.swapApproved
      : type === 'SWAP_REJECTED' ? settings.notificationTypes.swapRejected
        : type === 'BILLING' ? true : settings.notificationTypes.shiftAssigned;
  const membership = await client.query('SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2', [row.team_id, row.user_id]);
  const skip = async (reason: string) => {
    await client.query("UPDATE notification_deliveries SET state='SUPPRESSED',updated_at=NOW() WHERE notification_id=$1 AND state IN ('PENDING','RETRYABLE')", [notificationId]);
    await client.query("UPDATE notifications SET status='SKIPPED',delivered_at=NOW(),last_error=$2 WHERE id=$1", [notificationId, reason]);
  };
  if (!membership.rows.length) {
    await skip('recipient no longer belongs to team');
    return;
  }
  if (!specific || !settings.notificationCategories[category]) {
    await skip('disabled by user preference');
    return;
  }
  if (row.data.urgent !== true) {
    const permitted = nextPermittedDelivery(settings, now);
    if (permitted.getTime() > now.getTime())
      throw new DeferJob(permitted);
  }
  await client.query(`INSERT INTO notification_deliveries(notification_id,token)
    SELECT $1,token FROM device_tokens WHERE user_id=$2 AND push_enabled=TRUE ON CONFLICT DO NOTHING`, [notificationId, row.user_id]);
  const devices = (await client.query('SELECT * FROM notification_deliveries WHERE notification_id=$1 ORDER BY id', [notificationId])).rows;
  if (!devices.length) {
    await skip('no registered device');
    return;
  }
  const event: NotificationEvent = { teamId: row.team_id, userId: row.user_id, type, title: row.title, body: row.body, data: row.data, eventKey: row.event_key };
  try {
    for (const device of devices) {
      if (device.state === 'SENDING' || device.state === 'UNKNOWN') {
        await client.query("UPDATE notification_deliveries SET state='UNKNOWN',last_error='worker stopped before provider outcome was recorded',updated_at=NOW() WHERE id=$1", [device.id]);
        throw new UnrecoverableError('Push outcome uncertain; automatic resend prohibited');
      }
      if (!['PENDING', 'RETRYABLE'].includes(device.state))
        continue;
      // A batch may cross a quiet-hours boundary or a user may change preferences.
      const latest = await readSettings(client, row.user_id);
      const latestSpecific = type === 'SWAP_REQUESTED' ? latest.notificationTypes.swapRequested
        : type === 'SWAP_APPROVED' ? latest.notificationTypes.swapApproved
          : type === 'SWAP_REJECTED' ? latest.notificationTypes.swapRejected
            : type === 'BILLING' ? true : latest.notificationTypes.shiftAssigned;
      if (!latestSpecific || !latest.notificationCategories[category]) {
        await skip('disabled by user preference');
        return;
      }
      if (row.data.urgent !== true) {
        const deliveryTime = new Date(now.getTime() + Date.now() - startedAt);
        const permitted = nextPermittedDelivery(latest, deliveryTime);
        if (permitted.getTime() > deliveryTime.getTime())
          throw new DeferJob(permitted);
      }
      const stillRegistered = await client.query('SELECT 1 FROM device_tokens WHERE user_id=$1 AND token=$2 AND push_enabled=TRUE', [row.user_id, device.token]);
      if (!stillRegistered.rows.length) {
        await client.query("UPDATE notification_deliveries SET state='SUPPRESSED' WHERE id=$1", [device.id]);
        continue;
      }
      const claim = await client.query("UPDATE notification_deliveries SET state='SENDING',attempts=attempts+1,updated_at=NOW() WHERE id=$1 AND state IN ('PENDING','RETRYABLE') RETURNING id", [device.id]);
      if (!claim.rows.length)
        continue;
      let response: Response;
      try {
        response = await fetch(env.EXPO_PUSH_URL, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(buildExpoMessage(event, [device.token])) });
      }
      catch {
        await client.query("UPDATE notification_deliveries SET state='UNKNOWN',last_error='provider outcome unknown',updated_at=NOW() WHERE id=$1", [device.id]);
        throw new UnrecoverableError('Push outcome uncertain; automatic resend prohibited');
      }
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        await client.query('UPDATE notification_deliveries SET state=$2,last_error=$3,updated_at=NOW() WHERE id=$1', [device.id, retryable ? 'RETRYABLE' : 'SUPPRESSED', `HTTP ${response.status}`]);
        if (retryable)
          throw new Error(`Push provider rejected request: HTTP ${response.status}`);
        continue;
      }
      let ticket: {
        status?: string;
        id?: string;
        details?: {
          error?: string;
        };
      } | undefined;
      try {
        const payload = await response.json();
        ticket = Array.isArray(payload?.data) ? payload.data[0] : undefined;
      }
      catch { /* A malformed acknowledgement is ambiguous. */ }
      if (ticket?.status === 'ok') {
        await client.query('BEGIN');
        try {
          await client.query("UPDATE notification_deliveries SET state='SENT',ticket_id=$2,last_error=NULL,updated_at=NOW() WHERE id=$1", [device.id, ticket.id ?? null]);
          if (ticket.id) await enqueueOutbox(client, { key: 'receipts:' + device.id, kind: 'NOTIFICATION', teamId: row.team_id,
            payload: { notificationId, deliveryId: device.id, receiptCheck: true }, availableAt: new Date(now.getTime() + 15 * 60 * 1000) });
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      }
      else if (['DeviceNotRegistered', 'InvalidPushToken'].includes(ticket?.details?.error ?? '')) {
        await client.query('DELETE FROM device_tokens WHERE user_id=$1 AND token=$2', [row.user_id, device.token]);
        await client.query("UPDATE notification_deliveries SET state='INVALID',last_error='invalid device token',updated_at=NOW() WHERE id=$1", [device.id]);
      }
      else if (ticket?.status === 'error') {
        const transient = ['MessageRateExceeded', 'InternalServerError'].includes(ticket.details?.error ?? '');
        await client.query('UPDATE notification_deliveries SET state=$2,last_error=$3,updated_at=NOW() WHERE id=$1', [device.id, transient ? 'RETRYABLE' : 'SUPPRESSED', 'provider rejected ticket']);
        if (transient)
          throw new Error('Push provider rejected ticket temporarily');
      }
      else {
        await client.query("UPDATE notification_deliveries SET state='UNKNOWN',last_error='malformed provider acknowledgement',updated_at=NOW() WHERE id=$1", [device.id]);
        throw new UnrecoverableError('Push outcome uncertain; automatic resend prohibited');
      }
    }
    const sent = devices.length && (await client.query("SELECT 1 FROM notification_deliveries WHERE notification_id=$1 AND state='SENT' LIMIT 1", [notificationId])).rows.length > 0;
    await client.query('BEGIN');
    try {
      await client.query('UPDATE notifications SET status=$2,delivered_at=NOW(),last_error=$3 WHERE id=$1', [notificationId, sent ? 'SENT' : 'SKIPPED', sent ? null : 'no deliverable device']);
      await client.query('COMMIT');
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  catch (error) {
    if (error instanceof DeferJob)
      throw error;
    await client.query("UPDATE notifications SET status='FAILED',last_error=$2 WHERE id=$1", [notificationId, error instanceof UnrecoverableError ? 'delivery outcome uncertain' : 'provider rejected delivery; retry scheduled']);
    throw error;
  }
};
/** Receipt polling never sends a push. A late invalid-token report prunes the device. */
export const checkPushReceipts = async (client: PoolClient, notificationId: string, deliveryId?: string): Promise<void> => {
  const deliveries = (await client.query(`SELECT d.id,d.token,d.ticket_id,n.user_id FROM notification_deliveries d
    JOIN notifications n ON n.id=d.notification_id WHERE d.notification_id=$1 AND d.state='SENT' AND d.ticket_id IS NOT NULL AND ($2::uuid IS NULL OR d.id=$2::uuid)`, [notificationId,deliveryId??null])).rows;
  for (let offset = 0;offset < deliveries.length;offset += 1000) {
    const batch = deliveries.slice(offset, offset + 1000);
    const response = await fetch(env.EXPO_PUSH_RECEIPTS_URL, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: batch.map(row => row.ticket_id) })
    });
    if (!response.ok)
      throw new Error('Receipt provider rejected request');
    const payload = await response.json();
    let pending = false;
    for (const delivery of batch) {
      const receipt = payload?.data?.[delivery.ticket_id];
      if (!receipt) {
        pending = true;
        continue;
      }
      if (receipt.status === 'error' && ['DeviceNotRegistered', 'InvalidPushToken'].includes(receipt.details?.error)) {
        await client.query('DELETE FROM device_tokens WHERE user_id=$1 AND token=$2', [delivery.user_id, delivery.token]);
        await client.query("UPDATE notification_deliveries SET state='INVALID',last_error='invalid token reported by receipt',updated_at=NOW() WHERE id=$1", [delivery.id]);
      }
      else if (receipt.status === 'error') {
        await client.query("UPDATE notification_deliveries SET last_error='receipt reported delivery failure',updated_at=NOW() WHERE id=$1", [delivery.id]);
      }
    }
    if (pending)
      throw new Error('Push receipts are not yet available');
  }
};
