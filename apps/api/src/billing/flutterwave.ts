import { env } from '../env';
import { billingConfig } from './config';
import { HttpError } from '../http-error';

/**
 * Flutterwave gateway client. Contract verified against the official docs:
 * - checkout: POST {base}/v3/payments -> data.link
 * - verify:   GET  {base}/v3/transactions/{id}/verify -> data
 * - webhook:  validated with the `verif-hash` header value (not an HMAC).
 *
 * Flutterwave takes amounts in the currency's standard major unit (naira),
 * not minor units, so minor-unit values are converted before sending and
 * compared after verifying.
 */

export interface InitializePaymentInput {
  txRef: string;
  /** Amount in minor units (kobo). Converted to the gateway major unit. */
  amountMinor: number;
  currency: string;
  redirectUrl: string;
  customer: { email: string; name?: string };
}

export interface InitializePaymentResult {
  link: string;
}

const gatewayAmount = (amountMinor: number): number =>
  Math.round(amountMinor / billingConfig.minorUnitsPerMajor);

const secretsPresent = (): string | null => {
  const secretKey = env.FLW_SECRET_KEY;
  if (!secretKey) return null;
  return secretKey;
};

export const initializeCheckout = async (
  input: InitializePaymentInput
): Promise<InitializePaymentResult> => {
  const secretKey = secretsPresent();
  if (!secretKey) {
    throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payment gateway is not configured');
  }

  let res: Response;
  try {
    res = await fetch(`${billingConfig.flwBaseUrl}/v3/payments`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref: input.txRef,
        amount: gatewayAmount(input.amountMinor),
        currency: input.currency,
        redirect_url: input.redirectUrl,
        customer: {
          email: input.customer.email,
          name: input.customer.name,
        },
        customizations: {
          title: 'Rota Subscription',
        },
      }),
    });
  } catch {
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment gateway is unreachable');
  }

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment gateway rejected the request');
  }

  const link = body?.data?.link;
  if (typeof link !== 'string' || link.length === 0) {
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment gateway returned no checkout link');
  }
  return { link };
};

export interface VerifiedTransaction {
  transactionId: string;
  txRef: string;
  /** Amount reported by the gateway, in the currency's major unit. */
  amountMajor: number;
  currency: string;
  status: string;
}

export const verifyTransaction = async (transactionId: string): Promise<VerifiedTransaction> => {
  const secretKey = env.FLW_SECRET_KEY;
  if (!secretKey) {
    throw new HttpError(503, 'PAYMENTS_UNAVAILABLE', 'Payment gateway is not configured');
  }

  let res: Response;
  try {
    res = await fetch(
      `${billingConfig.flwBaseUrl}/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${secretKey}` },
      }
    );
  } catch {
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment gateway is unreachable');
  }

  if (!res.ok) {
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment verification request failed');
  }

  const body = await res.json().catch(() => null);
  const data = body?.data;
  if (!data || data.id === undefined) {
    throw new HttpError(502, 'PAYMENT_GATEWAY_ERROR', 'Payment verification returned no data');
  }

  return {
    transactionId: String(data.id),
    txRef: typeof data.tx_ref === 'string' ? data.tx_ref : '',
    amountMajor: Number(data.amount),
    currency: typeof data.currency === 'string' ? data.currency : '',
    status: typeof data.status === 'string' ? data.status : '',
  };
};

/**
 * Constant-time comparison of the incoming `verif-hash` header against the
 * configured secret. Read from process.env at request time so tests can set
 * it per scenario.
 */
export const verifyWebhookHash = (received: string | undefined): boolean => {
  const expected = process.env.FLW_SECRET_HASH;
  if (!expected || !received || received.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < received.length; i++) {
    diff |= received.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
};