# Billing - Milestone R1

The original Final Graduation Task PDF, Part 2 Task A (pricing/proration on
page 19), governs the new catalog. This document supersedes the old Phase 4
pricing description; historical Phase 4 test reports remain historical evidence.
See `R1-IMPLEMENTATION-REPORT.md` for executed validation and limitations.

## Catalog and compatibility

| Public plan | Monthly base (USD cents) | Included seats | Each additional seat |
|---|---:|---:|---:|
| Starter | 2000 ($20) | 5 | Unavailable; hard cap 5 |
| Team | 5000 ($50) | 15 | 300 ($3) |
| Business | 12000 ($120) | 40 | 200 ($2) |

Monthly charge = base + max(0, purchased seats - included seats) * extra rate.
The API normalizes a requested count below the allowance to the included count.
Owners and managers consume seats too; valid pending invitations reserve seats.
Team/Business have no commercial extra-seat cap; the API has a 100,000-seat
input safety bound. Starter rejects a sixth seat.

Migration `007_billing_financial_integrity.sql` adds the internal plan IDs
`STARTER_USD_V1`, `TEAM_USD_V1`, `BUSINESS_USD_V1` with public codes STARTER,
TEAM, BUSINESS. Existing FREE/STARTER/GROWTH/SCALE rows and financial values
are retained. Existing paid NGN subscriptions can renew/change seats using
their original plan; a paid NGN-to-USD checkout returns
`409 CURRENCY_CHANGE_REQUIRES_MIGRATION`. No exchange rate is invented. FREE
teams can buy a USD plan for a full new paid period without NGN credit.
`BILLING_CURRENCY=NGN` remains the legacy fallback; new quotes use plan currency.

## Exact calculations

All persisted/calculated amounts are integer minor units. Let O and N be old
and new monthly amounts, D be the period length in days, and R be remaining
days (ceil, clamped to the actual period length).

- unused credit = floor(O * R / D)
- remaining new cost = floor(N * R / D)
- payment due = max(0, remaining new cost - unused credit)

The two products are independently divided using BigInt integer arithmetic.
Do not round the net difference. A newly paid or expired subscription pays a
full new period; renewal pays the full current monthly amount.

Worked examples (30-day periods):

| Case | Credit | Cost | Due |
|---|---:|---:|---:|
| Starter -> Team, 20 days left | floor(2000*20/30)=1333 | floor(5000*20/30)=3333 | 2000 ($20) |
| Team 15 -> 18 seats, 12 days left | 2000 | 2360 | 360 ($3.60) |
| Starter -> Business, 1 day left | 66 | 400 | 334 ($3.34) |
| Team -> Business, 10 days left, after an earlier upgrade | 1666 | 4000 | 2334 ($23.34) |
| Renew Team with 18 seats | 0 | 5900 | 5900 ($59) |

Adapter conversion uses decimal strings (10067 -> "100.67"). Verification
parses at most two decimal places exactly and compares both currency and minor
amount to the payment itself. No new-payment tolerance or whole-dollar rounding
is used. Only pre-R1 NGN pending payments with no saved quote may match the
old adapter's exact whole-naira rounded value. Their original rows are unchanged;
the new ledger records the actual verified amount.

## Downgrades and seats

A lower plan tier or same-plan seat reduction is saved with `effective_at` equal
to the current paid period end. No payment/refund occurs immediately; the
subscription continues to expose its current plan/seats. At/after the boundary,
`materializeSubscription` applies the scheduled change before status/renewal
calculation and records its state. Expired subscriptions still require renewal.
The existing lazy materialization model remains: no new background scheduler
has been introduced in R1. Renewing before a scheduled change is due returns
`409 CHANGE_SCHEDULED` to avoid billing the obsolete plan.

All billing, invitation creation and invitation acceptance serialize on the team
row, with lock order team -> subscription -> payment. Capacity includes members
plus unexpired pending invitations. A resend of an existing invitation does not
consume a second reservation. Acceptance rechecks the locked invitation and
capacity, so concurrent acceptance cannot create duplicate members. A scheduled
lower capacity also limits future reservations immediately, so the downgrade
remains feasible. Seat edits and checkout reject a target below reservations.

## Initiation and reconciliation

Owner-only `POST /teams/:teamId/subscription/{checkout,seats,renew}` requires
`Idempotency-Key: <client-generated UUID>`. CORS permits this header. The mobile
client persists a key per user/team/operation/input, shares an in-flight request,
retains it after lost responses/restarts, and clears it for its matching terminal
payment. New randomness uses `expo-crypto`; rebuild the native app to include it.

