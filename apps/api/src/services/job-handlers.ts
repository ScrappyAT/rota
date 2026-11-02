import { PoolClient } from 'pg';
import { UnrecoverableError } from 'bullmq';
import { initializeCheckout, verifyTransaction, verifyTransactionByReference, VerifiedTransaction } from '../billing/flutterwave';
import { materializeSubscription, reconcilePayment } from '../billing/service';
import { OutboxRow } from './outbox';
import { deliverPush, checkPushReceipts } from './push-delivery';
import { notify } from './notifications';
import { invalidateActivity, invalidateRoster, invalidateShifts } from './cache';
export const paymentResponseReady = async (client: PoolClient, paymentId: string, link: string | null): Promise<void> => {
  await client.query(`UPDATE billing_idempotency b SET response=jsonb_set(jsonb_set(jsonb_set(b.response,'{data,processing}','false'::jsonb),'{data,checkoutUrl}',$2::jsonb),'{data,payment,status}',to_jsonb(p.status::text)),
    http_status=CASE WHEN $3::boolean THEN 201 ELSE 200 END,completed=TRUE FROM payment_transactions p
    WHERE p.id=$1::uuid AND b.response->'data'->'payment'->>'id'=$1::text`, [paymentId, JSON.stringify(link), Boolean(link)]);
};
const settleVerified = async (client: PoolClient, teamId: string, txRef: string, gateway: VerifiedTransaction, now: Date) => {
  if (!['successful', 'failed', 'cancelled'].includes(gateway.status.toLowerCase()))
    throw new Error('Provider payment is not terminal yet');
  await client.query('BEGIN');
  try {
    const result = await reconcilePayment(client, teamId, txRef, gateway, now);
    await client.query("UPDATE payment_transactions SET initialization_state='RESOLVED' WHERE team_id=$1 AND tx_ref=$2", [teamId, txRef]);
    await paymentResponseReady(client, result.payment.id, null);
    await client.query('COMMIT');
    return result;
  }
  catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
};
export const handleOutbox = async (client: PoolClient, job: OutboxRow, now: Date): Promise<unknown> => {
  const data = job.payload;
  if (job.kind === 'NOTIFICATION') {
    if (data.receiptCheck === true)
      await checkPushReceipts(client, String(data.notificationId), typeof data.deliveryId === 'string' ? data.deliveryId : undefined);
    else
      await deliverPush(client, String(data.notificationId), now);
    return null;
  }
  if (job.kind === 'PAYMENT_INITIALIZE') {
    const payment = (await client.query('SELECT * FROM payment_transactions WHERE id=$1', [data.paymentId])).rows[0];
    if (!payment || payment.status !== 'PENDING' || payment.initialization_state === 'READY')
      return null;
    if (payment.initialization_state !== 'QUEUED') {
      await client.query("UPDATE payment_transactions SET initialization_state='AMBIGUOUS' WHERE id=$1 AND status='PENDING' AND initialization_state='CLAIMED'", [payment.id]);
      return null; // A prior claim may have reached the provider. Never POST again.
    }
    const claim = await client.query("UPDATE payment_transactions SET initialization_state='CLAIMED' WHERE id=$1 AND status='PENDING' AND initialization_state='QUEUED' RETURNING id", [payment.id]);
    if (!claim.rows.length)
      return null;
    let link: string;
    try {
      link = (await initializeCheckout({ txRef: payment.tx_ref, amountMinor: payment.amount_minor, currency: payment.currency, customer: { email: String(data.email) }, redirectUrl: String(data.redirectUrl) })).link;
    }
    catch {
      await client.query("UPDATE payment_transactions SET initialization_state='AMBIGUOUS' WHERE id=$1 AND status='PENDING' AND initialization_state='CLAIMED'", [payment.id]);
      return { initialization: 'AMBIGUOUS' }; // The separately committed reconcile job will only GET this reference.
    }
    await client.query('BEGIN');
    try {
      // A webhook may already have settled it while checkout was initializing.
      const ready = await client.query("UPDATE payment_transactions SET initialization_state='READY',checkout_url=$2 WHERE id=$1 AND status='PENDING' AND initialization_state='CLAIMED' RETURNING id", [payment.id, link]);
      if (ready.rows.length)
        await paymentResponseReady(client, payment.id, link);
      await client.query('COMMIT');
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return null;
  }
  if (job.kind === 'PAYMENT_RECONCILE') {
    const payment = (await client.query('SELECT * FROM payment_transactions WHERE id=$1', [data.paymentId])).rows[0];
    if (!payment || payment.status !== 'PENDING')
      return null;
    const gateway = await verifyTransactionByReference(payment.tx_ref);
    return settleVerified(client, payment.team_id, payment.tx_ref, gateway, now);
  }
  if (job.kind === 'PAYMENT_VERIFY') {
    const gateway = await verifyTransaction(String(data.transactionId));
    if (gateway.transactionId !== String(data.transactionId))
      throw new UnrecoverableError('Provider returned another transaction ID');
    return settleVerified(client, String(data.teamId), String(data.txRef), gateway, now);
  }
  if (job.kind === 'PAYMENT_WEBHOOK') {
    const event = (await client.query('SELECT * FROM webhook_events WHERE event_key=$1', [data.eventKey])).rows[0];
    if (!event || event.processed_at)
      return { processed: false, reason: 'duplicate' };
    if (event.event_type !== 'charge.completed') {
      await client.query('UPDATE webhook_events SET processed_at=NOW() WHERE event_key=$1', [data.eventKey]);
      return { processed: false, reason: event.event_type };
    }
    const txRef = event.payload.data.tx_ref;
    const payment = (await client.query("SELECT team_id FROM payment_transactions WHERE tx_ref=$1 AND change_id IS NOT NULL AND status='PENDING'", [txRef])).rows[0];
    if (!payment) {
      await client.query('UPDATE webhook_events SET processed_at=NOW() WHERE event_key=$1', [data.eventKey]);
      return { processed: false, reason: 'no-pending' };
    }
    const gateway = await verifyTransaction(String(event.payload.data.id));
    if (gateway.transactionId !== String(event.payload.data.id))
      throw new UnrecoverableError('Provider returned another transaction ID');
    const result = await settleVerified(client, payment.team_id, txRef, gateway, now);
    await client.query('UPDATE webhook_events SET processed_at=NOW() WHERE event_key=$1', [data.eventKey]);
    return { processed: true, outcome: result.outcome };
  }
  if (job.kind === 'BILLING_RECHECK') {
    if (!(await client.query('SELECT 1 FROM teams WHERE id=$1', [job.team_id])).rows.length)
      return null;
    await client.query('BEGIN');
    try {
      await materializeSubscription(client, job.team_id!, now);
      await client.query('COMMIT');
    }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    return null;
  }
  // Durable cache invalidation supplements immediate invalidation/read-your-writes.
  if (job.team_id)
    await Promise.all([invalidateActivity(job.team_id), invalidateShifts(job.team_id), invalidateRoster(job.team_id)]);
  if (!job.team_id || !(await client.query('SELECT 1 FROM teams WHERE id=$1', [job.team_id])).rows.length)
    return null;
  await client.query('BEGIN');
  try {
    const type = String(data.type), payload = (data.payload ?? {}) as Record<string, unknown>;
    if (type === 'SHIFT_UPDATED' || type === 'SHIFT_DELETED') {
      for (const userId of (data.recipients ?? []) as string[])
        await notify({
          teamId: job.team_id, userId, type: type === 'SHIFT_UPDATED' ? 'SHIFT_CHANGED' : 'SHIFT_DELETED',
          title: type === 'SHIFT_UPDATED' ? 'Shift changed' : 'Shift removed', body: `Your shift "${String(payload.shiftTitle ?? '')}" was ${type === 'SHIFT_UPDATED' ? 'updated' : 'removed'}.`,
          data: { teamId: job.team_id, ...(type === 'SHIFT_UPDATED' ? { shiftId: payload.shiftId } : {}), event: type === 'SHIFT_UPDATED' ? 'shift_changed' : 'shift_deleted' }, eventKey: `activity:${data.activityId}:${userId}`,
        }, client);
    }
    if (['PAYMENT_RECEIVED', 'SUBSCRIPTION_CHANGED', 'RENEWAL_FAILED'].includes(type) && !(type === 'SUBSCRIPTION_CHANGED' && payload.requiresPayment === true)) {
      const owners = await client.query("SELECT user_id FROM team_memberships WHERE team_id=$1 AND role='OWNER'", [job.team_id]);
      for (const owner of owners.rows)
        await notify({
          teamId: job.team_id, userId: owner.user_id, type: 'BILLING',
          title: type === 'RENEWAL_FAILED' ? 'Subscription renewal failed' : type === 'PAYMENT_RECEIVED' ? 'Payment received' : 'Subscription updated',
          body: type === 'RENEWAL_FAILED' ? 'Renew before the grace period ends to keep your team active.' : 'Open billing to review your subscription.',
          data: { teamId: job.team_id, event: 'billing_' + type.toLowerCase() }, eventKey: `billing:${data.activityId}:${owner.user_id}`
        }, client);
    }
    await client.query('COMMIT');
  }
  catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  return null;
};
