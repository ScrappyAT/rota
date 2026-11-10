import crypto from 'node:crypto';
import { Queue, Worker } from 'bullmq';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { enqueueOutbox, JobKind } from '../src/services/outbox';
import { processOutboxJob, createJobQueue, dispatchOutbox, startJobWorker } from '../src/services/job-runtime';
import { requestContext } from '../src/services/observability';
import { verifyTransaction } from '../src/billing/flutterwave';
jest.mock('../src/billing/flutterwave', () => ({ ...jest.requireActual('../src/billing/flutterwave'), verifyTransaction: jest.fn() }));

describe('Phase 3 job observability with disposable PostgreSQL and Redis', () => {
  const records: Record<string, unknown>[] = [];
  const ids: string[] = [];
  let logs: jest.SpyInstance, warns: jest.SpyInstance, errors: jest.SpyInstance;
  let queue: Queue | undefined, worker: Worker | undefined;
  const secret = 'do-not-log-password-card-expo-token';
  const create = async (kind: JobKind, availableAt = new Date(0)) => {
    const client = await pool.connect();
    try {
      const id = await enqueueOutbox(client, { key: crypto.randomUUID(), kind, payload: { secret, transactionId: 'mocked' }, availableAt });
      ids.push(id); return id;
    } finally { client.release(); }
  };
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5540' || url.pathname !== '/rota_r1_test') throw new Error('Disposable Phase 3 database required');
    await redisClient.connect().catch(() => {});
  });
  beforeEach(() => {
    records.length = 0;
    const collect = (line: unknown) => { records.push(JSON.parse(String(line))); };
    logs = jest.spyOn(console, 'log').mockImplementation(collect);
    warns = jest.spyOn(console, 'warn').mockImplementation(collect);
    errors = jest.spyOn(console, 'error').mockImplementation(collect);
  });
  afterEach(async () => {
    await worker?.close(); worker = undefined;
    await queue?.close(); queue = undefined;
    await pool.query('DELETE FROM job_outbox WHERE id=ANY($1::uuid[])', [ids]); ids.length = 0;
    logs.mockRestore(); warns.mockRestore(); errors.mockRestore();
  });
  afterAll(async () => { await pool.end(); await redisClient.quit(); });
  it('records job type, attempt, completion duration and duplicate suppression without the payload', async () => {
    const id = await create('BILLING_RECHECK');
    await processOutboxJob(pool, id); await processOutboxJob(pool, id);
    expect(records.filter(r => r.jobId === id).map(r => r.event)).toEqual(['job.intent_written', 'job.started', 'job.completed', 'job.skipped']);
    expect(records.find(r => r.event === 'job.completed')).toMatchObject({ jobType: 'BILLING_RECHECK', attempt: 1, durationMs: expect.any(Number), outcome: 'success' });
    expect((await pool.query('SELECT attempts,status FROM job_outbox WHERE id=$1', [id])).rows[0]).toMatchObject({ attempts: 1, status: 'COMPLETED' });
    expect(JSON.stringify(records)).not.toContain(secret);
  });
  it('records bounded retries and terminal failure without a provider error message', async () => {
    jest.mocked(verifyTransaction).mockRejectedValue(new Error(secret));
    const id = await create('PAYMENT_VERIFY');
    for (let i = 0; i < 3; i++) await expect(processOutboxJob(pool, id)).rejects.toThrow();
    expect(records.filter(r => r.event === 'job.retry').map(r => r.attempt)).toEqual([1, 2]);
    expect(records.filter(r => r.event === 'job.retry').map(r => r.retryInMs)).toEqual([20, 40]);
    expect(records.find(r => r.event === 'job.dead')).toMatchObject({ jobId: id, jobType: 'PAYMENT_VERIFY', attempt: 3, durationMs: expect.any(Number), outcome: 'dead' });
    expect((await pool.query('SELECT status FROM job_outbox WHERE id=$1', [id])).rows[0].status).toBe('DEAD');
    expect(JSON.stringify(records)).not.toContain(secret);
  });
  it('distinguishes scheduling deferral from failed attempts', async () => {
    const id = await create('BILLING_RECHECK', new Date('2100-01-01'));
    await processOutboxJob(pool, id, new Date('2099-01-01'));
    expect(records.find(r => r.event === 'job.deferred')).toMatchObject({ jobId: id, jobType: 'BILLING_RECHECK', outcome: 'deferred', durationMs: expect.any(Number) });
    expect(records.some(r => r.event === 'job.retry')).toBe(false);
    expect((await pool.query('SELECT failures FROM job_outbox WHERE id=$1', [id])).rows[0].failures).toBe(0);
  });
  it('labels intent logs as uncommitted and preserves request correlation even when the business transaction rolls back', async () => {
    const client = await pool.connect(), requestId = crypto.randomUUID();
    let id: string | undefined;
    try {
      await client.query('BEGIN');
      id = await requestContext.run({ requestId, userId: () => undefined }, () => enqueueOutbox(client, { key: crypto.randomUUID(), kind: 'DOMAIN_EVENT', payload: { secret } }));
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect(records.find(r => r.jobId === id)).toMatchObject({ requestId, outcome: 'uncommitted' });
    expect((await pool.query('SELECT 1 FROM job_outbox WHERE id=$1', [id])).rowCount).toBe(0);
  });
  it('records execution through a real BullMQ worker after dispatcher publication', async () => {
    const id = await create('BILLING_RECHECK');
    queue = createJobQueue('phase3-' + crypto.randomUUID());
    await queue.waitUntilReady();
    worker = startJobWorker(pool, queue.name); await worker.waitUntilReady();
    await dispatchOutbox(pool, queue);
    const deadline = Date.now() + 8000;
    while (!records.some(r => r.event === 'job.completed' && r.jobId === id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    expect(records.find(r => r.event === 'job.completed' && r.jobId === id)).toMatchObject({ attempt: 1, jobType: 'BILLING_RECHECK', durationMs: expect.any(Number) });
  });
});
