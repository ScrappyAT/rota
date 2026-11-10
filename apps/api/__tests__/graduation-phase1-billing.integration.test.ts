import crypto from 'crypto';
import request from 'supertest';
import { PoolClient } from 'pg';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { billingConfig } from '../src/billing/config';
import { initializeCheckout, verifyTransaction } from '../src/billing/flutterwave';
import { materializeSubscription } from '../src/billing/service';
import { snapshotSubscription, reconstructSubscription } from '../src/billing/ledger';
import { processOutboxJob } from '../src/services/job-runtime';
import { minorToMajor, addDays } from '../src/billing/proration';

jest.mock('../src/billing/flutterwave', () => ({
  ...jest.requireActual('../src/billing/flutterwave'), initializeCheckout: jest.fn(), verifyTransaction: jest.fn(),
}));
const initialize = jest.mocked(initializeCheckout), verify = jest.mocked(verifyTransaction);
const boundary = new Date('2026-11-09T00:00:00Z');
const before = new Date('2026-11-08T00:00:00Z');
interface Fixture { team: string; owner: { id: string; email: string; token: string } }
interface Payment { id: string; txRef: string; amountMinor: number; currency: string }
const tx = async <T>(fn: (client: PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
};
const post = (f: Fixture, operation: string, body: object = {}, key = crypto.randomUUID()) =>
  request(app).post(`/teams/${f.team}/subscription/${operation}`).set('Authorization', `Bearer ${f.owner.token}`).set('Idempotency-Key', key).send(body);
const fixture = async (now: Date): Promise<Fixture> => {
  jest.setSystemTime(now);
  const email = `phase1-${crypto.randomUUID()}@example.test`;
  const registered = await request(app).post('/auth/register').send({ email, password: 'Password123', firstName: 'Phase1', lastName: 'Owner' });
  expect(registered.status).toBe(201);
  const owner = { id: registered.body.data.user.id as string, email, token: registered.body.data.accessToken as string };
  const created = await request(app).post('/teams').set('Authorization', `Bearer ${owner.token}`).send({ name: 'Phase 1 isolated billing' });
  expect(created.status).toBe(201);
  const team = created.body.data.id as string;
  // A paid fixture with an immutable baseline, not a real provider charge.
  await tx(async client => {
    await client.query(`UPDATE team_subscriptions SET plan_code='TEAM_USD_V1',seats=15,revision=1,
      period_started_at=$2,period_ends_at=$3 WHERE team_id=$1`, [team, addDays(boundary, -30), boundary]);
    await snapshotSubscription(client, team, 'phase1 paid fixture');
  });
  return { team, owner };
};
const changeTime = async (f: Fixture, now: Date) => {
  jest.setSystemTime(now);
  const login = await request(app).post('/auth/login').send({ email: f.owner.email, password: 'Password123' });
  expect(login.status).toBe(200); f.owner.token = login.body.data.accessToken;
};
const subscription = async (f: Fixture) => (await pool.query('SELECT * FROM team_subscriptions WHERE team_id=$1', [f.team])).rows[0];
const initializePayment = async (f: Fixture, operation = 'renew', body: object = {}, key = crypto.randomUUID()): Promise<Payment> => {
  const result = await post(f, operation, body, key); expect(result.status).toBe(202);
  const payment = result.body.data.payment as Payment;
  const job = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['initialize:' + payment.id])).rows[0];
  await processOutboxJob(pool, job.id);
  return payment;
};
const confirm = async (f: Fixture, payment: Payment, status: string, now = new Date()) => {
  const transactionId = crypto.randomUUID();
  verify.mockResolvedValueOnce({ transactionId, txRef: payment.txRef, amountMajor: minorToMajor(payment.amountMinor), currency: payment.currency, status });
  const response = await post(f, 'verify', { transactionId, txRef: payment.txRef }); expect(response.status).toBe(202);
  await processOutboxJob(pool, response.body.data.jobId, now);
  return (await pool.query('SELECT result FROM job_outbox WHERE id=$1', [response.body.data.jobId])).rows[0].result;
};
const graceJobs = async (f: Fixture) => (await pool.query("SELECT * FROM job_outbox WHERE team_id=$1 AND event_key LIKE 'grace:%'", [f.team])).rows;
const failedEvents = async (f: Fixture) => (await pool.query("SELECT * FROM job_outbox WHERE team_id=$1 AND payload->>'type'='RENEWAL_FAILED'", [f.team])).rows;
const financialRows = async (f: Fixture) => (await pool.query("SELECT * FROM financial_ledger WHERE team_id=$1 AND kind<>'STATE' ORDER BY sequence", [f.team])).rows;
const assertGrace = async (f: Fixture, firstFailure: Date) => {
  const sub = await subscription(f);
  expect(sub.status).toBe('PAST_DUE');
  expect(sub.last_renewal_failed_at.toISOString()).toBe(firstFailure.toISOString());
  expect(sub.grace_ends_at.toISOString()).toBe(addDays(firstFailure, billingConfig.graceDays).toISOString());
  expect(await graceJobs(f)).toHaveLength(1); expect(await failedEvents(f)).toHaveLength(1);
  expect((await graceJobs(f))[0].available_at.toISOString()).toBe(sub.grace_ends_at.toISOString());
  expect(await financialRows(f)).toHaveLength(0);
  const rebuilt = await tx(client => reconstructSubscription(client, f.team));
  expect(rebuilt.status).toBe(sub.status); expect(rebuilt.revision).toBe(sub.revision);
};

