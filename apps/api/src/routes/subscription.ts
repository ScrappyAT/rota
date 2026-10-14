import { Router, Response } from 'express';
import { pool } from '../db';
import { AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/tenant';
import {
  Roles,
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
  getPlan,
  computeChange,
  computeRenewal,
  openChange,
  reconcilePayment,
} from '../billing/service';
import { initializeCheckout, verifyTransaction } from '../billing/flutterwave';
import { env } from '../env';

const router = Router({ mergeParams: true });

// All subscription endpoints are owner-scoped.
router.use(requireRole([Roles.OWNER]));

// Current subscription + seat usage
router.get('/', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const { sub, plan } = await materializeSubscription(client, teamId, now);
      const usage = await getSeatUsage(client, teamId);

      const pending = await client.query(
        `SELECT id, team_id as "teamId", change_id as "changeId", tx_ref as "txRef",
                flw_transaction_id as "flwTransactionId", amount_minor as "amountMinor",
                currency, status, created_at as "createdAt"
         FROM payment_transactions
         WHERE team_id = $1 AND status = $2
         ORDER BY created_at DESC LIMIT 1`,
        [teamId, 'PENDING']
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
            planCode: sub.plan_code,
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
      res.json({ success: true, data: plans });
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

const sendChangeResult = async (
  req: AuthRequest,
  res: Response,
  teamId: string,
  actorId: string,
  computed: ReturnType<typeof computeChange>,
  returnUrl?: string
) => {
  const client = await pool.connect();
  let checkoutUrl: string | null = null;
  try {
    await client.query('BEGIN');
    const now = new Date();
    const { change, payment } = await openChange(client, teamId, actorId, computed, now);
    await client.query('COMMIT');

    if (computed.requiresPayment && payment) {
      const init = await initializeCheckout({
        txRef: payment.txRef,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
        redirectUrl: redirectUrlFor(req, returnUrl),
        customer: { email: req.user!.email },
      });
      checkoutUrl = init.link;
    }

    res.status(computed.requiresPayment ? 201 : 200).json({
      success: true,
      data: {
        change,
        payment: payment
          ? {
              id: payment.id,
              txRef: payment.txRef,
              amountMinor: payment.amountMinor,
              currency: payment.currency,
              status: payment.status,
            }
          : null,
        checkoutUrl,
      },
    });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
};

// Change plan (and optionally seats). Upgrades charge a prorated amount;
// downgrades apply immediately at no charge.
router.post('/checkout', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const data = CreateCheckoutSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const { sub, plan } = await materializeSubscription(client, teamId, now);
      const usage = await getSeatUsage(client, teamId);
      const targetSeats = data.seats ?? sub.seats;
      if (targetSeats < usage.members) {
        throw new HttpError(
          400,
          'SEAT_LIMIT_EXCEEDED',
          'Seats cannot be lower than the current number of members'
        );
      }
      const targetPlan = await getPlan(client, data.planCode);
      const computed = computeChange(sub, plan, targetPlan, targetSeats, now);
      await client.query('COMMIT');
      await sendChangeResult(req, res, teamId, req.user!.id, computed, data.returnUrl);
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

// Add or reduce seats (same plan)
router.post('/seats', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const data = UpdateSeatsSchema.parse(req.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const { sub, plan } = await materializeSubscription(client, teamId, now);
      const usage = await getSeatUsage(client, teamId);
      if (data.seats < usage.members) {
        throw new HttpError(
          400,
          'SEAT_LIMIT_EXCEEDED',
          'Seats cannot be lower than the current number of members'
        );
      }
      const computed = computeChange(sub, plan, plan, data.seats, now);
      await client.query('COMMIT');
      await sendChangeResult(req, res, teamId, req.user!.id, computed, data.returnUrl);
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

// Renew the current subscription for another period
router.post('/renew', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const returnUrl = typeof req.body?.returnUrl === 'string' ? req.body.returnUrl : undefined;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const now = new Date();
      const { sub, plan } = await materializeSubscription(client, teamId, now);
      const computed = computeRenewal(sub, plan);
      await client.query('COMMIT');
      await sendChangeResult(req, res, teamId, req.user!.id, computed, returnUrl);
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

// Server-side payment verification (called after the hosted checkout redirect)
router.post('/verify', async (req: AuthRequest, res, next) => {
  try {
    const teamId = uuidParam(req.params.teamId, 'teamId');
    const data = VerifyPaymentSchema.parse(req.body);

    const gateway = await verifyTransaction(data.transactionId);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await reconcilePayment(client, teamId, data.txRef, gateway, new Date());
      await client.query('COMMIT');
      res.json({ success: true, data: result });
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
              currency, status, created_at as "createdAt", updated_at as "updatedAt"
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
              amount_minor as "amountMinor", status, created_at as "createdAt"
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
              i.amount_minor as "amountMinor", i.description, i.status,
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
