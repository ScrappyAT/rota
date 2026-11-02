import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { env } from '../src/env';
import { openMail,sealMail } from '../src/services/auth-email';
import { processOutboxJob } from '../src/services/job-runtime';
import { drainTestJobs } from './helpers/jobs';
const mockedFetch=jest.fn();
const originalFetch=global.fetch;
interface Session {user:{id:string;email:string};accessToken:string;refreshToken:string}
const register=async():Promise<Session>=>{
  const response=await request(app).post('/auth/register').send({email:`r3-${crypto.randomUUID()}@example.test`,password:'Password123',firstName:'R3',lastName:'Test'});
  expect(response.status).toBe(201);return response.body.data;
};
const me=(s:Session)=>request(app).get('/auth/me').set('Authorization',`Bearer ${s.accessToken}`);
const refresh=(s:Session)=>request(app).post('/auth/refresh').send({userId:s.user.id,refreshToken:s.refreshToken});
const action=async(s:Session,purpose:'RESET'|'MAGIC')=>{
  const path=purpose==='RESET'?'password-reset':'magic-link';
  const response=await request(app).post(`/auth/${path}/request`).send({email:s.user.email});expect(response.status).toBe(200);
  await drainTestJobs(['AUTH_EMAIL']);
  const jobs=(await pool.query("SELECT * FROM job_outbox WHERE kind='AUTH_EMAIL' AND payload->>'stage'='deliver' ORDER BY sequence DESC")).rows;
  const row=jobs.find(j=>openMail(j.payload.sealed).email===s.user.email);
  expect(row).toBeDefined();return {row,token:openMail(row.payload.sealed).token};
};
beforeAll(async()=>{
  if(!env.DATABASE_URL.includes('127.0.0.1:5540/rota_r1_test'))throw new Error('Disposable database required');
  await redisClient.connect();global.fetch=mockedFetch;
});
beforeEach(()=>{mockedFetch.mockReset().mockResolvedValue({ok:true,status:200});});
afterAll(async()=>{global.fetch=originalFetch;await redisClient.quit();await pool.end();});
it('returns the same non-enumerating response and queues encrypted work for unknown accounts',async()=>{
  const s=await register();
  const a=await request(app).post('/auth/password-reset/request').send({email:s.user.email});
  const b=await request(app).post('/auth/password-reset/request').send({email:'unknown-'+crypto.randomUUID()+'@example.test'});
  expect(a.status).toBe(200);expect(b.body).toEqual(a.body);
  const payloads=(await pool.query("SELECT payload FROM job_outbox WHERE kind='AUTH_EMAIL' ORDER BY sequence DESC LIMIT 2")).rows;
  expect(payloads).toHaveLength(2);expect(JSON.stringify(payloads)).not.toContain(s.user.email);
  await drainTestJobs(['AUTH_EMAIL']);expect(mockedFetch).toHaveBeenCalledTimes(1);
});
it('resets once and revokes old access/refresh tokens across devices',async()=>{
  const s=await register();const a=await action(s,'RESET');
  const reset=()=>request(app).post('/auth/password-reset/confirm').send({token:a.token,password:'NewPassword123'});
  expect((await reset()).status).toBe(200);expect((await reset()).status).toBe(400);
  expect((await me(s)).status).toBe(401);expect((await refresh(s)).status).toBe(401);
  expect((await request(app).post('/auth/login').send({email:s.user.email,password:'Password123'})).status).toBe(401);
  expect((await request(app).post('/auth/login').send({email:s.user.email,password:'NewPassword123'})).status).toBe(200);
  const stored=(await pool.query('SELECT token_digest FROM auth_action_tokens WHERE id=$1',[a.row.payload.tokenId??openMail(a.row.payload.sealed).tokenId])).rows[0];
  expect(stored.token_digest).not.toBe(a.token);
});
it.each(['RESET','MAGIC'] as const)('rejects expired %s tokens without consuming a session',async purpose=>{
  const s=await register(),a=await action(s,purpose);
  await pool.query("UPDATE auth_action_tokens SET expires_at=NOW()-INTERVAL '1 second' WHERE id=$1",[openMail(a.row.payload.sealed).tokenId]);
  const response=await request(app).post(purpose==='RESET'?'/auth/password-reset/confirm':'/auth/magic-link/consume').send(purpose==='RESET'?{token:a.token,password:'NewPassword123'}:{token:a.token});
  expect(response.status).toBe(400);expect(response.body.error.code).toBe('INVALID_TOKEN');
});
it('magic links create a secure-store-compatible session and reject concurrent consumption',async()=>{
  const s=await register(),a=await action(s,'MAGIC');
  const responses=await Promise.all([1,2].map(()=>request(app).post('/auth/magic-link/consume').send({token:a.token})));
  expect(responses.map(r=>r.status).sort()).toEqual([200,400]);
  const session=responses.find(r=>r.status===200)!.body.data as Session;
  expect((await me(session)).status).toBe(200);expect((await refresh(session)).status).toBe(200);
});
it('reset tokens cannot be used as magic links and newer links invalidate older ones',async()=>{
  const s=await register(),first=await action(s,'RESET');
  expect((await request(app).post('/auth/magic-link/consume').send({token:first.token})).status).toBe(400);
  const second=await action(s,'RESET');expect(second.token).not.toBe(first.token);
  expect((await request(app).post('/auth/password-reset/confirm').send({token:first.token,password:'NewPassword123'})).status).toBe(400);
});
it('serializes concurrent refresh; reuse invalidation also revokes the winning descendant access token',async()=>{
  const s=await register();const responses=await Promise.all([refresh(s),refresh(s)]);
  expect(responses.map(r=>r.status).sort()).toEqual([200,401]);
  const winning=responses.find(r=>r.status===200)!.body.data as Session;
  expect((await me(winning)).status).toBe(401);expect((await refresh(winning)).status).toBe(401);
  expect((await pool.query('SELECT 1 FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL',[s.user.id])).rows).toHaveLength(0);
});
it('rejects expired refresh and access tokens',async()=>{
  const s=await register();await pool.query("UPDATE refresh_tokens SET expires_at=NOW()-INTERVAL '1 second' WHERE user_id=$1",[s.user.id]);
  expect((await refresh(s)).status).toBe(401);
  const expired={...s,accessToken:jwt.sign({...s.user},env.JWT_SECRET,{expiresIn:-1})};expect((await me(expired)).status).toBe(401);
});
it('logout-all revokes two devices, legacy access JWTs and opaque pre-R3 refresh tokens',async()=>{
  const s=await register();const second=(await request(app).post('/auth/login').send({email:s.user.email,password:'Password123'})).body.data as Session;
  const legacy={...s,accessToken:jwt.sign({...s.user},env.JWT_SECRET,{expiresIn:'15m'}),refreshToken:crypto.randomBytes(40).toString('hex')};
  await pool.query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",[s.user.id,await bcrypt.hash(legacy.refreshToken,10)]);
  expect((await me(legacy)).status).toBe(200);
  expect((await request(app).post('/auth/logout-all').set('Authorization',`Bearer ${s.accessToken}`).send({})).status).toBe(200);
  for(const device of [s,second,legacy]){expect((await me(device)).status).toBe(401);expect((await refresh(device)).status).toBe(401);}
});
it('upgrades a valid legacy refresh token without forcing the user to sign in',async()=>{
  const s=await register(),legacy=crypto.randomBytes(40).toString('hex');
  await pool.query("INSERT INTO refresh_tokens(user_id,token_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '7 days')",[s.user.id,await bcrypt.hash(legacy,10)]);
  const upgraded=await refresh({...s,refreshToken:legacy});expect(upgraded.status).toBe(200);
  expect(jwt.decode(upgraded.body.data.accessToken)).toHaveProperty('sid');expect((await me(upgraded.body.data)).status).toBe(200);
});
it('single-device logout revokes that access token while another device remains active',async()=>{
  const s=await register();const second=(await request(app).post('/auth/login').send({email:s.user.email,password:'Password123'})).body.data as Session;
  expect((await request(app).post('/auth/logout').set('Authorization',`Bearer ${s.accessToken}`).send({refreshToken:s.refreshToken})).status).toBe(200);
  expect((await me(s)).status).toBe(401);expect((await me(second)).status).toBe(200);
});
it('does not revoke a different user through a forged refresh owner or logout body',async()=>{
  const a=await register(),b=await register();
  expect((await request(app).post('/auth/refresh').send({userId:b.user.id,refreshToken:a.refreshToken})).status).toBe(401);
  expect((await request(app).post('/auth/logout-all').set('Authorization',`Bearer ${a.accessToken}`).send({userId:b.user.id})).status).toBe(400);
  expect((await me(b)).status).toBe(200);
});
it('email jobs retain one token and use stable provider idempotency across retry/replay',async()=>{
  const s=await register();mockedFetch.mockResolvedValueOnce({ok:false,status:503}).mockResolvedValue({ok:true,status:200});
  const a=await action(s,'MAGIC');expect(a.row.status).toBe('QUEUED');
  await processOutboxJob(pool,a.row.id);await processOutboxJob(pool,a.row.id);
  expect(mockedFetch).toHaveBeenCalledTimes(2);
  const first=mockedFetch.mock.calls[0][1],second=mockedFetch.mock.calls[1][1];
  expect(first.headers['Idempotency-Key']).toBe(second.headers['Idempotency-Key']);expect(first.body).toBe(second.body);
  expect((await pool.query('SELECT 1 FROM auth_action_tokens WHERE user_id=$1',[s.user.id])).rows).toHaveLength(1);
});
it('rejects tampered encrypted mail payloads',()=>{const sealed=sealMail({email:'private@example.test'});const bytes=Buffer.from(sealed,'base64');bytes[30]^=1;expect(()=>openMail(bytes.toString('base64'))).toThrow();});
it('strictly rejects malformed auth bodies and oversized collections before writes',async()=>{
  for(const [path,body] of [['/auth/register',{email:'bad',password:'123',firstName:'X',lastName:'Y'}],['/auth/refresh',{userId:'not-uuid',refreshToken:3}],['/auth/password-reset/request',{email:'bad'}],['/auth/password-reset/confirm',{token:'x',password:'short'}],['/auth/magic-link/consume',{token:'f'.repeat(64),userId:crypto.randomUUID()}],['/auth/login',{email:'ok@example.test',password:'x',extra:true}],['/auth/register',{items:Array(101).fill(0)}]] as const){const r=await request(app).post(path).send(body);expect(r.status).toBe(400);expect(r.body.error.code).toBe('VALIDATION_ERROR');}
});

