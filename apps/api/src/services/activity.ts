import { PoolClient } from 'pg';
import { enqueueOutbox } from './outbox';

export interface ActivityInput {
  teamId: string;
  actorId: string;
  type: string;
  payload?: Record<string, unknown>;
  /** Optional explicit timestamp (used by the seed script for determinism). */
  createdAt?: Date;
}

/**
 * Writes an activity event. Must be called inside the same transaction as the
 * business mutation it describes so the feed can never disagree with the data.
 */
export const addActivity = async (
  client: PoolClient,
  input: ActivityInput
): Promise<void> => {
  const actorRes = await client.query(
    'SELECT first_name, last_name FROM users WHERE id = $1',
    [input.actorId]
  );
  const actor = actorRes.rows[0];
  const actorName = actor ? `${actor.first_name} ${actor.last_name}` : 'Unknown user';

  const payload = { ...(input.payload ?? {}), actorName };

  const inserted = await client.query(
    `INSERT INTO activity_events (team_id, actor_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_TIMESTAMP)) RETURNING id`,
    [input.teamId, input.actorId, input.type, JSON.stringify(payload), input.createdAt ?? null]
  );
  let recipients: string[] = [];
  if (['SHIFT_UPDATED', 'SHIFT_DELETED'].includes(input.type) && input.payload?.shiftId) {
    const members = await client.query('SELECT user_id FROM shift_assignments WHERE shift_id=$1', [input.payload.shiftId]);
    recipients = members.rows.map(row => row.user_id);
  }
  await enqueueOutbox(client, { key: 'activity:' + inserted.rows[0].id, kind: 'DOMAIN_EVENT', teamId: input.teamId,
    payload: { activityId: inserted.rows[0].id, type: input.type, teamId: input.teamId, actorId: input.actorId, payload, recipients } });
};
