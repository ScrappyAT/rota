import { PoolClient } from 'pg';
import { DEFAULT_SETTINGS, SettingsPatch, UserSettings } from '@rota/shared';
export const readSettings = async (client: PoolClient, userId: string): Promise<UserSettings> => {
  await client.query('INSERT INTO user_settings(user_id) SELECT id FROM users WHERE id=$1 ON CONFLICT DO NOTHING', [userId]);
  const result = await client.query(`SELECT s.values,s.updated_at,s.field_updated_at,p.shift_assigned,p.swap_requested,p.swap_approved,p.swap_rejected
    FROM users u LEFT JOIN user_settings s ON s.user_id=u.id LEFT JOIN notification_preferences p ON p.user_id=u.id WHERE u.id=$1`, [userId]);
  const row = result.rows[0];
  if (!row)
    throw new Error('Settings user does not exist');
  const updatedAt = (row.updated_at ?? new Date(0)).toISOString();
  const values = row.values ?? DEFAULT_SETTINGS;
  const timestamps: Record<string, string> = { ...row.field_updated_at };
  for (const key of ['quietHours', 'timeZone', 'language', 'theme', 'notificationCategories.shifts', 'notificationCategories.swaps', 'notificationCategories.billing', 'notificationTypes.shiftAssigned', 'notificationTypes.swapRequested', 'notificationTypes.swapApproved', 'notificationTypes.swapRejected'])
    timestamps[key] ??= updatedAt;
  return {
    ...values, updatedAt, fieldUpdatedAt: timestamps, notificationTypes: {
      shiftAssigned: row.shift_assigned ?? true, swapRequested: row.swap_requested ?? true, swapApproved: row.swap_approved ?? true, swapRejected: row.swap_rejected ?? true,
    }
  };
};
/** Serialized server-receive-time LWW per supplied field; client clocks are never trusted. */
export const writeSettings = async (client: PoolClient, userId: string, patch: SettingsPatch): Promise<UserSettings> => {
  await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [userId]);
  await client.query('INSERT INTO user_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING', [userId]);
  const before = await readSettings(client, userId);
  const values = {
    quietHours: before.quietHours, timeZone: before.timeZone, language: before.language, theme: before.theme,
    notificationCategories: { ...before.notificationCategories, ...patch.notificationCategories }
  };
  for (const key of ['quietHours', 'timeZone', 'language', 'theme'] as const)
    if (patch[key] !== undefined)
      Object.assign(values, { [key]: patch[key] });
  const clock = await client.query("SELECT GREATEST(clock_timestamp(),$1::timestamptz+INTERVAL '1 millisecond') AS now", [before.updatedAt]);
  const timestamp = clock.rows[0].now.toISOString();
  const fields = { ...before.fieldUpdatedAt };
  for (const [key, value] of Object.entries(patch)) {
    if ((key === 'notificationCategories' || key === 'notificationTypes') && value && typeof value === 'object') {
      for (const field of Object.keys(value))
        fields[key + '.' + field] = timestamp;
    }
    else
      fields[key] = timestamp;
  }
  if (patch.notificationTypes) {
    const merged = { ...before.notificationTypes, ...patch.notificationTypes };
    await client.query(`INSERT INTO notification_preferences(user_id,shift_assigned,swap_requested,swap_approved,swap_rejected) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(user_id) DO UPDATE SET shift_assigned=$2,swap_requested=$3,swap_approved=$4,swap_rejected=$5,updated_at=$6`, [userId, merged.shiftAssigned, merged.swapRequested, merged.swapApproved, merged.swapRejected, timestamp]);
  }
  await client.query('UPDATE user_settings SET values=$2,field_updated_at=$3,updated_at=$4 WHERE user_id=$1', [userId, JSON.stringify(values), JSON.stringify(fields), timestamp]);
  return readSettings(client, userId);
};
