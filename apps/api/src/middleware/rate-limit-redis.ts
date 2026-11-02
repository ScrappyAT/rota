import { NextFunction,Request,Response,RequestHandler } from 'express';
import crypto from 'crypto';
import { ipKeyGenerator } from 'express-rate-limit';
import { redisClient } from '../redis';
import { AuthRequest } from './auth';
export interface RedisRateLimitOptions {windowSeconds:number;max:number;keyPrefix:string;key?:(req:Request)=>string;failClosed?:boolean}
const script=`local n=redis.call('INCR',KEYS[1]); if n==1 or redis.call('TTL',KEYS[1])<0 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;
export const redisRateLimit=(options:RedisRateLimitOptions)=>async(req:Request,res:Response,next:NextFunction)=>{
  const identity=options.key?.(req)??ipKeyGenerator(req.ip??req.socket.remoteAddress??'unknown');
  const key=options.keyPrefix+':'+crypto.createHash('sha256').update(identity).digest('hex');
  try {
    if (!redisClient.isReady) throw new Error('Redis unavailable');
    const count=Number(await redisClient.eval(script,{keys:[key],arguments:[String(options.windowSeconds)]}));
    if (count>options.max) {res.setHeader('Retry-After',options.windowSeconds);return res.status(429).json({success:false,error:{code:'TOO_MANY_REQUESTS',message:'Try again later'}});}
    next();
  }catch{
    if (options.failClosed) return res.status(503).json({success:false,error:{code:'RATE_LIMIT_UNAVAILABLE',message:'Try again later'}});
    next();
  }
};
const principal=(req:Request):string=>{
  const user=(req as AuthRequest).user;
  if (user) return user.id;
  if (typeof req.body?.email==='string') return req.body.email.trim().toLowerCase();
  if (typeof req.body?.userId==='string') return req.body.userId;
  return req.ip??'unknown';
};
/** Both counters are shared across API instances; no credential endpoint fails open. */
export const sensitiveLimit=(name:string,max:number):RequestHandler[]=>[
  redisRateLimit({windowSeconds:900,max,keyPrefix:'rl:'+name+':ip',failClosed:true}),
  redisRateLimit({windowSeconds:900,max,keyPrefix:'rl:'+name+':user',key:principal,failClosed:true}),
];
