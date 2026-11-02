/** All monetary inputs and outputs are integer minor units. */
const MS_PER_DAY = 86_400_000;
export const MAX_SEATS = 100_000;
export const roundMinor = (value: number): number => Math.round(value);
export const monthlyAmount = (price: number, seats: number): number => price * seats;
export interface PlanPricing {
  price_per_seat_minor: number; max_seats: number; pricing_model?: string;
  base_price_minor?: number; included_seats?: number; extra_seat_minor?: number | null;
}
export const planMonthlyAmount = (plan: PlanPricing, seats: number): number => {
  if (!Number.isSafeInteger(seats) || seats < 1 || seats > MAX_SEATS) throw new Error('Invalid seat count');
  if (plan.max_seats > 0 && seats > plan.max_seats) throw new Error(`This plan supports at most ${plan.max_seats} seats`);
  if (plan.pricing_model !== 'INCLUDED_SEATS') return monthlyAmount(plan.price_per_seat_minor, seats);
  const extra = Math.max(0, seats - (plan.included_seats ?? 0));
  if (extra && plan.extra_seat_minor == null) throw new Error('Extra seats unavailable');
  return (plan.base_price_minor ?? 0) + extra * (plan.extra_seat_minor ?? 0);
};
export interface ProrationInput {
  prevMonthlyMinor: number; nextMonthlyMinor: number; periodDays: number; daysRemaining: number;
}
export const prorationBreakdown = ({prevMonthlyMinor,nextMonthlyMinor,periodDays,daysRemaining}: ProrationInput) => {
  if (!Number.isSafeInteger(periodDays) || periodDays <= 0) throw new Error('Invalid periodDays');
  if (!Number.isSafeInteger(daysRemaining) || daysRemaining < 0 || daysRemaining > periodDays) throw new Error('Invalid daysRemaining');
  if (![prevMonthlyMinor,nextMonthlyMinor].every(v => Number.isSafeInteger(v) && v >= 0)) throw new Error('Invalid money');
  const floorPart = (amount: number) => Number(BigInt(amount) * BigInt(daysRemaining) / BigInt(periodDays));
  const creditMinor = floorPart(prevMonthlyMinor);
  const costMinor = floorPart(nextMonthlyMinor);
  return {creditMinor,costMinor,amountMinor:Math.max(0,costMinor-creditMinor)};
};
export const proratedChargeMinor = (input: ProrationInput): number => prorationBreakdown(input).amountMinor;
export const daysRemainingInPeriod = (end: Date | string, now: Date): number =>
  Math.ceil(Math.max(0,new Date(end).getTime()-now.getTime())/MS_PER_DAY);
export const addDays = (date: Date | string, days: number): Date => new Date(new Date(date).getTime()+days*MS_PER_DAY);
export const minorToMajor = (amount: number): string => {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid minor amount');
  return `${Math.floor(amount/100)}.${String(amount%100).padStart(2,'0')}`;
};
export const majorToMinor = (amount: unknown): number => {
  const value = String(amount);
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Invalid major amount');
  const [whole,fraction=''] = value.split('.');
  const minor = Number(BigInt(whole)*BigInt(100)+BigInt(fraction.padEnd(2,'0')));
  if (!Number.isSafeInteger(minor)) throw new Error('Amount too large');
  return minor;
};
