import request from 'supertest';
import crypto from 'crypto';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
interface Actor {id:string;token:string}
let owner:Actor,manager:Actor,staff:Actor,offered:Actor,outsider:Actor,team:string;
const register=async():Promise<Actor>=>{const r=await request(app).post('/auth/register').send({email:`policy-${crypto.randomUUID()}@example.test`,firstName:'R3',lastName:'Policy',password:'Password123'});expect(r.status).toBe(201);return{id:r.body.data.user.id,token:r.body.data.accessToken};};
const post=(actor:Actor,path:string,body:object={})=>request(app).post(path).set('Authorization',`Bearer ${actor.token}`).send(body);
const shift=async()=>{const r=await post(owner,`/teams/${team}/shifts`,{title:'R3 test',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString(),assigneeIds:[staff.id]});expect(r.status).toBe(201);return r.body.data.id as string;};
beforeAll(async()=>{
  if(!process.env.DATABASE_URL?.includes('127.0.0.1:5540/rota_r1_test'))throw new Error('Disposable server required');
  await redisClient.connect();[owner,manager,staff,offered,outsider]=await Promise.all([1,2,3,4,5].map(register));
  const r=await post(owner,'/teams',{name:'R3 Policies'});expect(r.status).toBe(201);team=r.body.data.id;
  for(const [actor,role] of [[manager,'MANAGER'],[staff,'STAFF'],[offered,'STAFF']] as const)await pool.query('INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,$3)',[team,actor.id,role]);
});
afterAll(async()=>{await redisClient.quit();await pool.end();});
it('denies requester, proposed replacement and cross-tenant approval; manager approval transfers once',async()=>{
  const id=await shift();const created=await post(staff,`/teams/${team}/shifts/${id}/swaps`,{offeredTo:offered.id});expect(created.status).toBe(201);const path=`/teams/${team}/swaps/${created.body.data.id}/approve`;
  for(const actor of [staff,offered])expect((await post(actor,path)).status).toBe(403);
  expect((await post(outsider,path)).status).toBe(404);
  const responses=await Promise.all([post(manager,path),post(owner,path)]);expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
  const assignments=(await pool.query('SELECT user_id FROM shift_assignments WHERE shift_id=$1',[id])).rows;
  expect(assignments.map(r=>r.user_id)).toEqual([offered.id]);
});
it('strictly rejects team/invite/role/shift/query payloads and staff shift deletion',async()=>{
  const id=await shift();
  for(const [path,body] of [['/teams',{name:4}],[`/invitations/team/${team}`,{email:'not-email',role:'STAFF'}],[`/teams/${team}/shifts`,{title:'Bad',extra:true}]] as const){const r=await post(owner,path,body);expect(r.status).toBe(400);expect(r.body.error.code).toBe('VALIDATION_ERROR');}
  const badCursor=Buffer.from(JSON.stringify({t:new Date().toISOString(),i:'not-a-uuid'})).toString('base64url');
  const cursorResponse=await request(app).get(`/teams/${team}/activity?cursor=${badCursor}`).set('Authorization',`Bearer ${owner.token}`);
  expect(cursorResponse.status).toBe(400);expect(cursorResponse.body.error.code).toBe('INVALID_CURSOR');
  const role=await request(app).patch(`/teams/${team}/members/${staff.id}/role`).set('Authorization',`Bearer ${owner.token}`).send({role:'STAFF',admin:true});expect(role.status).toBe(400);
  expect((await request(app).delete(`/teams/${team}/shifts/${id}`).set('Authorization',`Bearer ${staff.token}`)).status).toBe(403);
  expect((await request(app).get(`/teams/${team}/shifts?limit[x]=1`).set('Authorization',`Bearer ${owner.token}`)).status).toBe(400);
});
it('uses primary membership authorization even with an existing roster cache',async()=>{
  await request(app).get(`/teams/${team}/members`).set('Authorization',`Bearer ${offered.token}`);
  await pool.query('DELETE FROM team_memberships WHERE team_id=$1 AND user_id=$2',[team,offered.id]);
  expect((await request(app).get(`/teams/${team}/members`).set('Authorization',`Bearer ${offered.token}`)).status).toBe(404);
});
it('permits scheduling/invitations during grace, then restricts writes while preserving reads',async()=>{
  await pool.query(`UPDATE team_subscriptions SET plan_code='TEAM_USD_V1',seats=15,status='PAST_DUE',
    period_started_at=NOW()-INTERVAL '31 days',period_ends_at=NOW()-INTERVAL '1 day',
    last_renewal_failed_at=NOW()-INTERVAL '1 day',grace_ends_at=NOW()+INTERVAL '1 day' WHERE team_id=$1`,[team]);
  await shift();expect((await post(owner,`/invitations/team/${team}`,{email:'grace-'+crypto.randomUUID()+'@example.test',role:'STAFF'})).status).toBe(201);
  await pool.query("UPDATE team_subscriptions SET grace_ends_at=NOW()-INTERVAL '1 second' WHERE team_id=$1",[team]);
  const r=await post(owner,`/teams/${team}/shifts`,{title:'Restricted',startsAt:new Date(Date.now()+86400000).toISOString(),endsAt:new Date(Date.now()+90000000).toISOString()});
  expect(r.status).toBe(403);expect(r.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  expect((await request(app).get(`/teams/${team}/shifts`).set('Authorization',`Bearer ${staff.token}`)).status).toBe(200);
});
it('limits real invitation and payment routes before any financial/provider work',async()=>{
  const before=(await pool.query('SELECT COUNT(*)::int AS count FROM financial_ledger')).rows[0].count;
  for(let n=0;n<30;n++)expect((await post(owner,`/teams/${team}/subscription/checkout`,{seats:-1})).status).toBe(400);
  expect((await post(owner,`/teams/${team}/subscription/checkout`,{seats:-1})).status).toBe(429);
  for(let n=0;n<100;n++)expect((await post(owner,`/invitations/team/${team}`,{email:'invalid',role:'STAFF'})).status).toBe(400);
  expect((await post(owner,`/invitations/team/${team}`,{email:'invalid',role:'STAFF'})).status).toBe(429);
  expect((await pool.query('SELECT COUNT(*)::int AS count FROM financial_ledger')).rows[0].count).toBe(before);
},20000);
