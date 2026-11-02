import { Request,Response,NextFunction } from 'express';
import { z } from 'zod';
const query=z.object({limit:z.string().max(20).optional(),cursor:z.string().max(2048).optional(),
  from:z.string().refine(v=>!Number.isNaN(Date.parse(v)),'Invalid date').optional(),to:z.string().refine(v=>!Number.isNaN(Date.parse(v)),'Invalid date').optional(),status:z.string().max(40).optional(),
  type:z.string().max(80).optional(),mine:z.enum(['true','false']).optional(),userId:z.string().uuid().optional(),
  assignedTo:z.string().uuid().optional(),tx_ref:z.string().max(256).optional(),transaction_id:z.string().max(256).optional(),return_url:z.string().max(2048).optional()}).strict();
/** Reject arrays/nested query input before route parsers and SQL. Route schemas
 * retain their narrower semantic validation and tenant authorization. */
export const validateRequestShape=(req:Request,_res:Response,next:NextFunction)=>{
  try {
    // Zod 3 has no compatible fix for GHSA-mrhx-c7xc-m3w5. Bound collections
    // before schema traversal in addition to the HTTP byte limit.
    const stack:[unknown,number][]=[[req.body,0]];let count=0;
    while(stack.length){const [value,depth]=stack.pop()!;
      if(++count>1000||depth>20)throw new z.ZodError([{code:'custom',path:['body'],message:'Request nesting/collection limit exceeded'}]);
      if(value&&typeof value==='object'){
        const entries=Object.values(value);
        if(entries.length>100)throw new z.ZodError([{code:'custom',path:['body'],message:'Collection limit exceeded'}]);
        for(const item of entries)stack.push([item,depth+1]);
      }
    }
    query.parse(req.query);
    const parts=req.path.split('/').filter(Boolean);
    for (let i=0;i<parts.length;i++) {
      if (['teams','shifts','swaps','members','verifications'].includes(parts[i])&&parts[i+1])
        z.string().uuid().parse(parts[i+1]);
    }
    const noBody=req.method==='DELETE'&&!req.path.startsWith('/devices') || /\/(approve|cancel)$/.test(req.path);
    if (noBody) z.object({}).strict().parse(req.body??{});
    next();
  }catch(error){next(error);}
};
