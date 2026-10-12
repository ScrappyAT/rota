# Billing — Seat-Based Subscriptions (Phase 4)

Phase 4 adds seat-based, recurring subscriptions billed per team through the
Flutterwave gateway (NGN). This document describes the implemented behavior.
Test evidence: `docs/PHASE-4-TEST-REPORT.md`.

## Overview

- Every team has exactly one row in `team_subscriptions`; it is created on team
  creation (`FREE` plan, active, seats = `GREATEST(1, memberCount)`, one
  `BILLING_PERIOD_DAYS` period).
- Plans are stored in `billing_plans`. The system ships four seeded plans, all
  priced per seat per month.
- On a paid plan, `seats` is the number of seats the owner purchased.
  `FREE` seats are capped by the plan's `max_seats` (100) regardless of the
  stored value.
- Effective seat capacity: `plan.max_seats` on FREE, otherwise `subscription.seats`.
- Usage = current members + unexpired pending invitations. Adding members or
  new invites is blocked when that total would exceed capacity.

## Money model

- All money is stored and computed as **integer minor units** (kobo).
  `billing_plans.price_per_seat_minor` is kobo per seat per month.
- Flutterwave's hosted checkout and verify responses report amounts in the
  currency's **major unit** (naira). The client converts minor → major on the
  way out (`amountMinor / minorUnitsPerMajor`, 100) and back on the way in.
- Verification tolerance: expected major = `round(amountMinor / 100)`; a match
  within `0.5 / 100` is accepted (guards against float drift).
- Formatting helpers: `apps/api/src/billing/proration.ts`
  (`monthlyAmount`, `proratedChargeMinor`, `daysRemainingInPeriod`, `addDays`).

### Proration

- `monthly = pricePerSeatMinor * seats`.
- Upgrade or seat-adding charge =
  `round((newMonthly − oldMonthly) × daysRemaining / periodDays)`, clamped to 0.
- Downgrades and seat reductions charge nothing, apply immediately, and
  refund nothing (credit toward the next period is not credited — documented
  limitation).
- `daysRemainingInPeriod` is whole days (ceil), clamped to 0 after the period
  end (materialization flips an overdue active subscription to `EXPIRED` first).

## Subscription status lifecycle

- `ACTIVE` — normal operation. Lapses to `EXPIRED` automatically once
  `period_ends_at <= now` (lazy materialization).
- `PAST_DUE` — a **renewal payment failed** while the subscription was still
  `ACTIVE`. Opens a `SUBSCRIPTION_GRACE_DAYS` grace window
  (`grace_ends_at = now + graceDays`).
- `EXPIRED` — grace window elapsed (`PAST_DUE` + `grace_ends_at <= now`) or a
  period ended with no active renewal. Blocks adding members/invites and
  creating shifts.
- `CANCELLED` — reserved for a future termination flow (not reachable yet).

Transitions are lazy: `materializeSubscription(client, teamId, now)` computes
the transition and persists it before any billing operation reads the row.
`transitionStatus` is a pure function so the floor is unit-tested.

### Enforcements

- `assertCanGrow(client, teamId, now, extra)` — invitation create
  (`POST /invitations/team/:teamId`): requires `ACTIVE`, else 403
  `SUBSCRIPTION_REQUIRED`; reserves capacity so pending invites count against
  seats (`members + pending + extra > capacity` → 403 `SEAT_LIMIT_EXCEEDED`).
- `assertSubscriptionActive(client, teamId, now)` — shift create
  (`POST /teams/:teamId/shifts`): requires `ACTIVE` (403
  `SUBSCRIPTION_REQUIRED`). Seats themselves are not consumed by shift writes.
- Seat edits (`POST /seats`) reject setting seats below the current member
  count (400 `SEAT_LIMIT_EXCEEDED`).

## Change lifecycle

A change is one of `PLAN_UPGRADE`, `PLAN_DOWNGRADE`, `ADD_SEATS`,
`REDUCE_SEATS`, `RENEWAL` (`subscription_changes.type`).

`openChange(client, teamId, actorId, computed, now)` runs in the caller's
transaction and writes:

1. `subscription_changes` row — `PENDING_PAYMENT` if a charge is due,
   `PAID` otherwise.
2. `billing_invoices` row — `OUTSTANDING` or `PAID` accordingly.
3. When a charge is due, a `payment_transactions` row with a unique
   `tx_ref` (`rota-<uuid>`) and `PENDING` status.

- **No charge** (downgrade, seat reduction, FREE renewal): the new
  plan/seats are applied immediately inside `openChange` and a
  `SUBSCRIPTION_CHANGED` activity event is written.
- **Charge** (upgrade, seat addition, paid renewal): the change stays
  `PENDING_PAYMENT`; the API returns the checkout URL. The subscription is
  **not** modified until the payment settles.

### Renewal

