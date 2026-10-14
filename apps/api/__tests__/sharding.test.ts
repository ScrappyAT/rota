import crypto from 'crypto';
import {
  getShardId,
  isValidUUID,
  ShardedPoolManager,
  ShardedCoordinator,
  migrateAllShards,
  ShardUnavailableError,
  ShardConfig,
} from '../src/sharding';

describe('Two-PostgreSQL Sharding Simulation Suite', () => {
  describe('1. Deterministic Shard Key Routing', () => {
    it('validates UUID format correctly', () => {
      expect(isValidUUID('92ce8c0c-d708-43fa-a9a9-b63b1bde44e3')).toBe(true);
      expect(isValidUUID('invalid-uuid')).toBe(false);
      expect(isValidUUID('')).toBe(false);
      expect(isValidUUID('12345')).toBe(false);
    });

    it('throws when routing an invalid UUID', () => {
      expect(() => getShardId('not-a-uuid')).toThrow('Invalid UUID shard key provided');
    });

    it('routes deterministically: identical UUID always returns identical shard ID', () => {
      const sampleUUIDs = Array.from({ length: 20 }, () => crypto.randomUUID());
      for (const uuid of sampleUUIDs) {
        const first = getShardId(uuid);
        for (let i = 0; i < 5; i++) {
          expect(getShardId(uuid)).toBe(first);
        }
      }
    });

    it('normalizes case: uppercase and lowercase UUIDs map to the same shard', () => {
      const uuid = crypto.randomUUID().toLowerCase();
      expect(getShardId(uuid)).toBe(getShardId(uuid.toUpperCase()));
    });

    it('distributes 1,000 random team UUIDs evenly across Shard 0 and Shard 1', () => {
      let shard0Count = 0;
      let shard1Count = 0;
      const total = 1000;

      for (let i = 0; i < total; i++) {
        const id = crypto.randomUUID();
        const shard = getShardId(id, 2);
        if (shard === 0) shard0Count++;
        else if (shard === 1) shard1Count++;
      }

      // Neither shard should deviate significantly from 50% (allow 40%-60% window)
      expect(shard0Count).toBeGreaterThan(400);
      expect(shard0Count).toBeLessThan(600);
      expect(shard1Count).toBeGreaterThan(400);
      expect(shard1Count).toBeLessThan(600);
      expect(shard0Count + shard1Count).toBe(total);
    });
  });

  describe('2. Live Multi-Database Integration & Physical Tenant Isolation', () => {
    let poolManager: ShardedPoolManager;
    let coordinator: ShardedCoordinator;
    let shardsAvailable = false;

    beforeAll(async () => {
      poolManager = new ShardedPoolManager();
      const health = await poolManager.checkAllHealth();
      shardsAvailable = health[0]?.healthy && health[1]?.healthy;

      if (shardsAvailable) {
        await migrateAllShards(poolManager);
      }
      coordinator = new ShardedCoordinator(poolManager);
    });

    afterAll(async () => {
      if (poolManager) {
        await poolManager.closeAll();
      }
    });

    it('verifies both sharded databases are accessible and healthy', async () => {
      if (!shardsAvailable) {
        console.warn('Skipping live shard test: sharding containers not detected on ports 5441/5442.');
        return;
      }
      const health = await poolManager.checkAllHealth();
      expect(health[0].healthy).toBe(true);
      expect(health[1].healthy).toBe(true);
    });

    it('routes Team Alpha to Shard 0 and proves physical absence on Shard 1', async () => {
      if (!shardsAvailable) return;

      let teamId0: string | null = null;
      while (!teamId0) {
        const candidate = crypto.randomUUID();
        if (getShardId(candidate) === 0) teamId0 = candidate;
      }

      const ownerId = crypto.randomUUID();
      const team = await coordinator.createTeam({
        teamId: teamId0,
        name: 'Unit Test Cafe A',
        ownerUserId: ownerId,
        ownerEmail: `owner-${ownerId.slice(0, 8)}@test.example`,
      });

      expect(team.shardId).toBe(0);

      // Verify physical isolation
      const isolation = await coordinator.verifyIsolation(teamId0);
      expect(isolation.expectedShardId).toBe(0);
      expect(isolation.targetShardCount).toBe(1);
      expect(isolation.otherShardCount).toBe(0);
      expect(isolation.isIsolated).toBe(true);
    });

    it('routes Team Beta to Shard 1 and proves physical absence on Shard 0', async () => {
      if (!shardsAvailable) return;

      let teamId1: string | null = null;
      while (!teamId1) {
        const candidate = crypto.randomUUID();
        if (getShardId(candidate) === 1) teamId1 = candidate;
      }

      const ownerId = crypto.randomUUID();
      const team = await coordinator.createTeam({
        teamId: teamId1,
        name: 'Unit Test Clinic B',
        ownerUserId: ownerId,
        ownerEmail: `owner-${ownerId.slice(0, 8)}@test.example`,
      });

      expect(team.shardId).toBe(1);

      // Verify physical isolation
      const isolation = await coordinator.verifyIsolation(teamId1);
      expect(isolation.expectedShardId).toBe(1);
      expect(isolation.targetShardCount).toBe(1);
      expect(isolation.otherShardCount).toBe(0);
      expect(isolation.isIsolated).toBe(true);
    });

    it('persists shifts on the routed shard and returns correct shard metadata', async () => {
      if (!shardsAvailable) return;

      let teamId: string | null = null;
      while (!teamId) {
        const candidate = crypto.randomUUID();
        if (getShardId(candidate) === 0) teamId = candidate;
      }

      const ownerId = crypto.randomUUID();
      await coordinator.createTeam({
        teamId,
        name: 'Shift Isolated Team',
        ownerUserId: ownerId,
        ownerEmail: `owner-${ownerId.slice(0, 8)}@test.example`,
      });

      const now = new Date();
      const shift = await coordinator.createShift({
        teamId,
        title: 'Sharded Shift 1',
        startsAt: new Date(now.getTime() + 100000),
        endsAt: new Date(now.getTime() + 200000),
      });

      expect(shift.shardId).toBe(0);

      const listRes = await coordinator.getShiftsForTeam(teamId);
      expect(listRes.shardId).toBe(0);
      expect(listRes.shifts.some((s) => s.id === shift.id)).toBe(true);

      // Other shard (Shard 1) must have 0 shifts for this team
      const shard1Pool = poolManager.getPoolForShard(1);
      const crossCheck = await shard1Pool.query('SELECT count(*) FROM shifts WHERE team_id = $1', [teamId]);
      expect(parseInt(crossCheck.rows[0].count, 10)).toBe(0);
    });
  });

  describe('3. Cross-Shard Scatter-Gather Queries', () => {
    let poolManager: ShardedPoolManager;
    let coordinator: ShardedCoordinator;
    let shardsAvailable = false;

    beforeAll(async () => {
      poolManager = new ShardedPoolManager();
      const health = await poolManager.checkAllHealth();
      shardsAvailable = health[0]?.healthy && health[1]?.healthy;
      if (shardsAvailable) {
        await migrateAllShards(poolManager);
      }
      coordinator = new ShardedCoordinator(poolManager);
    });

    afterAll(async () => {
      if (poolManager) {
        await poolManager.closeAll();
      }
    });

    it('aggregates memberships across Shard 0 and Shard 1 for a multi-tenant user', async () => {
      if (!shardsAvailable) return;

      const workerUserId = crypto.randomUUID();
      const workerEmail = `worker-${workerUserId.slice(0, 8)}@test.example`;

      // Find one team for Shard 0 and one team for Shard 1
      let teamId0: string | null = null;
      let teamId1: string | null = null;
      while (!teamId0 || !teamId1) {
        const candidate = crypto.randomUUID();
        const shard = getShardId(candidate);
        if (shard === 0 && !teamId0) teamId0 = candidate;
        if (shard === 1 && !teamId1) teamId1 = candidate;
      }

      await coordinator.createTeam({
        teamId: teamId0,
        name: 'Cross Team Zero',
        ownerUserId: workerUserId,
        ownerEmail: workerEmail,
      });

      await coordinator.createTeam({
        teamId: teamId1,
        name: 'Cross Team One',
        ownerUserId: workerUserId,
        ownerEmail: workerEmail,
      });

      // Scatter-gather across both shards
      const result = await coordinator.getUserTeamsScatterGather(workerUserId);
      expect(result.shardsQueried).toBe(2);
      expect(result.memberships.length).toBeGreaterThanOrEqual(2);

      const team0Record = result.memberships.find((m) => m.teamId === teamId0);
      const team1Record = result.memberships.find((m) => m.teamId === teamId1);

      expect(team0Record).toBeDefined();
      expect(team0Record?.shardId).toBe(0);

      expect(team1Record).toBeDefined();
      expect(team1Record?.shardId).toBe(1);
    });
  });

  describe('4. Fault Tolerance & Shard Unavailability Behavior', () => {
    it('isolates blast radius: healthy shard succeeds when another shard is offline', async () => {
      // Mock configs where Shard 0 is valid and Shard 1 points to a non-existent port (5449)
      const faultyConfigs: ShardConfig[] = [
        {
          id: 0,
          name: 'Healthy-Shard-0',
          host: '127.0.0.1',
          port: 5441,
          database: 'rota_shard_0',
          user: 'postgres',
          connectionString: 'postgres://postgres:postgres@127.0.0.1:5441/rota_shard_0',
        },
        {
          id: 1,
          name: 'Dead-Shard-1',
          host: '127.0.0.1',
          port: 5449, // Port where no database is listening
          database: 'rota_shard_1',
          user: 'postgres',
          connectionString: 'postgres://postgres:postgres@127.0.0.1:5449/rota_shard_1',
        },
      ];

      const faultManager = new ShardedPoolManager(faultyConfigs, { connectionTimeoutMillis: 500 });
      const faultCoordinator = new ShardedCoordinator(faultManager);

      try {
        // Find a team for Shard 0 (healthy) and Shard 1 (offline)
        let teamId0: string | null = null;
        let teamId1: string | null = null;
        while (!teamId0 || !teamId1) {
          const candidate = crypto.randomUUID();
          const shard = getShardId(candidate, 2);
          if (shard === 0 && !teamId0) teamId0 = candidate;
          if (shard === 1 && !teamId1) teamId1 = candidate;
        }

        // 1. Team on Shard 0 succeeds without being affected by Shard 1
        const ownerId = crypto.randomUUID();
        const teamA = await faultCoordinator.createTeam({
          teamId: teamId0,
          name: 'Resilient Cafe',
          ownerUserId: ownerId,
          ownerEmail: `owner-${ownerId.slice(0, 8)}@test.example`,
        });
        expect(teamA.shardId).toBe(0);
        expect(teamA.name).toBe('Resilient Cafe');

        // 2. Team on Shard 1 fails cleanly with ShardUnavailableError
        await expect(
          faultCoordinator.createTeam({
            teamId: teamId1,
            name: 'Unavailable Clinic',
            ownerUserId: ownerId,
          })
        ).rejects.toThrow(ShardUnavailableError);

        // 3. Scatter-gather returns partial results from Shard 0 along with error info for Shard 1
        const scatterRes = await faultCoordinator.getUserTeamsScatterGather(ownerId);
        expect(scatterRes.memberships.some((m) => m.teamId === teamId0)).toBe(true);
        expect(scatterRes.partialErrors).toBeDefined();
        expect(scatterRes.partialErrors?.some((e) => e.shardId === 1)).toBe(true);
      } finally {
        await faultManager.closeAll();
      }
    });
  });
});
