import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { ShardedPoolManager } from './poolManager';

export interface MigrationResult {
  shardId: number;
  shardName: string;
  applied: string[];
  alreadyRun: string[];
}

/**
 * Runs all SQL migrations in sequence against a single PostgreSQL pool.
 */
export async function runMigrationsOnPool(
  pool: Pool,
  migrationsDir: string = path.join(__dirname, '../../migrations')
): Promise<{ applied: string[]; alreadyRun: string[] }> {
  const client = await pool.connect();
  const applied: string[] = [];
  const alreadyRun: string[] = [];

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        executed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);

    const files = fs.readdirSync(migrationsDir).sort();

    for (const file of files) {
      if (!file.endsWith('.sql')) continue;

      const { rows } = await client.query('SELECT name FROM migrations WHERE name = $1', [file]);
      if (rows.length === 0) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO migrations (name) VALUES ($1)', [file]);
          await client.query('COMMIT');
          applied.push(file);
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      } else {
        alreadyRun.push(file);
      }
    }

    return { applied, alreadyRun };
  } finally {
    client.release();
  }
}

/**
 * Runs all migrations across all shards managed by the ShardedPoolManager.
 */
export async function migrateAllShards(
  manager: ShardedPoolManager,
  migrationsDir?: string
): Promise<MigrationResult[]> {
  const configs = manager.getConfigs();
  const results: MigrationResult[] = [];

  for (const cfg of configs) {
    const pool = manager.getPoolForShard(cfg.id);
    const { applied, alreadyRun } = await runMigrationsOnPool(pool, migrationsDir);
    results.push({
      shardId: cfg.id,
      shardName: cfg.name,
      applied,
      alreadyRun,
    });
  }

  return results;
}