The server stores the request hash and response under team/actor/key in the same
transaction as the change/invoice/payment, before calling the provider. A replay
returns the same reference/result; changed intent with that key returns 409.
The provider call occurs outside the database transaction, once per reserved
intent. A lost/ambiguous provider response leaves a 202 processing response and
is not automatically reissued. This prevents duplicate checkout creation but
requires later verification/webhook/manual resolution if initialization crashed.

Success is 201 with checkout URL; scheduled/zero-due change is 200; unresolved
initialization is 202 with the reserved payment and processing=true. A distinct
new UUID represents a distinct authorized intent, not a retry.

Settlement locks the team and payment, validates reference/currency/amount,
then claims PENDING exactly once. A quote stores the expected subscription
revision. A late payment cannot overwrite a newer paid change; it is recorded
with an unapplied credit for manual resolution. A late failed renewal also
cannot invalidate a newer paid upgrade. Existing webhook hash verification and
webhook deduplication are retained. Durable webhook processing is outside R1.

## Append-only ledger and reconstruction

`financial_ledger` stores CHARGE, CREDIT, REFUND and zero-amount STATE entries,
with unique event keys, original currency and optional payment reference.
Triggers reject UPDATE, DELETE and TRUNCATE. Event-key replay must match the
original contents; a conflicting entry returns LEDGER_CONFLICT. No cascading
foreign keys allow operational entity deletion to erase the ledger.

A settled prorated payment posts the gross remaining-service CHARGE and the
unused-time CREDIT, whose difference is the captured amount. CHARGE metadata
also records receivedMinor. Zero-net immediate changes post both offsetting
entries. Scheduled downgrades post state only until effective. Imported
successful payments get opening charges at their original stored amounts;
opening STATE snapshots honestly mark the beginning of reconstructable history.
No earlier missing accounting events are fabricated.

Every R1 subscription transition atomically appends a canonical STATE snapshot,
including full scheduled-change details. `reconstructSubscription` and
`reconstructBilling` read only immutable ledger data. The latter reads state,
schedule and per-currency charge/credit/refund totals in one SQL snapshot;
`GET /teams/:teamId/subscription/ledger/reconstruction` exposes it to owners.
Tests corrupt the mutable subscription and prove exact reconstruction. Currencies
are never netted against one another; totals are decimal strings for precision.

`recordRefund` is an internal accounting function for an externally confirmed
refund. It locks the settled payment, caps cumulative refunds at the actual
captured amount, and deduplicates event keys. It never calls Flutterwave or
moves funds. There is no new public refund endpoint. Database administrators
can disable triggers; this is database-enforced append-only accounting, not an
external tamper-proof archive. R1 preserves pre-existing mutable invoice/payment
projections; the ledger is the new immutable financial history.

## Disposable verification

Normal development services on 5440/6380 are not used. Create these isolated
services once (the passwords below are disposable test credentials):

```powershell
docker run -d --name rota-r1-test-postgres -e POSTGRES_PASSWORD=r1-disposable-only -e POSTGRES_DB=rota_r1_test -p 127.0.0.1:5540:5432 postgres:15-alpine
docker run -d --name rota-r1-test-redis -p 127.0.0.1:6480:6379 redis:7-alpine
docker run -d --name rota-r1-test-shard-0 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rota_r1_shard_0 -p 127.0.0.1:5541:5432 postgres:15-alpine
docker run -d --name rota-r1-test-shard-1 -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=rota_r1_shard_1 -p 127.0.0.1:5542:5432 postgres:15-alpine
npm run build:shared
npm run test:r1
```

Wait for PostgreSQL readiness before running. The script pins every database,
Redis, provider and push URL instead of reading real service credentials from
`.env`, applies migrations only to the isolated main test database, and runs
Jest serially. Sharding tests migrate only these disposable shards. The upgrade
preservation test creates/drops only `rota_r1_upgrade_test` on the guarded
127.0.0.1:5540 disposable PostgreSQL server. Integration tests really use
PostgreSQL/Redis; gateway responses and HTTP adapter fetches are mocked.
No real financial transaction is executed.

Jest caches under the ignored repository `.r1-test-cache` directory to avoid
the earlier temporary-cache EPERM problem. The large-dataset reseed test has
the same 120-second budget as its existing setup; its assertions are unchanged.
Mobile has no runtime test runner; client intent logic is exercised in the API
Jest process by importing the actual shared implementation. Device checkout
and a real Flutterwave account's USD capabilities remain unverified.
