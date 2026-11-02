import { drainTestJobs } from './helpers/jobs';
import { processOutboxJob } from '../src/services/job-runtime';
import crypto from 'crypto';
import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';
import { initializeCheckout, verifyTransaction } from '../src/billing/flutterwave';
import { majorToMinor, minorToMajor } from '../src/billing/proration';
import { materializeSubscription } from '../src/billing/service';
import { appendLedger, recordRefund, reconstructSubscription, reconstructBilling } from '../src/billing/ledger';
import { PoolClient } from 'pg';
jest.mock('../src/billing/flutterwave', () => ({ ...jest.requireActual('../src/billing/flutterwave'), initializeCheckout: jest.fn(), verifyTransaction: jest.fn() }));
const initialize = jest.mocked(initializeCheckout), verify = jest.mocked(verifyTransaction);
interface Actor {
  token: string;
  id: string;
  email: string;
}
interface Payment {
  id: string;
  txRef: string;
  amountMinor: number;
  currency: string;
  status: string;
}
interface ChangeResult {
  change: {
    id: string;
    type: string;
    amountMinor: number;
    effectiveAt: string | null;
  };
  payment: Payment | null;
  checkoutUrl: string | null;
  processing: boolean;
}
let owner: Actor, outsider: Actor;
const gateways = new Map<string, {
  transactionId: string;
  txRef: string;
  amountMajor: string;
  currency: string;
  status: string;
}>();
const rawPost = (actor: Actor, team: string, operation: string, body: object = {}, key = crypto.randomUUID()) => request(app).post(`/teams/${team}/subscription/${operation}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', key).send(body);
// Model the real asynchronous client: submit, execute worker, then poll/replay.
const post = async (actor: Actor, team: string, operation: string, body: object = {}, key = crypto.randomUUID()) => {
  const response=await rawPost(actor,team,operation,body,key);
  if(response.status!==202)return response;
  if(operation==='verify'){
    try{await processOutboxJob(pool,response.body.data.jobId);}catch{/* Poll the durable failure, too. */}
    let verification=await request(app).get(`/teams/${team}/subscription/verifications/${response.body.data.jobId}`).set('Authorization',`Bearer ${actor.token}`);
    for(let i=0;verification.status===202&&i<50;i++){await new Promise(resolve=>setTimeout(resolve,10));verification=await request(app).get(`/teams/${team}/subscription/verifications/${response.body.data.jobId}`).set('Authorization',`Bearer ${actor.token}`);}
    return verification;
  }
  await drainTestJobs(['PAYMENT_INITIALIZE']);
  return rawPost(actor,team,operation,body,key);
};
const checkout = (team: string, planCode: string, seats?: number, key?: string) => post(owner, team, 'checkout', { planCode, ...(seats ? { seats } : {}) }, key);
const register = async (): Promise<Actor> => {
  const email = `r1-${crypto.randomUUID()}@test.example`;
  const res = await request(app).post('/auth/register').send({ email, password: 'password123', firstName: 'R1', lastName: 'Owner' });
  expect(res.status).toBe(201);
  return { token: res.body.data.accessToken, id: res.body.data.user.id, email };
};
const summary = async (team: string) => {
  const res = await request(app).get(`/teams/${team}/subscription`).set('Authorization', `Bearer ${owner.token}`);
  expect(res.status).toBe(200);
  return res.body.data;
};
const settle = async (team: string, payment: Payment, status = 'successful') => {
  const id = crypto.randomUUID();
  gateways.set(id, { transactionId: id, txRef: payment.txRef, amountMajor: minorToMajor(payment.amountMinor), currency: payment.currency, status });
  return post(owner, team, 'verify', { txRef: payment.txRef, transactionId: id });
};
const makeTeam = async (planCode?: string, seats?: number) => {
  const res = await request(app).post('/teams').set('Authorization', `Bearer ${owner.token}`).send({ name: 'R1 isolated team' });
  expect(res.status).toBe(201);
  const team = res.body.data.id as string;
  if (planCode) {
    const opened = await checkout(team, planCode, seats);
    expect(opened.status).toBe(201);
    expect((await settle(team, opened.body.data.payment)).body.data.outcome).toBe('SUCCESS');
  }
  return team;
};
const tx = async <T>(fn: (client: PoolClient) => Promise<T>) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  }
  catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
  finally {
    client.release();
  }
};
const webhook = async (body: object, hash = 'secret-hash-test') => {
  const payload=body as {event:string;data:{id:string;tx_ref:string;amount:string;currency:string;status:string}};
  gateways.set(String(payload.data.id),{transactionId:String(payload.data.id),txRef:payload.data.tx_ref,amountMajor:payload.data.amount,currency:payload.data.currency,status:payload.data.status});
  const response=await request(app).post('/billing/webhook/flutterwave').set('verif-hash',hash).send(body);
  if(response.status===200&&response.body.data.reason==='queued'){
    const job=(await pool.query('SELECT id FROM job_outbox WHERE event_key=$1',['webhook:'+payload.event+':'+payload.data.id])).rows[0];
    await processOutboxJob(pool,job.id);
    response.body.data={...response.body.data,...(await pool.query('SELECT result FROM job_outbox WHERE id=$1',[job.id])).rows[0].result};
  }
  return response;
};
describe('R1 billing API,financial integrity and legacy preservation', () => {
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (url.hostname !== '127.0.0.1' || url.port !== '5540' || url.pathname !== '/rota_r1_test')
      throw new Error('This suite requires the disposable R1 test database');
    await pool.query('DELETE FROM job_outbox');
    process.env.FLW_SECRET_HASH = 'secret-hash-test';
    initialize.mockImplementation(async (input) => ({ link: `https://checkout.test/${input.txRef}` }));
    verify.mockImplementation(async (id) => {
      const result = gateways.get(id); if (!result)
        throw new Error('Unknown mocked transaction'); return result;
    });
    await redisClient.connect().catch(() => { });
    owner = await register();
    outsider = await register();
  });
  afterAll(async () => { await pool.end(); await redisClient.quit().catch(() => { }); });
  it('01. provisions FREE without changing the legacy NGN plan records', async () => {
    const team = await makeTeam();
    expect((await summary(team)).subscription.planCode).toBe('FREE');
    expect((await pool.query("SELECT price_per_seat_minor,currency,max_seats FROM billing_plans WHERE code='STARTER'")).rows[0]).toEqual({ price_per_seat_minor: 250000, currency: 'NGN', max_seats: 10 });
  });
  it('02. exposes exactly the assignment USD catalog and included-seat prices', async () => {
    const team = await makeTeam();
    const res = await request(app).get(`/teams/${team}/subscription/plans`).set('Authorization', `Bearer ${owner.token}`);
    expect(res.body.data.map((p: {
      code: string;
      currency: string;
      basePriceMinor: number;
      includedSeats: number;
      extraSeatMinor: number | null;
    }) => [p.code, p.currency, p.basePriceMinor, p.includedSeats, p.extraSeatMinor]))
      .toEqual([['STARTER', 'USD', 2000, 5, null], ['TEAM', 'USD', 5000, 15, 300], ['BUSINESS', 'USD', 12000, 40, 200]]);
  });
  it('03. protects all billing writes and reconstruction from other tenants', async () => {
    const team = await makeTeam();
    expect((await post(outsider, team, 'checkout', { planCode: 'STARTER' })).status).toBe(404);
    expect((await request(app).get(`/teams/${team}/subscription/ledger/reconstruction`).set('Authorization', `Bearer ${outsider.token}`)).status).toBe(404);
  });
  it('04. requires a client idempotency key and rejects invalid seats/plans', async () => {
    const team = await makeTeam();
    expect((await request(app).post(`/teams/${team}/subscription/checkout`).set('Authorization', `Bearer ${owner.token}`).send({ planCode: 'STARTER' })).status).toBe(400);
    expect((await checkout(team, 'UNKNOWN')).status).toBe(400);
    expect((await checkout(team, 'STARTER', 6)).status).toBe(400);
    expect((await post(owner, team, 'seats', { seats: -1 })).status).toBe(400);
  });
  it('05. first paid checkout is USD20 and applies only after server settlement', async () => {
    const team = await makeTeam();
    const opened = await checkout(team, 'STARTER', 5);
    const data = opened.body.data as ChangeResult;
    expect(data.payment).toMatchObject({ amountMinor: 2000, currency: 'USD', status: 'PENDING' });
    expect((await summary(team)).subscription.planCode).toBe('FREE');
    expect((await settle(team, data.payment!)).body.data.outcome).toBe('SUCCESS');
    expect((await summary(team)).subscription).toMatchObject({ planCode: 'STARTER', seats: 5, currency: 'USD' });
  });
  it('06. concurrent duplicate checkout opens one payment and makes one provider call', async () => {
    const team = await makeTeam(), key = crypto.randomUUID(), before = initialize.mock.calls.length;
    const results = await Promise.all([checkout(team, 'TEAM', 18, key), checkout(team, 'TEAM', 18, key), checkout(team, 'TEAM', 18, key)]);
    expect(new Set(results.map(r => r.body.data.payment.txRef)).size).toBe(1);
    expect(initialize.mock.calls.length - before).toBe(1);
    const replay = await checkout(team, 'TEAM', 18, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(results.find(r => r.status === 201)!.body);
    expect((await pool.query('SELECT count(*)::int AS n FROM payment_transactions WHERE team_id=$1', [team])).rows[0].n).toBe(1);
  });
  it('07. reusing a key with changed intent is a conflict', async () => {
    const team = await makeTeam(), key = crypto.randomUUID();
    await checkout(team, 'STARTER', 5, key);
    const res = await checkout(team, 'TEAM', 15, key);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
  it('08. uncertain provider initialization stays pending and is never initiated twice', async () => {
    const team = await makeTeam(), key = crypto.randomUUID(), before = initialize.mock.calls.length;
    initialize.mockRejectedValueOnce(new Error('connection lost after provider received request'));
    const first = await checkout(team, 'TEAM', 15, key), second = await checkout(team, 'TEAM', 15, key);
    expect(first.status).toBe(202);
    expect(second.body).toEqual(first.body);
    expect(first.body.data.processing).toBe(true);
    expect(initialize.mock.calls.length - before).toBe(1);
  });
  it('09. separate-floor upgrade records charge and unused-time credit', async () => {
    const team = await makeTeam('STARTER', 5);
    await pool.query("UPDATE team_subscriptions SET period_started_at=NOW()-INTERVAL '10 days',period_ends_at=NOW()+INTERVAL '20 days' WHERE team_id=$1", [team]);
    const opened = await checkout(team, 'TEAM', 15);
    expect(opened.body.data.payment.amountMinor).toBe(2000);
    await settle(team, opened.body.data.payment);
    const rows = (await pool.query('SELECT kind,amount_minor::int AS amount FROM financial_ledger WHERE payment_id=$1 ORDER BY sequence', [opened.body.data.payment.id])).rows;
    expect(rows).toEqual([{ kind: 'CHARGE', amount: 3333 }, { kind: 'CREDIT', amount: 1333 }]);
  });
  it('10. rejects rounded gateway amounts and currency mismatches without any financial write', async () => {
    const team = await makeTeam('STARTER', 5);
    await pool.query("UPDATE team_subscriptions SET period_started_at=NOW()-INTERVAL '29 days',period_ends_at=NOW()+INTERVAL '1 day' WHERE team_id=$1", [team]);
    const opened = await checkout(team, 'BUSINESS', 40), payment = opened.body.data.payment as Payment;
    expect(payment.amountMinor).toBe(334);
    const id = crypto.randomUUID();
    gateways.set(id, { transactionId: id, txRef: payment.txRef, amountMajor: '3.00', currency: 'USD', status: 'successful' });
    expect((await post(owner, team, 'verify', { txRef: payment.txRef, transactionId: id })).status).toBe(400);
    gateways.set(id, { ...gateways.get(id)!, amountMajor: '3.34', currency: 'NGN' });
    expect((await post(owner, team, 'verify', { txRef: payment.txRef, transactionId: id })).status).toBe(400);
    expect((await pool.query('SELECT count(*)::int AS n FROM financial_ledger WHERE payment_id=$1', [payment.id])).rows[0].n).toBe(0);
    expect((await settle(team, payment)).body.data.outcome).toBe('SUCCESS');
  });
  it('11. duplicate concurrent settlement appends one financial outcome', async () => {
    const team = await makeTeam(), opened = await checkout(team, 'STARTER', 5), payment = opened.body.data.payment as Payment;
    const id = crypto.randomUUID();
    gateways.set(id, { transactionId: id, txRef: payment.txRef, amountMajor: '20.00', currency: 'USD', status: 'successful' });
    const results = await Promise.all([post(owner, team, 'verify', { txRef: payment.txRef, transactionId: id }), post(owner, team, 'verify', { txRef: payment.txRef, transactionId: id })]);
    expect(results.map(r => r.body.data.outcome).sort()).toEqual(['SUCCESS', 'SUCCESS']);
    expect((await pool.query("SELECT count(*)::int AS n FROM financial_ledger WHERE payment_id=$1 AND kind='CHARGE'", [payment.id])).rows[0].n).toBe(1);
  });
  it('12. downgrade is effective at period end and renewal uses the lower rate', async () => {
    const team = await makeTeam('TEAM', 15), before = (await summary(team)).subscription;
    const scheduled = await checkout(team, 'STARTER', 5);
    expect(scheduled.body.data.payment).toBeNull();
    expect(scheduled.body.data.change.effectiveAt).toBe(before.periodEndsAt);
    expect((await summary(team)).subscription).toMatchObject({ planCode: 'TEAM', seats: 15 });
    expect((await post(owner, team, 'renew')).status).toBe(409);
    await tx(client => materializeSubscription(client, team, new Date(before.periodEndsAt)));
    expect((await summary(team)).subscription.planCode).toBe('STARTER');
    const renewal = await post(owner, team, 'renew');
    expect(renewal.body.data.payment.amountMinor).toBe(2000);
    expect((await settle(team, renewal.body.data.payment)).body.data.outcome).toBe('SUCCESS');
  });
  it('13. seat reduction is scheduled with no charge/refund today', async () => {
    const team = await makeTeam('TEAM', 18);
    const res = await post(owner, team, 'seats', { seats: 15 });
    expect(res.body.data.payment).toBeNull();
    expect(res.body.data.change.effectiveAt).toBeTruthy();
    expect((await summary(team)).subscription.seats).toBe(18);
  });
  it('14. pending invitations reserve seats and reductions below them are rejected', async () => {
    const team = await makeTeam('TEAM', 18);
    await pool.query(`INSERT INTO invitations(team_id,email,role,token_hash,inviter_id,expires_at)
      SELECT $1,'reserve-'||g||'@test.example','STAFF',gen_random_uuid()::text,$2,NOW()+INTERVAL '1 hour' FROM generate_series(1,15) g`, [team, owner.id]);
    const res = await post(owner, team, 'seats', { seats: 15 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SEAT_LIMIT_EXCEEDED');
  });
  it('15. concurrent invitations cannot oversell the last Starter seat', async () => {
    const team = await makeTeam('STARTER', 5);
    await pool.query(`INSERT INTO invitations(team_id,email,role,token_hash,inviter_id,expires_at)
      SELECT $1,'reserved-'||g||'@test.example','STAFF',gen_random_uuid()::text,$2,NOW()+INTERVAL '1 hour' FROM generate_series(1,3) g`, [team, owner.id]);
    const invite = (email: string) => request(app).post(`/invitations/team/${team}`).set('Authorization', `Bearer ${owner.token}`).send({ email, role: 'STAFF' });
    const results = await Promise.all([invite('last-a@test.example'), invite('last-b@test.example')]);
    expect(results.map(r => r.status).sort()).toEqual([201, 403]);
  });
  it('16. invitation acceptance rechecks reserved capacity under the billing lock', async () => {
    const team = await makeTeam('STARTER', 5), staff = await register();
    const invite = await request(app).post(`/invitations/team/${team}`).set('Authorization', `Bearer ${owner.token}`).send({ email: staff.email, role: 'STAFF' });
    const accept = () => request(app).post('/invitations/accept').set('Authorization', `Bearer ${staff.token}`).send({ code: invite.body.data.code });
    const results = await Promise.all([accept(), accept()]);
    expect(results.map(r => r.status).sort()).toEqual([200, 400]);
    expect((await summary(team)).seatsUsed).toBe(2);
  });
  it('17. scheduled downgrade prevents new reservations above future capacity', async () => {
    const team = await makeTeam('TEAM', 15);
    await checkout(team, 'STARTER', 5);
    await pool.query(`INSERT INTO invitations(team_id,email,role,token_hash,inviter_id,expires_at)
      SELECT $1,'future-'||g||'@test.example','STAFF',gen_random_uuid()::text,$2,NOW()+INTERVAL '1 hour' FROM generate_series(1,4) g`, [team, owner.id]);
    const res = await request(app).post(`/invitations/team/${team}`).set('Authorization', `Bearer ${owner.token}`).send({ email: 'sixth@test.example', role: 'STAFF' });
    expect(res.status).toBe(403);
  });
  it('18. authenticates,settles and deduplicates webhooks', async () => {
    const team = await makeTeam(), opened = await checkout(team, 'STARTER', 5), payment = opened.body.data.payment as Payment;
    const body = { event: 'charge.completed', data: { id: crypto.randomUUID(), tx_ref: payment.txRef, amount: '20.00', currency: 'USD', status: 'successful' } };
    expect((await webhook(body, 'wrong')).status).toBe(401);
    expect((await webhook(body)).body.data.processed).toBe(true);
    expect((await webhook(body)).body.data.reason).toBe('duplicate');
  });
  it('19. unknown webhook references are harmless and unsuccessful renewals remain auditable', async () => {
    expect((await webhook({ event: 'charge.completed', data: { id: crypto.randomUUID(), tx_ref: 'unknown', amount: '20.00', currency: 'USD', status: 'successful' } })).body.data.reason).toBe('no-pending');
    const team = await makeTeam('STARTER', 5), renewal = await post(owner, team, 'renew');
    await settle(team, renewal.body.data.payment, 'failed');
    expect((await summary(team)).subscription.status).toBe('PAST_DUE');
  });
  it('20. late settlement preserves the newer subscription and records a credit', async () => {
    const team = await makeTeam('STARTER', 5), old = await checkout(team, 'BUSINESS', 40), newer = await checkout(team, 'TEAM', 15);
    await settle(team, newer.body.data.payment);
    await settle(team, old.body.data.payment);
    expect((await summary(team)).subscription.planCode).toBe('TEAM');
    expect((await pool.query("SELECT amount_minor::int AS amount FROM financial_ledger WHERE event_key=$1", [`superseded-credit:${old.body.data.payment.id}`])).rows[0].amount).toBe(old.body.data.payment.amountMinor);
  });
  it('21. repeated ledger event keys cannot change the posted amount', async () => {
    const team = await makeTeam();
    const entry = { teamId: team, eventKey: crypto.randomUUID(), kind: 'CREDIT' as const, amountMinor: 10, currency: 'USD' };
    await tx(client => appendLedger(client, entry));
    await tx(client => appendLedger(client, entry));
    await expect(tx(client => appendLedger(client, { ...entry, amountMinor: 11 }))).rejects.toMatchObject({ code: 'LEDGER_CONFLICT' });
  });
  it('22. ledger rejects UPDATE,DELETE and TRUNCATE', async () => {
    for (const sql of ['UPDATE financial_ledger SET amount_minor=0', 'DELETE FROM financial_ledger', 'TRUNCATE financial_ledger'])
      await expect(pool.query(sql)).rejects.toMatchObject({ code: '55000' });
  });
  it('23. subscription is reconstructable after its projection is corrupted', async () => {
    const team = await makeTeam('TEAM', 18);
    await post(owner, team, 'seats', { seats: 15 });
    const original = (await pool.query('SELECT to_jsonb(s) AS s FROM team_subscriptions s WHERE team_id=$1', [team])).rows[0].s;
    await pool.query('UPDATE team_subscriptions SET seats=999 WHERE team_id=$1', [team]);
    const rebuilt = await tx(client => reconstructSubscription(client, team));
    expect(rebuilt).toEqual(original);
    await pool.query('UPDATE team_subscriptions SET seats=$1 WHERE team_id=$2', [rebuilt.seats, team]);
    expect((await summary(team)).subscription.seats).toBe(18);
  });
  it('24. concurrent refunds cannot exceed the settled amount and replay is harmless', async () => {
    const team = await makeTeam(), opened = await checkout(team, 'STARTER', 5), payment = opened.body.data.payment as Payment;
    await settle(team, payment);
    const keys = [crypto.randomUUID(), crypto.randomUUID()];
    const results = await Promise.allSettled(keys.map(key => tx(client => recordRefund(client, payment.id, 1500, key))));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const key = keys[results.findIndex(r => r.status === 'fulfilled')];
    await tx(client => recordRefund(client, payment.id, 1500, key));
    expect((await pool.query("SELECT SUM(amount_minor)::int AS total FROM financial_ledger WHERE payment_id=$1 AND kind='REFUND'", [payment.id])).rows[0].total).toBe(1500);
  });
  it('25. does not convert existing paid NGN subscriptions into USD', async () => {
    const team = await makeTeam();
    await pool.query("UPDATE team_subscriptions SET plan_code='STARTER',seats=5 WHERE team_id=$1", [team]);
    const res = await checkout(team, 'TEAM', 15);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CURRENCY_CHANGE_REQUIRES_MIGRATION');
    const renewal = await post(owner, team, 'renew');
    expect(renewal.body.data.payment).toMatchObject({ currency: 'NGN', amountMinor: 1250000 });
  });
  it('26. payment lookup is transaction-specific and tenant isolated', async () => {
    const team = await makeTeam(), opened = await checkout(team, 'STARTER', 5);
    const path = `/teams/${team}/subscription/payments/${opened.body.data.payment.txRef}`;
    expect((await request(app).get(path).set('Authorization', `Bearer ${owner.token}`)).body.data.status).toBe('PENDING');
    expect((await request(app).get(path).set('Authorization', `Bearer ${outsider.token}`)).status).toBe(404);
  });
  it('27. preserves pending history while hiding old unsubmitted checkout cards', async () => {
    const team = await makeTeam(), opened = await checkout(team, 'STARTER', 5), id = opened.body.data.payment.id;
    await pool.query("UPDATE payment_transactions SET created_at=NOW()-INTERVAL '2 hours' WHERE id=$1", [id]);
    expect((await summary(team)).pendingPayment).toBeNull();
    expect((await pool.query('SELECT status FROM payment_transactions WHERE id=$1', [id])).rows[0].status).toBe('PENDING');
  });
  it('28. history and invoices retain currency and pagination', async () => {
    const team = await makeTeam('STARTER', 5);
    await checkout(team, 'TEAM', 15);
    for (const route of ['changes', 'billing']) {
      const res = await request(app).get(`/teams/${team}/subscription/${route}?limit=1`).set('Authorization', `Bearer ${owner.token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.hasMore).toBe(true);
    }
  });
  it('29. keeps checkout redirect allow-list protection', async () => {
    const bad = await request(app).get('/billing/redirect?return_url=https://evil.example');
    expect(bad.text).toContain('rota://billing/redirect');
    expect(bad.text).not.toContain('href="https://evil.example');
  });
  it('30. forwards a valid mobile return URL and exact cents to the mocked provider', async () => {
    const team = await makeTeam();
    await post(owner, team, 'checkout', { planCode: 'TEAM', seats: 18, returnUrl: 'rota://billing/redirect' });
    const input = initialize.mock.calls.at(-1)![0];
    expect(input.amountMinor).toBe(5900);
    expect(input.currency).toBe('USD');
    expect(input.redirectUrl).toContain('return_url=rota%3A%2F%2Fbilling%2Fredirect');
    expect(majorToMinor(minorToMajor(input.amountMinor))).toBe(input.amountMinor);
  });
  it('31. concurrent downgrade and invitation cannot violate future capacity', async () => {
    const team = await makeTeam('TEAM', 15);
    await pool.query(`INSERT INTO invitations(team_id,email,role,token_hash,inviter_id,expires_at)
      SELECT $1,'race-'||g||'@test.example','STAFF',gen_random_uuid()::text,$2,NOW()+INTERVAL '1 hour' FROM generate_series(1,4) g`, [team, owner.id]);
    const invite = request(app).post(`/invitations/team/${team}`).set('Authorization', `Bearer ${owner.token}`).send({ email: 'race-last@test.example', role: 'STAFF' });
    const [down, add] = await Promise.all([checkout(team, 'STARTER', 5), invite]);
    expect([[200, 403], [400, 201]]).toContainEqual([down.status, add.status]);
  });
  it('32. a late failed renewal cannot invalidate a newer paid upgrade', async () => {
    const team = await makeTeam('STARTER', 5), old = await post(owner, team, 'renew'), upgrade = await checkout(team, 'TEAM', 15);
    await settle(team, upgrade.body.data.payment);
    await settle(team, old.body.data.payment, 'failed');
    expect((await summary(team)).subscription).toMatchObject({ planCode: 'TEAM', status: 'ACTIVE' });
  });
  it('33. Staff cannot initiate payments or read the financial ledger', async () => {
    const team = await makeTeam();
    await pool.query("INSERT INTO team_memberships(team_id,user_id,role) VALUES($1,$2,'STAFF')", [team, outsider.id]);
    expect((await post(outsider, team, 'checkout', { planCode: 'STARTER' })).status).toBe(403);
    expect((await request(app).get(`/teams/${team}/subscription/ledger/reconstruction`).set('Authorization', `Bearer ${outsider.token}`)).status).toBe(403);
  });
  it('34. gateway reference mismatch leaves payment pending', async () => {
    const team = await makeTeam(), opened = await checkout(team, 'STARTER', 5), payment = opened.body.data.payment as Payment, id = crypto.randomUUID();
    gateways.set(id, { transactionId: id, txRef: 'different', amountMajor: '20.00', currency: 'USD', status: 'successful' });
    expect((await post(owner, team, 'verify', { txRef: payment.txRef, transactionId: id })).status).toBe(400);
    expect((await pool.query('SELECT status FROM payment_transactions WHERE id=$1', [payment.id])).rows[0].status).toBe('PENDING');
  });
  it('35. rebuilds scheduled change details and currency totals from the ledger alone', async () => {
    const team = await makeTeam('TEAM', 18);
    await post(owner, team, 'seats', { seats: 15 });
    const rebuilt = await tx(client => reconstructBilling(client, team));
    expect(rebuilt.scheduledChange).toMatchObject({ to_seats: 15, type: 'REDUCE_SEATS' });
    expect(rebuilt.totals).toContainEqual({ currency: 'USD', charges: '5900', credits: '0', refunds: '0' });
  });
  it('36. a failed webhook cannot overwrite a successful payment', async () => {
    const team = await makeTeam(), opened = await checkout(team, 'STARTER', 5), payment = opened.body.data.payment as Payment;
    await settle(team, payment);
    expect((await webhook({ event: 'charge.completed', data: { id: crypto.randomUUID(), tx_ref: payment.txRef, amount: '20.00', currency: 'USD', status: 'failed' } })).body.data.reason).toBe('no-pending');
    expect((await summary(team)).subscription.status).toBe('ACTIVE');
  });
  it('37. preserves settlement of legacy pending NGN payments created by the old rounded adapter', async () => {
    const team = await makeTeam();
    const change = (await pool.query("INSERT INTO subscription_changes(team_id,actor_id,type,from_plan_code,to_plan_code,from_seats,to_seats,amount_minor,status) VALUES($1,$2,'PLAN_UPGRADE','FREE','STARTER',1,2,10067,'PENDING_PAYMENT') RETURNING id", [team, owner.id])).rows[0].id;
    const payment = (await pool.query("INSERT INTO payment_transactions(team_id,change_id,tx_ref,amount_minor,currency) VALUES($1,$2,$3,10067,'NGN') RETURNING id", [team, change, crypto.randomUUID()])).rows[0].id;
    const row = (await pool.query('SELECT tx_ref FROM payment_transactions WHERE id=$1', [payment])).rows[0];
    const result = await settle(team, { id: payment, txRef: row.tx_ref, amountMinor: 10100, currency: 'NGN', status: 'PENDING' });
    expect(result.body.data.outcome).toBe('SUCCESS');
    expect((await pool.query('SELECT amount_minor FROM payment_transactions WHERE id=$1', [payment])).rows[0].amount_minor).toBe(10067);
    expect((await pool.query("SELECT amount_minor::int AS amount FROM financial_ledger WHERE payment_id=$1 AND kind='CHARGE'", [payment])).rows[0].amount).toBe(10100);
  });
  it('38. posts both sides of a zero-net included-seat change', async () => {
    const team = await makeTeam('TEAM', 18);
    const opened = await post(owner, team, 'seats', { seats: 18 });
    expect(opened.status).toBe(200);
    expect(opened.body.data.payment).toBeNull();
    const events = (await pool.query("SELECT kind,amount_minor::int AS amount FROM financial_ledger WHERE event_key IN ($1,$2) ORDER BY kind", [`change-charge:${opened.body.data.change.id}`, `change-credit:${opened.body.data.change.id}`])).rows;
    expect(events).toEqual([{ kind: 'CHARGE', amount: 5900 }, { kind: 'CREDIT', amount: 5900 }]);
  });
  it('39. resending a reserved invitation at capacity does not consume another seat', async () => {
    const team = await makeTeam('STARTER', 5);
    const invite = (email: string) => request(app).post(`/invitations/team/${team}`).set('Authorization', `Bearer ${owner.token}`).send({email,role:'STAFF'});
    for (let i=0;i<4;i++) expect((await invite(`resend-${i}@test.example`)).status).toBe(201);
    expect((await invite('resend-0@test.example')).status).toBe(201);
    expect((await summary(team)).pendingInvites).toBe(4);
    expect((await invite('resend-extra@test.example')).status).toBe(403);
  });

});
