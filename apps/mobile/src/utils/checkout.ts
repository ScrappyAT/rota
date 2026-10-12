import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { API_URL } from '../api/client';
import { verifyPayment } from '../api/billing';

export interface CheckoutReturn {
  txRef?: string;
  transactionId?: string;
  status?: string;
}

export function parseCheckoutReturn(url: string | null | undefined): CheckoutReturn {
  if (!url) return {};
  const { queryParams } = Linking.parse(url);
  const params = queryParams ?? {};
  const pick = (name: string): string | undefined => {
    const value = params[name];
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
    return undefined;
  };
  return {
    txRef: pick('tx_ref'),
    transactionId: pick('transaction_id'),
    status: pick('status'),
  };
}

export type CheckoutResult = 'settled' | 'pending' | 'cancelled';

/**
 * Opens the hosted Flutterwave checkout in the system browser and, if the
 * redirect carries the transaction id, verifies the payment server-side.
 * Settlement is also delivered by the gateway webhook, so callers should
 * always refetch the subscription summary afterwards.
 */
export async function openCheckout(teamId: string, checkoutUrl: string): Promise<CheckoutResult> {
  try {
    const result = await WebBrowser.openAuthSessionAsync(checkoutUrl, `${API_URL}/billing/redirect`);
    if (result.type !== 'success' || !result.url) return 'cancelled';

    const params = parseCheckoutReturn(result.url);
    if (params.txRef && params.transactionId) {
      try {
        await verifyPayment(teamId, params.txRef, params.transactionId);
        return 'settled';
      } catch {
        return 'pending';
      }
    }
    return 'pending';
  } catch {
    return 'cancelled';
  }
}