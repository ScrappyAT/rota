import request from 'supertest';
import express from 'express';
import { redisClient } from '../src/redis';
import { sensitiveLimit } from '../src/middleware/rate-limit-redis';
import { AuthRequest } from '../src/middleware/auth';
const makeApp=()=>{const app=express();app.set('trust proxy',true);app.use(express.json());app.use((req:AuthRequest,_res,next)=>{req.user={id:String(req.headers['x-test-user']||'one')} as NonNullable<AuthRequest['user']>;next();});app.post('/x',sensitiveLimit('integration-test',2),(_req,res)=>res.json({success:true}));return app;};
beforeAll(async()=>{await redisClient.connect();});
afterAll(async()=>{await redisClient.quit();});
it('shares atomic per-IP limits across application instances and retains TTL',async()=>{
  const a=makeApp(),b=makeApp();
  expect((await request(a).post('/x').send({})).status).toBe(200);
  expect((await request(b).post('/x').set('x-test-user','two').send({})).status).toBe(200);
  const blocked=await request(a).post('/x').set('x-test-user','three').send({});
  expect(blocked.status).toBe(429);expect(blocked.headers['retry-after']).toBe('900');
  const keys=await redisClient.keys('rl:integration-test:ip:*');expect(keys).toHaveLength(1);
  expect(await redisClient.ttl(keys[0])).toBeGreaterThan(0);
});
it('fails closed for sensitive requests during Redis outage',async()=>{
  await redisClient.disconnect();
  expect((await request(makeApp()).post('/x').send({})).status).toBe(503);
  await redisClient.connect();
});

it('enforces a user quota even when IP addresses change',async()=>{
 const app=makeApp();
 for(const ip of ['192.0.2.1','192.0.2.2'])expect((await request(app).post('/x').set('X-Forwarded-For',ip).send({})).status).toBe(200);
 expect((await request(app).post('/x').set('X-Forwarded-For','192.0.2.3').send({})).status).toBe(429);
});
it('rejects excess concurrent requests atomically',async()=>{
 const responses=await Promise.all(Array.from({length:8},()=>request(makeApp()).post('/x').send({})));
 expect(responses.filter(r=>r.status===200)).toHaveLength(2);expect(responses.filter(r=>r.status===429)).toHaveLength(6);
});
