import { sensitiveLimit } from '../middleware/rate-limit-redis';
import { Router } from 'express';
import { z } from 'zod';
import { initiateBilling } from '../billing/initiation';
import { reconstructBilling } from '../billing/ledger';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import {
  Roles,
  PaymentStatus,
  CreateCheckoutSchema,
  VerifyPaymentSchema,
  UpdateSeatsSchema,
} from '@rota/shared';
import { HttpError } from '../http-error';
import { uuidParam } from '../utils';
import { parseLimit, page, cursorPosition } from '../pagination';
import {
  listPlans,
  materializeSubscription,
  getSeatUsage,
  capacityOf,
  cleanupStalePendingPayments,
} from '../billing/service';
import { enqueueOutbox } from '../services/outbox';
import { env } from '../env';
import { planMonthlyAmount } from '../billing/proration';

const router = Router({ mergeParams: true });

// All subscription endpoints are owner-scoped.
router.use(requireRole([Roles.OWNER]));
const billingLimits=sensitiveLimit('billing',30);
router.use((req,res,next)=>req.method==='GET'?next():billingLimits[0](req,res,()=>billingLimits[1](req,res,next)));

// Current subscription + seat usage
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      await cleanupStalePendingPayments(client, teamId, now);
      const { sub, plan } = await materializeSubscription(client, teamId, now);
      const usage = await getSeatUsage(client, teamId);

      const unsubmittedCutoff = new Date(now.getTime() - 60 * 60 * 1000);
      const pending = await client.query(
        `SELECT id, team_id as "teamId", change_id as "changeId", tx_ref as "txRef",
                flw_transaction_id as "flwTransactionId", amount_minor as "amountMinor",
                currency, status, created_at as "createdAt"
         FROM payment_transactions pt
         WHERE pt.team_id = $1 AND pt.status = $2
           AND NOT EXISTS (
             SELECT 1 FROM payment_transactions newer
             WHERE newer.team_id = pt.team_id
               AND newer.status = $3
               AND (newer.created_at > pt.created_at OR (newer.created_at = pt.created_at AND newer.id != pt.id))
           )
           AND NOT (
             pt.flw_transaction_id IS NULL
             AND pt.created_at < $4
           )
         ORDER BY pt.created_at DESC LIMIT 1`,
        [teamId, PaymentStatus.PENDING, PaymentStatus.SUCCESSFUL, unsubmittedCutoff]
      );
      const failedRenewal = await client.query(
        `SELECT pt.id, pt.team_id as "teamId", pt.change_id as "changeId", pt.tx_ref as "txRef",
                pt.flw_transaction_id as "flwTransactionId", pt.amount_minor as "amountMinor",
                pt.currency, pt.status, pt.created_at as "createdAt"
         FROM payment_transactions pt
         JOIN subscription_changes sc ON sc.id = pt.change_id
         WHERE pt.team_id = $1 AND sc.type = 'RENEWAL' AND pt.status = 'FAILED'
         ORDER BY pt.created_at DESC LIMIT 1`,
        [teamId]
      );
      await client.query('COMMIT');

      res.json({
        success: true,
        data: {
          subscription: {
            teamId: sub.team_id,
            planCode:plan.public_code??sub.plan_code,
            currency:plan.currency,monthlyPriceMinor:planMonthlyAmount(plan,sub.seats),basePriceMinor:plan.base_price_minor,includedSeats:plan.included_seats,extraSeatMinor:plan.extra_seat_minor,
            scheduledChangeId:sub.scheduled_change_id,
            seats: sub.seats,
            status: sub.status,
            periodStartedAt: sub.period_started_at,
            periodEndsAt: sub.period_ends_at,
            hasFailedRenewal: Boolean(sub.last_renewal_failed_at),
            graceEndsAt: sub.grace_ends_at,
            planName: plan.name,
            planPricePerSeatMinor: plan.price_per_seat_minor,
            planMaxSeatsExempt: plan.is_free,
          },
          seatsUsed: usage.members,
          pendingInvites: usage.pendingInvites,
          seatCapacity: capacityOf(sub, plan),
          billingEnabled: Boolean(env.FLW_SECRET_KEY && env.FLW_PUBLIC_KEY),
          pendingPayment: pending.rows[0] ?? null,
          latestFailedRenewal: failedRenewal.rows[0] ?? null,
        },
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

// Available plans
router.get('/plans', async (req: AuthRequest, res, next) => {
  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const plans = await listPlans(client);
      await client.query('COMMIT');
      res.json({success:true,data:plans.map(p=>({...p,code:p.public_code??p.code,basePriceMinor:p.base_price_minor,includedSeats:p.included_seats,extraSeatMinor:p.extra_seat_minor}))});
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (error) {
    next(error);
  }
});

const ALLOWED_REDIRECT_PREFIXES = ['rota://', 'exp://'];

export const isAllowedReturnUrl = (url: string): boolean => {
  if (ALLOWED_REDIRECT_PREFIXES.some((prefix) => url.startsWith(prefix))) {
    return true;
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(url)) {
    return true;
  }
  return false;
};

const redirectUrlFor = (req: AuthRequest, returnUrl?: string): string => {
  const base = `${req.protocol}://${req.get('host')}/billing/redirect`;
  if (returnUrl && isAllowedReturnUrl(returnUrl)) {
    return `${base}?return_url=${encodeURIComponent(returnUrl)}`;
  }
  return base;
};

const RenewalSchema=z.object({returnUrl:z.string().max(2048).optional()}).strict();
for (const operation of ['checkout','seats','renew'] as const) {
  router.post('/'+operation,async(req:AuthRequest,res,next)=>{
    try {
      const data=operation==='checkout'?CreateCheckoutSchema.parse(req.body):operation==='seats'?UpdateSeatsSchema.parse(req.body):RenewalSchema.parse(req.body??{});
      const input=data as {planCode?:string;seats?:number;returnUrl?:string};
      const result=await initiateBilling(pool,{...input,operation,teamId:uuidParam(req.params.teamId,'teamId'),actorId:req.user!.id,
        email:req.user!.email,key:req.get('Idempotency-Key')??'',redirectUrl:redirectUrlFor(req,input.returnUrl)});
      res.status(result.status).json(result.body);
    } catch(error){next(error);}
  });
}

router.get('/ledger/reconstruction',async(req:AuthRequest,res,next)=>{
  const client=await pool.connect();
  try {
    res.json({success:true,data:await reconstructBilling(client,uuidParam(req.params.teamId,'teamId'))});
  } catch(error){next(error);} finally{client.release();}
});

// Queue a read-only provider verification; the app can poll its durable outcome.
router.post('/verify',async(req:AuthRequest,res,next)=>{
  try {
    const teamId=uuidParam(req.params.teamId,'teamId'),data=VerifyPaymentSchema.parse(req.body);
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const payment=await client.query('SELECT id FROM payment_transactions WHERE team_id=$1 AND tx_ref=$2',[teamId,data.txRef]);
      if(!payment.rows.length)throw new HttpError(404,'PAYMENT_NOT_FOUND','Payment transaction not found');
      const jobId=await enqueueOutbox(client,{key:'verify:'+payment.rows[0].id+':'+data.transactionId,kind:'PAYMENT_VERIFY',teamId,payload:{teamId,txRef:data.txRef,transactionId:data.transactionId}});
      await client.query('COMMIT');res.status(202).json({success:true,data:{outcome:'PENDING',jobId}});
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }catch(error){next(error);}
});
router.get('/verifications/:jobId',async(req:AuthRequest,res,next)=>{
  try {
    const result=await pool.query("SELECT status,result FROM job_outbox WHERE id=$1 AND team_id=$2 AND kind='PAYMENT_VERIFY'",[uuidParam(req.params.jobId,'jobId'),uuidParam(req.params.teamId,'teamId')]);
    if(!result.rows.length)throw new HttpError(404,'NOT_FOUND','Verification not found');
    const row=result.rows[0];
    if(row.result?.error)return res.status(row.result.statusCode??400).json({success:false,error:row.result.error});
    if(row.status==='COMPLETED')return res.json({success:true,data:row.result});
    if(row.status==='DEAD')return res.status(503).json({success:false,error:{code:'VERIFICATION_FAILED',message:'Verification needs review'}});
    res.status(202).json({success:true,data:{outcome:'PENDING',jobId:req.params.jobId}});
  }catch(error){next(error);}
});

// Check status of a specific payment transaction by txRef
router.get('/payments/:txRef', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const txRef = String(req.params.txRef || '').trim();
    if (!txRef) {
      throw new HttpError(400, 'INVALID_TX_REF', 'Transaction reference is required');
    }

    const { rows } = await pool.query(
      `SELECT id, team_id as "teamId", change_id as "changeId", tx_ref as "txRef",
              flw_transaction_id as "flwTransactionId", amount_minor as "amountMinor",
              currency,status,initialization_state as "initializationState",checkout_url as "checkoutUrl",created_at as "createdAt",updated_at as "updatedAt"
       FROM payment_transactions
       WHERE team_id = $1 AND tx_ref = $2`,
      [teamId, txRef]
    );

    if (rows.length === 0) {
      throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'Payment transaction not found');
    }

    res.json({ success: true, data: rows[0] });
  } catch (error) {
    next(error);
  }
});