beforeAll(async () => {
  if (!process.env.DATABASE_URL?.includes('127.0.0.1:5540/rota_r1_test') || process.env.REDIS_URL !== 'redis://127.0.0.1:6480') throw new Error('Disposable Phase 1 infrastructure required');
  await redisClient.connect();
  jest.useFakeTimers({ now: boundary, doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'nextTick', 'queueMicrotask', 'performance', 'hrtime'] });
  initialize.mockImplementation(async input => ({ link: `https://checkout.invalid/${input.txRef}` }));
  jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External providers prohibited in Phase 1 tests'));
});
beforeEach(() => { initialize.mockClear(); verify.mockReset(); });
afterAll(async () => { jest.useRealTimers(); jest.restoreAllMocks(); await redisClient.quit(); await pool.end(); });

it.each([['before', before], ['exactly at', boundary], ['after', addDays(boundary, 2)]] as const)(
  'grants one documented grace window when renewal starts %s period end and fails', async (_label, now) => {
    const f = await fixture(now), payment = await initializePayment(f);
    expect(payment.amountMinor).toBe(5000); expect(payment.currency).toBe('USD');
    expect((await confirm(f, payment, 'failed', now)).outcome).toBe('FAILED');
    await assertGrace(f, now); expect(initialize).toHaveBeenCalledTimes(1);
  }, 15000);

it('accepts a delayed failed renewal after a clock-only expiration without losing grace', async () => {
  const f = await fixture(before), payment = await initializePayment(f);
  await tx(client => materializeSubscription(client, f.team, boundary));
  await confirm(f, payment, 'failed', addDays(boundary, 1));
  await assertGrace(f, addDays(boundary, 1));
});

it('a verification outage changes no payment, subscription or ledger and retries the same job safely', async () => {
  const f = await fixture(boundary), payment = await initializePayment(f), transactionId = crypto.randomUUID();
  const original = await subscription(f);
  const response = await post(f, 'verify', { txRef: payment.txRef, transactionId }); expect(response.status).toBe(202);
  verify.mockRejectedValueOnce(new Error('Provider verification unavailable'));
  await expect(processOutboxJob(pool, response.body.data.jobId)).rejects.toThrow('Provider verification unavailable');
  expect(await subscription(f)).toEqual(original);
  expect((await pool.query('SELECT status FROM payment_transactions WHERE id=$1', [payment.id])).rows[0].status).toBe('PENDING');
  expect(await graceJobs(f)).toHaveLength(0); expect(await financialRows(f)).toHaveLength(0);
  verify.mockResolvedValueOnce({ transactionId, txRef: payment.txRef, amountMajor: '50.00', currency: 'USD', status: 'failed' });
  await processOutboxJob(pool, response.body.data.jobId); await assertGrace(f, boundary);
  expect(initialize).toHaveBeenCalledTimes(1);
});

