import { primaryReadContext } from '../services/cache';
import { needsPrimary } from '../services/read-routing';
import { fenceWrites } from '../services/read-routing';
import { Request,Response,NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { User } from '@rota/shared';
import { env } from '../env';
import { pool } from '../db';
export interface AuthRequest extends Request { user?:User;sessionId?:string }
export const authenticate=async(req:AuthRequest,res:Response,next:NextFunction)=>{
  try {
    const header=req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new Error('Missing token');
    const claims=jwt.verify(header.slice(7),env.JWT_SECRET,{algorithms:['HS256']}) as User & {av?:number;sid?:string};
    if (!claims.id || !/^[0-9a-f-]{36}$/i.test(claims.id)) throw new Error('Invalid subject');
    const result=await pool.query(`SELECT u.auth_version,s.revoked_at,s.id AS session_id FROM users u
      LEFT JOIN auth_sessions s ON s.id=$2 AND s.user_id=u.id WHERE u.id=$1`,[claims.id,claims.sid??null]);
    const row=result.rows[0];
    if (!row || row.auth_version!==(claims.av??0) || (claims.sid && (!row.session_id||row.revoked_at))) throw new Error('Revoked');
    req.sessionId=claims.sid;
    req.user={id:claims.id,email:claims.email,firstName:claims.firstName,lastName:claims.lastName,createdAt:claims.createdAt};
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) await fenceWrites(claims.id);
    primaryReadContext.run(await needsPrimary(claims.id),()=>next());
  }catch(error){
    if (error instanceof jwt.JsonWebTokenError || error instanceof Error && ['Missing token','Invalid subject','Revoked'].includes(error.message))
      return res.status(401).json({success:false,error:{code:'UNAUTHORIZED',message:'Invalid or expired token'}});
    next(error);
  }
};
