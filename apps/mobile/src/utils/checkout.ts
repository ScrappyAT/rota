import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import { fetchPaymentStatus, verifyPayment } from '../api/billing';

export interface CheckoutReturn {
  txRef?: string;
  transactionId?: string;
  status?: string;
}

export function parseCheckoutReturn(url: string | null | undefined): CheckoutReturn {
  if (!url) return {};
  const { queryParams } = Linking.parse(url);
  const params = queryParams ?? {};
  const pick = (...names: string[]): string | undefined => {
    for (const name of names) {
      const value = params[name];
      if (typeof value === 'string' && value.length > 0) return value;
      if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
    }
    return undefined;
  };
  return {
    txRef: pick('tx_ref', 'txRef'),
    transactionId: pick('transaction_id', 'transactionId', 'id'),
    status: pick('status'),
  };
}

export type CheckoutResult = 'settled' | 'pending' | 'cancelled' | 'failed';

export interface CheckoutVerifier {
  verifyPayment: (teamId: string, txRef: string, transactionId: string) => Promise<{ outcome: string }>;
  fetchPaymentStatus: (teamId: string, txRef: string) => Promise<{ status: string }>;
}

/**
 * Reconciles the browser session result against the backend.
 *
 * Invariants:
 * 1. Success ('settled') is ONLY returned when the specific checkout transaction is confirmed SUCCESSFUL.
 * 2. Absence of a pending payment, network error, or inconclusive response returns 'pending', NEVER 'settled'.
 * 3. Cancellation ('cancelled') is ONLY returned when explicitly confirmed by the gateway redirect.
 * 4. Existing active subscriptions cannot cause an unconfirmed checkout to appear settled.
 */
export async function reconcileCheckoutSession(
  teamId: string,
  result: WebBrowser.WebBrowserAuthSessionResult,
  expectedTxRef?: string,
  verifier: CheckoutVerifier = { verifyPayment, fetchPaymentStatus }
): Promise<CheckoutResult> {
  // Case 1: Browser returned with redirect URL (e.g. intercepted deep link)
  if (result.type === 'success' && result.url) {
    const params = parseCheckoutReturn(result.url);
    const statusLower = params.status?.toLowerCase();

    // Cancellation is shown ONLY when explicitly confirmed by the gateway redirect:
    if (statusLower === 'cancelled') {
      return 'cancelled';
    }
    if (statusLower === 'failed') {
      return 'failed';
    }

    const txRef = params.txRef || expectedTxRef;
    if (txRef && params.transactionId) {
      try {
        const verifyRes = await verifier.verifyPayment(teamId, txRef, params.transactionId);
        if (verifyRes.outcome === 'SUCCESS') {
          return 'settled';
        }
        if (verifyRes.outcome === 'FAILED') {
          return 'failed';
        }
        // If outcome is ALREADY_PROCESSED, verify the specific transaction's status
        const payment = await verifier.fetchPaymentStatus(teamId, txRef).catch(() => null);
        if (payment?.status === 'SUCCESSFUL') {
          return 'settled';
        }
        if (payment?.status === 'FAILED') {
          return 'failed';
        }
        return 'pending';
      } catch {
        // Direct verify failed (network or error). Fall through to inspect specific transaction.
      }
    }
  }

  // Case 2: Browser was dismissed, closed, or redirect params were missing/incomplete.
  // Success is reported ONLY when the specific checkout's transaction is confirmed SUCCESSFUL.
  if (expectedTxRef) {
    try {
      const payment = await verifier.fetchPaymentStatus(teamId, expectedTxRef);
      if (payment.status === 'SUCCESSFUL') {
        return 'settled';
      }
      if (payment.status === 'FAILED') {
        return 'failed';
      }
      // Status is PENDING - webhook or bank processing has not finalized yet.
      return 'pending';
    } catch {
      // Inconclusive backend response or network error: MUST NOT BE INTERPRETED AS SUCCESS.
      return 'pending';
    }
  }

  // If no expected transaction reference is available or verify didn't resolve,
  // report pending (never assume success or cancellation).
  return 'pending';
}

/**
 * Opens the hosted Flutterwave checkout in the system browser and reconciles
 * the outcome against the backend.
 */
export async function openCheckout(
  teamId: string,
  checkoutUrl: string,
  expectedTxRef?: string,
  verifier?: CheckoutVerifier
): Promise<CheckoutResult> {
  const returnUrl = Linking.createURL('billing/redirect');
  const activeVerifier = verifier ?? { verifyPayment, fetchPaymentStatus };
  try {
    const result = await WebBrowser.openAuthSessionAsync(checkoutUrl, returnUrl);
    return await reconcileCheckoutSession(teamId, result, expectedTxRef, activeVerifier);
  } catch {
    if (expectedTxRef) {
      try {
        const payment = await activeVerifier.fetchPaymentStatus(teamId, expectedTxRef);
        if (payment.status === 'SUCCESSFUL') return 'settled';
        if (payment.status === 'FAILED') return 'failed';
      } catch {
        // Inconclusive
      }
    }
    return 'pending';
  }
}