it('applies a delayed successful renewal after clock-only expiration once, instead of posting an unapplied credit', async () => {
  const f = await fixture(before), payment = await initializePayment(f);
  await tx(client => materializeSubscription(client, f.team, boundary));
  const settled = addDays(boundary, 1);
  await confirm(f, payment, 'successful', settled); await confirm(f, payment, 'successful', settled);
  const sub = await subscription(f);
  expect(sub.status).toBe('ACTIVE'); expect(sub.period_started_at.toISOString()).toBe(settled.toISOString());
  expect(sub.period_ends_at.toISOString()).toBe(addDays(settled, billingConfig.periodDays).toISOString());
  expect((await financialRows(f)).map(row => row.kind)).toEqual(['CHARGE']);
});

it('deduplicates concurrent failed webhooks, owner notices, grace jobs and ledger snapshots', async () => {
  const f = await fixture(boundary), payment = await initializePayment(f), transactionId = crypto.randomUUID();
  verify.mockResolvedValue({ transactionId, txRef: payment.txRef, amountMajor: '50.00', currency: 'USD', status: 'failed' });
  const send = () => request(app).post('/billing/webhook/flutterwave').set('verif-hash', process.env.FLW_SECRET_HASH!).send({ event: 'charge.completed', data: { id: transactionId, tx_ref: payment.txRef } });
  const responses = await Promise.all([send(), send(), send()]); expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
  expect(responses.filter(r => r.body.data.reason === 'queued')).toHaveLength(1);
  const job = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['webhook:charge.completed:' + transactionId])).rows[0];
  await processOutboxJob(pool, job.id); await processOutboxJob(pool, job.id);
  await assertGrace(f, boundary);
  const events = await failedEvents(f); await processOutboxJob(pool, events[0].id); await processOutboxJob(pool, events[0].id);
  expect((await pool.query("SELECT id FROM notifications WHERE team_id=$1 AND data->>'event'='billing_renewal_failed'", [f.team])).rows).toHaveLength(1);
  expect(verify).toHaveBeenCalledTimes(1);
});

it('repeated renewal failures and idempotency-key replay cannot extend or reopen the cycle grace window', async () => {
  const f = await fixture(boundary), key = crypto.randomUUID(), first = await initializePayment(f, 'renew', {}, key);
  await confirm(f, first, 'failed'); const grace = (await subscription(f)).grace_ends_at as Date;
  const replay = await post(f, 'renew', {}, key); expect(replay.body.data.payment.id).toBe(first.id);
  const second = await initializePayment(f); await confirm(f, second, 'failed', addDays(boundary, 1));
  await assertGrace(f, boundary); expect(initialize).toHaveBeenCalledTimes(2);
  await processOutboxJob(pool, (await graceJobs(f))[0].id, grace);
  const third = await initializePayment(f); await confirm(f, third, 'failed', addDays(grace, 1));
  const expired = await subscription(f); expect(expired.status).toBe('EXPIRED'); expect(expired.grace_ends_at).toEqual(grace);
  expect(await graceJobs(f)).toHaveLength(1); expect(await failedEvents(f)).toHaveLength(1);
});

it('allows protected scheduling during grace, restricts at the exact deadline, and permits a successful retry', async () => {
  const f = await fixture(boundary), first = await initializePayment(f); await confirm(f, first, 'failed');
  const shift = () => request(app).post(`/teams/${f.team}/shifts`).set('Authorization', `Bearer ${f.owner.token}`).send({ title: 'Grace access', startsAt: '2027-01-01T09:00:00Z', endsAt: '2027-01-01T17:00:00Z' });
  expect((await shift()).status).toBe(201);
  const grace = (await subscription(f)).grace_ends_at as Date;
  const check = (await graceJobs(f))[0]; await processOutboxJob(pool, check.id, grace); await processOutboxJob(pool, check.id, grace);
  await changeTime(f, grace);
  expect((await shift()).status).toBe(403);
  expect((await request(app).get(`/teams/${f.team}/shifts`).set('Authorization', `Bearer ${f.owner.token}`)).status).toBe(200);
  const recovery = addDays(grace, 1); await changeTime(f, recovery);
  const retry = await initializePayment(f); await confirm(f, retry, 'successful', recovery);
  const restored = await subscription(f); expect(restored.status).toBe('ACTIVE'); expect(restored.grace_ends_at).toBeNull(); expect(restored.last_renewal_failed_at).toBeNull();
  expect((await shift()).status).toBe(201); expect((await financialRows(f)).map(row => row.kind)).toEqual(['CHARGE']);
});

