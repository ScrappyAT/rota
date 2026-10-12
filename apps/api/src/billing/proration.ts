/**
 * Pure billing math. All money values are integer minor units (kobo for NGN).
 * Keep this module free of I/O so it can be unit-tested in isolation.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const roundMinor = (value: number): number => Math.round(value);

/** Full monthly charge for `seats` at `pricePerSeatMinor`. */
export const monthlyAmount = (pricePerSeatMinor: number, seats: number): number =>
  pricePerSeatMinor * seats;

export interface ProrationInput {
  prevMonthlyMinor: number;
  nextMonthlyMinor: number;
  periodDays: number;
  daysRemaining: number;
}

/**
 * Positive difference between the new and old monthly rate, prorated over the
 * days remaining in the current billing period. Downgrades/seat reductions
 * intentionally return 0 (no charge, applied immediately, no refund).
 */
export const proratedChargeMinor = ({
  prevMonthlyMinor,
  nextMonthlyMinor,
  periodDays,
  daysRemaining,
}: ProrationInput): number => {
  if (periodDays <= 0 || !Number.isInteger(periodDays)) {
    throw new Error('periodDays must be a positive integer');
  }
  if (daysRemaining < 0) {
    throw new Error('daysRemaining must be non-negative');
  }
  const accrue = Math.max(0, nextMonthlyMinor - prevMonthlyMinor);
  return roundMinor((accrue * daysRemaining) / periodDays);
};

/** Whole days left in the current period, clamped to 0. */
export const daysRemainingInPeriod = (periodEndsAt: Date | string, now: Date): number => {
  const remainingMs = Math.max(0, new Date(periodEndsAt).getTime() - now.getTime());
  return Math.ceil(remainingMs / MS_PER_DAY);
};

export const addDays = (date: Date | string, days: number): Date =>
  new Date(new Date(date).getTime() + days * MS_PER_DAY);