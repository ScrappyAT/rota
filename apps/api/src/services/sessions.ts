import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { PoolClient } from 'pg';
import { User } from '@rota/shared';
import { pool } from '../db';
import { env } from '../env';
export const digest = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
export const userColumns = 'id,email,first_name AS "firstName",last_name AS "lastName",created_at AS "createdAt",auth_version,password_hash';
export interface AuthUser extends User { auth_version: number; password_hash: string }
export const publicUser = (u: User): User => ({id:u.id,email:u.email,firstName:u.firstName,lastName:u.lastName,createdAt:u.createdAt});
export const transaction = async <T>(fn: (client: PoolClient)=>Promise<T>): Promise<T> => {
  const client=await pool.connect();
  try { await client.query('BEGIN'); const result=await fn(client); await client.query('COMMIT'); return result; }
  catch(error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};
// Credential mutations lock the user first, then token/session rows.
export const lockUser = async (client: PoolClient,id: string): Promise<AuthUser|undefined> =>
  (await client.query<AuthUser>(`SELECT ${userColumns} FROM users WHERE id=$1 FOR UPDATE`,[id])).rows[0];
export const revokeAll = async (client: PoolClient,id: string): Promise<void> => {
  await client.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1',[id]);
  await client.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1',[id]);
  await client.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1',[id]);
};
export const issueSession = async (client: PoolClient,user: AuthUser,existingSession?: string) => {
  const sessionId=existingSession??crypto.randomUUID();
  if (!existingSession) await client.query('INSERT INTO auth_sessions(id,user_id) VALUES($1,$2)',[sessionId,user.id]);
  const refreshToken=crypto.randomBytes(32).toString('hex');
  await client.query("INSERT INTO refresh_tokens(user_id,token_hash,token_digest,session_id,expires_at) VALUES($1,$2,$3,$4,NOW()+INTERVAL '7 days')",
    [user.id,await bcrypt.hash(refreshToken,10),digest(refreshToken),sessionId]);
  const safe=publicUser(user);
  return {user:safe,refreshToken,accessToken:jwt.sign({...safe,av:user.auth_version,sid:sessionId},env.JWT_SECRET,{algorithm:'HS256',expiresIn:'15m'})};
};
export const findRefresh = async (client: PoolClient,userId: string,token: string) => {
  const current=await client.query('SELECT * FROM refresh_tokens WHERE user_id=$1 AND token_digest=$2',[userId,digest(token)]);
  if (current.rows[0]) return current.rows[0];
  const legacy=await client.query('SELECT * FROM refresh_tokens WHERE user_id=$1 AND token_digest IS NULL',[userId]);
  for (const row of legacy.rows) if (await bcrypt.compare(token,row.token_hash)) return row;
  return undefined;
};