it('concurrent password resets consume one token and leave no active old sessions',async()=>{
 const s=await register(),a=await action(s,'RESET');
 const responses=await Promise.all([1,2].map(()=>request(app).post('/auth/password-reset/confirm').send({token:a.token,password:'NewPassword123'})));
 expect(responses.map(r=>r.status).sort()).toEqual([200,400]);expect((await me(s)).status).toBe(401);
});
it('logout-all fences a simultaneous refresh without leaving an active descendant',async()=>{
 const s=await register();
 const [logout,rotation]=await Promise.all([request(app).post('/auth/logout-all').set('Authorization',`Bearer ${s.accessToken}`).send({}),refresh(s)]);
 expect(logout.status).toBe(200);expect([200,401]).toContain(rotation.status);
 if(rotation.status===200)expect((await me(rotation.body.data)).status).toBe(401);
 expect((await pool.query('SELECT 1 FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL',[s.user.id])).rows).toHaveLength(0);
});
it('login and reset request quotas are enforced through the actual API',async()=>{
 const s=await register();for(let n=0;n<5;n++)expect((await request(app).post('/auth/password-reset/request').send({email:s.user.email})).status).toBe(200);
 expect((await request(app).post('/auth/password-reset/request').send({email:s.user.email})).status).toBe(429);
 for(let n=0;n<30;n++)expect((await request(app).post('/auth/login').send({email:s.user.email,password:'wrong'})).status).toBe(401);
 expect((await request(app).post('/auth/login').send({email:s.user.email,password:'wrong'})).status).toBe(429);
},20000);