it('allows an already pending successful renewal across grace and expiry without weakening paid-change revisions', async () => {
  const f = await fixture(boundary), first = await initializePayment(f), pending = await initializePayment(f);
  await confirm(f, first, 'failed'); const grace = (await subscription(f)).grace_ends_at as Date;
  await processOutboxJob(pool, (await graceJobs(f))[0].id, grace);
  await confirm(f, pending, 'successful', addDays(grace, 1));
  expect((await subscription(f)).status).toBe('ACTIVE'); expect((await financialRows(f)).map(row => row.kind)).toEqual(['CHARGE']);
});

it('late renewal failure/success cannot undo a newer paid upgrade', async () => {
  const f = await fixture(boundary), failed = await initializePayment(f), pending = await initializePayment(f);
  const upgrade = await initializePayment(f, 'checkout', { planCode: 'BUSINESS', seats: 40 }); await confirm(f, upgrade, 'successful');
  const upgraded = await subscription(f); await confirm(f, failed, 'failed'); await confirm(f, pending, 'successful');
  expect(await subscription(f)).toEqual(upgraded); expect(await graceJobs(f)).toHaveLength(0);
  expect((await financialRows(f)).filter(row => row.event_key === 'superseded-credit:' + pending.id)).toHaveLength(1);
});

it('a newer successful renewal fences an older success even when the plan and seats are unchanged', async () => {
  const f = await fixture(boundary), older = await initializePayment(f), newer = await initializePayment(f);
  await confirm(f, newer, 'successful'); const renewed = await subscription(f);
  await confirm(f, older, 'successful', addDays(boundary, 1));
  expect(await subscription(f)).toEqual(renewed);
  expect((await financialRows(f)).filter(row => row.event_key === 'superseded-credit:' + older.id)).toHaveLength(1);
});

it('a scheduled downgrade preserves an existing grace deadline instead of creating a second window', async () => {
  const f = await fixture(before), first = await initializePayment(f); await confirm(f, first, 'failed');
  const grace = (await subscription(f)).grace_ends_at as Date;
  expect((await post(f, 'checkout', { planCode: 'STARTER', seats: 5 })).status).toBe(200);
  await changeTime(f, boundary);
  const retry = await initializePayment(f); expect(retry.amountMinor).toBe(2000);
  expect((await subscription(f)).status).toBe('PAST_DUE'); expect((await subscription(f)).grace_ends_at).toEqual(grace);
  await confirm(f, retry, 'failed'); expect((await subscription(f)).grace_ends_at).toEqual(grace);
  expect(await graceJobs(f)).toHaveLength(1); expect(await failedEvents(f)).toHaveLength(1);
});

it('a zero-due same-plan change cannot erase the first failure and restart grace', async () => {
  const f = await fixture(before), first = await initializePayment(f); await confirm(f, first, 'failed');
  const original = await subscription(f);
  expect((await post(f, 'checkout', { planCode: 'TEAM', seats: 15 })).status).toBe(200);
  const retry = await initializePayment(f); await confirm(f, retry, 'failed', boundary);
  const sub = await subscription(f);
  expect(sub.last_renewal_failed_at).toEqual(original.last_renewal_failed_at); expect(sub.grace_ends_at).toEqual(original.grace_ends_at);
  expect(await graceJobs(f)).toHaveLength(1); expect(await failedEvents(f)).toHaveLength(1);
});

it('applies a scheduled downgrade at the boundary, then grants grace at the lower renewal price', async () => {
  const f = await fixture(before);
  const scheduled = await post(f, 'checkout', { planCode: 'STARTER', seats: 5 }); expect(scheduled.status).toBe(200);
  expect((await subscription(f)).plan_code).toBe('TEAM_USD_V1'); expect((await post(f, 'renew')).status).toBe(409);
  await changeTime(f, boundary);
  const payment = await initializePayment(f); expect(payment.amountMinor).toBe(2000);
  await confirm(f, payment, 'failed'); await assertGrace(f, boundary);
  expect((await subscription(f)).plan_code).toBe('STARTER_USD_V1'); expect((await subscription(f)).scheduled_change_id).toBeNull();
});
