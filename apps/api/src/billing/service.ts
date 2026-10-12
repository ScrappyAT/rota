import { PoolClient } from 'pg';
import crypto from 'crypto';
import {
  SubscriptionStatus,
  SubscriptionChangeType,
  SubscriptionChangeStatus,
  PaymentStatus,
  InvoiceStatus,
} from '@rota/shared';
import { HttpError } from '../http-error';
import { billingConfig } from './config';
import {
  monthlyAmount,
  proratedChargeMinor,
  daysRemainingInPeriod,
  addDays,
} from './proration';
import { addActivity } from '../services/activity';

export const FREE_PLAN_CODE = 'FREE';

export interface PlanRow {
  code: string;
  name: string;
  price_per_seat_minor: number;
  max_seats: number;
  currency: string;
  is_free: boolean;
}

export interface SubscriptionRow {
  team_id: string;
  plan_code: string;
  seats: number;
  status: SubscriptionStatus;
  period_started_at: Date;
  period_ends_at: Date;
  last_renewal_failed_at: Date | null;
  grace_ends_at: Date | null;
}

export interface ChangeRow {
  id: string;
  teamId: string;
  actorId: string;
  type: SubscriptionChangeType;
  fromPlanCode: string | null;
  toPlanCode: string | null;
  fromSeats: number | null;
  toSeats: number | null;
  amountMinor: number;
  status: SubscriptionChangeStatus;
  createdAt: Date;
}

export interface PaymentRow {
  id: string;
  teamId: string;
  changeId: string | null;
  txRef: string;
  flwTransactionId: string | null;
  amountMinor: number;
  currency: string;
  status: PaymentStatus;
  createdAt: Date;
}

export interface SeatUsage {
  members: number;
  pendingInvites: number;
}

export interface ComputedChange {
  type: SubscriptionChangeType;
  fromPlanCode: string | null;
  toPlanCode: string | null;
  fromSeats: number | null;
  toSeats: number | null;
  amountMinor: number;
  requiresPayment: boolean;
}

const requiresPaymentFor = (amountMin:number, plan: PlanRow): boolean => amountMin > 0 && !plan.is_free;

export const getPlan = async (client: PoolClient, code: string): Promise<PlanRow> => {
  const { rows } = await client.query(
    `SELECT code, name, price_per_seat_minor, max_seats, currency, is_free
     FROM billing_plans WHERE code = $1`,
    [code]
  );
  if (rows.length === 0) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Unknown subscription plan');
  }
  const r = rows[0];
  return {
    code: r.code,
    name: r.name,
    price_per_seat_minor: r.price_per_seat_minor,
    max_seats: r.max_seats,
    currency: r.currency,
    is_free: r.is_free,
  };
};

export const listPlans = async (client: PoolClient): Promise<PlanRow[]> => {
  const { rows } = await client.query(
    `SELECT code, name, price_per_seat_minor, max_seats, currency, is_free
     FROM billing_plans ORDER BY price_per_seat_minor ASC, code ASC`
  );
  return rows.map((r) => ({
    code: r.code,
    name: r.name,
    price_per_seat_minor: r.price_per_seat_minor,
    max_seats: r.max_seats,
    currency: r.currency,
    is_free: r.is_free,
  }));
};

export const getRawSubscription = async (
  client: PoolClient,
  teamId: string
): Promise<SubscriptionRow> => {
  const { rows } = await client.query(
    `SELECT team_id, plan_code, seats, status, period_started_at, period_ends_at,
            last_renewal_failed_at, grace_ends_at
     FROM team_subscriptions WHERE team_id = $1`,
    [teamId]
  );
  if (rows.length === 0) {
    throw new HttpError(404, 'NOT_FOUND', 'Subscription not found');
  }
  const r = rows[0];
  return {
    team_id: r.team_id,
    plan_code: r.plan_code,
    seats: r.seats,
    status: r.status,
    period_started_at: r.period_started_at,
    period_ends_at: r.period_ends_at,
    last_renewal_failed_at: r.last_renewal_failed_at,
    grace_ends_at: r.grace_ends_at,
  };
};

/**
 * Pure transition of a subscription's status based on the current clock.
 * Kept free of I/O so it can be unit-tested directly.
 */
