import crypto from 'crypto';
import { ShardedPoolManager, migrateAllShards, ShardedCoordinator, getShardId } from '../src/sharding';

async function main() {
  console.log('\n===============================================================');
  console.log('    ROTA — TWO-POSTGRESQL-DATABASE SHARDING DEMONSTRATION');
  console.log('===============================================================\n');

  const poolManager = new ShardedPoolManager();

  try {
    // 1. Health Checks
    console.log('[1/6] Probing Shard Health...');
    const health = await poolManager.checkAllHealth();
    for (const [shardId, res] of Object.entries(health)) {
      if (!res.healthy) {
        console.error(`❌ Shard ${shardId} is UNHEALTHY! Error: ${res.error}`);
        console.error('Please ensure the sharding containers are started:');
        console.error('  docker compose -f infrastructure/docker-compose.sharding.yml up -d');
        process.exit(1);
      }
      console.log(`  ✓ Shard ${shardId} connected (${res.latencyMs}ms)`);
    }

    // 2. Migration Pipeline
    console.log('\n[2/6] Running SQL Schema Migrations on Both Shards...');
    const migrationResults = await migrateAllShards(poolManager);
    for (const res of migrationResults) {
      console.log(`  ✓ ${res.shardName} (Port ${res.shardId === 0 ? 5441 : 5442}): ${res.applied.length} new migrations applied, ${res.alreadyRun.length} previously applied.`);
    }

    const coordinator = new ShardedCoordinator(poolManager);

    // 3. Finding deterministic team UUIDs for Shard 0 and Shard 1
    console.log('\n[3/6] Generating Deterministic Team Shard Keys...');
    let teamId0: string | null = null;
    let teamId1: string | null = null;

    while (!teamId0 || !teamId1) {
      const candidate = crypto.randomUUID();
      const shard = getShardId(candidate);
      if (shard === 0 && !teamId0) teamId0 = candidate;
      if (shard === 1 && !teamId1) teamId1 = candidate;
    }

    console.log(`  • Team Alpha ID (routes to Shard 0): ${teamId0}`);
    console.log(`  • Team Beta ID  (routes to Shard 1): ${teamId1}`);

    const aliceUserId = crypto.randomUUID();
    console.log(`  • Multi-team Worker (Alice) ID:      ${aliceUserId}`);

    const aliceEmail = `alice-${aliceUserId.slice(0, 8)}@rota.example`;

    // 4. Intra-Team Writes Routed to Independent Shards
    console.log('\n[4/6] Creating Teams & Shifts via Deterministic Shard Routing...');
    const teamAlpha = await coordinator.createTeam({
      teamId: teamId0,
      name: 'Alpha Cafe (Shard 0)',
      ownerUserId: aliceUserId,
      ownerEmail: aliceEmail,
    });
    console.log(`  ✓ Created "${teamAlpha.name}" -> Saved to ${teamAlpha.shardId === 0 ? 'PostgreSQL Shard 0 (:5441)' : 'Shard 1'}`);

    const teamBeta = await coordinator.createTeam({
      teamId: teamId1,
      name: 'Beta Health (Shard 1)',
      ownerUserId: aliceUserId,
      ownerEmail: aliceEmail,
    });
    console.log(`  ✓ Created "${teamBeta.name}" -> Saved to ${teamBeta.shardId === 1 ? 'PostgreSQL Shard 1 (:5442)' : 'Shard 0'}`);

    // Create shifts for each team
    const now = new Date();
    const shiftA = await coordinator.createShift({
      teamId: teamId0,
      title: 'Morning Barista Shift',
      startsAt: new Date(now.getTime() + 3600000),
      endsAt: new Date(now.getTime() + 28800000),
    });
    console.log(`  ✓ Shift "${shiftA.title}" for Team Alpha written to Shard ${shiftA.shardId}`);

    const shiftB = await coordinator.createShift({
      teamId: teamId1,
      title: 'Emergency Triage Shift',
      startsAt: new Date(now.getTime() + 7200000),
      endsAt: new Date(now.getTime() + 32400000),
    });
    console.log(`  ✓ Shift "${shiftB.title}" for Team Beta written to Shard ${shiftB.shardId}`);

    // 5. Verifying Strict Physical Tenant Isolation
    console.log('\n[5/6] Verifying Physical Tenant Isolation Across Shards...');
    const isolationA = await coordinator.verifyIsolation(teamId0);
    console.log(`  • Team Alpha (${teamId0}):`);
    console.log(`    - Shard 0 row count: ${isolationA.targetShardCount} (Expected: 1)`);
    console.log(`    - Shard 1 row count: ${isolationA.otherShardCount} (Expected: 0)`);
    console.log(`    - Isolated: ${isolationA.isIsolated ? '✅ YES' : '❌ NO'}`);

    const isolationB = await coordinator.verifyIsolation(teamId1);
    console.log(`  • Team Beta  (${teamId1}):`);
    console.log(`    - Shard 1 row count: ${isolationB.targetShardCount} (Expected: 1)`);
    console.log(`    - Shard 0 row count: ${isolationB.otherShardCount} (Expected: 0)`);
    console.log(`    - Isolated: ${isolationB.isIsolated ? '✅ YES' : '❌ NO'}`);

    // 6. Cross-Shard Scatter-Gather Query
    console.log('\n[6/6] Executing Cross-Shard Scatter-Gather Query for Alice...');
    const scatterGather = await coordinator.getUserTeamsScatterGather(aliceUserId);
    console.log(`  • Shards queried concurrently: ${scatterGather.shardsQueried}`);
    console.log(`  • Consolidated memberships retrieved: ${scatterGather.memberships.length}`);
    for (const m of scatterGather.memberships) {
      console.log(`    - [Shard ${m.shardId}] ${m.teamName} (Role: ${m.role})`);
    }

    console.log('\n===============================================================');
    console.log('  ✅ TWO-POSTGRESQL SHARDING SIMULATION COMPLETED SUCCESSFULLY');
    console.log('===============================================================\n');
  } finally {
    await poolManager.closeAll();
  }
}

main().catch((err) => {
  console.error('\n❌ Demonstration failed with error:', err);
  process.exit(1);
});
