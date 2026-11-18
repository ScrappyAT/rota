import { HttpError } from '../src/http-error';
import { verifyTransactionByReference } from '../src/billing/flutterwave';
import { sanitizeErrorMessage, jobBackoff } from '../src/services/job-runtime';
import { handleOutbox } from '../src/services/job-handlers';
import { DeferJob } from '../src/services/outbox';

jest.mock('../src/env', () => ({
  env: {
    FLW_SECRET_KEY: 'r1-mocked-key',
    FLW_ENV: 'sandbox',
    FLW_BASE_URL: 'http://127.0.0.1:9',
    BILLING_CURRENCY: 'USD',
    BILLING_PERIOD_DAYS: 30,
    SUBSCRIPTION_GRACE_DAYS: 14,
    JOB_ATTEMPTS: 5,
    JOB_BACKOFF_MS: 1000,
  },
}));

describe('Payment Reconciliation & Gateway Recovery Regression Tests', () => {
  const fetchMock = jest.spyOn(globalThis, 'fetch');

  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    fetchMock.mockRestore();
  });

  describe('1. Gateway Verification Error Handling & Categorization', () => {
    it('treats Flutterwave 404 as TRANSACTION_NOT_FOUND (not yet paid)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ status: 'error', message: 'Transaction not found' }),
      } as Response);

      await expect(verifyTransactionByReference('tx-not-found')).rejects.toMatchObject({
        statusCode: 404,
        code: 'TRANSACTION_NOT_FOUND',
      });
    });

    it('treats empty data or null ID from 200 response as TRANSACTION_NOT_FOUND', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: 'success', data: null }),
      } as Response);

      await expect(verifyTransactionByReference('tx-empty-data')).rejects.toMatchObject({
        statusCode: 404,
        code: 'TRANSACTION_NOT_FOUND',
      });
    });

    it('identifies gateway authentication failure (401) with GATEWAY_AUTHENTICATION_ERROR', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ status: 'error', message: 'Invalid secret key' }),
      } as Response);

      await expect(verifyTransactionByReference('tx-auth-fail')).rejects.toMatchObject({
        statusCode: 401,
        code: 'GATEWAY_AUTHENTICATION_ERROR',
      });
    });

    it('handles temporary network or gateway timeout as PAYMENT_GATEWAY_UNREACHABLE', async () => {
      fetchMock.mockRejectedValueOnce(new Error('fetch failed / timeout'));

      await expect(verifyTransactionByReference('tx-timeout')).rejects.toMatchObject({
        statusCode: 502,
        code: 'PAYMENT_GATEWAY_UNREACHABLE',
      });
    });

    it('handles temporary gateway 502/503 responses as PAYMENT_GATEWAY_ERROR', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        json: async () => ({ status: 'error', message: 'Gateway service unavailable' }),
      } as Response);

      await expect(verifyTransactionByReference('tx-gateway-503')).rejects.toMatchObject({
        statusCode: 502,
        code: 'PAYMENT_GATEWAY_ERROR',
      });
    });

    it('returns verified transaction details on successful terminal payment', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          status: 'success',
          data: {
            id: 998877,
            tx_ref: 'tx-paid-ref',
            amount: '20.00',
            currency: 'USD',
            status: 'successful',
          },
        }),
      } as Response);

      const verified = await verifyTransactionByReference('tx-paid-ref');
      expect(verified).toEqual({
        transactionId: '998877',
        txRef: 'tx-paid-ref',
        amountMajor: '20.00',
        currency: 'USD',
        status: 'successful',
      });
    });
  });

  describe('2. Sanitization of Sensitive Information in Logs and Errors', () => {
    it('redacts Bearer tokens, FLW secret keys, and card numbers from error messages', () => {
      const raw = 'Failed with Bearer eyJhbGciOiJIUzI1NiJ9.test and FLWSECK_TEST-1234567890ab-X for 4111 2222 3333 4444 and secret=superSecret123';
      const sanitized = sanitizeErrorMessage(raw);

      expect(sanitized).not.toContain('eyJhbGci');
      expect(sanitized).not.toContain('FLWSECK_TEST');
      expect(sanitized).not.toContain('4111 2222 3333 4444');
      expect(sanitized).not.toContain('superSecret123');
      expect(sanitized).toContain('Bearer [REDACTED]');
      expect(sanitized).toContain('[REDACTED_KEY]');
      expect(sanitized).toContain('[REDACTED_CARD]');
      expect(sanitized).toContain('secret=[REDACTED]');
    });
  });

  describe('3. Ordering Safeguards with Initialization & State Transitions', () => {
    it('defers reconciliation when checkout initialization is still QUEUED (under 5m)', async () => {
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [
                {
                  id: 'payment-1',
                  status: 'PENDING',
                  initialization_state: 'QUEUED',
                  created_at: new Date(Date.now() - 30000), // 30s old
                  tx_ref: 'tx-queued-1',
                  team_id: 'team-1',
                },
              ],
            };
          }
          if (sql.includes("SELECT status FROM job_outbox WHERE event_key = 'initialize:'")) {
            return { rows: [{ status: 'PENDING' }] };
          }
          return { rows: [] };
        }),
      } as unknown as import('pg').PoolClient;

      const job = {
        id: 'job-1',
        event_key: 'reconcile:payment-1',
        kind: 'PAYMENT_RECONCILE' as const,
        team_id: 'team-1',
        payload: { paymentId: 'payment-1' },
        status: 'RUNNING',
        generation: 1,
        attempts: 1,
        failures: 0,
        dispatch_failures: 0,
        available_at: new Date(),
      };

      await expect(handleOutbox(fakeClient, job, new Date())).rejects.toThrow(DeferJob);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('transitions long-queued initialization (>5m) to MANUAL_REVIEW without calling provider', async () => {
      const mockQueries: Array<{ sql: string; values?: unknown[] }> = [];
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
          mockQueries.push({ sql, values });
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [
                {
                  id: 'payment-stuck-queue',
                  status: 'PENDING',
                  initialization_state: 'QUEUED',
                  created_at: new Date(Date.now() - 360000), // 6 minutes old
                  tx_ref: 'tx-stuck-queued',
                  team_id: 'team-1',
                },
              ],
            };
          }
          if (sql.includes("SELECT status FROM job_outbox WHERE event_key = 'initialize:'")) {
            return { rows: [{ status: 'QUEUED' }] };
          }
          return { rows: [] };
        }),
      } as unknown as import('pg').PoolClient;

      const job = {
        id: 'job-stuck-queue',
        event_key: 'reconcile:payment-stuck-queue',
        kind: 'PAYMENT_RECONCILE' as const,
        team_id: 'team-1',
        payload: { paymentId: 'payment-stuck-queue' },
        status: 'RUNNING',
        generation: 1,
        attempts: 1,
        failures: 0,
        dispatch_failures: 0,
        available_at: new Date(),
      };

      const result = await handleOutbox(fakeClient, job, new Date());
      expect(result).toEqual({ outcome: 'STUCK_QUEUED_MANUAL_REVIEW' });

      // Verifies state was transitioned to MANUAL_REVIEW
      const reviewUpdate = mockQueries.find((q) => q.sql.includes("initialization_state='MANUAL_REVIEW'"));
      expect(reviewUpdate).toBeDefined();

      // Provider verification must NOT be called for an uninitialized payment
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('transitions QUEUED payment to MANUAL_REVIEW immediately if initialize job is DEAD', async () => {
      const mockQueries: Array<{ sql: string; values?: unknown[] }> = [];
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql: string, values?: unknown[]) => {
          mockQueries.push({ sql, values });
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [
                {
                  id: 'payment-dead-init',
                  status: 'PENDING',
                  initialization_state: 'QUEUED',
                  created_at: new Date(Date.now() - 60000), // only 1 min old
                  tx_ref: 'tx-dead-init',
                  team_id: 'team-1',
                },
              ],
            };
          }
          if (sql.includes("SELECT status FROM job_outbox WHERE event_key = 'initialize:'")) {
            return { rows: [{ status: 'DEAD' }] };
          }
          return { rows: [] };
        }),
      } as unknown as import('pg').PoolClient;

      const job = {
        id: 'job-dead-init',
        event_key: 'reconcile:payment-dead-init',
        kind: 'PAYMENT_RECONCILE' as const,
        team_id: 'team-1',
        payload: { paymentId: 'payment-dead-init' },
        status: 'RUNNING',
        generation: 1,
        attempts: 1,
        failures: 0,
        dispatch_failures: 0,
        available_at: new Date(),
      };

      const result = await handleOutbox(fakeClient, job, new Date());
      expect(result).toEqual({ outcome: 'STUCK_QUEUED_MANUAL_REVIEW' });

      const reviewUpdate = mockQueries.find((q) => q.sql.includes("initialization_state='MANUAL_REVIEW'"));
      expect(reviewUpdate).toBeDefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('defers reconciliation for a delayed claim on an old payment record (uses updated_at claim age)', async () => {
      // Payment created 15 minutes ago, but only claimed 10 seconds ago (updated_at = now - 10s)
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [
                {
                  id: 'payment-delayed-claim',
                  status: 'PENDING',
                  initialization_state: 'CLAIMED',
                  created_at: new Date(Date.now() - 900000), // 15 minutes ago
                  updated_at: new Date(Date.now() - 10000),  // 10 seconds ago
                  tx_ref: 'tx-delayed-claim',
                  team_id: 'team-1',
                },
              ],
            };
          }
          return { rows: [] };
        }),
      } as unknown as import('pg').PoolClient;

      const job = {
        id: 'job-delayed-claim',
        event_key: 'reconcile:payment-delayed-claim',
        kind: 'PAYMENT_RECONCILE' as const,
        team_id: 'team-1',
        payload: { paymentId: 'payment-delayed-claim' },
        status: 'RUNNING',
        generation: 1,
        attempts: 1,
        failures: 0,
        dispatch_failures: 0,
        available_at: new Date(),
      };

      // Must defer because the claim is active (10s old < 60s), not abandoned
      await expect(handleOutbox(fakeClient, job, new Date())).rejects.toThrow(DeferJob);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('transitions genuinely stale CLAIMED payment (>60s claim age) to AMBIGUOUS before verifying', async () => {
      const mockQueries: string[] = [];
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          mockQueries.push(sql);
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [
                {
                  id: 'payment-stale-claim',
                  status: 'PENDING',
                  initialization_state: 'CLAIMED',
                  created_at: new Date(Date.now() - 300000),
                  updated_at: new Date(Date.now() - 75000), // 75 seconds ago (>60s claim age)
                  tx_ref: 'tx-stale-claim-ref',
                  team_id: 'team-1',
                },
              ],
            };
          }
          if (sql.includes("UPDATE payment_transactions SET initialization_state='AMBIGUOUS'")) {
            return { rows: [{ id: 'payment-stale-claim' }] };
          }
          return { rows: [] };
        }),
      } as unknown as import('pg').PoolClient;

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ status: 'error', message: 'Transaction not found' }),
      } as Response);

      const job = {
        id: 'job-stale-claim',
        event_key: 'reconcile:payment-stale-claim',
        kind: 'PAYMENT_RECONCILE' as const,
        team_id: 'team-1',
        payload: { paymentId: 'payment-stale-claim' },
        status: 'RUNNING',
        generation: 1,
        attempts: 1,
        failures: 0,
        dispatch_failures: 0,
        available_at: new Date(),
      };

      await expect(handleOutbox(fakeClient, job, new Date())).rejects.toMatchObject({
        statusCode: 404,
        code: 'TRANSACTION_NOT_FOUND',
      });

      expect(mockQueries.some((q) => q.includes("initialization_state='AMBIGUOUS'"))).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('proceeds to verify when initialization state is READY or AMBIGUOUS', async () => {
      const fakeClient = {
        query: jest.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [
                {
                  id: 'payment-ready',
                  status: 'PENDING',
                  initialization_state: 'READY',
                  created_at: new Date(),
                  tx_ref: 'tx-ready-ref',
                  team_id: 'team-1',
                },
              ],
            };
          }
          if (sql.includes('SELECT * FROM payment_transactions WHERE team_id=$1 AND tx_ref=$2')) {
            return {
              rows: [
                {
                  id: 'payment-ready',
                  teamId: 'team-1',
                  changeId: null,
                  txRef: 'tx-ready-ref',
                  amountMinor: 2000,
                  currency: 'USD',
                  status: 'PENDING',
                  createdAt: new Date(),
                },
              ],
            };
          }
          return { rows: [] };
        }),
      } as unknown as import('pg').PoolClient;

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ status: 'error', message: 'Transaction not found' }),
      } as Response);

      const job = {
        id: 'job-ready',
        event_key: 'reconcile:payment-ready',
        kind: 'PAYMENT_RECONCILE' as const,
        team_id: 'team-1',
        payload: { paymentId: 'payment-ready' },
        status: 'RUNNING',
        generation: 1,
        attempts: 1,
        failures: 0,
        dispatch_failures: 0,
        available_at: new Date(),
      };

      await expect(handleOutbox(fakeClient, job, new Date())).rejects.toMatchObject({
        statusCode: 404,
        code: 'TRANSACTION_NOT_FOUND',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('4. Retry Scheduling & Backoff Bounds', () => {
    it('uses human checkout scale (1m, 2m, 4m, 8m) for PAYMENT_RECONCILE in production', () => {
      // In production mode with base >= 1000ms
      expect(jobBackoff(1, 'PAYMENT_RECONCILE')).toBe(60000);   // 1m
      expect(jobBackoff(2, 'PAYMENT_RECONCILE')).toBe(120000);  // 2m
      expect(jobBackoff(3, 'PAYMENT_RECONCILE')).toBe(240000);  // 4m
      expect(jobBackoff(4, 'PAYMENT_RECONCILE')).toBe(480000);  // 8m
      expect(jobBackoff(5, 'PAYMENT_RECONCILE')).toBe(600000);  // 10m cap
    });

    it('preserves standard backoff for non-reconcile jobs', () => {
      expect(jobBackoff(1, 'NOTIFICATION')).toBe(1000);
      expect(jobBackoff(2, 'NOTIFICATION')).toBe(2000);
      expect(jobBackoff(3, 'NOTIFICATION')).toBe(4000);
      expect(jobBackoff(1)).toBe(1000);
      expect(jobBackoff(2)).toBe(2000);
    });
  });

  describe('5. Job Runtime Classification & Manual Review Transitions', () => {
    it('classifies TRANSACTION_NOT_FOUND (404) as retryable on early attempts', async () => {
      const { processOutboxJob } = await import('../src/services/job-runtime');
      const updates: Array<{ sql: string; values: unknown[] }> = [];

      const mockClient = {
        query: jest.fn().mockImplementation(async (sql: string, values: unknown[]) => {
          updates.push({ sql, values });
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          if (sql.includes('SELECT * FROM job_outbox WHERE id=$1')) {
            return {
              rows: [{
                id: 'outbox-rec-1',
                kind: 'PAYMENT_RECONCILE',
                status: 'PENDING',
                available_at: new Date(Date.now() - 1000),
                attempts: 0,
                failures: 0,
                payload: { paymentId: 'payment-404' },
                team_id: 'team-1',
              }],
            };
          }
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [{
                id: 'payment-404',
                status: 'PENDING',
                initialization_state: 'READY',
                created_at: new Date(Date.now() - 60000),
                tx_ref: 'tx-404',
                team_id: 'team-1',
              }],
            };
          }
          if (sql.includes('UPDATE job_outbox SET status=\'RUNNING\'')) return { rows: [{ attempts: 1 }] };
          return { rows: [] };
        }),
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      } as unknown as import('pg').Pool;

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ status: 'error', message: 'Transaction not found' }),
      } as Response);

      await expect(processOutboxJob(mockPool, 'outbox-rec-1')).rejects.toThrow();

      // Verify the job was requeued as QUEUED (retryable), not marked DEAD
      const outboxUpdate = updates.find((u) => u.sql.includes('UPDATE job_outbox SET failures=failures+1'));
      expect(outboxUpdate).toBeDefined();
      expect(outboxUpdate!.values[1]).toBe('QUEUED');
      expect(outboxUpdate!.values[2]).toContain('TRANSACTION_NOT_FOUND');

      // Verify payment was NOT set to MANUAL_REVIEW on attempt 1
      const manualReviewUpdate = updates.find((u) => u.sql.includes("initialization_state='MANUAL_REVIEW'"));
      expect(manualReviewUpdate).toBeUndefined();
    });

    it('transitions payment to MANUAL_REVIEW when retry budget is exhausted', async () => {
      const { processOutboxJob } = await import('../src/services/job-runtime');
      const updates: Array<{ sql: string; values: unknown[] }> = [];

      const mockClient = {
        query: jest.fn().mockImplementation(async (sql: string, values: unknown[]) => {
          updates.push({ sql, values });
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          if (sql.includes('SELECT * FROM job_outbox WHERE id=$1')) {
            return {
              rows: [{
                id: 'outbox-rec-dead',
                kind: 'PAYMENT_RECONCILE',
                status: 'PENDING',
                available_at: new Date(Date.now() - 1000),
                attempts: 4,
                failures: 4, // 5th failure will reach env.JOB_ATTEMPTS (5)
                payload: { paymentId: 'payment-exhausted' },
                team_id: 'team-1',
              }],
            };
          }
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [{
                id: 'payment-exhausted',
                status: 'PENDING',
                initialization_state: 'READY',
                created_at: new Date(Date.now() - 600000),
                tx_ref: 'tx-exhausted',
                team_id: 'team-1',
              }],
            };
          }
          if (sql.includes('UPDATE job_outbox SET status=\'RUNNING\'')) return { rows: [{ attempts: 5 }] };
          return { rows: [] };
        }),
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      } as unknown as import('pg').Pool;

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        json: async () => ({ status: 'error', message: 'Transaction not found' }),
      } as Response);

      await expect(processOutboxJob(mockPool, 'outbox-rec-dead')).rejects.toThrow();

      // Verify the job was marked DEAD
      const outboxUpdate = updates.find((u) => u.sql.includes('UPDATE job_outbox SET failures=failures+1'));
      expect(outboxUpdate).toBeDefined();
      expect(outboxUpdate!.values[1]).toBe('DEAD');

      // Verify payment initialization_state was transitioned to MANUAL_REVIEW
      const manualReviewUpdate = updates.find((u) => u.sql.includes("initialization_state='MANUAL_REVIEW'"));
      expect(manualReviewUpdate).toBeDefined();
      expect(manualReviewUpdate!.values[0]).toBe('payment-exhausted');
    });

    it('marks GATEWAY_AUTHENTICATION_ERROR as DEAD immediately without burning retries', async () => {
      const { processOutboxJob } = await import('../src/services/job-runtime');
      const updates: Array<{ sql: string; values: unknown[] }> = [];

      const mockClient = {
        query: jest.fn().mockImplementation(async (sql: string, values: unknown[]) => {
          updates.push({ sql, values });
          if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
          if (sql.includes('SELECT * FROM job_outbox WHERE id=$1')) {
            return {
              rows: [{
                id: 'outbox-auth-dead',
                kind: 'PAYMENT_RECONCILE',
                status: 'PENDING',
                available_at: new Date(Date.now() - 1000),
                attempts: 0,
                failures: 0,
                payload: { paymentId: 'payment-auth' },
                team_id: 'team-1',
              }],
            };
          }
          if (sql.includes('SELECT * FROM payment_transactions WHERE id=$1')) {
            return {
              rows: [{
                id: 'payment-auth',
                status: 'PENDING',
                initialization_state: 'READY',
                created_at: new Date(Date.now() - 60000),
                tx_ref: 'tx-auth',
                team_id: 'team-1',
              }],
            };
          }
          if (sql.includes('UPDATE job_outbox SET status=\'RUNNING\'')) return { rows: [{ attempts: 1 }] };
          return { rows: [] };
        }),
        release: jest.fn(),
      };

      const mockPool = {
        connect: jest.fn().mockResolvedValue(mockClient),
      } as unknown as import('pg').Pool;

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ status: 'error', message: 'Invalid API secret key' }),
      } as Response);

      await expect(processOutboxJob(mockPool, 'outbox-auth-dead')).rejects.toThrow();

      // 401 must fail-fast to DEAD on attempt 1
      const outboxUpdate = updates.find((u) => u.sql.includes('UPDATE job_outbox SET failures=failures+1'));
      expect(outboxUpdate).toBeDefined();
      expect(outboxUpdate!.values[1]).toBe('DEAD');
      expect(outboxUpdate!.values[2]).toContain('GATEWAY_AUTHENTICATION_ERROR');
    });
  });
});