export const transitionStatus = (sub: SubscriptionRow, now: Date): SubscriptionRow => {
  if (sub.status === SubscriptionStatus.ACTIVE && sub.period_ends_at.getTime() <= now.getTime()) {
    return { ...sub, status: SubscriptionStatus.EXPIRED };
  }
  if (
    sub.status === SubscriptionStatus.PAST_DUE &&
    sub.grace_ends_at &&
    sub.grace_ends_at.getTime() <= now.getTime()
  ) {
    return { ...sub, status: SubscriptionStatus.EXPIRED };
  }
  return sub;
};

/** Lazily materializes status transitions and persists them before returning. */
export const materializeSubscription = async (
  client: PoolClient,
  teamId: string,
  now: Date
): Promise<{ sub: SubscriptionRow; plan: PlanRow }> => {
  const sub = await getRawSubscription(client, teamId);
  const plan = await getPlan(client, sub.plan_code);
  const next = transitionStatus(sub, now);
  if (next.status !== sub.status) {
    await client.query(
      `UPDATE team_subscriptions SET status = $1, updated_at = CURRENT_TIMESTAMP
       WHERE team_id = $2`,
      [next.status, teamId]
    );
  }
  return { sub: next, plan };
};

export const getSeatUsage = async (client: PoolClient, teamId: string): Promise<SeatUsage> => {
  const members = await client.query(
    'SELECT COUNT(*)::int AS n FROM team_memberships WHERE team_id = $1',
    [teamId]
  );
  const pending = await client.query(
    `SELECT COUNT(*)::int AS n FROM invitations
     WHERE team_id = $1 AND accepted_at IS NULL AND expires_at > NOW()`,
    [teamId]
  );
  return { members: members.rows[0].n, pendingInvites: pending.rows[0].n };
};

export const capacityOf = (sub: SubscriptionRow, plan: PlanRow): number =>
  plan.is_free ? plan.max_seats : sub.seats;

/** Throws when adding `extra` members/invites would exceed the seat capacity. */
export const assertCanGrow = async (
  client: PoolClient,
  teamId: string,
  now: Date,
  extra: number
): Promise<void> => {
  const { sub, plan } = await materializeSubscription(client, teamId, now);
  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw new HttpError(
      403,
      'SUBSCRIPTION_REQUIRED',
      'An active subscription is required to add members to this team'
    );
  }
  const usage = await getSeatUsage(client, teamId);
  const capacity = capacityOf(sub, plan);
  if (usage.members + usage.pendingInvites + extra > capacity) {
    throw new HttpError(
      403,
      'SEAT_LIMIT_EXCEEDED',
      `Seat limit reached (${capacity}). The team needs more seats before adding members.`
    );
  }
};

/** Blocks shift creation etc. when the subscription is not active. */
export const assertSubscriptionActive = async (
  client: PoolClient,
  teamId: string,
  now: Date
): Promise<void> => {
  const { sub } = await materializeSubscription(client, teamId, now);
  if (sub.status !== SubscriptionStatus.ACTIVE) {
    throw new HttpError(
      403,
      'SUBSCRIPTION_REQUIRED',
      'An active subscription is required for this action'
    );
  }
};

export const computeChange = (
  sub: SubscriptionRow,
  currentPlan: PlanRow,
  targetPlan: PlanRow,
  targetSeats: number,
  now: Date
): ComputedChange => {
  if (targetSeats < 1) {
    throw new HttpError(400, 'VALIDATION_ERROR', 'Seats must be a positive integer');
  }
  if (targetSeats > targetPlan.max_seats) {
    throw new HttpError(
      400,
      'SEAT_LIMIT_EXCEEDED',
      `This plan supports at most ${targetPlan.max_seats} seats`
    );
  }

  const prevMonthly = monthlyAmount(currentPlan.price_per_seat_minor, sub.seats);
  const nextMonthly = monthlyAmount(targetPlan.price_per_seat_minor, targetSeats);
  const accrue = nextMonthly - prevMonthly;
  const daysRemaining = daysRemainingInPeriod(sub.period_ends_at, now);

  let type: SubscriptionChangeType;
  let amountMinor: number;
  if (accrue > 0) {
    type =
      targetPlan.code !== sub.plan_code
        ? SubscriptionChangeType.PLAN_UPGRADE
        : SubscriptionChangeType.ADD_SEATS;
    amountMinor = proratedChargeMinor({
      prevMonthlyMinor: prevMonthly,
      nextMonthlyMinor: nextMonthly,
      periodDays: billingConfig.periodDays,
      daysRemaining,
    });
  } else {
    type =
      targetPlan.code !== sub.plan_code
        ? SubscriptionChangeType.PLAN_DOWNGRADE
        : SubscriptionChangeType.REDUCE_SEATS;
    amountMinor = 0;
  }

  return {
    type,
    fromPlanCode: sub.plan_code,
    toPlanCode: targetPlan.code,
    fromSeats: sub.seats,
    toSeats: targetSeats,
    amountMinor,
    requiresPayment: amountMinor > 0 && !targetPlan.is_free,
  };
};

