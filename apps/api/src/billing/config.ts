import { env } from '../env';

export interface BillingConfig {
  currency: string;
  periodDays: number;
  graceDays: number;
  flwEnv: 'sandbox' | 'live';
  flwBaseUrl: string;
  /** Gateway amount units per one major unit of BILLING_CURRENCY (e.g. kobo per naira). */
  minorUnitsPerMajor: number;
}

export const billingConfig: BillingConfig = {
  currency: env.BILLING_CURRENCY,
  periodDays: env.BILLING_PERIOD_DAYS,
  graceDays: env.SUBSCRIPTION_GRACE_DAYS,
  flwEnv: env.FLW_ENV,
  flwBaseUrl: env.FLW_BASE_URL.replace(/\/+$/, ''),
  minorUnitsPerMajor: 100,
};