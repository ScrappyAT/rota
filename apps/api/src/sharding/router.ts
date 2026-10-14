import crypto from 'crypto';

export interface ShardConfig {
  id: number;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  connectionString: string;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const DEFAULT_SHARD_CONFIGS: ShardConfig[] = [
  {
    id: 0,
    name: 'Shard-0',
    host: process.env.SHARD_0_HOST || '127.0.0.1',
    port: parseInt(process.env.SHARD_0_PORT || '5441', 10),
    database: process.env.SHARD_0_DB || 'rota_shard_0',
    user: process.env.SHARD_0_USER || 'postgres',
    connectionString:
      process.env.SHARD_0_DATABASE_URL ||
      'postgres://postgres:postgres@127.0.0.1:5441/rota_shard_0',
  },
  {
    id: 1,
    name: 'Shard-1',
    host: process.env.SHARD_1_HOST || '127.0.0.1',
    port: parseInt(process.env.SHARD_1_PORT || '5442', 10),
    database: process.env.SHARD_1_DB || 'rota_shard_1',
    user: process.env.SHARD_1_USER || 'postgres',
    connectionString:
      process.env.SHARD_1_DATABASE_URL ||
      'postgres://postgres:postgres@127.0.0.1:5442/rota_shard_1',
  },
];

/**
 * Validates that a string is a valid canonical RFC-4122 UUID.
 */
export function isValidUUID(uuid: string): boolean {
  return typeof uuid === 'string' && UUID_REGEX.test(uuid.trim());
}

/**
 * Deterministically routes a team_id UUID to a shard index (0 or 1).
 * Uses MD5 cryptographic hashing of the normalized UUID, reading the first 4 bytes
 * as an unsigned 32-bit integer, modulo the total shard count.
 *
 * Properties:
 * 1. Strict determinism: Identical UUID always maps to the same shard.
 * 2. Uniform distribution: Spreads UUIDs evenly across shards.
 * 3. Fast execution: Under 0.01ms per routing decision in Node.js.
 */
export function getShardId(teamId: string, shardCount: number = DEFAULT_SHARD_CONFIGS.length): number {
  if (!isValidUUID(teamId)) {
    throw new Error(`Invalid UUID shard key provided: "${teamId}"`);
  }

  const normalized = teamId.trim().toLowerCase();
  const hash = crypto.createHash('md5').update(normalized).digest('hex');
  const intVal = parseInt(hash.substring(0, 8), 16);
  return intVal % shardCount;
}

/**
 * Returns the full shard configuration object for a given team_id.
 */
export function getShardConfigForTeam(
  teamId: string,
  configs: ShardConfig[] = DEFAULT_SHARD_CONFIGS
): ShardConfig {
  const shardId = getShardId(teamId, configs.length);
  const cfg = configs.find((c) => c.id === shardId);
  if (!cfg) {
    throw new Error(`Shard configuration not found for shardId: ${shardId}`);
  }
  return cfg;
}
