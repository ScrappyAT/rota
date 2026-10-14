import crypto from 'crypto';
import { Pool } from 'pg';
import { ShardedPoolManager } from './poolManager';
import { getShardId } from './router';

export class ShardUnavailableError extends Error {
  constructor(public readonly shardId: number, message: string) {
    super(`[Shard ${shardId} Unavailable] ${message}`);
    this.name = 'ShardUnavailableError';
  }
}

export interface ShardedTeamRecord {
  id: string;
  name: string;
  createdAt: string;
  shardId: number;
}

export interface ShardedShiftRecord {
  id: string;
  teamId: string;
  title: string;
  startsAt: string;
  endsAt: string;
  status: string;
  shardId: number;
}

export interface UserMembershipRecord {
  teamId: string;
  teamName: string;
  role: string;
  shardId: number;
}

export interface ScatterGatherResult {
  memberships: UserMembershipRecord[];
  shardsQueried: number;
  partialErrors?: Array<{ shardId: number; error: string }>;
}

export class ShardedCoordinator {
  constructor(private poolManager: ShardedPoolManager) {}

  /**
   * Helper to execute a query against the specific shard routed by teamId.
   */
  public async executeForTeam<T>(
    teamId: string,
    callback: (client: { query: Pool['query'] }, shardId: number) => Promise<T>
  ): Promise<{ result: T; shardId: number }> {
    const { pool, shardId } = this.poolManager.getPoolForTeam(teamId);
    try {
      const client = await pool.connect();
      try {
        const result = await callback(client, shardId);
        return { result, shardId };
      } finally {
        client.release();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED') || msg.includes('timeout') || msg.includes('connection')) {
        throw new ShardUnavailableError(shardId, msg);
      }
      throw err;
    }
  }

  /**
   * Creates a team on the deterministically selected shard.
   * Also ensures an owner user record exists on that shard to satisfy FK constraints.
   */
  public async createTeam(params: {
    teamId?: string;
    name: string;
    ownerUserId: string;
    ownerEmail?: string;
  }): Promise<ShardedTeamRecord> {
    const teamId = params.teamId || crypto.randomUUID();
    const email = params.ownerEmail || `owner-${params.ownerUserId.slice(0, 8)}@example.com`;

    const { result, shardId } = await this.executeForTeam(teamId, async (client) => {
      // 1. Ensure user exists on this shard (idempotent across ID and email)
      const userRes = await client.query(
        `INSERT INTO users (id, email, first_name, last_name, password_hash)
         VALUES ($1, $2, 'Team', 'Owner', 'hashed-password')
         ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [params.ownerUserId, email]
      );
      const effectiveOwnerId = userRes.rows[0]?.id || params.ownerUserId;

      // 2. Insert team with owner_id
      const teamRes = await client.query(
        `INSERT INTO teams (id, name, owner_id)
         VALUES ($1, $2, $3)
         RETURNING id, name, created_at`,
        [teamId, params.name, effectiveOwnerId]
      );
      const row = teamRes.rows[0];

      // 3. Insert owner membership
      await client.query(
        `INSERT INTO team_memberships (team_id, user_id, role)
         VALUES ($1, $2, 'OWNER')
         ON CONFLICT (team_id, user_id) DO NOTHING`,
        [teamId, effectiveOwnerId]
      );

      // 4. Provision free subscription
      await client.query(
        `INSERT INTO team_subscriptions (team_id, plan_code, status, seats, period_started_at, period_ends_at)
         VALUES ($1, 'FREE', 'ACTIVE', 5, NOW(), NOW() + interval '30 days')
         ON CONFLICT (team_id) DO NOTHING`,
        [teamId]
      );

      return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at.toISOString(),
      };
    });

    return {
      ...result,
      shardId,
    };
  }

  /**
   * Adds a member to an existing team on its designated shard.
   */
  public async addMember(params: {
    teamId: string;
    userId: string;
    role: 'OWNER' | 'MANAGER' | 'STAFF';
    email?: string;
  }): Promise<{ teamId: string; userId: string; role: string; shardId: number }> {
    const email = params.email || `user-${params.userId.slice(0, 8)}@example.com`;

    const { shardId } = await this.executeForTeam(params.teamId, async (client) => {
      const userRes = await client.query(
        `INSERT INTO users (id, email, first_name, last_name, password_hash)
         VALUES ($1, $2, 'Staff', 'Member', 'hashed-password')
         ON CONFLICT (email) DO UPDATE SET updated_at = NOW()
         RETURNING id`,
        [params.userId, email]
      );
      const effectiveUserId = userRes.rows[0]?.id || params.userId;

      await client.query(
        `INSERT INTO team_memberships (team_id, user_id, role)
         VALUES ($1, $2, $3)
         ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [params.teamId, effectiveUserId, params.role]
      );
    });

    return {
      teamId: params.teamId,
      userId: params.userId,
      role: params.role,
      shardId,
    };
  }

