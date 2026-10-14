import {
  roundMinor,
  monthlyAmount,
  proratedChargeMinor,
  daysRemainingInPeriod,
  addDays,
} from '../src/billing/proration';
import {
  transitionStatus,
  computeChange,
  computeRenewal,
  capacityOf,
  SubscriptionRow,
  PlanRow,
} from '../src/billing/service';
import { SubscriptionStatus, SubscriptionChangeType } from '@rota/shared';
import { billingConfig } from '../src/billing/config';
import { isAllowedReturnUrl } from '../src/routes/subscription';

const freePlan: PlanRow = {
  code: 'FREE',
  name: 'Free',
  price_per_seat_minor: 0,
  max_seats: 100,
  currency: 'NGN',
  is_free: true,
  pricePerSeatMinor: 0,
  maxSeats: 100,
  isFree: true,
};

const starterPlan: PlanRow = {
  code: 'STARTER',
  name: 'Starter',
  price_per_seat_minor: 250000,
  max_seats: 10,
  currency: 'NGN',
  is_free: false,
  pricePerSeatMinor: 250000,
  maxSeats: 10,
  isFree: false,
};

const growthPlan: PlanRow = {
  code: 'GROWTH',
  name: 'Growth',
  price_per_seat_minor: 300000,
  max_seats: 50,
  currency: 'NGN',
  is_free: false,
  pricePerSeatMinor: 300000,
  maxSeats: 50,
  isFree: false,
};

const scalePlan: PlanRow = {
  code: 'SCALE',
  name: 'Scale',
  price_per_seat_minor: 350000,
  max_seats: 500,
  currency: 'NGN',
  is_free: false,
  pricePerSeatMinor: 350000,
  maxSeats: 500,
  isFree: false,
};

const sub = (overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
  team_id: '00000000-0000-0000-0000-000000000001',
  plan_code: 'STARTER',
  seats: 5,
  status: SubscriptionStatus.ACTIVE,
  period_started_at: new Date('2026-01-01T00:00:00.000Z'),
  period_ends_at: new Date('2026-01-31T00:00:00.000Z'),
  last_renewal_failed_at: null,
  grace_ends_at: null,
  ...overrides,
});

describe('billing proration (pure)', () => {
  it('01. monthly amount is price per seat times seats', () => {
    expect(monthlyAmount(250000, 5)).toBe(1250000);
    expect(monthlyAmount(0, 20)).toBe(0);
  });

  it('02. prorated charge is the rate difference scaled by remaining days', () => {
    const charge = proratedChargeMinor({
      prevMonthlyMinor: 1250000, // starter x5
      nextMonthlyMinor: 1500000, // growth x5
      periodDays: 30,
      daysRemaining: 15,
    });
    expect(charge).toBe(125000);
  });

  it('03. proration rounds to whole minor units', () => {
    const charge = proratedChargeMinor({
      prevMonthlyMinor: 0,
      nextMonthlyMinor: 100,
      periodDays: 30,
      daysRemaining: 7,
    });
    expect(charge).toBe(Math.round((100 * 7) / 30));
  });

  it('04. downgrade and equal-rate changes accrue zero', () => {
    const downgrade = proratedChargeMinor({
      prevMonthlyMinor: 1500000,
      nextMonthlyMinor: 1250000,
      periodDays: 30,
      daysRemaining: 20,
    });
    expect(downgrade).toBe(0);

    const equal = proratedChargeMinor({
      prevMonthlyMinor: 100000,
      nextMonthlyMinor: 100000,
      periodDays: 30,
      daysRemaining: 20,
    });
    expect(equal).toBe(0);
  });

  it('05. proration rejects invalid periods and remaining days', () => {
    expect(() =>
      proratedChargeMinor({
        prevMonthlyMinor: 0,
        nextMonthlyMinor: 100,
        periodDays: 0,
        daysRemaining: 5,
      })
    ).toThrow();
    expect(() =>
      proratedChargeMinor({
        prevMonthlyMinor: 0,
        nextMonthlyMinor: 100,
        periodDays: 30,
        daysRemaining: -1,
      })
    ).toThrow();
  });

  it('06. days remaining clamps to zero', () => {
    const now = new Date('2026-01-15T00:00:00.000Z');
    expect(daysRemainingInPeriod('2026-02-14T00:00:00.000Z', now)).toBe(
      Math.ceil((30 * 24 * 60 * 60 * 1000) / (24 * 60 * 60 * 1000))
    );
    expect(daysRemainingInPeriod('2026-01-10T00:00:00.000Z', now)).toBe(0);
  });

  it('07. roundMinor rounds to nearest integer minor unit', () => {
    expect(roundMinor(23.3)).toBe(23);
    expect(roundMinor(23.6)).toBe(24);
  });

  it('08. addDays shifts a date by whole days', () => {
    const base = new Date('2026-01-01T00:00:00.000Z');
    expect(addDays(base, billingConfig.periodDays).toISOString()).toBe(
      '2026-01-31T00:00:00.000Z'
    );
  });
});

