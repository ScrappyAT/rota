import crypto from 'crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { ApiResponse } from '@rota/shared';
import { HttpError } from '../http-error';
import { enqueueOutbox } from '../services/outbox';
import { computeChange, computeRenewal, getPurchasablePlan, getSeatUsage, lockBillingTeam, materializeSubscription, openChange, } from './service';
export interface InitiationInput {
  operation: 'checkout' | 'seats' | 'renew';
  teamId: string;
  actorId: string;
  email: string;
  key: string;
  planCode?: string;
  seats?: number;
  returnUrl?: string;
  redirectUrl: string;
}
/** Reserve the exact intent before any external call. An ambiguous call is never reissued. */
export const initiateBilling = async (pool: Pool, input: InitiationInput): Promise<{
  status: number;
  body: ApiResponse<unknown>;
}> => {
  const key = z.string().uuid().parse(input.key);
  const hash = crypto.createHash('sha256').update(JSON.stringify({
    operation: input.operation, planCode: input.planCode ?? null,
    seats: input.seats ?? null, returnUrl: input.returnUrl ?? null,
  })).digest('hex');
  const client = await pool.connect();
  let response: {
    change: Awaited<ReturnType<typeof openChange>>['change'];
    payment: Awaited<ReturnType<typeof openChange>>['payment'];
    checkoutUrl: string | null;
    processing: boolean;
  };
  try {
    await client.query('BEGIN');
    await lockBillingTeam(client, input.teamId);
    const old = await client.query('SELECT * FROM billing_idempotency WHERE team_id=$1 AND actor_id=$2 AND key=$3', [input.teamId, input.actorId, key]);
    if (old.rows.length) {
      if (old.rows[0].request_hash !== hash)
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'This key belongs to a different billing request');
      await client.query('COMMIT');
      return { status: old.rows[0].http_status, body: old.rows[0].response };
    }
    const now = new Date();
    const { sub, plan } = await materializeSubscription(client, input.teamId, now);
    let computed;
    if (input.operation === 'renew') {
      // Do not bill a renewal for an obsolete scheduled plan before it is due.
      if (sub.scheduled_change_id)
        throw new HttpError(409, 'CHANGE_SCHEDULED', 'Renew when the scheduled change becomes effective');
      computed = computeRenewal(sub, plan);
    }
    else {
      const target = input.operation === 'checkout' ? await getPurchasablePlan(client, input.planCode!) : plan;
      const seats = Math.max(input.seats ?? sub.seats, target.included_seats ?? 0);
      const usage = await getSeatUsage(client, input.teamId);
      if (seats < usage.members + usage.pendingInvites)
        throw new HttpError(400, 'SEAT_LIMIT_EXCEEDED', 'Seats cannot be below members plus pending invitations');
      computed = computeChange(sub, plan, target, seats, now);
    }
    const opened = await openChange(client, input.teamId, input.actorId, computed, now);
    response = { ...opened, checkoutUrl: null, processing: Boolean(opened.payment) };
    const body = { success: true, data: response };
    await client.query(`INSERT INTO billing_idempotency(team_id,actor_id,key,request_hash,response,http_status,completed)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [input.teamId, input.actorId, key, hash, JSON.stringify(body), opened.payment ? 202 : 200, !opened.payment]);
    if (opened.payment) {
      await client.query("UPDATE payment_transactions SET initialization_state='QUEUED' WHERE id=$1", [opened.payment.id]);
      await enqueueOutbox(client, {key:'initialize:'+opened.payment.id,kind:'PAYMENT_INITIALIZE',teamId:input.teamId,
        payload:{paymentId:opened.payment.id,teamId:input.teamId,email:input.email,redirectUrl:input.redirectUrl}});
      await enqueueOutbox(client, {key:'reconcile:'+opened.payment.id,kind:'PAYMENT_RECONCILE',teamId:input.teamId,
        payload:{paymentId:opened.payment.id,teamId:input.teamId,txRef:opened.payment.txRef},availableAt:new Date(now.getTime()+30000)});
    }
    await client.query('COMMIT');
  }
  catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
  finally {
    client.release();
  }
  if (!response.payment)
    return { status: 200, body: { success: true, data: response } };
  return { status:202,body:{success:true,data:response} };
};
