import request from 'supertest';
import { app } from '../src/index';
import { pool } from '../src/db';
import { redisClient } from '../src/redis';

// The gateway is a third-party HTTP service; mock it so tests run without
// network access or credentials. webhook signature/hash validation stays real.
jest.mock('../src/billing/flutterwave', () => ({
  ...jest.requireActual('../src/billing/flutterwave'),
  initializeCheckout: jest.fn(),
  verifyTransaction: jest.fn(),
}));

import { initializeCheckout, verifyTransaction } from '../src/billing/flutterwave';

const mockedInitializeCheckout = jest.mocked(initializeCheckout);
const mockedVerifyTransaction = jest.mocked(verifyTransaction);

interface Registered {
  id: string;
  token: string;
  email: string;
}

describe('Phase 4: Seat-based subscriptions and Flutterwave billing', () => {
  let alice: Registered;
  let bob: Registered;
  let carol: Registered;
  let dave: Registered;
  let evelyn: Registered;
  let ownerTeamB: Registered;

  let teamA: string;
  let teamB: string;

  const password = 'password123';

  beforeAll(async () => {
    setEnvWebhookHash('secret-hash-test');
    mockedInitializeCheckout.mockResolvedValue({ link: 'https://checkout.flutterwave.com/test/link' });
    await pool.query('DELETE FROM webhook_events');
    await pool.query('DELETE FROM payment_transactions');
    await pool.query('DELETE FROM subscription_changes');
    await pool.query('DELETE FROM billing_invoices');
    await pool.query('DELETE FROM invitations');
    await pool.query('DELETE FROM shift_assignments');
    await pool.query('DELETE FROM swap_requests');
    await pool.query('DELETE FROM shifts');
    await pool.query('DELETE FROM activity_events');
    await pool.query('DELETE FROM team_memberships');
    await pool.query('DELETE FROM teams');
    await pool.query('DELETE FROM refresh_tokens');
    await pool.query('DELETE FROM users');
    await redisClient.connect().catch(() => {});
  });

  afterAll(async () => {
    await pool.end();
    await redisClient.quit();
  });

  const register = async (firstName: string, lastName: string, email: string): Promise<Registered> => {
    const res = await request(app).post('/auth/register').send({ firstName, lastName, email, password });
    expect(res.status).toBe(201);
    return { id: res.body.data.user.id, token: res.body.data.accessToken, email };
  };

  const createTeam = async (token: string, name: string): Promise<string> => {
    const res = await request(app).post('/teams').set('Authorization', `Bearer ${token}`).send({ name });
    expect(res.status).toBe(201);
    return res.body.data.id;
  };

  const inviteAndAccept = async (teamId: string, ownerToken: string, role: string, user: Registered) => {
    const invite = await request(app)
      .post(`/invitations/team/${teamId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ email: user.email, role });
    expect(invite.status).toBe(201);
    const accept = await request(app)
      .post('/invitations/accept')
      .set('Authorization', `Bearer ${user.token}`)
      .send({ token: invite.body.data.token });
    expect(accept.status).toBe(200);
  };

  const getSummary = async (token: string, teamId: string) => {
    const res = await request(app).get(`/teams/${teamId}/subscription`).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    return res.body.data;
  };

  const checkout = async (token: string, teamId: string, body: Record<string, unknown>) => {
    return request(app).post(`/teams/${teamId}/subscription/checkout`).set('Authorization', `Bearer ${token}`).send(body);
  };

  const changeSeats = async (token: string, teamId: string, seats: number) => {
    return request(app).post(`/teams/${teamId}/subscription/seats`).set('Authorization', `Bearer ${token}`).send({ seats });
  };

  const renew = async (token: string, teamId: string) => {
    return request(app).post(`/teams/${teamId}/subscription/renew`).set('Authorization', `Bearer ${token}`);
  };

  const verify = async (token: string, teamId: string, txRef: string, transactionId: string) => {
    return request(app)
      .post(`/teams/${teamId}/subscription/verify`)
      .set('Authorization', `Bearer ${token}`)
      .send({ txRef, transactionId });
  };

  const setEnvWebhookHash = (value: string) => {
    process.env.FLW_SECRET_HASH = value;
  };

  const callWebhook = async (body: Record<string, unknown>, header?: string) => {
    return request(app)
      .post('/billing/webhook/flutterwave')
      .set('verif-hash', header ?? process.env.FLW_SECRET_HASH!)
      .send(body);
  };

  it('01. registers users, creates teams, and provisions FREE subscriptions', async () => {
    alice = await register('Alice', 'Owner', 'alice-b@test.com');
    bob = await register('Bob', 'Manager', 'bob-b@test.com');
    carol = await register('Carol', 'Staff', 'carol-b@test.com');
    dave = await register('Dave', 'Pending', 'dave-b@test.com');
    evelyn = await register('Evelyn', 'Pending', 'evelyn-b@test.com');
    ownerTeamB = await register('Omar', 'Owner', 'omar-b@test.com');

    teamA = await createTeam(alice.token, 'Team A');
    teamB = await createTeam(ownerTeamB.token, 'Team B');

    await inviteAndAccept(teamA, alice.token, 'MANAGER', bob);
    await inviteAndAccept(teamA, alice.token, 'STAFF', carol);

    const subRes = await pool.query(
      'SELECT plan_code, seats, status FROM team_subscriptions WHERE team_id = $1',
      [teamA]
    );
    expect(subRes.rows).toHaveLength(1);
    expect(subRes.rows[0]).toMatchObject({ plan_code: 'FREE', seats: 1, status: 'ACTIVE' });
  });

  it('02. summary reports the FREE plan, seat usage, and capacity of 100', async () => {
    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.planCode).toBe('FREE');
    expect(summary.subscription.status).toBe('ACTIVE');
    expect(summary.seatsUsed).toBe(3);
    expect(summary.pendingInvites).toBe(0);
    expect(summary.seatCapacity).toBe(100);
  });

  it('03. non-owners get 403 and other tenants get 404', async () => {
    const staff = await request(app)
      .get(`/teams/${teamA}/subscription`)
      .set('Authorization', `Bearer ${carol.token}`);
    expect(staff.status).toBe(403);

    const crossTenant = await request(app)
      .get(`/teams/${teamA}/subscription`)
      .set('Authorization', `Bearer ${ownerTeamB.token}`);
    expect(crossTenant.status).toBe(404);
  });

  it('04. upgrading to GROWTH with 5 seats opens a paid checkout', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'GROWTH', seats: 5 });
    expect(res.status).toBe(201);
    expect(res.body.data.checkoutUrl).toBe('https://checkout.flutterwave.com/test/link');
    expect(res.body.data.payment.status).toBe('PENDING');
    expect(res.body.data.payment.amountMinor).toBe(1500000);
    expect(res.body.data.change.type).toBe('PLAN_UPGRADE');
    expect(mockedInitializeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ txRef: res.body.data.payment.txRef, amountMinor: 1500000 })
    );
    (global as any).currentTxRef = res.body.data.payment.txRef;
  });

  it('05. verifying a successful payment applies the upgrade', async () => {
    const txRef = (global as any).currentTxRef;
    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90001',
      txRef,
      amountMajor: 15000,
      currency: 'NGN',
      status: 'successful',
    });

    const res = await verify(alice.token, teamA, txRef, '90001');
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('SUCCESS');

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.planCode).toBe('GROWTH');
    expect(summary.subscription.seats).toBe(5);
    expect(summary.seatCapacity).toBe(5);

    const db = await pool.query(
      `SELECT pt.status, sc.status as change_status, inv.status as invoice_status
       FROM payment_transactions pt
       JOIN subscription_changes sc ON sc.id = pt.change_id
       JOIN billing_invoices inv ON inv.change_id = sc.id
       WHERE pt.tx_ref = $1`,
      [txRef]
    );
    expect(db.rows[0]).toMatchObject({
      status: 'SUCCESSFUL',
      change_status: 'PAID',
      invoice_status: 'PAID',
    });
  });

  it('06. replaying verification is idempotent', async () => {
    const txRef = (global as any).currentTxRef;
    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90001',
      txRef,
      amountMajor: 15000,
      currency: 'NGN',
      status: 'successful',
    });
    const res = await verify(alice.token, teamA, txRef, '90001');
    expect(res.status).toBe(200);
    expect(res.body.data.outcome).toBe('ALREADY_PROCESSED');
  });

  it('07. reducing seats applies immediately with no payment', async () => {
    const res = await changeSeats(alice.token, teamA, 3);
    expect(res.status).toBe(200);
    expect(res.body.data.change.type).toBe('REDUCE_SEATS');
    expect(res.body.data.payment).toBeNull();

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.seats).toBe(3);
  });

  it('08. seats below the current member count are rejected', async () => {
    const res = await changeSeats(alice.token, teamA, 2);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('SEAT_LIMIT_EXCEEDED');
  });

  it('09. removing a member frees a seat', async () => {
    const res = await request(app)
      .delete(`/teams/${teamA}/members/${carol.id}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(res.status).toBe(200);
    const summary = await getSummary(alice.token, teamA);
    expect(summary.seatsUsed).toBe(2);
  });

  it('10. invites within seat capacity are allowed (seats 3, used 2, pending 0)', async () => {
    const invite = await request(app)
      .post(`/invitations/team/${teamA}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: dave.email, role: 'STAFF' });
    expect(invite.status).toBe(201);
    const summary = await getSummary(alice.token, teamA);
    expect(summary.pendingInvites).toBe(1);
  });

  it('11. invites beyond seat capacity are blocked', async () => {
    const invite = await request(app)
      .post(`/invitations/team/${teamA}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: evelyn.email, role: 'STAFF' });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('SEAT_LIMIT_EXCEEDED');
  });

  it('12. downgrading the plan applies immediately at no charge', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'STARTER' });
    expect(res.status).toBe(200);
    expect(res.body.data.change.type).toBe('PLAN_DOWNGRADE');
    expect(res.body.data.change.amountMinor).toBe(0);

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.planCode).toBe('STARTER');
    expect(summary.subscription.seats).toBe(3);
  });

  it('13. adding seats creates a prorated paid change that settles on verify', async () => {
    const res = await changeSeats(alice.token, teamA, 4);
    expect(res.status).toBe(201);
    expect(res.body.data.change.type).toBe('ADD_SEATS');
    expect(res.body.data.payment.amountMinor).toBe(250000);

    const txRef = res.body.data.payment.txRef;
    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90002',
      txRef,
      amountMajor: 2500,
      currency: 'NGN',
      status: 'successful',
    });
    const verified = await verify(alice.token, teamA, txRef, '90002');
    expect(verified.body.data.outcome).toBe('SUCCESS');

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.seats).toBe(4);
  });

  it('14. seat reduction applies immediately even with pending invites', async () => {
    const res = await changeSeats(alice.token, teamA, 2);
    expect(res.status).toBe(200);
    expect(res.body.data.change.type).toBe('REDUCE_SEATS');
    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.seats).toBe(2);
  });

  it('15. a failed renewal moves an active subscription to PAST_DUE', async () => {
    const res = await renew(alice.token, teamA);
    expect(res.status).toBe(201);
    expect(res.body.data.change.type).toBe('RENEWAL');
    expect(res.body.data.payment.amountMinor).toBe(500000);

    const txRef = res.body.data.payment.txRef;
    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90003',
      txRef,
      amountMajor: 5000,
      currency: 'NGN',
      status: 'failed',
    });
    const verified = await verify(alice.token, teamA, txRef, '90003');
    expect(verified.status).toBe(200);
    expect(verified.body.data.outcome).toBe('FAILED');

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.status).toBe('PAST_DUE');
    expect(summary.subscription.hasFailedRenewal).toBe(true);
    expect(summary.latestFailedRenewal).toBeTruthy();
  });

  it('16. PAST_DUE teams cannot be invited', async () => {
    const invite = await request(app)
      .post(`/invitations/team/${teamA}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: evelyn.email, role: 'STAFF' });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('17. an EXPIRED subscription blocks shifts and invites', async () => {
    await pool.query(
      `UPDATE team_subscriptions SET status = 'ACTIVE',
         period_ends_at = NOW() - INTERVAL '1 day'
       WHERE team_id = $1`,
      [teamA]
    );

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.status).toBe('EXPIRED');

    const shift = await request(app)
      .post(`/teams/${teamA}/shifts`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Blocked shift', startsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), endsAt: new Date(Date.now() + 4 * 3600_000).toISOString() });
    expect(shift.status).toBe(403);
    expect(shift.body.error.code).toBe('SUBSCRIPTION_REQUIRED');

    const invite = await request(app)
      .post(`/invitations/team/${teamA}`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ email: evelyn.email, role: 'STAFF' });
    expect(invite.status).toBe(403);
    expect(invite.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('18. a successful renewal reactivates and reopens shift creation', async () => {
    const res = await renew(alice.token, teamA);
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;

    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90004',
      txRef,
      amountMajor: 5000,
      currency: 'NGN',
      status: 'successful',
    });
    const verified = await verify(alice.token, teamA, txRef, '90004');
    expect(verified.body.data.outcome).toBe('SUCCESS');

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.status).toBe('ACTIVE');
    expect(new Date(summary.subscription.periodEndsAt).getTime()).toBeGreaterThan(Date.now());

    const shift = await request(app)
      .post(`/teams/${teamA}/shifts`)
      .set('Authorization', `Bearer ${alice.token}`)
      .send({ title: 'Restored shift', startsAt: new Date(Date.now() + 2 * 3600_000).toISOString(), endsAt: new Date(Date.now() + 4 * 3600_000).toISOString() });
    expect(shift.status).toBe(201);
  });

  it('19. the webhook settles a pending payment', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'GROWTH' });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;
    expect(res.body.data.payment.amountMinor).toBe(100000);

    const webhook = await callWebhook({
      event: 'charge.completed',
      data: { id: 70001, tx_ref: txRef, amount: 1000, currency: 'NGN', status: 'successful' },
    });
    expect(webhook.status).toBe(200);
    expect(webhook.body.data).toMatchObject({ processed: true, outcome: 'SUCCESS' });

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.planCode).toBe('GROWTH');
    expect(summary.subscription.seats).toBe(2);
  });

  it('20. duplicate webhook events are ignored', async () => {
    const webhook = await callWebhook({
      event: 'charge.completed',
      data: { id: 70001, tx_ref: 'anything', amount: 1000, currency: 'NGN', status: 'successful' },
    });
    expect(webhook.status).toBe(200);
    expect(webhook.body.data).toEqual({ processed: false, reason: 'duplicate' });
  });

  it('21. wrong webhook hash is rejected', async () => {
    const webhook = await callWebhook(
      { event: 'charge.completed', data: { id: 70010, tx_ref: 'x', amount: 1000, currency: 'NGN', status: 'successful' } },
      'wrong-hash'
    );
    expect(webhook.status).toBe(401);
  });

  it('22. webhook for an unknown reference is a no-op', async () => {
    const webhook = await callWebhook({
      event: 'charge.completed',
      data: { id: 70002, tx_ref: 'rota-unknown-ref', amount: 1000, currency: 'NGN', status: 'successful' },
    });
    expect(webhook.status).toBe(200);
    expect(webhook.body.data).toMatchObject({ processed: false, reason: 'no-pending' });
  });

  it('23. a malformed verified amount rolls the whole settlement back', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'SCALE' });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;
    const changeId = res.body.data.change.id;

    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90005',
      txRef,
      amountMajor: Number('not-a-number'),
      currency: 'NGN',
      status: 'successful',
    });

    const verified = await verify(alice.token, teamA, txRef, '90005');
    expect(verified.status).toBe(400);
    expect(verified.body.error.code).toBe('PAYMENT_MISMATCH');

    const db = await pool.query('SELECT status FROM payment_transactions WHERE tx_ref = $1', [txRef]);
    expect(db.rows[0].status).toBe('PENDING');
    const changeDb = await pool.query('SELECT status FROM subscription_changes WHERE id = $1', [changeId]);
    expect(changeDb.rows[0].status).toBe('PENDING_PAYMENT');

    const summary = await getSummary(alice.token, teamA);
    expect(summary.subscription.planCode).toBe('GROWTH');
    expect(summary.subscription.seats).toBe(2);
  });

  it('24. a currency mismatch is rejected and nothing is applied', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'SCALE' });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;

    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90006',
      txRef,
      amountMajor: 1000,
      currency: 'USD',
      status: 'successful',
    });

    const verified = await verify(alice.token, teamA, txRef, '90006');
    expect(verified.status).toBe(400);
    expect(verified.body.error.code).toBe('PAYMENT_MISMATCH');

    const db = await pool.query('SELECT status FROM payment_transactions WHERE tx_ref = $1', [txRef]);
    expect(db.rows[0].status).toBe('PENDING');
  });

  it('25. plans, change history, and invoices are listed and paginated', async () => {
    const plans = await request(app).get(`/teams/${teamA}/subscription/plans`).set('Authorization', `Bearer ${alice.token}`);
    expect(plans.status).toBe(200);
    expect(plans.body.data.map((p: any) => p.code)).toEqual(['FREE', 'STARTER', 'GROWTH', 'SCALE']);

    const changes = await request(app).get(`/teams/${teamA}/subscription/changes?limit=50`).set('Authorization', `Bearer ${alice.token}`);
    expect(changes.status).toBe(200);
    expect(changes.body.data.items.length).toBeGreaterThan(0);
    expect(changes.body.data.hasMore).toBe(false);
    expect(changes.body.data.items.length).toBeLessThanOrEqual(50);
    expect(changes.body.data.nextCursor).toBeTruthy();

    const invoices = await request(app).get(`/teams/${teamA}/subscription/billing`).set('Authorization', `Bearer ${alice.token}`);
    expect(invoices.status).toBe(200);
    expect(invoices.body.data.items.length).toBeGreaterThan(0);
    expect(invoices.body.data.items[0].changeType).toBeTruthy();

    const crossTenant = await request(app)
      .get(`/teams/${teamA}/subscription/changes`)
      .set('Authorization', `Bearer ${ownerTeamB.token}`);
    expect(crossTenant.status).toBe(404);
  });
});