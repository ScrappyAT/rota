import { PoolClient } from 'pg';
import { HttpError } from '../http-error';
export type JobKind = 'DOMAIN_EVENT' | 'NOTIFICATION' | 'PAYMENT_WEBHOOK' | 'PAYMENT_INITIALIZE' | 'PAYMENT_RECONCILE' | 'PAYMENT_VERIFY' | 'BILLING_RECHECK';
export interface OutboxRow {
  id: string;
  event_key: string;
  kind: JobKind;
  team_id: string | null;
  payload: Record<string, unknown>;
  status: string;
  generation: number;
  attempts: number;
  failures: number;
  dispatch_failures: number;
  available_at: Date;
}
/** The caller owns BEGIN/COMMIT: persistence must share the business transaction. */
export const enqueueOutbox = async (client: PoolClient, input: {
  key: string;
  kind: JobKind;
  teamId?: string;
  payload: Record<string, unknown>;
  availableAt?: Date;
}): Promise<string> => {
  const values = [input.key, input.kind, input.teamId ?? null, JSON.stringify(input.payload), input.availableAt ?? new Date()];
  const inserted = await client.query(`INSERT INTO job_outbox(event_key,kind,team_id,payload,available_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(event_key) DO NOTHING RETURNING id`, values);
  if (inserted.rows[0])
    return inserted.rows[0].id;
  const existing = await client.query(`SELECT id FROM job_outbox WHERE event_key=$1 AND kind=$2
    AND team_id IS NOT DISTINCT FROM $3::uuid AND payload=$4::jsonb`, values.slice(0, 4));
  if (!existing.rows[0])
    throw new HttpError(409, 'OUTBOX_CONFLICT', 'Event key belongs to different contents');
  return existing.rows[0].id;
};
export class DeferJob extends Error {
  constructor(public readonly until: Date) { super('Deferred until permitted delivery window'); }
}
/** Operator-only helper; does not authorize resending an uncertain push. */
export const replayDeadJob = async (client: PoolClient, id: string): Promise<void> => {
  const result = await client.query(`SELECT o.*,EXISTS(SELECT 1 FROM notification_deliveries d
    WHERE d.notification_id::text=o.payload->>'notificationId' AND d.state IN ('UNKNOWN','SENDING')) AS uncertain
    FROM job_outbox o WHERE o.id=$1 FOR UPDATE`, [id]);
  if (!result.rows[0] || result.rows[0].status !== 'DEAD')
    throw new HttpError(409, 'NOT_FAILED', 'A failed job is required');
  if (result.rows[0].uncertain)
    throw new HttpError(409, 'DELIVERY_UNCERTAIN', 'Resolve uncertain push delivery before replay');
  await client.query(`UPDATE job_outbox SET status='PENDING',failures=0,dispatch_failures=0,generation=generation+1,
    manual_replays=manual_replays+1,next_dispatch_at=NOW(),available_at=NOW(),last_error=NULL WHERE id=$1`, [id]);
};
