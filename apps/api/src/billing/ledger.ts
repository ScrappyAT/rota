import { PoolClient } from 'pg';
import { HttpError } from '../http-error';
export type LedgerKind = 'CHARGE' | 'CREDIT' | 'REFUND' | 'STATE';
export const appendLedger = async (client: PoolClient, entry: {
  teamId: string;
  eventKey: string;
  kind: LedgerKind;
  amountMinor: number;
  currency: string;
  paymentId?: string;
  detail?: Record<string, unknown>;
}): Promise<void> => {
  if (!Number.isSafeInteger(entry.amountMinor) || entry.amountMinor < 0)
    throw new Error('Invalid ledger amount');
  const values = [entry.teamId, entry.eventKey, entry.kind, entry.amountMinor, entry.currency, entry.paymentId ?? null, JSON.stringify(entry.detail ?? {})];
  const inserted = await client.query(`INSERT INTO financial_ledger(team_id,event_key,kind,amount_minor,currency,payment_id,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO NOTHING RETURNING sequence`, values);
  if (!inserted.rows.length) {
    const same = await client.query(`SELECT sequence FROM financial_ledger WHERE team_id=$1 AND event_key=$2
      AND kind=$3 AND amount_minor=$4 AND currency=$5 AND payment_id IS NOT DISTINCT FROM $6::uuid AND detail=$7::jsonb`, values);
    if (!same.rows.length)
      throw new HttpError(409, 'LEDGER_CONFLICT', 'Ledger event key has different contents');
  }
};
export const snapshotSubscription = async (client: PoolClient, teamId: string, reason: string): Promise<void> => {
  const { rows } = await client.query(`SELECT to_jsonb(s) AS subscription,p.currency FROM team_subscriptions s
    JOIN billing_plans p ON p.code=s.plan_code WHERE s.team_id=$1`, [teamId]);
  if (!rows[0])
    throw new HttpError(404, 'NOT_FOUND', 'Subscription not found');
  const scheduled = rows[0].subscription.scheduled_change_id
    ? await client.query('SELECT to_jsonb(c) AS change FROM subscription_changes c WHERE id=$1', [rows[0].subscription.scheduled_change_id]) : null;
  await appendLedger(client, {
    teamId, eventKey: `state:${teamId}:${rows[0].subscription.revision}`, kind: 'STATE', amountMinor: 0,
    currency: rows[0].currency, detail: { reason, subscription: rows[0].subscription, scheduledChange: scheduled?.rows[0]?.change ?? null }
  });
};
/** Rebuilds canonical state using immutable records only, without reading projections. */
export const reconstructSubscription = async (client: PoolClient, teamId: string): Promise<Record<string, unknown>> => {
  const { rows } = await client.query(`SELECT detail->'subscription' AS subscription FROM financial_ledger
    WHERE team_id=$1 AND kind='STATE' ORDER BY sequence DESC LIMIT 1`, [teamId]);
  if (!rows.length)
    throw new HttpError(404, 'NOT_FOUND', 'No ledger baseline');
  return rows[0].subscription;
};
/** Rebuilds schedule details and per-currency totals without querying mutable tables. */
export const reconstructBilling = async (client: PoolClient, teamId: string) => {
  // One statement gives state and totals the same PostgreSQL snapshot.
  const { rows } = await client.query(`WITH latest AS (
    SELECT detail FROM financial_ledger WHERE team_id=$1 AND kind='STATE' ORDER BY sequence DESC LIMIT 1
  ), totals AS (
    SELECT currency,
      COALESCE(SUM(amount_minor) FILTER (WHERE kind='CHARGE'),0)::text AS charges,
      COALESCE(SUM(amount_minor) FILTER (WHERE kind='CREDIT'),0)::text AS credits,
      COALESCE(SUM(amount_minor) FILTER (WHERE kind='REFUND'),0)::text AS refunds
    FROM financial_ledger WHERE team_id=$1 GROUP BY currency
  ) SELECT (SELECT detail FROM latest) AS state,
    COALESCE((SELECT jsonb_agg(t ORDER BY t.currency) FROM totals t),'[]'::jsonb) AS totals`, [teamId]);
  if (!rows[0].state)
    throw new HttpError(404, 'NOT_FOUND', 'No ledger baseline');
  return { subscription: rows[0].state.subscription, scheduledChange: rows[0].state.scheduledChange ?? null, totals: rows[0].totals };
};
/** Records an externally confirmed refund. Never calls the provider or moves money. */
export const recordRefund = async (client: PoolClient, paymentId: string, amountMinor: number, eventKey: string): Promise<void> => {
  const payment = await client.query('SELECT * FROM payment_transactions WHERE id=$1 FOR UPDATE', [paymentId]);
  const row = payment.rows[0];
  if (!row || row.status !== 'SUCCESSFUL')
    throw new HttpError(400, 'INVALID_REFUND', 'Settled payment required');
  const duplicate = await client.query('SELECT sequence FROM financial_ledger WHERE event_key=$1', [eventKey]);
  if (!duplicate.rows.length) {
    const refunded = await client.query(`SELECT COALESCE(SUM(amount_minor),0) AS total FROM financial_ledger WHERE payment_id=$1 AND kind='REFUND'`, [paymentId]);
    const captured = await client.query("SELECT detail->>'receivedMinor' AS amount FROM financial_ledger WHERE payment_id=$1 AND kind='CHARGE' ORDER BY sequence LIMIT 1", [paymentId]);
    const refundable = Number(captured.rows[0]?.amount ?? row.amount_minor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0 || amountMinor + Number(refunded.rows[0].total) > refundable)
      throw new HttpError(400, 'INVALID_REFUND', 'Refund exceeds settled payment');
  }
  await appendLedger(client, {
    teamId: row.team_id, eventKey, kind: 'REFUND', amountMinor, currency: row.currency,
    paymentId, detail: { source: 'externally confirmed refund' }
  });
};
