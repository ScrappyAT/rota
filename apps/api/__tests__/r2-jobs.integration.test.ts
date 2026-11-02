import crypto from 'crypto';
import path from 'path';
import { fork, ChildProcess } from 'child_process';
import request from 'supertest';
import { Queue, Worker } from 'bullmq';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { enqueueOutbox, replayDeadJob } from '../src/services/outbox';
import { createJobQueue, dispatchOutbox, processOutboxJob, startJobWorker, jobBackoff } from '../src/services/job-runtime';
import { notify } from '../src/services/notifications';
import { writeSettings } from '../src/services/settings';
import { initializeCheckout, verifyTransaction, verifyTransactionByReference } from '../src/billing/flutterwave';
import { addActivity } from '../src/services/activity';
jest.mock('../src/billing/flutterwave', () => ({ ...jest.requireActual('../src/billing/flutterwave'), initializeCheckout: jest.fn(), verifyTransaction: jest.fn(), verifyTransactionByReference: jest.fn() }));
const initialize = jest.mocked(initializeCheckout), verify = jest.mocked(verifyTransaction), byReference = jest.mocked(verifyTransactionByReference);
const fetchMock = jest.spyOn(globalThis, 'fetch');
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (check: () => Promise<boolean>, timeout = 8000) => {
  const end = Date.now() + timeout; while (Date.now() < end) {
    if (await check())
      return;
    await pause();
  } throw new Error('Failure drill timed out');
};
const tx = async <T>(fn: (client: import('pg').PoolClient) => Promise<T>) => {
  const client = await pool.connect(); try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  }
    catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    finally {
    client.release();
  }
};
let owner: string, ownerId: string, staffId: string, team: string, queue: Queue, worker: Worker | undefined, child: ChildProcess | undefined;
const outbox = async (id: string) => (await pool.query('SELECT * FROM job_outbox WHERE id=$1', [id])).rows[0];
const push = async (key = crypto.randomUUID()) => {
  await notify({ teamId: team, userId: staffId, type: 'SHIFT_ASSIGNED', title: 'R2 test', body: 'R2 test', data: { teamId: team, shiftId: crypto.randomUUID(), event: 'shift_assigned' }, eventKey: key });
  return (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['push:' + key])).rows[0].id as string;
};
const start = async () => { worker = startJobWorker(pool, queue.name, { lockDuration: 1000, stalledInterval: 250 }); await worker.waitUntilReady(); };
const runQueued = async (id: string) => { await start(); await dispatchOutbox(pool, queue); await waitFor(async () => ['COMPLETED', 'DEAD'].includes((await outbox(id)).status)); };
const checkout = async () => request(app).post(`/teams/${team}/subscription/checkout`).set('Authorization', `Bearer ${owner}`).set('Idempotency-Key', crypto.randomUUID()).send({ planCode: 'STARTER', seats: 5 });
describe('R2 real PostgreSQL/Redis workers and failure recovery', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5540' || url.pathname !== '/rota_r1_test')
      throw new Error('Disposable R2 server only');
    await redisClient.connect().catch(() => { });
    for (let i = 0;i < 2;i++) {
      const result = await request(app).post('/auth/register').send({ email: `r2-${crypto.randomUUID()}@test.example`, password: 'password123', firstName: 'R2', lastName: 'Test' });
      expect(result.status).toBe(201);
      if (i === 0) {
        owner = result.body.data.accessToken;
        ownerId = result.body.data.user.id;
      }
      else
        staffId = result.body.data.user.id;
    }
    const created = await request(app).post('/teams').set('Authorization', `Bearer ${owner}`).send({ name: 'R2 drills' });
    expect(created.status).toBe(201);
    team = created.body.data.id;
    await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'STAFF')", [team, staffId]);
    await pool.query("INSERT INTO device_tokens(user_id,token) VALUES($1,'ExponentPushToken[r2-device]')", [staffId]);
    queue = createJobQueue('r2-drills-' + crypto.randomUUID());
    queue.on('error', () => { });
    await queue.waitUntilReady();
  });
  beforeEach(async () => {
    const created = await request(app).post('/teams').set('Authorization', `Bearer ${owner}`).send({ name: 'Independent R2 drill' });
    expect(created.status).toBe(201);
    team = created.body.data.id;
    await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'STAFF')", [team, staffId]);
    await pool.query("DELETE FROM device_tokens WHERE user_id=$1 AND token<>'ExponentPushToken[r2-device]'", [staffId]);
    await pool.query('DELETE FROM job_outbox');
    await queue.obliterate({ force: true });
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok', id: 'mock-ticket' }] }) } as Response);
    initialize.mockReset().mockResolvedValue({ link: 'https://checkout.test/r2' });
    verify.mockReset();
    byReference.mockReset();
    await tx(client => writeSettings(client, staffId, { quietHours: { enabled: false, start: '22:00', end: '06:00' }, notificationCategories: { shifts: true, swaps: true, billing: true }, notificationTypes: { shiftAssigned: true } }));
  });
  afterEach(async () => {
    if (child) {
      child.kill('SIGKILL');
      child = undefined;
    } await worker?.close(); worker = undefined;
  });
  afterAll(async () => { await queue.obliterate({ force: true }); await queue.close(); fetchMock.mockRestore(); await pool.end(); await redisClient.quit(); });
  it('rolls back a business change, its notification and all outbox rows atomically', async () => {
    const key = crypto.randomUUID();
    await expect(tx(async (client) => {
      await addActivity(client, { teamId: team, actorId: ownerId, type: 'SHIFT_UPDATED', payload: { marker: key } });
      await notify({ teamId: team, userId: staffId, type: 'SHIFT_ASSIGNED', title: 'rollback', body: 'rollback', eventKey: key }, client);
      throw new Error('simulated transaction abort');
    })).rejects.toThrow('simulated transaction abort');
    expect((await pool.query('SELECT id FROM notifications WHERE event_key=$1', [key])).rows).toHaveLength(0);
    expect((await pool.query('SELECT id FROM job_outbox')).rows).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('commits a shift and its intent while no worker is running, then delivers after restart', async () => {
    const result = await request(app).post(`/teams/${team}/shifts`).set('Authorization', `Bearer ${owner}`).send({ title: 'durable shift', startsAt: '2027-01-01T09:00:00Z', endsAt: '2027-01-01T17:00:00Z', assigneeIds: [staffId] });
    expect(result.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
    const id = (await pool.query("SELECT id FROM job_outbox WHERE kind='NOTIFICATION'")).rows[0].id;
    await runQueued(id);
    expect((await outbox(id)).status).toBe('COMPLETED');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('backs off rejected pushes and succeeds on the third bounded attempt', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 } as Response).mockResolvedValueOnce({ ok: false, status: 429 } as Response);
    const id = await push();
    await runQueued(id);
    expect((await outbox(id))).toMatchObject({ status: 'COMPLETED', failures: 2, attempts: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const attempts = (await pool.query('SELECT outcome,started_at FROM job_attempts WHERE outbox_id=$1 ORDER BY attempt', [id])).rows;
    expect(attempts.map(r => r.outcome)).toEqual(['RETRYABLE', 'RETRYABLE', 'COMPLETED']);
    expect(jobBackoff(2)).toBe(jobBackoff(1) * 2);
  });
  it('retains a dead job after the bounded budget and replays explicitly after repair', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503 } as Response);
    const id = await push();
    await runQueued(id);
    expect((await outbox(id))).toMatchObject({ status: 'DEAD', failures: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await waitFor(async () => await (await queue.getJob(id + '-0'))!.getState() === 'failed');
    expect(await (await queue.getJob(id + '-0'))!.getState()).toBe('failed');
    await tx(client => replayDeadJob(client, id));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) } as Response);
    await dispatchOutbox(pool, queue);
    await waitFor(async () => (await outbox(id)).status === 'COMPLETED');
    expect((await outbox(id)).manual_replays).toBe(1);
  });
  it('replaying completed work or racing processors does not send another push', async () => {
    const id = await push();
    await Promise.allSettled([processOutboxJob(pool, id), processOutboxJob(pool, id)]);
    await processOutboxJob(pool, id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await pool.query("UPDATE job_outbox SET status='PENDING' WHERE id=$1", [id]);
    await processOutboxJob(pool, id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('suppresses a category disabled after enqueueing', async () => {
    const id = await push();
    await tx(client => writeSettings(client, staffId, { notificationCategories: { shifts: false } }));
    await runQueued(id);
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await pool.query("SELECT status FROM notifications WHERE id=(SELECT (payload->>'notificationId')::uuid FROM job_outbox WHERE id=$1)", [id])).rows[0].status).toBe('SKIPPED');
  });
  it('defers quiet-hour pushes and rechecks changed preferences before the due send', async () => {
    await tx(client => writeSettings(client, staffId, { timeZone: 'Africa/Lagos', quietHours: { enabled: true, start: '22:00', end: '06:00' } }));
    const id = await push();
    await pool.query("UPDATE job_outbox SET available_at='2026-11-01T00:00:00Z' WHERE id=$1", [id]);
    await processOutboxJob(pool, id, new Date('2026-11-02T01:00:00Z'));
    const deferred = await outbox(id);
    expect(deferred.status).toBe('PENDING');
    expect(deferred.available_at.toISOString()).toBe('2026-11-02T05:00:00.000Z');
    expect(deferred.failures).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    await tx(client => writeSettings(client, staffId, { notificationCategories: { shifts: false } }));
    await processOutboxJob(pool, id, new Date('2026-11-02T05:00:00Z'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await outbox(id)).status).toBe('COMPLETED');
  });
  it('a deferred notification sends once when its permitted window opens', async () => {
    await tx(client => writeSettings(client, staffId, { timeZone: 'UTC', quietHours: { enabled: true, start: '22:00', end: '06:00' } }));
    const id = await push();
    await pool.query("UPDATE job_outbox SET available_at='2026-11-01T00:00:00Z' WHERE id=$1", [id]);
    await processOutboxJob(pool, id, new Date('2026-11-02T02:00:00Z'));
    await processOutboxJob(pool, id, new Date('2026-11-02T06:00:00Z'));
    await processOutboxJob(pool, id, new Date('2026-11-02T06:00:00Z'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('losing Redis queue contents is recoverable from PostgreSQL', async () => {
    const id = await push();
    await dispatchOutbox(pool, queue);
    expect(await queue.getJob(id + '-0')).toBeDefined();
    await queue.obliterate({ force: true });
    await pool.query('UPDATE job_outbox SET next_dispatch_at=NOW() WHERE id=$1', [id]);
    await runQueued(id);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('initialization is queued and an ambiguous result is recovered only by reference verification', async () => {
    initialize.mockRejectedValueOnce(new Error('lost response'));
    const response = await checkout();
    expect(response.status).toBe(202);
    expect(initialize).not.toHaveBeenCalled();
    const payment = response.body.data.payment;
    const init = (await pool.query("SELECT id FROM job_outbox WHERE event_key=$1", ['initialize:' + payment.id])).rows[0].id;
    await processOutboxJob(pool, init);
    await pool.query("UPDATE job_outbox SET status='PENDING' WHERE id=$1", [init]);
    await processOutboxJob(pool, init);
    expect(initialize).toHaveBeenCalledTimes(1);
    byReference.mockResolvedValue({ transactionId: crypto.randomUUID(), txRef: payment.txRef, amountMajor: '20.00', currency: 'USD', status: 'successful' });
    const reconcile = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['reconcile:' + payment.id])).rows[0].id;
    await pool.query('UPDATE job_outbox SET available_at=NOW() WHERE id=$1', [reconcile]);
    await processOutboxJob(pool, reconcile);
    await processOutboxJob(pool, reconcile);
    expect(byReference).toHaveBeenCalledTimes(1);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT status,initialization_state FROM payment_transactions WHERE id=$1', [payment.id])).rows[0]).toEqual({ status: 'SUCCESSFUL', initialization_state: 'RESOLVED' });
    expect((await pool.query("SELECT count(*)::int AS n FROM financial_ledger WHERE payment_id=$1 AND kind='CHARGE'", [payment.id])).rows[0].n).toBe(1);
  });
  it('a crash after the initialization claim never permits another checkout POST', async () => {
    const response = await checkout(), payment = response.body.data.payment;
    await pool.query("UPDATE payment_transactions SET initialization_state='CLAIMED' WHERE id=$1", [payment.id]);
    const id = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['initialize:' + payment.id])).rows[0].id;
    await processOutboxJob(pool, id);
    expect(initialize).not.toHaveBeenCalled();
  });
  it('unknown payment references exhaust verification attempts without creating another charge', async () => {
    const response = await checkout(), payment = response.body.data.payment;
    byReference.mockRejectedValue(new Error('not found yet'));
    const id = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['reconcile:' + payment.id])).rows[0].id;
    await pool.query('UPDATE job_outbox SET available_at=NOW() WHERE id=$1', [id]);
    for (let i = 0;i < 3;i++)
      await processOutboxJob(pool, id).catch(() => { });
    expect((await outbox(id)).status).toBe('DEAD');
    expect(byReference).toHaveBeenCalledTimes(3);
    expect(initialize).not.toHaveBeenCalled();
    expect((await pool.query('SELECT initialization_state FROM payment_transactions WHERE id=$1', [payment.id])).rows[0].initialization_state).toBe('MANUAL_REVIEW');
  });
  it('webhooks acknowledge before provider work, ignore spoofed body amounts and replay safely', async () => {
    const response = await checkout(), payment = response.body.data.payment;
    process.env.FLW_SECRET_HASH = 'r2-test-hash';
    const webhookId = crypto.randomUUID();
    const body = { event: 'charge.completed', data: { id: webhookId, tx_ref: payment.txRef, amount: '0.01', currency: 'NGN', status: 'failed' } };
    verify.mockResolvedValue({ transactionId: webhookId, txRef: payment.txRef, amountMajor: '20.00', currency: 'USD', status: 'successful' });
    const send = () => request(app).post('/billing/webhook/flutterwave').set('verif-hash', 'r2-test-hash').send(body);
    expect((await send()).body.data.reason).toBe('queued');
    expect(verify).not.toHaveBeenCalled();
    const id = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['webhook:charge.completed:' + webhookId])).rows[0].id;
    await processOutboxJob(pool, id);
    await processOutboxJob(pool, id);
    expect((await send()).body.data.reason).toBe('duplicate');
    expect(verify).toHaveBeenCalledTimes(1);
    expect((await pool.query('SELECT status FROM payment_transactions WHERE id=$1', [payment.id])).rows[0].status).toBe('SUCCESSFUL');
    expect((await request(app).post('/billing/webhook/flutterwave').set('verif-hash', 'wrong').send(body)).status).toBe(401);
  });
  it('per-device replay preserves successful devices and retries only rejected ones', async () => {
    await pool.query("INSERT INTO device_tokens(user_id,token) VALUES($1,'ExponentPushToken[r2-second]')", [staffId]);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ status: 'ok' }] }) } as Response).mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const id = await push();
    await processOutboxJob(pool, id).catch(() => { });
    await processOutboxJob(pool, id);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const bodies = fetchMock.mock.calls.map(call => JSON.parse(call[1]!.body as string).to[0]);
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(bodies[2]).toBe(bodies[1]);
    await pool.query("DELETE FROM device_tokens WHERE token='ExponentPushToken[r2-second]'");
  });
  it('publishes a quiet-hours deferral into the real BullMQ delayed set', async () => {
    const now = new Date(), start = new Date(now.getTime() - 60000), end = new Date(now.getTime() + 120000);
    const hhmm = (date: Date) => date.toISOString().slice(11, 16);
    await tx(client => writeSettings(client, staffId, { timeZone: 'UTC', quietHours: { enabled: true, start: hhmm(start), end: hhmm(end) } }));
    const id = await push();
    await processOutboxJob(pool, id);
    await dispatchOutbox(pool, queue);
    const row = await outbox(id);
    expect(await (await queue.getJob(id + '-' + row.generation))!.getState()).toBe('delayed');
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('checks receipts in a separate job and prunes a token reported invalid later', async () => {
    const id = await push();
    await processOutboxJob(pool, id);
    const notificationId = (await outbox(id)).payload.notificationId;
    const receipt = (await pool.query("SELECT id FROM job_outbox WHERE payload->>'notificationId'=$1 AND payload->>'receiptCheck'='true'", [notificationId])).rows[0].id;
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ data: { 'mock-ticket': { status: 'error', details: { error: 'DeviceNotRegistered' } } } }) } as Response);
    await pool.query('UPDATE job_outbox SET available_at=NOW() WHERE id=$1', [receipt]);
    await processOutboxJob(pool, receipt);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).toEqual({ ids: ['mock-ticket'] });
    expect((await pool.query('SELECT token FROM device_tokens WHERE user_id=$1', [staffId])).rows).toHaveLength(0);
    await pool.query("INSERT INTO device_tokens(user_id,token) VALUES($1,'ExponentPushToken[r2-device]')", [staffId]);
  });
  it('rejects another tenant and malformed IDs on the exact swap destination', async () => {
    const shift = await request(app).post(`/teams/${team}/shifts`).set('Authorization', `Bearer ${owner}`).send({ title: 'deep link', startsAt: '2027-01-01T09:00:00Z', endsAt: '2027-01-01T17:00:00Z', assigneeIds: [ownerId] });
    expect(shift.status).toBe(201);
    const swap = await request(app).post(`/teams/${team}/shifts/${shift.body.data.id}/swaps`).set('Authorization', `Bearer ${owner}`).send({ offeredTo: staffId });
    expect(swap.status).toBe(201);
    const target = `/teams/${team}/swaps/${swap.body.data.id}`;
    expect((await request(app).get(target).set('Authorization', `Bearer ${owner}`)).body.data.id).toBe(swap.body.data.id);
    const registration = await request(app).post('/auth/register').send({ email: `outsider-${crypto.randomUUID()}@test.example`, password: 'password123', firstName: 'Out', lastName: 'Side' });
    expect((await request(app).get(target).set('Authorization', `Bearer ${registration.body.data.accessToken}`)).status).toBe(404);
    expect((await request(app).get(`/teams/${team}/swaps/not-a-uuid`).set('Authorization', `Bearer ${owner}`)).status).toBe(400);
  });

  it('notifies the owner on failed renewal and schedules restriction while preserving R1 safeguards', async () => {
    await pool.query("INSERT INTO device_tokens(user_id,token) VALUES($1,'ExponentPushToken[r2-owner]') ON CONFLICT DO NOTHING", [ownerId]);
    await tx(client => writeSettings(client, ownerId, { notificationCategories: { billing: true }, quietHours: { enabled: false, start: '22:00', end: '06:00' } }));
    const first = await checkout(), paid = first.body.data.payment;
    byReference.mockResolvedValue({ transactionId: crypto.randomUUID(), txRef: paid.txRef, amountMajor: '20.00', currency: 'USD', status: 'successful' });
    const reconcile = async (paymentId: string) => {
      const id = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['reconcile:' + paymentId])).rows[0].id;
      await pool.query('UPDATE job_outbox SET available_at=NOW() WHERE id=$1', [id]); await processOutboxJob(pool, id);
    };
    await reconcile(paid.id);
    const key = crypto.randomUUID();
    const renew = () => request(app).post(`/teams/${team}/subscription/renew`).set('Authorization', `Bearer ${owner}`).set('Idempotency-Key', key).send({});
    const renewal = await renew(), failed = renewal.body.data.payment;
    byReference.mockResolvedValue({ transactionId: crypto.randomUUID(), txRef: failed.txRef, amountMajor: '20.00', currency: 'USD', status: 'failed' });
    await reconcile(failed.id);
    expect((await renew()).body.data.payment.status).toBe('FAILED');
    const domain = (await pool.query("SELECT id FROM job_outbox WHERE team_id=$1 AND payload->>'type'='RENEWAL_FAILED'", [team])).rows[0].id;
    await processOutboxJob(pool, domain);
    const notice = (await pool.query("SELECT o.id FROM job_outbox o JOIN notifications n ON n.id::text=o.payload->>'notificationId' WHERE n.team_id=$1 AND n.data->>'event'='billing_renewal_failed'", [team])).rows[0].id;
    await processOutboxJob(pool, notice);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).toMatchObject({ to: ['ExponentPushToken[r2-owner]'], data: { teamId: team, event: 'billing_renewal_failed' } });
    const grace = (await pool.query('SELECT grace_ends_at,status FROM team_subscriptions WHERE team_id=$1', [team])).rows[0]; expect(grace.status).toBe('PAST_DUE');
    const check = (await pool.query('SELECT id FROM job_outbox WHERE event_key=$1', ['grace:' + failed.id])).rows[0].id;
    await processOutboxJob(pool, check, grace.grace_ends_at);
    expect((await pool.query('SELECT status FROM team_subscriptions WHERE team_id=$1', [team])).rows[0].status).toBe('EXPIRED');
  });
  it.each(['before', 'push'])('recovers after a killed worker (%s), with no unsafe resend', async (mode) => {
    const id = await push();
    await dispatchOutbox(pool, queue);
    child = fork(path.join(__dirname, 'fixtures/stalling-worker.ts'), [], { cwd: path.resolve(__dirname, '../../..'), execArgv: ['-r', 'ts-node/register/transpile-only'], env: { ...process.env, R2_DRILL_CHILD: 'true', R2_DRILL_QUEUE: queue.name, R2_DRILL_MODE: mode, TS_NODE_PROJECT: 'apps/api/tsconfig.json' }, silent: true });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Drill child did not reach checkpoint')), 15000); child!.once('message', () => { clearTimeout(timeout); resolve(); }); child!.once('error', reject); child!.once('exit', code => {
        if (code)
          reject(new Error('Drill child exited: ' + code));
      });
    });
    const stopped = child;
    await new Promise<void>(resolve => { stopped!.once('exit', () => resolve()); stopped!.kill('SIGKILL'); });
    child = undefined;
    await start();
    await waitFor(async () => ['COMPLETED', 'DEAD'].includes((await outbox(id)).status), 10000);
    if (mode === 'before') {
      expect((await outbox(id)).status).toBe('COMPLETED');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
    else {
      expect((await outbox(id)).status).toBe('DEAD');
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(tx(client => replayDeadJob(client, id))).rejects.toMatchObject({ code: 'DELIVERY_UNCERTAIN' });
      expect((await pool.query("SELECT outcome FROM job_attempts WHERE outbox_id=$1 ORDER BY attempt", [id])).rows.map(r => r.outcome)).toEqual(['INTERRUPTED', 'DEAD']);
    }
  }, 25000);
});
