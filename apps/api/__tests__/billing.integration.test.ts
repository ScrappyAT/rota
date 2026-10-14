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

  it('26. plans endpoint returns camelCase fields pricePerSeatMinor, maxSeats, isFree', async () => {
    const plans = await request(app).get(`/teams/${teamA}/subscription/plans`).set('Authorization', `Bearer ${alice.token}`);
    expect(plans.status).toBe(200);
    expect(plans.body.data).toHaveLength(4);

    for (const plan of plans.body.data) {
      expect(typeof plan.code).toBe('string');
      expect(typeof plan.name).toBe('string');
      expect(typeof plan.pricePerSeatMinor).toBe('number');
      expect(typeof plan.maxSeats).toBe('number');
      expect(typeof plan.currency).toBe('string');
      expect(typeof plan.isFree).toBe('boolean');
      expect(Number.isFinite(plan.pricePerSeatMinor)).toBe(true);
      expect(Number.isFinite(plan.maxSeats)).toBe(true);
      // Backward-compatible snake_case fields also present
      expect(plan.price_per_seat_minor).toBe(plan.pricePerSeatMinor);
      expect(plan.max_seats).toBe(plan.maxSeats);
      expect(plan.is_free).toBe(plan.isFree);
    }

    const free = plans.body.data.find((p: any) => p.code === 'FREE');
    expect(free.pricePerSeatMinor).toBe(0);
    expect(free.isFree).toBe(true);

    const growth = plans.body.data.find((p: any) => p.code === 'GROWTH');
    expect(growth.pricePerSeatMinor).toBe(300000);
    expect(growth.maxSeats).toBe(50);
    expect(growth.isFree).toBe(false);
  });

  it('27. GET /billing/redirect bridges back to mobile app and sanitizes open redirects', async () => {
    // Default scheme rota://
    const resDefault = await request(app)
      .get('/billing/redirect?status=successful&tx_ref=ref-123&transaction_id=98765');
    expect(resDefault.status).toBe(200);
    expect(resDefault.text).toContain('rota://billing/redirect?status=successful&tx_ref=ref-123&transaction_id=98765');
    expect(resDefault.text).toContain('Returning to Rota...');

    // Allowed custom return_url (e.g. dev localhost)
    const resLocalhost = await request(app)
      .get('/billing/redirect?status=successful&tx_ref=ref-123&transaction_id=98765&return_url=http://localhost:8081/billing/redirect');
    expect(resLocalhost.status).toBe(200);
    expect(resLocalhost.text).toContain('http://localhost:8081/billing/redirect?status=successful&tx_ref=ref-123&transaction_id=98765');

    // Malicious open redirect fallback to safe rota://
    const resMalicious = await request(app)
      .get('/billing/redirect?status=successful&tx_ref=ref-123&transaction_id=98765&return_url=https://attacker.com/steal');
    expect(resMalicious.status).toBe(200);
    expect(resMalicious.text).not.toContain('attacker.com');
    expect(resMalicious.text).toContain('rota://billing/redirect?status=successful&tx_ref=ref-123&transaction_id=98765');
  });

  it('28. checkout forwards returnUrl to Flutterwave initializeCheckout', async () => {
    const res = await checkout(alice.token, teamA, {
      planCode: 'GROWTH',
      seats: 4,
      returnUrl: 'rota://billing/redirect',
    });
    expect(res.status).toBe(201);
    expect(mockedInitializeCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        redirectUrl: expect.stringContaining('return_url=rota%3A%2F%2Fbilling%2Fredirect'),
      })
    );
  });

  it('29. webhook with failed status marks payment and change as FAILED', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'SCALE', seats: 5 });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;
    const amountMajor = Math.round(res.body.data.payment.amountMinor / 100);

    const webhook = await callWebhook({
      event: 'charge.completed',
      data: { id: 70099, tx_ref: txRef, amount: amountMajor, currency: 'NGN', status: 'failed' },
    });
    expect(webhook.status).toBe(200);
    expect(webhook.body.data).toMatchObject({ processed: true, outcome: 'FAILED' });

    const db = await pool.query('SELECT status FROM payment_transactions WHERE tx_ref = $1', [txRef]);
    expect(db.rows[0].status).toBe('FAILED');

    const changeDb = await pool.query('SELECT status FROM subscription_changes WHERE id = $1', [res.body.data.change.id]);
    expect(changeDb.rows[0].status).toBe('FAILED');
  });

  it('30. out-of-order webhook cannot overwrite a verified SUCCESSFUL payment', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'GROWTH', seats: 3 });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;
    const amountMajor = Math.round(res.body.data.payment.amountMinor / 100);

    // First, verify successfully via redirect handler
    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '90099',
      txRef,
      amountMajor,
      currency: 'NGN',
      status: 'successful',
    });
    const verified = await verify(alice.token, teamA, txRef, '90099');
    expect(verified.status).toBe(200);
    expect(verified.body.data.outcome).toBe('SUCCESS');

    // Later webhook arrives with status failed or successful
    const lateWebhook = await callWebhook({
      event: 'charge.completed',
      data: { id: 70100, tx_ref: txRef, amount: amountMajor, currency: 'NGN', status: 'failed' },
    });
    expect(lateWebhook.status).toBe(200);
    // Since payment was already claimed and settled to SUCCESSFUL, there is no pending payment to settle
    expect(lateWebhook.body.data).toMatchObject({ processed: false, reason: 'no-pending' });

    // Payment in DB is still SUCCESSFUL
    const db = await pool.query('SELECT status FROM payment_transactions WHERE tx_ref = $1', [txRef]);
    expect(db.rows[0].status).toBe('SUCCESSFUL');
  });

  it('31. GET /teams/:teamId/subscription/payments/:txRef retrieves exact transaction status and isolates tenants', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'GROWTH', seats: 4 });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;

    // Direct query by owner for pending payment
    const checkPending = await request(app)
      .get(`/teams/${teamA}/subscription/payments/${txRef}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(checkPending.status).toBe(200);
    expect(checkPending.body.data).toMatchObject({
      txRef,
      status: 'PENDING',
      teamId: teamA,
    });

    // Unknown txRef returns 404
    const check404 = await request(app)
      .get(`/teams/${teamA}/subscription/payments/non-existent-tx-ref`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(check404.status).toBe(404);
    expect(check404.body.error.code).toBe('PAYMENT_NOT_FOUND');

    // Cross-tenant access denied with 404
    const checkCrossTenant = await request(app)
      .get(`/teams/${teamA}/subscription/payments/${txRef}`)
      .set('Authorization', `Bearer ${ownerTeamB.token}`);
    expect(checkCrossTenant.status).toBe(404);
  });

  it('32. abandoned checkout followed by successful checkout does not cancel older transaction and reconciles late payment without altering active subscription', async () => {
    // Team A is on Growth plan. Setup GROWTH 5 seats to replicate Samsung test state:
    const setupGrowth = await checkout(alice.token, teamA, { planCode: 'GROWTH', seats: 5 });
    expect(setupGrowth.status).toBe(201);
    const growthTxRef = setupGrowth.body.data.payment.txRef;
    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '80001',
      txRef: growthTxRef,
      amountMajor: Math.round(setupGrowth.body.data.payment.amountMinor / 100),
      currency: 'NGN',
      status: 'successful',
    });
    const verifyGrowth = await verify(alice.token, teamA, growthTxRef, '80001');
    expect(verifyGrowth.status).toBe(200);

    // Verify team is now GROWTH, 5 seats
    const currentSub = await request(app).get(`/teams/${teamA}/subscription`).set('Authorization', `Bearer ${alice.token}`);
    expect(currentSub.body.data.subscription.planCode).toBe('GROWTH');
    expect(currentSub.body.data.subscription.seats).toBe(5);

    // 1. Attempt Scale checkout for 100 seats (high-value attempt, e.g. ~₦323,833.33)
    const scale100 = await checkout(alice.token, teamA, { planCode: 'SCALE', seats: 100 });
    expect(scale100.status).toBe(201);
    const scale100TxRef = scale100.body.data.payment.txRef;
    expect(scale100.body.data.payment.amountMinor).toBeGreaterThan(30000000);

    // At this point, pendingPayment reflects this high-value attempt:
    const subWithPending = await request(app).get(`/teams/${teamA}/subscription`).set('Authorization', `Bearer ${alice.token}`);
    expect(subWithPending.body.data.pendingPayment).toMatchObject({
      txRef: scale100TxRef,
      status: 'PENDING',
    });

    // 2. User abandons the 100-seat checkout, and instead checks out Scale for 5 seats:
    const scale5 = await checkout(alice.token, teamA, { planCode: 'SCALE', seats: 5 });
    expect(scale5.status).toBe(201);
    const scale5TxRef = scale5.body.data.payment.txRef;

    // 3. Scale 5 seats succeeds:
    mockedVerifyTransaction.mockResolvedValueOnce({
      transactionId: '80002',
      txRef: scale5TxRef,
      amountMajor: Math.round(scale5.body.data.payment.amountMinor / 100),
      currency: 'NGN',
      status: 'successful',
    });
    const verifyScale5 = await verify(alice.token, teamA, scale5TxRef, '80002');
    expect(verifyScale5.status).toBe(200);
    expect(verifyScale5.body.data.outcome).toBe('SUCCESS');

    // 4. Verify subscription screen state:
    // Team subscription is now SCALE, 5 seats
    const finalSub = await request(app).get(`/teams/${teamA}/subscription`).set('Authorization', `Bearer ${alice.token}`);
    expect(finalSub.body.data.subscription.planCode).toBe('SCALE');
    expect(finalSub.body.data.subscription.seats).toBe(5);
    expect(finalSub.body.data.subscription.status).toBe('ACTIVE');

    // The abandoned 100-seat pendingPayment is NOT shown on the subscription screen:
    expect(finalSub.body.data.pendingPayment).toBeNull();

    // In database, the 100-seat transaction was NOT falsely cancelled; it remains PENDING in audit ledger:
    const abandonedTx = await pool.query('SELECT status FROM payment_transactions WHERE tx_ref = $1', [scale100TxRef]);
    expect(abandonedTx.rows[0].status).toBe('PENDING');

    // 5. Late success: customer's 100-seat payment actually settles at Flutterwave:
    const scale100AmountMajor = Math.round(scale100.body.data.payment.amountMinor / 100);
    const lateWebhook = await callWebhook({
      event: 'charge.completed',
      data: {
        id: 80003,
        tx_ref: scale100TxRef,
        amount: scale100AmountMajor,
        currency: 'NGN',
        status: 'successful',
      },
    });
    expect(lateWebhook.status).toBe(200);
    expect(lateWebhook.body.data).toMatchObject({ processed: true, outcome: 'SUCCESS' });

    // Financial outcome is fully recorded:
    const settledTx = await pool.query('SELECT status, flw_transaction_id FROM payment_transactions WHERE tx_ref = $1', [scale100TxRef]);
    expect(settledTx.rows[0].status).toBe('SUCCESSFUL');
    expect(settledTx.rows[0].flw_transaction_id).toBe('80003');

    const settledInvoice = await pool.query('SELECT status, paid_at FROM billing_invoices WHERE change_id = $1', [scale100.body.data.change.id]);
    expect(settledInvoice.rows[0].status).toBe('PAID');
    expect(settledInvoice.rows[0].paid_at).not.toBeNull();

    // But active subscription state is PRESERVED (NOT reverted to 100 seats):
    const subAfterLateSettlement = await request(app).get(`/teams/${teamA}/subscription`).set('Authorization', `Bearer ${alice.token}`);
    expect(subAfterLateSettlement.body.data.subscription.planCode).toBe('SCALE');
    expect(subAfterLateSettlement.body.data.subscription.seats).toBe(5);
  });

  it('33. unresolved transaction with no gateway transaction ID is suppressed from subscription screen but remains PENDING in ledger', async () => {
    const res = await checkout(alice.token, teamA, { planCode: 'SCALE', seats: 6 });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;

    // Simulate an unsubmitted checkout past 1 hour:
    await pool.query(
      `UPDATE payment_transactions
       SET created_at = NOW() - INTERVAL '2 hours'
       WHERE tx_ref = $1`,
      [txRef]
    );

    // Suppressed from active subscription screen:
    const subRes = await request(app).get(`/teams/${teamA}/subscription`).set('Authorization', `Bearer ${alice.token}`);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.pendingPayment).toBeNull();

    // Database ledger is NOT falsified: remains PENDING with flw_transaction_id NULL:
    const dbTx = await pool.query('SELECT status, flw_transaction_id FROM payment_transactions WHERE tx_ref = $1', [txRef]);
    expect(dbTx.rows[0].status).toBe('PENDING');
    expect(dbTx.rows[0].flw_transaction_id).toBeNull();

    // Direct endpoint retrieves accurate audit status:
    const checkDirect = await request(app)
      .get(`/teams/${teamA}/subscription/payments/${txRef}`)
      .set('Authorization', `Bearer ${alice.token}`);
    expect(checkDirect.status).toBe(200);
    expect(checkDirect.body.data.status).toBe('PENDING');
  });

  it('34. pending checkout with flw_transaction_id is not expired without gateway verification', async () => {
    const res = await checkout(ownerTeamB.token, teamB, { planCode: 'GROWTH', seats: 4 });
    expect(res.status).toBe(201);
    const txRef = res.body.data.payment.txRef;

    // Set a gateway transaction ID and backdate:
    await pool.query(
      `UPDATE payment_transactions
       SET flw_transaction_id = 'flw-sub-12345', created_at = NOW() - INTERVAL '2 hours'
       WHERE tx_ref = $1`,
      [txRef]
    );

    // Should NOT be silently suppressed because it has a gateway transaction ID awaiting settlement:
    const subRes = await request(app).get(`/teams/${teamB}/subscription`).set('Authorization', `Bearer ${ownerTeamB.token}`);
    expect(subRes.status).toBe(200);
    expect(subRes.body.data.pendingPayment).not.toBeNull();
    expect(subRes.body.data.pendingPayment.txRef).toBe(txRef);

    const dbTx = await pool.query('SELECT status FROM payment_transactions WHERE tx_ref = $1', [txRef]);
    expect(dbTx.rows[0].status).toBe('PENDING');
  });
});