// Change history
router.get('/changes', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const limit = parseLimit(req.query.limit as string | undefined);
    const cursor = cursorPosition(req.query.cursor as string | undefined);

    const conditions: string[] = ['team_id = $1'];
    const params: unknown[] = [teamId];
    let n = 2;

    if (cursor) {
      conditions.push(`(created_at < $${n} OR (created_at = $${n} AND id < $${n + 1}))`);
      params.push(cursor.timestamp, cursor.id);
      n += 2;
    }
    params.push(limit + 1);

    const { rows } = await pool.query(
      `SELECT id, team_id as "teamId", actor_id as "actorId", type,
              from_plan_code as "fromPlanCode", to_plan_code as "toPlanCode",
              from_seats as "fromSeats", to_seats as "toSeats",
              amount_minor as "amountMinor",status,created_at as "createdAt",currency,effective_at as "effectiveAt"
       FROM subscription_changes
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${n}`,
      params
    );

    res.json({
      success: true,
      data: page({ rows, limit, keyOf: (r) => ({ timestamp: r.createdAt, id: r.id }) }),
    });
  } catch (error) {
    next(error);
  }
});

// Invoice history
router.get('/billing', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const limit = parseLimit(req.query.limit as string | undefined);
    const cursor = cursorPosition(req.query.cursor as string | undefined);

    const conditions: string[] = ['i.team_id = $1'];
    const params: unknown[] = [teamId];
    let n = 2;

    if (cursor) {
      conditions.push(`(i.created_at < $${n} OR (i.created_at = $${n} AND i.id < $${n + 1}))`);
      params.push(cursor.timestamp, cursor.id);
      n += 2;
    }
    params.push(limit + 1);

    const { rows } = await pool.query(
      `SELECT i.id, i.team_id as "teamId", i.change_id as "changeId",
              i.amount_minor as "amountMinor",i.description,i.status,COALESCE(pt.currency,sc.currency,'NGN') as currency,
              i.created_at as "createdAt", i.paid_at as "paidAt",
              sc.type as "changeType", pt.tx_ref as "txRef"
       FROM billing_invoices i
       LEFT JOIN subscription_changes sc ON sc.id = i.change_id
       LEFT JOIN payment_transactions pt ON pt.change_id = i.change_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY i.created_at DESC, i.id DESC
       LIMIT $${n}`,
      params
    );

    res.json({
      success: true,
      data: page({ rows, limit, keyOf: (r) => ({ timestamp: r.createdAt, id: r.id }) }),
    });
  } catch (error) {
    next(error);
  }
});

export default router;