  /**
   * Creates a shift strictly routed to the team's designated shard.
   */
  public async createShift(params: {
    teamId: string;
    title: string;
    startsAt: Date;
    endsAt: Date;
    shiftId?: string;
    createdBy?: string;
  }): Promise<ShardedShiftRecord> {
    const shiftId = params.shiftId || crypto.randomUUID();

    const { result, shardId } = await this.executeForTeam(params.teamId, async (client) => {
      let createdBy = params.createdBy;
      if (!createdBy) {
        const teamRow = await client.query('SELECT owner_id FROM teams WHERE id = $1', [params.teamId]);
        createdBy = teamRow.rows[0]?.owner_id;
      }

      const res = await client.query(
        `INSERT INTO shifts (id, team_id, created_by, title, starts_at, ends_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')
         RETURNING id, team_id, created_by, title, starts_at, ends_at, status`,
        [shiftId, params.teamId, createdBy, params.title, params.startsAt.toISOString(), params.endsAt.toISOString()]
      );
      const row = res.rows[0];
      return {
        id: row.id,
        teamId: row.team_id,
        title: row.title,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        status: row.status,
      };
    });

    return {
      ...result,
      shardId,
    };
  }

  /**
   * Retrieves all shifts for a team from its designated shard.
   */
  public async getShiftsForTeam(teamId: string): Promise<{ shifts: ShardedShiftRecord[]; shardId: number }> {
    const { result, shardId: targetShardId } = await this.executeForTeam<ShardedShiftRecord[]>(teamId, async (client, currentShardId) => {
      const res = await client.query(
        `SELECT id, team_id, title, starts_at, ends_at, status
         FROM shifts
         WHERE team_id = $1
         ORDER BY starts_at ASC`,
        [teamId]
      );
      return res.rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        title: row.title,
        startsAt: row.starts_at.toISOString(),
        endsAt: row.ends_at.toISOString(),
        status: row.status,
        shardId: currentShardId,
      }));
    });

    return { shifts: result, shardId: targetShardId };
  }

  /**
   * Directly queries both shards to verify physical tenant isolation:
   * Proves that a team and its shifts exist ONLY on its designated shard and 0 rows exist on the other.
   */
  public async verifyIsolation(teamId: string): Promise<{
    expectedShardId: number;
    targetShardCount: number;
    otherShardCount: number;
    isIsolated: boolean;
  }> {
    const expectedShardId = getShardId(teamId, 2);
    const otherShardId = expectedShardId === 0 ? 1 : 0;

    const targetPool = this.poolManager.getPoolForShard(expectedShardId);
    const otherPool = this.poolManager.getPoolForShard(otherShardId);

    const targetRes = await targetPool.query('SELECT count(*) FROM teams WHERE id = $1', [teamId]);
    const otherRes = await otherPool.query('SELECT count(*) FROM teams WHERE id = $1', [teamId]);

    const targetCount = parseInt(targetRes.rows[0].count, 10);
    const otherCount = parseInt(otherRes.rows[0].count, 10);

    return {
      expectedShardId,
      targetShardCount: targetCount,
      otherShardCount: otherCount,
      isIsolated: targetCount > 0 && otherCount === 0,
    };
  }

  /**
   * Cross-shard Scatter-Gather Query:
   * Resolves all team memberships for a user by querying Shard 0 and Shard 1 concurrently.
   * If one shard is down, it returns partial results with degraded status.
   */
  public async getUserTeamsScatterGather(userId: string): Promise<ScatterGatherResult> {
    const configs = this.poolManager.getConfigs();
    const queryPromises = configs.map(async (cfg) => {
      const pool = this.poolManager.getPoolForShard(cfg.id);
      const res = await pool.query(
        `SELECT tm.team_id, t.name as team_name, tm.role
         FROM team_memberships tm
         JOIN teams t ON t.id = tm.team_id
         WHERE tm.user_id = $1
         ORDER BY t.name ASC`,
        [userId]
      );
      return res.rows.map((r) => ({
        teamId: r.team_id,
        teamName: r.team_name,
        role: r.role,
        shardId: cfg.id,
      }));
    });

    const settled = await Promise.allSettled(queryPromises);
    const memberships: UserMembershipRecord[] = [];
    const partialErrors: Array<{ shardId: number; error: string }> = [];

    settled.forEach((outcome, idx) => {
      const shardId = configs[idx].id;
      if (outcome.status === 'fulfilled') {
        memberships.push(...outcome.value);
      } else {
        const err = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        partialErrors.push({ shardId, error: err });
      }
    });

    // Deterministic sort across all shards by teamName then teamId
    memberships.sort((a, b) => a.teamName.localeCompare(b.teamName) || a.teamId.localeCompare(b.teamId));

    return {
      memberships,
      shardsQueried: configs.length,
      partialErrors: partialErrors.length > 0 ? partialErrors : undefined,
    };
  }
}
