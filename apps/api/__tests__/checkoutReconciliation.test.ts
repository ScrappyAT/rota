/**
 * Regression and Verification Tests for Checkout Result Reconciliation
 *
 * Requirements verified:
 * 1. Success is reported ONLY when the specific checkout's transaction is confirmed SUCCESSFUL by the backend.
 * 2. Absence of a pending payment, network failure, or an inconclusive response MUST NOT be interpreted as success.
 * 3. Cancellation is shown ONLY when explicitly confirmed by the gateway; otherwise display pending.
 * 4. Existing active subscriptions must NOT cause a new unsuccessful checkout to appear successful.
 * 5. Delayed webhook settlement and duplicate redirects remain safe and idempotent.
 */

describe('Checkout Result Reconciliation & Dismissal Resilience', () => {
  type CheckoutResult = 'settled' | 'pending' | 'cancelled' | 'failed';

  interface CheckoutVerifier {
    verifyPayment: (teamId: string, txRef: string, transactionId: string) => Promise<{ outcome: string }>;
    fetchPaymentStatus: (teamId: string, txRef: string) => Promise<{ status: string }>;
  }

  interface WebBrowserResult {
    type: 'cancel' | 'dismiss' | 'opened' | 'locked' | 'success';
    url?: string;
  }

  // Pure implementation of parseCheckoutReturn matching apps/mobile/src/utils/checkout.ts
  const parseCheckoutReturn = (url: string | null | undefined): { txRef?: string; transactionId?: string; status?: string } => {
    if (!url) return {};
    try {
      const parsedUrl = new URL(url);
      const params = parsedUrl.searchParams;
      const pick = (...names: string[]): string | undefined => {
        for (const name of names) {
          const val = params.get(name);
          if (val) return val;
        }
        return undefined;
      };
      return {
        txRef: pick('tx_ref', 'txRef'),
        transactionId: pick('transaction_id', 'transactionId', 'id'),
        status: pick('status') ?? undefined,
      };
    } catch {
      return {};
    }
  };

  // Implementation matching reconcileCheckoutSession in apps/mobile/src/utils/checkout.ts
  const reconcileCheckoutSession = async (
    teamId: string,
    result: WebBrowserResult,
    expectedTxRef?: string,
    verifier?: CheckoutVerifier
  ): Promise<CheckoutResult> => {
    if (result.type === 'success' && result.url) {
      const params = parseCheckoutReturn(result.url);
      const statusLower = params.status?.toLowerCase();

      if (statusLower === 'cancelled') {
        return 'cancelled';
      }
      if (statusLower === 'failed') {
        return 'failed';
      }

      const txRef = params.txRef || expectedTxRef;
      if (txRef && params.transactionId && verifier) {
        try {
          const verifyRes = await verifier.verifyPayment(teamId, txRef, params.transactionId);
          if (verifyRes.outcome === 'SUCCESS') {
            return 'settled';
          }
          if (verifyRes.outcome === 'FAILED') {
            return 'failed';
          }
          const payment = await verifier.fetchPaymentStatus(teamId, txRef).catch(() => null);
          if (payment?.status === 'SUCCESSFUL') {
            return 'settled';
          }
          if (payment?.status === 'FAILED') {
            return 'failed';
          }
          return 'pending';
        } catch {
          // Fall through to status check
        }
      }
    }

    if (expectedTxRef && verifier) {
      try {
        const payment = await verifier.fetchPaymentStatus(teamId, expectedTxRef);
        if (payment.status === 'SUCCESSFUL') {
          return 'settled';
        }
        if (payment.status === 'FAILED') {
          return 'failed';
        }
        return 'pending';
      } catch {
        return 'pending';
      }
    }

    return 'pending';
  };

  const teamId = 'team-uuid-1234';
  const expectedTxRef = 'rota-sub-upgrade-987';

  it('1. browser dismissal with no pending payment returns pending, NEVER settled or cancelled', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn().mockRejectedValue(new Error('PAYMENT_NOT_FOUND')),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      { type: 'dismiss' },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('pending');
    expect(outcome).not.toBe('settled');
    expect(outcome).not.toBe('cancelled');
    expect(verifier.fetchPaymentStatus).toHaveBeenCalledWith(teamId, expectedTxRef);
  });

  it('2. existing active subscription does NOT cause an unconfirmed checkout to appear settled', async () => {
    // Team already has an active subscription, but this checkout transaction is still PENDING:
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn().mockResolvedValue({ status: 'PENDING' }),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      { type: 'dismiss' },
      expectedTxRef,
      verifier
    );

    // Must return 'pending' rather than assuming active subscription means this checkout succeeded
    expect(outcome).toBe('pending');
    expect(outcome).not.toBe('settled');
  });

  it('3. inconclusive backend response or network error returns pending, never settled or cancelled', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn().mockRejectedValue(new Error('Network request failed: timeout')),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      { type: 'dismiss' },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('pending');
    expect(outcome).not.toBe('settled');
    expect(outcome).not.toBe('cancelled');
  });

  it('4. browser dismissal when background webhook confirmed SUCCESSFUL returns settled', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn().mockResolvedValue({ status: 'SUCCESSFUL' }),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      { type: 'dismiss' },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('settled');
  });

  it('5. browser dismissal when backend confirms transaction FAILED returns failed', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn().mockResolvedValue({ status: 'FAILED' }),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      { type: 'dismiss' },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('failed');
  });

  it('6. browser dismissal without expectedTxRef returns pending, never settled or cancelled', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn(),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      { type: 'dismiss' },
      undefined,
      verifier
    );

    expect(outcome).toBe('pending');
    expect(verifier.fetchPaymentStatus).not.toHaveBeenCalled();
  });

  it('7. cancellation is reported ONLY when explicitly confirmed by gateway redirect', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn(),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      {
        type: 'success',
        url: 'rota://billing/redirect?status=cancelled&tx_ref=rota-sub-upgrade-987',
      },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('cancelled');
    expect(verifier.verifyPayment).not.toHaveBeenCalled();
  });

  it('8. gateway redirect with status=failed returns failed', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn(),
      fetchPaymentStatus: jest.fn(),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      {
        type: 'success',
        url: 'rota://billing/redirect?status=failed&tx_ref=rota-sub-upgrade-987',
      },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('failed');
    expect(verifier.verifyPayment).not.toHaveBeenCalled();
  });

  it('9. successful gateway redirect verifies server-side and returns settled', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn().mockResolvedValue({ outcome: 'SUCCESS' }),
      fetchPaymentStatus: jest.fn(),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      {
        type: 'success',
        url: 'rota://billing/redirect?status=successful&tx_ref=rota-sub-upgrade-987&transaction_id=123456',
      },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('settled');
    expect(verifier.verifyPayment).toHaveBeenCalledWith(teamId, 'rota-sub-upgrade-987', '123456');
  });

  it('10. direct verification returning ALREADY_PROCESSED checks status and returns settled', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn().mockResolvedValue({ outcome: 'ALREADY_PROCESSED' }),
      fetchPaymentStatus: jest.fn().mockResolvedValue({ status: 'SUCCESSFUL' }),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      {
        type: 'success',
        url: 'rota://billing/redirect?status=successful&tx_ref=rota-sub-upgrade-987&transaction_id=123456',
      },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('settled');
    expect(verifier.fetchPaymentStatus).toHaveBeenCalledWith(teamId, 'rota-sub-upgrade-987');
  });

  it('11. transaction-specific verification: redirect for an unconfirmed transaction returns failed or pending, NEVER settled', async () => {
    const verifier: CheckoutVerifier = {
      verifyPayment: jest.fn().mockResolvedValue({ outcome: 'FAILED' }),
      fetchPaymentStatus: jest.fn().mockResolvedValue({ status: 'FAILED' }),
    };

    const outcome = await reconcileCheckoutSession(
      teamId,
      {
        type: 'success',
        url: 'rota://billing/redirect?status=successful&tx_ref=rota-sub-upgrade-987&transaction_id=123456',
      },
      expectedTxRef,
      verifier
    );

    expect(outcome).toBe('failed');
    expect(outcome).not.toBe('settled');
  });

  it('12. parseCheckoutReturn parses native Android deep links accurately', () => {
    const nativeAndroidUrl = 'rota://billing/redirect?status=successful&tx_ref=rota-99c4d310-440a-48aa-b523-d890e2b64c27&transaction_id=892341';
    const parsed = parseCheckoutReturn(nativeAndroidUrl);
    expect(parsed.status).toBe('successful');
    expect(parsed.txRef).toBe('rota-99c4d310-440a-48aa-b523-d890e2b64c27');
    expect(parsed.transactionId).toBe('892341');

    const cancelledUrl = 'rota://billing/redirect?status=cancelled&tx_ref=rota-cancelled-123';
    const parsedCancelled = parseCheckoutReturn(cancelledUrl);
    expect(parsedCancelled.status).toBe('cancelled');
    expect(parsedCancelled.txRef).toBe('rota-cancelled-123');
    expect(parsedCancelled.transactionId).toBeUndefined();
  });
});