`POST /renew` → `computeRenewal(sub, plan)`: one full month at current
price × seats. Free plans renew instantly (no payment). Paid renewals open a
`PENDING` payment; on success `applyRenewal` sets a fresh `period_started_at =
now` / `period_ends_at = now + periodDays`. A failed renewal marks the change
`FAILED` and, only if the subscription was `ACTIVE`, flips it to `PAST_DUE`
with `grace_ends_at = now + graceDays`.

## Payment verification & idempotency

Reconciliation (`reconcilePayment`) runs inside an explicit transaction and is
used by both `POST /subscription/verify` and the webhook:

1. Load the `PENDING`‑or‑later payment by `(team_id, tx_ref)`
   (404 `PAYMENT_NOT_FOUND` if unknown).
2. Already `SUCCESSFUL`/`FAILED` → `ALREADY_PROCESSED` (no-op replay).
3. Validate gateway data: tx_ref match, currency must equal
   `BILLING_CURRENCY`, amount within tolerance (400 `PAYMENT_MISMATCH` if any
   fails; the outer `ROLLBACK` leaves nothing half-applied), and no conflicting
   `flw_transaction_id`.
4. **Claim** the payment with a guarded update:
   `UPDATE ... SET status = $state WHERE id = $id AND status = 'PENDING'`.
   A competing settle in a concurrent transaction sees zero rows and returns
   `ALREADY_PROCESSED`.
5. Apply the effect: `applyChange` (upgrades/add/seat-changes) or
   `applyRenewal` (renewals), mark change `PAID`, invoice `PAID`,
   write `PAYMENT_RECEIVED` + `SUBSCRIPTION_CHANGED` activity.

The webhook additionally deduplicates by `webhook_events.event_key`
(`<event>:<data.id>`, PK) via `ON CONFLICT DO UPDATE ... RETURNING
processed_at`: a second delivery returns `{ processed: false, reason:
'duplicate' }`. The `verif-hash` header is validated with a constant-time
comparison against `FLW_SECRET_HASH` (401 on mismatch). Webhook events for
other event types are acknowledged and marked processed but not settled.

## API endpoints

All under `/teams/:teamId`, **OWNER only** (403 for managers/staff,
404 for non-members), except the two public `/billing` routes:

Subscription (`/teams/:teamId/subscription`):

- `GET /` — enrollment summary: `subscription` (with `planName`,
  `planPricePerSeatMinor`, `planMaxSeatsExempt`), `seatsUsed`,
  `pendingInvites`, `seatCapacity`, `billingEnabled`, `pendingPayment`,
  `latestFailedRenewal`.
- `GET /plans` — public plan catalog (ascending price).
- `POST /checkout` — `{ planCode, seats? }`. Charges when the monthly
  accrue is positive; otherwise applies immediately.
- `POST /seats` — `{ seats }` on the current plan.
- `POST /renew` — one full period at current config.
- `POST /verify` — `{ txRef, transactionId }`. Calls Flutterwave
  `GET /v3/transactions/:id/verify`, then reconciles.
- `GET /changes` — change history, cursor paginated.
- `GET /billing` — invoice history, cursor paginated.

Public (`/billing`):

- `POST /webhook/flutterwave` — Flutterwave webhook: `verif-hash` check +
  `event_key` dedupe + reconciliation. Rate limited (300 req / 15 min / IP).
- `GET /redirect` — browser landing page after hosted checkout; carries no
  secrets and just tells the user to return to the app.

Paid-plan responses return `201` with `checkoutUrl`; no-charge responses
return `200`. `initializeCheckout` returns the hosted payment link by POSTing
`/v3/payments` with `tx_ref`, major-unit amount, `redirect_url =
<host>/billing/redirect`, and the actor's email.

## Mobile

Owner-only screens in `apps/mobile/app/subscription/`:

- `index.tsx` — plan, status, seats/capacity, period, pending payment,
  renewal (opens checkout when a charge is due), graceful/expired warnings.
- `plans.tsx` — plan catalog with optional seat count; runs checkout and opens
  it via `WebBrowser.openAuthSessionAsync(checkoutUrl, <API>/billing/redirect)`.
  If the return URL carries `tx_ref` + `transaction_id` it calls
  `POST /verify`; otherwise it refetches the summary and lets the webhook
  settle the payment.
- `billing.tsx` — change history + invoices (recent 50 each).

Settings (`app/(tabs)/settings.tsx`) links to these three for the selected
team when the signed-in user is an owner. The API layer lives in
`apps/mobile/src/api/billing.ts`; checkout return parsing in
`apps/mobile/src/utils/checkout.ts`.

## Known limitations

- No refunds or prorated credits for downgrades/seat reductions.
- `CANCELLED` status is defined but nothing produces it yet.
- Seats can be lowered only down to the current member count
  (members first must be removed).
- Webhook and verify are the only settlement paths; a payment that is neither
  verified nor delivered by webhook stays `PENDING` forever (no expiry job).
- Live/sandbox latency and the end-to-end card flow require real Flutterwave
  credentials and have not been exercised.