import { Pool,QueryResultRow } from 'pg';
import { pool } from '../db';
import { env } from '../env';
export const replicaPool=env.READ_DATABASE_URL?new Pool({connectionString:env.READ_DATABASE_URL,
  max:env.DB_POOL_MAX,connectionTimeoutMillis:1000,statement_timeout:3000}):null;
replicaPool?.on('error',()=>console.warn('[replica] idle connection failed; reads fall back to primary'));
export const needsPrimary=async(userId:string):Promise<boolean>=>Boolean((await pool.query(
  'SELECT 1 FROM user_write_fences WHERE user_id=$1 AND primary_until>NOW()',[userId])).rows.length);
/** A pre-write durable fence covers concurrent requests and every device/API instance.
 * Conservative five-minute lease also covers requests interrupted after commit. */
export const fenceWrites=async(userId:string):Promise<void>=>{
  await pool.query(`INSERT INTO user_write_fences(user_id,primary_until) VALUES($1,NOW()+INTERVAL '5 minutes')
    ON CONFLICT(user_id) DO UPDATE SET primary_until=GREATEST(user_write_fences.primary_until,EXCLUDED.primary_until)`,[userId]);
};
/** Exported separately so failure/lag drills can use two real disposable databases. */
export const routedRead=async<T extends QueryResultRow=QueryResultRow>(primary:Pool,replica:Pool|null,primaryOnly:boolean,sql:string,values:unknown[]=[])=>{
  if (!/^\s*SELECT\b/i.test(sql)||sql.includes(';')) throw new Error('Only single SELECT statements can use read routing');
  if (!replica||primaryOnly) return primary.query<T>(sql,values);
  let client;let broken=false;
  try {
    client=await replica.connect();
    await client.query('BEGIN READ ONLY');
    const result=await client.query<T>(sql,values);
    await client.query('COMMIT');
    return result;
  }catch{
    if (client) {try {await client.query('ROLLBACK');} catch { broken=true; }}
    console.warn('[replica] read failed; using primary');
    return primary.query<T>(sql,values);
  }finally{client?.release(broken);}
};
export const readQuery=async<T extends QueryResultRow=QueryResultRow>(userId:string,sql:string,values:unknown[]=[])=>
  routedRead<T>(pool,replicaPool,replicaPool?await needsPrimary(userId):true,sql,values);
