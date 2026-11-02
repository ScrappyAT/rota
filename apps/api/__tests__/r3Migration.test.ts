import { Client } from 'pg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
it('adds R3 structures without changing legacy refresh records or financial migrations',async()=>{
  const url=new URL(process.env.DATABASE_URL!);
  if(url.hostname!=='127.0.0.1'||url.port!=='5540'||url.pathname!=='/rota_r1_test')throw new Error('Disposable server required');
  const admin=new Client({connectionString:url.toString()});await admin.connect();
  const name='rota_r3_upgrade_test';let created=false;let client:Client|undefined;
  try{
    await admin.query(`CREATE DATABASE ${name}`);created=true;url.pathname='/'+name;
    client=new Client({connectionString:url.toString()});await client.connect();
    const root=path.resolve(__dirname,'../migrations');
    for(const file of fs.readdirSync(root).filter(f=>f.endsWith('.sql')&&f<'009_').sort())await client.query(fs.readFileSync(path.join(root,file),'utf8'));
    const user=crypto.randomUUID(),token=crypto.randomUUID();
    await client.query("INSERT INTO users(id,email,first_name,last_name,password_hash) VALUES($1,'legacy-r3@test.example','Legacy','User','historical-hash')",[user]);
    await client.query("INSERT INTO refresh_tokens(id,user_id,token_hash,expires_at) VALUES($1,$2,'historical-refresh-hash',NOW()+INTERVAL '7 days')",[token,user]);
    const before=(await client.query('SELECT * FROM refresh_tokens WHERE id=$1',[token])).rows[0];
    await client.query('BEGIN');await client.query(fs.readFileSync(path.join(root,'009_auth_security_routing.sql'),'utf8'));await client.query('COMMIT');
    const after=(await client.query('SELECT * FROM refresh_tokens WHERE id=$1',[token])).rows[0];
    for(const key of Object.keys(before))expect(after[key]).toEqual(before[key]);
    expect(after.session_id).toBeNull();expect(after.token_digest).toBeNull();
    expect((await client.query('SELECT auth_version FROM users WHERE id=$1',[user])).rows[0].auth_version).toBe(0);
    for(const table of ['auth_sessions','auth_action_tokens','user_write_fences'])expect((await client.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
  }finally{
    await client?.end();if(created)await admin.query(`DROP DATABASE ${name}`);await admin.end();
  }
},30000);
