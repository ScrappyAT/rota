import { majorToMinor, minorToMajor, planMonthlyAmount, prorationBreakdown } from '../src/billing/proration';
import { computeChange, computeRenewal, PlanRow, SubscriptionRow } from '../src/billing/service';
import { SubscriptionStatus } from '@rota/shared';
const plan = (code: string, base: number, included: number, extra: number | null): PlanRow => ({
  code, name: code, price_per_seat_minor: 0, max_seats: extra === null ? included : 0, currency: 'USD', is_free: false,
  pricePerSeatMinor: 0, maxSeats: extra === null ? included : 0, isFree: false,
  pricing_model: 'INCLUDED_SEATS', base_price_minor: base, included_seats: included, extra_seat_minor: extra,
});
const starter = plan('STARTER_USD_V1', 2000, 5, null), team = plan('TEAM_USD_V1', 5000, 15, 300), business = plan('BUSINESS_USD_V1', 12000, 40, 200);
const start = new Date('2026-01-01T00:00:00Z'), end = new Date('2026-01-31T00:00:00Z');
const sub = (p = starter, seats = 5): SubscriptionRow => ({
  team_id: 'team', plan_code: p.code, seats, status: SubscriptionStatus.ACTIVE,
  period_started_at: start, period_ends_at: end, last_renewal_failed_at: null, grace_ends_at: null, revision: 1
});
describe('R1 exact USD catalog and proration', () => {
  it.each([[starter, 5, 2000], [team, 15, 5000], [team, 18, 5900], [business, 40, 12000], [business, 43, 12600]] as const)('prices included seats and billable extras %#', (p, seats, expected) => expect(planMonthlyAmount(p, seats)).toBe(expected));
  it('Starter rejects a sixth seat', () => expect(() => planMonthlyAmount(starter, 6)).toThrow());
  it('matches the PDF upgrade example: 1333 credit,3333 cost,2000 due', () => {
    expect(prorationBreakdown({ prevMonthlyMinor: 2000, nextMonthlyMinor: 5000, periodDays: 30, daysRemaining: 20 }))
      .toEqual({ creditMinor: 1333, costMinor: 3333, amountMinor: 2000 });
  });
  it('downgrade retains paid access and schedules the next period', () => {
    const change = computeChange(sub(team, 15), team, starter, 5, new Date('2026-01-11T00:00:00Z'));
    expect(change).toMatchObject({ amountMinor: 0, requiresPayment: false, effectiveAt: end });
  });
  it('adds three billable Team seats with 12 days remaining for 360 cents', () => {
    expect(computeChange(sub(team, 15), team, team, 18, new Date('2026-01-19T00:00:00Z')).amountMinor).toBe(360);
  });
  it('removing seats schedules a reduction without a cash refund', () => {
    expect(computeChange(sub(team, 18), team, team, 15, new Date('2026-01-19T00:00:00Z')))
      .toMatchObject({ effectiveAt: end, amountMinor: 0 });
  });
  it('change on first day charges the full difference', () => expect(computeChange(sub(), starter, team, 15, start).amountMinor).toBe(3000));
  it('last-day separate rounding differs from rounding the net difference', () => {
    expect(computeChange(sub(), starter, business, 40, new Date('2026-01-30T00:00:00Z')).amountMinor).toBe(334);
  });
  it('two changes use the plan actually paid for after the first change', () => {
    const first = computeChange(sub(), starter, team, 15, new Date('2026-01-11T00:00:00Z'));
    const second = computeChange(sub(team, 15), team, business, 40, new Date('2026-01-21T00:00:00Z'));
    expect([first.amountMinor, second.amountMinor]).toEqual([2000, 2334]);
  });
  it('renewal bills the full new monthly price including extras', () => expect(computeRenewal(sub(team, 18), team).amountMinor).toBe(5900));
  it.each([-1, 1.5, 31])('rejects invalid remaining days %s', daysRemaining => expect(() => prorationBreakdown({ prevMonthlyMinor: 2000, nextMonthlyMinor: 5000, periodDays: 30, daysRemaining })).toThrow());
  it.each([0, 1, 334, 10067, 2147483647])('round-trips cents exactly %s', minor => expect(majorToMinor(minorToMajor(minor))).toBe(minor));
  it.each(['1.001', 'NaN', 'Infinity', '1e2', '-1', ''])('rejects non-currency gateway amount %s', amount => expect(() => majorToMinor(amount)).toThrow());
});
