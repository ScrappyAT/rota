import { PoolClient } from 'pg';

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

  await client.query(
    `INSERT INTO activity_events (team_id, actor_id, type, payload, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5, CURRENT_TIMESTAMP))`,
    [input.teamId, input.actorId, input.type, JSON.stringify(payload), input.createdAt ?? null]
  );
};