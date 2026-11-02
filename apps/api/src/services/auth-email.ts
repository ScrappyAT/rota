import crypto from 'crypto';
import { PoolClient } from 'pg';
import { UnrecoverableError } from 'bullmq';
import { env } from '../env';
import { HttpError } from '../http-error';
import { enqueueOutbox,OutboxRow } from './outbox';
import { transaction,digest,lockUser,revokeAll,issueSession } from './sessions';
type Purpose='RESET'|'MAGIC';
const mailKey=():Buffer=>{
  if (!env.AUTH_MAIL_KEY) throw new HttpError(503,'EMAIL_UNAVAILABLE','Authentication email is not configured');
  return Buffer.from(env.AUTH_MAIL_KEY,'hex');
};
export const sealMail=(data:unknown):string=>{
  const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',mailKey(),iv);
  const body=Buffer.concat([cipher.update(JSON.stringify(data),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),body]).toString('base64');
};
export const openMail=(value:string):Record<string,string>=>{
  const bytes=Buffer.from(value,'base64');
  const decipher=crypto.createDecipheriv('aes-256-gcm',mailKey(),bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString('utf8'));
};
export const requestAuthEmail=async(email:string,purpose:Purpose):Promise<void>=>{
  const sealed=sealMail({email,purpose});
  // Identical persistence/response path for existing and unknown accounts.
  await transaction(client=>enqueueOutbox(client,{key:`auth-request:${crypto.randomUUID()}`,kind:'AUTH_EMAIL',payload:{stage:'request',sealed}}));
};
export const handleAuthEmail=async(client:PoolClient,job:OutboxRow):Promise<unknown>=>{
  const data=openMail(String(job.payload.sealed));
  if (job.payload.stage==='request') {
    await client.query('BEGIN');
    try {
      const found=await client.query('SELECT id FROM users WHERE email=$1',[data.email]);
      if (found.rows[0]) {
        const user=await lockUser(client,found.rows[0].id);
        const token=crypto.randomBytes(32).toString('hex');
        const inserted=await client.query(`INSERT INTO auth_action_tokens(id,user_id,purpose,token_digest,expires_at)
          VALUES($1,$2,$3,$4,NOW()+INTERVAL '15 minutes') ON CONFLICT(id) DO NOTHING RETURNING id`,[job.id,user!.id,data.purpose,digest(token)]);
        if (inserted.rows[0]) {
          await client.query('UPDATE auth_action_tokens SET consumed_at=NOW() WHERE user_id=$1 AND purpose=$2 AND id<>$3 AND consumed_at IS NULL',[user!.id,data.purpose,job.id]);
          await enqueueOutbox(client,{key:`auth-deliver:${job.id}`,kind:'AUTH_EMAIL',payload:{stage:'deliver',sealed:sealMail({...data,token,tokenId:job.id})}});
        }
      }
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}
    return null;
  }
  const active=await client.query('SELECT 1 FROM auth_action_tokens WHERE id=$1 AND consumed_at IS NULL AND expires_at>NOW()',[data.tokenId]);
  if (!active.rows.length) return {skipped:'expired-or-used'};
  if (!env.MAIL_API_KEY || !env.MAIL_FROM) throw new Error('Authentication email provider unavailable');
  const url=new URL(env.AUTH_LINK_BASE);url.searchParams.set('purpose',data.purpose);url.searchParams.set('token',data.token);
  const response=await fetch(env.MAIL_API_URL,{method:'POST',signal:AbortSignal.timeout(15000),headers:{
    Authorization:`Bearer ${env.MAIL_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':job.id,
  },body:JSON.stringify({from:env.MAIL_FROM,to:[data.email],subject:data.purpose==='RESET'?'Reset your Rota password':'Sign in to Rota',
    text:`Open this link in Rota within 15 minutes. Ignore it if you did not request it.\n${url.toString()}`})});
  if (!response.ok) {
    if (response.status>=400&&response.status<500&&response.status!==429) throw new UnrecoverableError(`Email provider rejected request (${response.status})`);
    throw new Error(`Email provider unavailable (${response.status})`);
  }
  return {accepted:true};
};
export const consumeAction=async(token:string,purpose:Purpose,passwordHash?:string)=>transaction(async client=>{
  const lookup=await client.query('SELECT user_id FROM auth_action_tokens WHERE token_digest=$1',[digest(token)]);
  if (!lookup.rows[0]) throw new HttpError(400,'INVALID_TOKEN','Invalid or expired link');
  const user=await lockUser(client,lookup.rows[0].user_id);
  const consumed=await client.query(`UPDATE auth_action_tokens SET consumed_at=NOW() WHERE token_digest=$1
    AND purpose=$2 AND consumed_at IS NULL AND expires_at>NOW() RETURNING id`,[digest(token),purpose]);
  if (!consumed.rows.length||!user) throw new HttpError(400,'INVALID_TOKEN','Invalid or expired link');
  if (purpose==='RESET') {
    await client.query('UPDATE users SET password_hash=$2 WHERE id=$1',[user.id,passwordHash]);
    await revokeAll(client,user.id);
    // A pre-reset magic link must not resurrect a revoked session.
    await client.query('UPDATE auth_action_tokens SET consumed_at=COALESCE(consumed_at,NOW()) WHERE user_id=$1',[user.id]);
    return undefined;
  }
  return issueSession(client,user);
});
