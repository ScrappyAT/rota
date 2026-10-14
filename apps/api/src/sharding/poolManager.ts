import { Pool, PoolConfig } from 'pg';
import { ShardConfig, DEFAULT_SHARD_CONFIGS, getShardId } from './router';

export class ShardedPoolManager {
  private pools = new Map<number, Pool>();
  private configs: ShardConfig[];

  constructor(configs: ShardConfig[] = DEFAULT_SHARD_CONFIGS, customPoolOptions: Partial<PoolConfig> = {}) {
    this.configs = configs;
    for (const cfg of configs) {
      const pool = new Pool({
        connectionString: cfg.connectionString,
        connectionTimeoutMillis: 3000,
        idleTimeoutMillis: 10000,
        max: 10,
        ...customPoolOptions,
      });

      pool.on('error', (err) => {
        console.error(`[ShardedPoolManager] Unexpected error on idle client for ${cfg.name}:`, err.message);
      });

      this.pools.set(cfg.id, pool);
    }
  }

  public getConfigs(): ShardConfig[] {
    return [...this.configs];
  }

  public getPoolForShard(shardId: number): Pool {
    const pool = this.pools.get(shardId);
    if (!pool) {
      throw new Error(`No database pool initialized for shard ID ${shardId}`);
    }
    return pool;
  }

  public getPoolForTeam(teamId: string): { pool: Pool; shardId: number; config: ShardConfig } {
    const shardId = getShardId(teamId, this.configs.length);
    const config = this.configs.find((c) => c.id === shardId)!;
    const pool = this.getPoolForShard(shardId);
    return { pool, shardId, config };
  }

  public async checkShardHealth(shardId: number): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      const pool = this.getPoolForShard(shardId);
      const client = await pool.connect();
      try {
        await client.query('SELECT 1');
        return {
          healthy: true,
          latencyMs: Date.now() - start,
        };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: msg,
      };
    }
  }

  public async checkAllHealth(): Promise<Record<number, { healthy: boolean; latencyMs: number; error?: string }>> {
    const results: Record<number, { healthy: boolean; latencyMs: number; error?: string }> = {};
    await Promise.all(
      this.configs.map(async (cfg) => {
        results[cfg.id] = await this.checkShardHealth(cfg.id);
      })
    );
    return results;
  }

  public async closeAll(): Promise<void> {
    const closePromises: Promise<void>[] = [];
    this.pools.forEach((pool, id) => {
      closePromises.push(
        pool.end().catch((err) => {
          console.warn(`[ShardedPoolManager] Error closing pool ${id}:`, err);
        })
      );
    });
    await Promise.all(closePromises);
    this.pools.clear();
  }
}
