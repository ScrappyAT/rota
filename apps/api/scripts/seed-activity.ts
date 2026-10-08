/**
 * Seed the activity feed with deterministic data.
 *
 * Usage:
 *   npm run db:seed:activity -- --team <team-uuid> [--count 10000] [--reset]
 *
 * - `--count` defaults to 10000.
 * - `--reset` deletes ONLY previously seeded rows for the team (rows whose
 *   payload.source = 'seed'). It never touches other rows or tables.
 * - Rerunning without `--reset` inserts nothing new for existing ids (rows are
 *   keyed deterministically by a digest of (teamId, index)), so records are
 *   not duplicated on repeated runs.
 *
 * Timestamps are generated from a fixed anchor (2026-01-01T00:00:00Z) with
 * deliberate collisions (3 rows share each timestamp) so the id tie-breaker in
 * the cursor ordering is exercised.
 */
import { pool } from '../src/db';

export const SEED_COUNT_DEFAULT = 10000;
const SEED_ANCHOR = new Date('2026-01-01T00:00:00Z');
const SEED_TYPES = [
  'SHIFT_CREATED',
  'SHIFT_ASSIGNED',
  'SWAP_REQUESTED',
  'SWAP_APPROVED',
  'SHIFT_UPDATED',
  'MEMBER_JOINED',
];

export interface SeedOptions {
  teamId: string;
  count?: number;
  reset?: boolean;
}

export interface SeedResult {
  teamId: string;
  inserted: number;
  totalSeedRows: number;
  resetPerformed: boolean;
}

export async function seedActivity(options: SeedOptions): Promise<SeedResult> {
  const { teamId, count = SEED_COUNT_DEFAULT, reset = false } = options;

  if (!/^[0-9a-f-]{36}$/i.test(teamId)) {
    throw new Error(`Invalid team id: ${teamId}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`count must be a positive integer`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const team = await client.query('SELECT id FROM teams WHERE id = $1', [teamId]);
    if (team.rows.length === 0) {
      throw new Error(`Team ${teamId} not found`);
    }

    if (reset) {
      await client.query(
        `DELETE FROM activity_events WHERE team_id = $1 AND payload->>'source' = 'seed'`,
        [teamId]
      );
    }

    const insertRes = await client.query(
      `INSERT INTO activity_events (id, team_id, actor_id, type, payload, created_at)
       SELECT md5($1::text || ':' || i)::uuid, $1::uuid, NULL,
              ($4::text[])[1 + ((i - 1) % array_length($4::text[], 1))],
              jsonb_build_object('source', 'seed', 'seedIndex', i, 'actorName', 'Seed Bot'),
              $2::timestamptz + ((($3::int - i) / 3) * interval '1 second')
       FROM generate_series(1, $3::int) AS i
       ON CONFLICT (id) DO NOTHING`,
      [teamId, SEED_ANCHOR.toISOString(), count, SEED_TYPES]
    );

    const countRes = await client.query(
      `SELECT count(*)::int AS total FROM activity_events
       WHERE team_id = $1 AND payload->>'source' = 'seed'`,
      [teamId]
    );

    await client.query('COMMIT');

    return {
      teamId,
      inserted: (insertRes.rowCount ?? 0) ?? 0,
      totalSeedRows: countRes.rows[0].total,
      resetPerformed: reset,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// CLI entry point
const parseArgs = (argv: string[]): SeedOptions => {
  const options: SeedOptions = { teamId: '' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--team') {
      options.teamId = argv[i + 1] ?? '';
      i += 1;
    } else if (arg.startsWith('--team=')) {
      options.teamId = arg.slice('--team='.length);
    } else if (arg === '--count') {
      options.count = Number(argv[i + 1] ?? '');
      i += 1;
    } else if (arg.startsWith('--count=')) {
      options.count = Number(arg.slice('--count='.length));
    } else if (arg === '--reset') {
      options.reset = true;
    }
  }
  return options;
};

const runCli = async () => {
  const options = parseArgs(process.argv.slice(2));
  if (!options.teamId || options.count === undefined || Number.isNaN(options.count)) {
    console.log(
      'Usage: npm run db:seed:activity -- --team <team-uuid> [--count 10000] [--reset]\n' +
        '  --reset  deletes only previously seeded rows for this team before inserting'
    );
    process.exit(1);
  }

  try {
    const result = await seedActivity(options);
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (e) {
    console.error('Seeding failed:', (e as Error).message);
    process.exit(1);
  }
};

if (require.main === module) {
  runCli();
}