export const computeRenewal = (
  sub: SubscriptionRow,
  plan: PlanRow
): ComputedChange => {
  const amountMinor = monthlyAmount(plan.price_per_seat_minor, sub.seats);
  return {
    type: SubscriptionChangeType.RENEWAL,
    fromPlanCode: plan.code,
    toPlanCode: plan.code,
    fromSeats: sub.seats,
    toSeats: sub.seats,
    amountMinor,
    requiresPayment: requiresPaymentFor(amountMinor, plan),
  };
};

export const generateTxRef = (): string => `rota-${crypto.randomUUID()}`;

const changeDescription = (change: ChangeRow): string => {
  switch (change.type) {
    case SubscriptionChangeType.PLAN_UPGRADE:
      return `Plan upgrade ${change.fromPlanCode} -> ${change.toPlanCode} (${change.toSeats} seats, prorated)`;
    case SubscriptionChangeType.PLAN_DOWNGRADE:
      return `Plan change ${change.fromPlanCode} -> ${change.toPlanCode} (${change.toSeats} seats)`;
    case SubscriptionChangeType.ADD_SEATS:
      return `Add seats ${change.fromSeats} -> ${change.toSeats}`;
    case SubscriptionChangeType.REDUCE_SEATS:
      return `Reduce seats ${change.fromSeats} -> ${change.toSeats}`;
    case SubscriptionChangeType.RENEWAL:
      return `Subscription renewal (${change.toSeats} seats)`;
  }
};

/**
 * Records a subscription change plus its invoice (and a PENDING payment when a
 * charge is due) in one transaction. When no payment is required the new
 * plan/seats are applied immediately.
 */
