import { Router,Request,Response,NextFunction } from 'express';
import bcrypt from 'bcrypt';
import { RegisterSchema,LoginSchema,RefreshSchema,LogoutSchema,EmailActionSchema,ResetPasswordSchema,MagicConsumeSchema } from '@rota/shared';
import { authenticate,AuthRequest } from '../middleware/auth';
import { HttpError } from '../http-error';
import { transaction,userColumns,AuthUser,issueSession,lockUser,findRefresh,revokeAll } from '../services/sessions';
import { requestAuthEmail,consumeAction } from '../services/auth-email';
import { sensitiveLimit } from '../middleware/rate-limit-redis';
import { z } from 'zod';
import { env } from '../env';
const router=Router();
router.use(sensitiveLimit('auth-principal',env.AUTH_RATE_LIMIT_MAX));
const invalid=()=>new HttpError(401,'UNAUTHORIZED','Invalid or expired credentials');
router.post('/register',async(req:Request,res:Response,next:NextFunction)=>{try {
  const data=RegisterSchema.parse(req.body);
  const hash=await bcrypt.hash(data.password,10);
  const result=await transaction(async client=>{
    const u=await client.query<AuthUser>(`INSERT INTO users(email,first_name,last_name,password_hash) VALUES($1,$2,$3,$4) RETURNING ${userColumns}`,[data.email,data.firstName,data.lastName,hash]);
    return issueSession(client,u.rows[0]);
  });res.status(201).json({success:true,data:result});
} catch(error) {if ((error as {code?:string}).code==='23505') return next(new HttpError(400,'DUPLICATE_ACCOUNT','Email already exists'));next(error);} });
const dummyHash=bcrypt.hashSync('not-a-user-password',10);
router.post('/login',sensitiveLimit('login',30),async(req:Request,res:Response,next:NextFunction)=>{try {
  const data=LoginSchema.parse(req.body);
  const result=await transaction(async client=>{
    const u=(await client.query<AuthUser>(`SELECT ${userColumns} FROM users WHERE email=$1 FOR UPDATE`,[data.email])).rows[0];
    const matches=await bcrypt.compare(data.password,u?.password_hash||dummyHash);
    if (!u||!matches) throw new HttpError(401,'INVALID_CREDENTIALS','Invalid email or password');
    return issueSession(client,u);
  });res.json({success:true,data:result});
}catch(error){next(error);} });
router.post('/refresh',async(req:Request,res:Response,next:NextFunction)=>{try {
  const data=RefreshSchema.parse(req.body);
  const result=await transaction(async client=>{
    const user=await lockUser(client,data.userId);
    if (!user) return null;
    const old=await findRefresh(client,user.id,data.refreshToken);
    if (!old) return null;
    // Revocation commits before a replay returns 401.
    if (old.revoked_at) {await revokeAll(client,user.id);return null;}
    if (new Date(old.expires_at)<=new Date()) return null;
    if (old.session_id) {
      const session=await client.query('SELECT revoked_at FROM auth_sessions WHERE id=$1',[old.session_id]);
      if (!session.rows[0]||session.rows[0].revoked_at) return null;
    }
    await client.query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1',[old.id]);
    return issueSession(client,user,old.session_id??undefined);
  });if (!result) throw invalid();res.json({success:true,data:result});
}catch(error){next(error);} });
router.post('/logout',authenticate,async(req:AuthRequest,res:Response,next:NextFunction)=>{try {
  const data=LogoutSchema.parse(req.body);
  await transaction(async client=>{
    await lockUser(client,req.user!.id);
    const token=data.refreshToken?await findRefresh(client,req.user!.id,data.refreshToken):undefined;
    const sessionId=token?.session_id??req.sessionId;
    if (sessionId) {
      await client.query('UPDATE auth_sessions SET revoked_at=NOW() WHERE id=$1',[sessionId]);
      await client.query('UPDATE refresh_tokens SET revoked_at=COALESCE(revoked_at,NOW()) WHERE session_id=$1',[sessionId]);
    } else if (token) await client.query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1',[token.id]);
  });res.json({success:true});
}catch(error){next(error);} });
router.post('/logout-all',authenticate,sensitiveLimit('logout-all',30),async(req:AuthRequest,res:Response,next:NextFunction)=>{try {
  z.object({}).strict().parse(req.body??{});
  await transaction(async client=>{await lockUser(client,req.user!.id);await revokeAll(client,req.user!.id);});
  res.json({success:true});
}catch(error){next(error);} });
for (const [path,purpose] of [['/password-reset/request','RESET'],['/magic-link/request','MAGIC']] as const) {
  router.post(path,sensitiveLimit('auth-email',5),async(req:Request,res:Response,next:NextFunction)=>{try {
    const {email}=EmailActionSchema.parse(req.body);
    await requestAuthEmail(email,purpose);
    res.json({success:true,data:{message:'If the account is eligible, an email will arrive shortly.'}});
  }catch(error){next(error);} });
}
router.post('/password-reset/confirm',sensitiveLimit('reset-confirm',10),async(req:Request,res:Response,next:NextFunction)=>{try {
  const data=ResetPasswordSchema.parse(req.body);
  const hash=await bcrypt.hash(data.password,10);
  await consumeAction(data.token,'RESET',hash);res.json({success:true});
}catch(error){next(error);} });
router.post('/magic-link/consume',sensitiveLimit('magic-consume',10),async(req:Request,res:Response,next:NextFunction)=>{try {
  const {token}=MagicConsumeSchema.parse(req.body);
  const data=await consumeAction(token,'MAGIC');res.json({success:true,data});
}catch(error){next(error);} });
router.get('/me',authenticate,(req:AuthRequest,res)=>{res.json({success:true,data:req.user});});
export default router;