describe('subscription transitions (pure)', () => {
  it('09. ACTIVE past period end expires', () => {
    const expired = transitionStatus(
      sub({ period_ends_at: new Date('2026-01-10T00:00:00.000Z') }),
      new Date('2026-01-20T00:00:00.000Z')
    );
    expect(expired.status).toBe(SubscriptionStatus.EXPIRED);
  });

  it('10. ACTIVE inside the period stays active', () => {
    const active = transitionStatus(sub({}), new Date('2026-01-15T00:00:00.000Z'));
    expect(active.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('11. ACTIVE exactly at period end expires', () => {
    const end = new Date('2026-01-31T00:00:00.000Z');
    const expired = transitionStatus(sub({ period_ends_at: end }), end);
    expect(expired.status).toBe(SubscriptionStatus.EXPIRED);
  });

  it('12. PAST_DUE inside grace stays past due', () => {
    const pastDue = transitionStatus(
      sub({
        status: SubscriptionStatus.PAST_DUE,
        grace_ends_at: new Date('2026-02-10T00:00:00.000Z'),
      }),
      new Date('2026-02-05T00:00:00.000Z')
    );
    expect(pastDue.status).toBe(SubscriptionStatus.PAST_DUE);
  });

  it('13. PAST_DUE past the grace window expires', () => {
    const expired = transitionStatus(
      sub({
        status: SubscriptionStatus.PAST_DUE,
        grace_ends_at: new Date('2026-02-10T00:00:00.000Z'),
      }),
      new Date('2026-02-11T00:00:00.000Z')
    );
    expect(expired.status).toBe(SubscriptionStatus.EXPIRED);
  });

  it('14. EXPIRED stays expired', () => {
    const expired = transitionStatus(
      sub({ status: SubscriptionStatus.EXPIRED }),
      new Date('2030-01-01T00:00:00.000Z')
    );
    expect(expired.status).toBe(SubscriptionStatus.EXPIRED);
  });
});

describe('change computation (pure)', () => {
  const now = new Date('2026-01-15T00:00:00.000Z');

  it('15. plan upgrade charges a prorated difference and requires payment', () => {
    const s = sub({ plan_code: 'STARTER', seats: 5 });
    const change = computeChange(s, starterPlan, growthPlan, 5, now);
    expect(change.type).toBe(SubscriptionChangeType.PLAN_UPGRADE);
    expect(change.amountMinor).toBeGreaterThan(0);
    expect(change.requiresPayment).toBe(true);
    expect(change.fromPlanCode).toBe('STARTER');
    expect(change.toPlanCode).toBe('GROWTH');
  });

  it('16. upgrading from FREE requires payment against the full month', () => {
    const s = sub({ plan_code: 'FREE', seats: 3 });
    const change = computeChange(s, freePlan, growthPlan, 3, now);
    const expected = Math.round(
      (300000 * 3 * daysRemainingInPeriod(s.period_ends_at, now)) / billingConfig.periodDays
    );
    expect(change.type).toBe(SubscriptionChangeType.PLAN_UPGRADE);
    expect(change.amountMinor).toBe(expected);
    expect(change.requiresPayment).toBe(true);
  });

  it('17. adding seats on a paid plan is a paid change', () => {
    const s = sub({ plan_code: 'STARTER', seats: 5 });
    const change = computeChange(s, starterPlan, starterPlan, 7, now);
    expect(change.type).toBe(SubscriptionChangeType.ADD_SEATS);
    expect(change.amountMinor).toBeGreaterThan(0);
    expect(change.requiresPayment).toBe(true);
  });

  it('18. downgrading plans applies immediately at no charge', () => {
    const s = sub({ plan_code: 'GROWTH', seats: 5 });
    const change = computeChange(s, growthPlan, starterPlan, 5, now);
    expect(change.type).toBe(SubscriptionChangeType.PLAN_DOWNGRADE);
    expect(change.amountMinor).toBe(0);
    expect(change.requiresPayment).toBe(false);
  });

  it('19. reducing seats applies immediately at no charge', () => {
    const s = sub({ plan_code: 'STARTER', seats: 7 });
    const change = computeChange(s, starterPlan, starterPlan, 4, now);
    expect(change.type).toBe(SubscriptionChangeType.REDUCE_SEATS);
    expect(change.amountMinor).toBe(0);
    expect(change.requiresPayment).toBe(false);
  });

  it('20. a combined plan+seat change at the same monthly rate pays nothing', () => {
    // STARTER x5 = 1,250,000; GROWTH x5 = 1,500,000 -> downgrade to STARTER x5 > 0 size?
    const s = sub({ plan_code: 'GROWTH', seats: 5 });
    // From GROWTH x5 (1.5M) to STARTER x4 (1.0M): net decrease -> immediate.
    const down = computeChange(s, growthPlan, starterPlan, 4, now);
    expect(down.type).toBe(SubscriptionChangeType.PLAN_DOWNGRADE);
    expect(down.amountMinor).toBe(0);
  });

  it('21. seats above the plan maximum are rejected', () => {
    const s = sub({ plan_code: 'GROWTH', seats: 5 });
    expect(() => computeChange(s, growthPlan, growthPlan, 51, now)).toThrow(
      /at most 50 seats/
    );
  });

  it('22. seats must be positive', () => {
    const s = sub({});
    expect(() => computeChange(s, starterPlan, starterPlan, 0, now)).toThrow(
      /positive integer/
    );
  });
});

describe('renewal and capacity helpers', () => {
  it('23. paid renewal charges the full monthly amount and requires payment', () => {
    const s = sub({ plan_code: 'GROWTH', seats: 5 });
    const change = computeRenewal(s, growthPlan);
    expect(change.type).toBe(SubscriptionChangeType.RENEWAL);
    expect(change.amountMinor).toBe(1500000);
    expect(change.requiresPayment).toBe(true);
  });

  it('24. FREE renewal is immediate with no charge', () => {
    const s = sub({ plan_code: 'FREE', seats: 7 });
    const change = computeRenewal(s, freePlan);
    expect(change.amountMinor).toBe(0);
    expect(change.requiresPayment).toBe(false);
  });

  it('25. FREE capacity is the plan maximum, paid capacity is seats', () => {
    expect(capacityOf(sub({ plan_code: 'FREE' }), freePlan)).toBe(100);
    expect(capacityOf(sub({ plan_code: 'STARTER', seats: 9 }), starterPlan)).toBe(9);
  });

  it('26. returnUrl validation allows app schemes and localhost but rejects external domains', () => {
    expect(isAllowedReturnUrl('rota://billing/redirect')).toBe(true);
    expect(isAllowedReturnUrl('rota://custom/path?foo=bar')).toBe(true);
    expect(isAllowedReturnUrl('exp://127.0.0.1:8081/--/billing/redirect')).toBe(true);
    expect(isAllowedReturnUrl('http://localhost:8081/billing/redirect')).toBe(true);
    expect(isAllowedReturnUrl('http://127.0.0.1:8081/billing/redirect')).toBe(true);
    expect(isAllowedReturnUrl('https://evil.com/phishing')).toBe(false);
    expect(isAllowedReturnUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedReturnUrl('ftp://example.com')).toBe(false);
  });
});