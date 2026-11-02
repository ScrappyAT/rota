import crypto from 'crypto';
import { Pool } from 'pg';
import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { needsPrimary,fenceWrites,routedRead } from '../src/services/read-routing';
import { primaryReadContext,getCache,setCache } from '../src/services/cache';
const replica=new Pool({connectionString:'postgres://postgres:r3-disposable-only@127.0.0.1:5543/rota_r1_test',max:2});
let userId:string;
beforeAll(async()=>{
  if(!process.env.DATABASE_URL?.includes('127.0.0.1:5540/rota_r1_test'))throw new Error('Disposable server required');
  await redisClient.connect();
  const r=await request(app).post('/auth/register').send({email:`routing-${crypto.randomUUID()}@example.test`,password:'Password123',firstName:'Read',lastName:'Route'});userId=r.body.data.user.id;
  for(const db of [pool,replica]) await db.query('CREATE TABLE IF NOT EXISTS r3_routing_probe(id INTEGER PRIMARY KEY,value TEXT NOT NULL)');
  await pool.query("INSERT INTO r3_routing_probe VALUES(1,'primary-new') ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value");
  await replica.query("INSERT INTO r3_routing_probe VALUES(1,'replica-old') ON CONFLICT(id) DO UPDATE SET value=EXCLUDED.value");
});
afterAll(async()=>{await replica.end();await redisClient.quit();await pool.end();});
it('routes eligible reads to the separate read database',async()=>{
  const result=await routedRead(pool,replica,false,'SELECT value FROM r3_routing_probe WHERE id=$1',[1]);
  expect(result.rows[0].value).toBe('replica-old');
});
it('durable user fencing prevents replica lag after a write across API instances/devices',async()=>{
  expect(await needsPrimary(userId)).toBe(false);await fenceWrites(userId);expect(await needsPrimary(userId)).toBe(true);
  const result=await routedRead(pool,replica,await needsPrimary(userId),'SELECT value FROM r3_routing_probe WHERE id=$1',[1]);
  expect(result.rows[0].value).toBe('primary-new');
  await pool.query("UPDATE user_write_fences SET primary_until=NOW()-INTERVAL '1 second' WHERE user_id=$1",[userId]);
  expect(await needsPrimary(userId)).toBe(false);
});
it('falls back to primary after a replica query/schema failure',async()=>{
  await pool.query('CREATE TABLE IF NOT EXISTS r3_primary_only_probe(value INTEGER)');
  expect((await routedRead(pool,replica,false,'SELECT COUNT(*)::int AS count FROM r3_primary_only_probe')).rows[0].count).toBe(0);
});
it('falls back when the read pool is unavailable without promoting it for writes',async()=>{
  const unavailable=new Pool({connectionString:process.env.DATABASE_URL});await unavailable.end();
  const result=await routedRead(pool,unavailable,false,'SELECT value FROM r3_routing_probe WHERE id=$1',[1]);
  expect(result.rows[0].value).toBe('primary-new');
  await expect(routedRead(pool,replica,false,"UPDATE r3_routing_probe SET value='bad'")).rejects.toThrow('single SELECT');
});
it('enforces READ ONLY on the secondary connection',async()=>{
  await replica.query("CREATE OR REPLACE FUNCTION r3_attempt_write() RETURNS integer LANGUAGE SQL AS $$ INSERT INTO r3_routing_probe VALUES(2,'bad') RETURNING id $$");
  await expect(routedRead(pool,replica,false,'SELECT r3_attempt_write()')).rejects.toThrow();
  expect((await replica.query('SELECT 1 FROM r3_routing_probe WHERE id=2')).rows).toHaveLength(0);
});
it('bypasses stale Redis reads during a primary lease while caching authoritative results',async()=>{
  const key='cache:r3:'+userId;await setCache(key,{value:'old'},30);
  await primaryReadContext.run(true,async()=>{
    expect(await getCache(key)).toBeNull();await setCache(key,{value:'new'},30);
  });expect(await getCache(key)).toEqual({value:'new'});await redisClient.del(key);
});