export const openChange = async (
  client: PoolClient,
  teamId: string,
  actorId: string,
  computed: ComputedChange,
  now: Date
): Promise<{ change: ChangeRow; payment: PaymentRow | null }> => {
  const insertRes = await client.query(
    `INSERT INTO subscription_changes
       (team_id, actor_id, type, from_plan_code, to_plan_code, from_seats, to_seats, amount_minor, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, team_id as "teamId", actor_id as "actorId", type,
               from_plan_code as "fromPlanCode", to_plan_code as "toPlanCode",
               from_seats as "fromSeats", to_seats as "toSeats",
               amount_minor as "amountMinor", status, created_at as "createdAt"`,
    [
      teamId,
      actorId,
      computed.type,
      computed.fromPlanCode,
      computed.toPlanCode,
      computed.fromSeats,
      computed.toSeats,
      computed.amountMinor,
      computed.requiresPayment
        ? SubscriptionChangeStatus.PENDING_PAYMENT
        : SubscriptionChangeStatus.PAID,
      now,
    ]
  );
  const change = insertRes.rows[0] as ChangeRow;

  await client.query(
    `INSERT INTO billing_invoices (team_id, change_id, amount_minor, description, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      teamId,
      change.id,
      computed.amountMinor,
      changeDescription(change),
      computed.requiresPayment ? InvoiceStatus.OUTSTANDING : InvoiceStatus.PAID,
      now,
    ]
  );

  let payment: PaymentRow | null = null;
  if (computed.requiresPayment) {
    payment = await insertPayment(client, teamId, change.id, computed.amountMinor, now);
  } else {
    await applyChange(client, change);
    await client.query(
      'UPDATE billing_invoices SET status = $1, paid_at = CURRENT_TIMESTAMP WHERE change_id = $2',
      [InvoiceStatus.PAID, change.id]
    );
    await addActivity(client, {
      teamId,
      actorId,
      type: 'SUBSCRIPTION_CHANGED',
      payload: {
        changeType: change.type,
        planCode: change.toPlanCode,
        seats: change.toSeats,
        amountMinor: change.amountMinor,
        requiresPayment: false,
      },
    });
  }

  return { change, payment };
};

const insertPayment = async (
  client: PoolClient,
  teamId: string,
  changeId: string,
  amountMinor: number,
  now: Date
): Promise<PaymentRow> => {
  const res = await client.query(
    `INSERT INTO payment_transactions
       (team_id, change_id, tx_ref, amount_minor, currency, status, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, team_id as "teamId", change_id as "changeId", tx_ref as "txRef",
               flw_transaction_id as "flwTransactionId", amount_minor as "amountMinor",
               currency, status, created_at as "createdAt"`,
    [teamId, changeId, generateTxRef(), amountMinor, billingConfig.currency, PaymentStatus.PENDING, now]
  );
  return res.rows[0] as PaymentRow;
};

/** Applies a plan + seat change without extending the billing period. */
const applyChange = async (client: PoolClient, change: ChangeRow): Promise<void> => {
  await client.query(
    `UPDATE team_subscriptions
     SET plan_code = $1, seats = $2, status = $3,
         last_renewal_failed_at = NULL, grace_ends_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE team_id = $4`,
    [change.toPlanCode, change.toSeats, SubscriptionStatus.ACTIVE, change.teamId]
  );
};

/** Applies a paid renewal: updates config and starts a fresh billing period. */
const applyRenewal = async (client: PoolClient, change: ChangeRow, now: Date): Promise<void> => {
  await client.query(
    `UPDATE team_subscriptions
     SET plan_code = $1, seats = $2, status = $3,
         period_started_at = $4, period_ends_at = $5,
         last_renewal_failed_at = NULL, grace_ends_at = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE team_id = $6`,
    [
      change.toPlanCode,
      change.toSeats,
      SubscriptionStatus.ACTIVE,
      now,
      addDays(now, billingConfig.periodDays),
      change.teamId,
    ]
  );
};

export interface GatewayVerification {
  transactionId: string;
  txRef: string;
  /** Amount reported by the gateway, in the currency's major unit. */
  amountMajor: number;
  currency: string;
  status: string;
}

export interface ReconcileResult {
  outcome: 'SUCCESS' | 'ALREADY_PROCESSED' | 'FAILED';
  payment: PaymentRow;
  change: ChangeRow | null;
}

/**
 * Reconciles gateway data against a PENDING on-site payment and — only when
 * everything checks out — applies the subscription change. All writes happen
 * inside the caller's transaction so any error below rolls them back.
 */
export const reconcilePayment = async (
  client: PoolClient,
  teamId: string,
  txRef: string,
  gateway: GatewayVerification,
  now: Date
): Promise<ReconcileResult> => {
  const payRes = await client.query(
    `SELECT id, team_id as "teamId", change_id as "changeId", tx_ref as "txRef",
            flw_transaction_id as "flwTransactionId", amount_minor as "amountMinor",
            currency, status, created_at as "createdAt"
     FROM payment_transactions WHERE team_id = $1 AND tx_ref = $2`,
    [teamId, txRef]
  );
  if (payRes.rows.length === 0) {
    throw new HttpError(404, 'PAYMENT_NOT_FOUND', 'No pending payment matches this reference');
  }
  const payment = payRes.rows[0] as PaymentRow;

  if (payment.status === PaymentStatus.SUCCESSFUL || payment.status === PaymentStatus.FAILED) {
    return { outcome: 'ALREADY_PROCESSED', payment, change: null };
  }

  const change = payment.changeId
    ? await getChangeById(client, payment.changeId)
    : null;

  if (gateway.txRef && gateway.txRef !== payment.txRef) {
    throw new HttpError(400, 'PAYMENT_MISMATCH', 'Transaction reference does not match');
  }
  if (gateway.currency !== billingConfig.currency) {
    throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment currency does not match the subscription');
  }
  const expectedMajor = Math.round(payment.amountMinor / billingConfig.minorUnitsPerMajor);
  if (
    !Number.isFinite(gateway.amountMajor) ||
    Math.abs(gateway.amountMajor - expectedMajor) > 0.5 / billingConfig.minorUnitsPerMajor
  ) {
    throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment amount does not match the expected amount');
  }
  if (payment.flwTransactionId && payment.flwTransactionId !== gateway.transactionId) {
    throw new HttpError(400, 'PAYMENT_MISMATCH', 'Payment was already linked to another transaction');
  }

  const state = gateway.status === 'successful' ? PaymentStatus.SUCCESSFUL : PaymentStatus.FAILED;

  const claimRes = await client.query(
    `UPDATE payment_transactions
     SET status = $1, flw_transaction_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3 AND status = $4
     RETURNING id`,
    [
      state,
      gateway.transactionId,
      payment.id,
      PaymentStatus.PENDING,
    ]
  );
  if (claimRes.rows.length === 0) {
    return { outcome: 'ALREADY_PROCESSED', payment, change };
  }

  const settledPayment = {
    ...payment,
    status: state,
    flwTransactionId: gateway.transactionId,
  };

  if (state === PaymentStatus.FAILED) {
    await client.query('UPDATE subscription_changes SET status = $1 WHERE id = $2', [
      SubscriptionChangeStatus.FAILED,
      payment.changeId,
    ]);
    // A failed renewal of an otherwise-healthy active subscription opens a
    // grace window. If it was already EXPIRED the state stays EXPIRED.
    const currentSub = await getRawSubscription(client, teamId);
    if (
      change?.type === SubscriptionChangeType.RENEWAL &&
      currentSub.status === SubscriptionStatus.ACTIVE
    ) {
      await client.query(
        `UPDATE team_subscriptions
         SET last_renewal_failed_at = CURRENT_TIMESTAMP,
             grace_ends_at = $1,
             status = $2,
             updated_at = CURRENT_TIMESTAMP
         WHERE team_id = $3`,
        [
          addDays(now, billingConfig.graceDays),
          SubscriptionStatus.PAST_DUE,
          teamId,
        ]
      );
    }
    return { outcome: 'FAILED', payment: settledPayment, change };
  }

  if (change) {
    if (change.type === SubscriptionChangeType.RENEWAL) {
      await applyRenewal(client, change, now);
    } else {
      await applyChange(client, change);
    }
    await client.query('UPDATE subscription_changes SET status = $1 WHERE id = $2', [
      SubscriptionChangeStatus.PAID,
      change.id,
    ]);
    await client.query('UPDATE billing_invoices SET status = $1, paid_at = CURRENT_TIMESTAMP WHERE change_id = $2', [
      InvoiceStatus.PAID,
      change.id,
    ]);
    await addActivity(client, {
      teamId,
      actorId: change.actorId,
      type: 'PAYMENT_RECEIVED',
      payload: {
        txRef: payment.txRef,
        transactionId: gateway.transactionId,
        amountMinor: payment.amountMinor,
        currency: payment.currency,
      },
    });
    await addActivity(client, {
      teamId,
      actorId: change.actorId,
      type: 'SUBSCRIPTION_CHANGED',
      payload: {
        changeType: change.type,
        planCode: change.toPlanCode,
        seats: change.toSeats,
        amountMinor: change.amountMinor,
        requiresPayment: true,
      },
    });
  }

  return { outcome: 'SUCCESS', payment: settledPayment, change };
};

export const getChangeById = async (
  client: PoolClient,
  changeId: string
): Promise<ChangeRow | null> => {
  const { rows } = await client.query(
    `SELECT id, team_id as "teamId", actor_id as "actorId", type,
            from_plan_code as "fromPlanCode", to_plan_code as "toPlanCode",
            from_seats as "fromSeats", to_seats as "toSeats",
            amount_minor as "amountMinor", status, created_at as "createdAt"
     FROM subscription_changes WHERE id = $1`,
    [changeId]
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.id,
    teamId: r.teamId,
    actorId: r.actorId,
    type: r.type,
    fromPlanCode: r.fromPlanCode,
    toPlanCode: r.toPlanCode,
    fromSeats: r.fromSeats,
    toSeats: r.toSeats,
    amountMinor: r.amountMinor,
    status: r.status,
    createdAt: r.createdAt,
  };
};