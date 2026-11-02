# Milestone R1 implementation report

Date: 2026-10-30. Repository: `C:/Users/HP/Desktop/rota project`.
Branch: `codex/r1-billing-financial-integrity`, created from the clean current
`main` at `d4954cc`. Changes remain uncommitted for review. No push, merge,
deployment, production database access, or real financial transaction occurred.
Only Milestone R1 was implemented; R2, R3 and R4 were not started.

The authoritative financial rules are the original Dev and Design HQ Final
Graduation Task PDF, Part 2 Task A, page 19. Existing Phase 4 documentation was
historical evidence, not the source of the new prices. Completed demos/posts
and submission deliverables have not been recategorized as pending work.

## 1. Scope and evidence

All paths below are relative to the repository path above; the complete changed
file inventory at the end links to absolute workspace paths.

| R1 requirement | Implementation | Test evidence |
|---|---|---|
| Exact prices, allowances, extras | `007_billing_financial_integrity.sql`; `proration.ts:planMonthlyAmount`; `service.ts:getPurchasablePlan/listPlans` | `financialCalculations.test.ts` catalog cases; `billing.integration.test.ts` 01,02,04,05,30 |
| Independent proration rounding | `proration.ts:prorationBreakdown`; `service.ts:computeChange/computeRenewal` | Calculation suite covers upgrade, downgrade, adding/removing seats, first/last day and two changes; integration cases 09,10 validate persisted amounts |
| End-period downgrades | `computeChange`, `openChange`, `materializeSubscription`; revision/scheduled-change columns | Integration 12,13,14,17,31,35; current plan retained before boundary, target applied at boundary, renewal uses lower price |
| Exact gateway conversion/verification | `minorToMajor/majorToMinor`, `flutterwave.ts:initializeCheckout/verifyTransaction`, `reconcilePayment` | `flutterwavePrecision.test.ts`; integration 10,30,34,37; malformed decimals and exact round-trip cases |
| Seats include pending invitations and concurrency | `initiation.ts:initiateBilling`, `service.ts:assertCanGrow`, invitation create/accept under team row lock | Integration 14-17,31,39; duplicate acceptance, final reservation, resend and downgrade races |
| Client-generated keys/server dedupe | `PaymentAttempts`, mobile `requestPayment`, `initiateBilling`, `billing_idempotency`; UUID header required | `paymentAttempts.test.ts` actual shared client logic; integration 04,06-08,11; one provider call/transaction for duplicate intent, persisted retry, conflict |
| Immutable charge/credit/refund ledger | `ledger.ts:appendLedger/snapshotSubscription/reconstructSubscription/reconstructBilling/recordRefund`; mutation-rejecting triggers | Integration 20-24,35,37,38: late credit, mutation rejection, replay conflicts, corrupt projection/rebuild, full scheduled state, per-currency totals and concurrent refund cap |
| Focused unit/integration regression coverage | Real PostgreSQL/Redis, real HTTP API, mocked gateway; disposable main plus two actual shard databases | Final gates below; no database mocking in integration tests |

Backend behaviors above are implemented and tested. The mobile binding and
pricing screens compile/lint; native checkout/storage UI runtime has not been
observed. Shared client intent behavior is exercised directly in Jest, not a
copied test implementation.

## 2. Migration and historical data

One additive migration: `apps/api/migrations/007_billing_financial_integrity.sql`.
No existing migration was edited. It adds:

- Pricing model, public plan code, base price, included seats and extra-seat rate.
- Versioned USD plan IDs `STARTER_USD_V1`, `TEAM_USD_V1`, `BUSINESS_USD_V1`.
- Subscription revision and scheduled change reference; change currency,
  effective date, expected revision and saved financial quote.
- `billing_idempotency`, with request hash, reserved response/reference and status.
- `financial_ledger`, indexes, unique event keys and triggers rejecting UPDATE,
  DELETE and TRUNCATE. It has no cascading entity foreign keys.
- Opening immutable subscription snapshots and charges for historical successful
  payments, at their original stored amounts and currencies.

Conflict with the previous model: the old internal `STARTER` means NGN2500 per
seat/month, not the assignment USD20 total for five seats. GROWTH/SCALE are also
legacy NGN per-seat rows. Reusing or updating those IDs would reinterpret old
subscriptions, invoices and payments. Instead, new catalog requests resolve
public codes to versioned USD IDs. Existing paid NGN plans remain renewable
with their old rates. A paid cross-currency checkout returns 409
`CURRENCY_CHANGE_REQUIRES_MIGRATION`; no FX credit or automatic conversion is
applied. FREE teams can start a fresh USD period.

`billingMigration.test.ts` builds a pre-R1 database with actual historical NGN
subscriptions, paid/pending payments and invoices, applies 007, and compares the
original financial fields exactly. It also checks the imported NGN charge.
All migrations and data writes in this work were confined to disposable servers.
007 has not been applied to development or production databases.

## 3. Formulas and worked examples

| Plan | Base per month | Included | Extra monthly rate |
|---|---:|---:|---:|
| Starter | USD20 = 2000 cents | 5 | None; sixth seat rejected |
| Team | USD50 = 5000 cents | 15 | USD3 = 300 cents |
| Business | USD120 = 12000 cents | 40 | USD2 = 200 cents |

Monthly amount = base + max(0, purchased seats - included seats) * extra rate.
For example, Team with 18 seats costs 5000 + 3*300 = 5900 cents (USD59).
All team members, including the owner/managers, count; pending valid invitations
reserve seats. Counts below the included allowance normalize to the allowance.
Team/Business have a 100,000-seat API input bound, not an extra commercial tier cap.

For O = old monthly cents, N = new monthly cents, R = whole remaining days,
D = actual period length in days:

```
credit = floor(O * R / D)
cost   = floor(N * R / D)
due    = max(0, cost - credit)
```

BigInt division floors each nonnegative product separately; no rounding of the
net difference. Remaining days use ceil and are clamped to the actual period.
The new catalog uses the existing configured 30-day default. First paid checkout
and expired-period changes pay a full fresh period; renewals pay the full month.

- PDF example, Starter -> Team with 20/30 days: credit 1333, cost 3333,
  due 2000 cents (USD20).
- Three added Team seats with 12/30 days: old 5000, new 5900; credit 2000,
  cost 2360, due 360 cents (USD3.60).
- Starter -> Business with 1/30 days: credit 66, cost 400, due 334 cents
  (USD3.34). Rounding the difference would incorrectly produce 333.
- Two changes: Starter -> Team at 20/30 days costs 2000. A later Team ->
  Business at 10/30 days uses the paid Team price: credit 1666, cost 4000,
  due 2334. The second quote never reuses Starter as its baseline.
- Downgrade/seat reduction: due zero now; effective at period end. Paid access
  remains until then. Team 18 -> Team 15 renews at 5000 once effective.
- Gateway precision: 10067 cents sends decimal string "100.67"; verified
  "3.34" parses to 334. Invalid/fractional-cent amounts are rejected.

A paid proration posts gross cost as CHARGE and unused time as CREDIT. Their
net equals the captured payment. Zero-net immediate changes post both offsetting
entries. A late superseded payment posts an additional unapplied CREDIT so it
cannot revert the current plan. Refunds are independent entries capped at actual
captured funds. Totals are reconstructed per currency and never combined across
USD and NGN. Currency totals are strings to avoid precision loss.

## 4. Safety, idempotency and reconstruction

Billing initiation stores the intent/payment/reserved response transactionally
before the provider call. A same-key replay returns the original result and
reference; a different payload with the same key is 409. A concurrent or ambiguous
initialization can return 202 processing with its reserved reference; it is not
reissued automatically. A genuinely new key is a distinct payment intent.
Mobile uses expo-crypto UUIDs and platform-safe persistent keys per user/team/
operation/input, sharing double submissions and retaining retry references.

Capacity writers serialize on the team row; subsequent locks use subscription
then payment ordering. Accept rechecks the token and current invitation after
waiting for the lock. Scheduled lower capacity constrains new reservations so a
future downgrade stays feasible. Billing settlement revision checks prevent
older success/failure callbacks from undoing a newer paid change.

Ledger writes, financial outcomes and subscription STATE snapshots commit in
one transaction. Each STATE stores canonical subscription and full scheduled
change details. Reconstruction reads only the immutable ledger, with state and
per-currency totals read in one SQL snapshot. A test corrupts the operational
subscription seats, reconstructs the original JSON from ledger entries, compares
it exactly, and restores the disposable test projection. The opening snapshot
is the honest boundary of reconstructable pre-R1 history.

`recordRefund` records an externally confirmed refund and never moves funds.
There is no new provider refund call or public refund endpoint. Conflicting
replays are rejected; concurrent refund totals cannot exceed captured funds.

## 5. Executed verification

| Gate | Observed result |
|---|---|
| Full safe API suite, `scripts/test-r1.ps1 --silent --json --outputFile=../../.r1-test-cache/r1-results.json` | PASS: 22/22 suites, 278/278 tests, zero failed/skipped/todo; 74.855 seconds |
| Six core financial suites (included in full run) | PASS: 102 tests: billing integration 39, legacy billing unit 26, exact calculations 28, HTTP adapter 2, actual client attempt registry 6, migration preservation 1 |
| Standalone calculation/adapter/client run | PASS: 3 suites, 36 tests with no database access |
| `npm run typecheck` | PASS: API, mobile and shared, zero TypeScript errors |
| `npm run lint` | PASS: zero errors; 5 pre-existing warnings in untouched auth/shared code |
| `npm run build:api` | PASS: shared package and API compile |
| `npm test -w @rota/mobile` | Exits successfully with the existing "No tests in mobile yet" stub; no device tests claimed |
| `git diff --check` | PASS; no whitespace errors |

Raw complete final Jest results: [r1-results.json](<C:/Users/HP/Desktop/rota project/.r1-test-cache/r1-results.json>).
All 22 suites passed, including authentication/tenant isolation, invitations,
shifts/swaps/activity, 10k dataset, push, Redis cache/rate tests and physical
sharding regression coverage. There are no remaining test failures.

The safe runner is `npm run test:r1` (`scripts/test-r1.ps1`). It explicitly pins
main PostgreSQL to 127.0.0.1:5540/rota_r1_test, Redis to 6480, and the two shard
databases to 5541/5542. Dummy financial keys and local non-serving HTTP endpoints
prevent use of real providers. Jest runs serially. The upgrade test creates and
drops only its own guarded `rota_r1_upgrade_test` on the disposable server.
The four disposable containers created for this run were removed after successful
verification. Recreate them using `BILLING.md` before rerunning. Ordinary development ports 5440/6380 and
production connections were never used by this correction's test runs.

Failures found and resolved during validation:

1. A failed-renewal snapshot initially reused a revision, causing a ledger
   conflict/rollback. The state update now increments revision; failed renewal
   and late failed renewal are regression-tested.
2. The first complete run hit the pre-existing 5-second large-dataset reseed
   timeout and four subsequent cache/data assertions failed after that timeout.
   The unchanged suite passed 11/11 alone. Its reseed budget now matches the
   existing 120-second setup budget; all assertions remain in place.
3. A new client reference-retention test caught a retry discarding its associated
   payment reference. Retaining the complete stored attempt fixes it. A separate
   test enforces SecureStore-safe keys and distinct encoded scopes.
4. Running the adapter unit test independently exposed reliance on externally
   supplied dummy keys. The test now supplies its own dummy env configuration
   and mocked fetch; it no longer needs service credentials.

EPERM: it did not recur in the executed isolated full runs or ordinary unit
runs. Jest now uses an ignored workspace-local cache rather than the problematic
temporary-cache location. Elevated execution was needed for Docker/local service
access in this environment. These observations do not prove a unique original
Windows EPERM cause; no assertions or test suites were disabled to avoid it.

## 6. Remaining limitations and review boundaries

- Existing paid NGN accounts need a separately approved transition policy to
  move to USD; they are deliberately not silently converted. Old pending NGN
  payments without saved quotes can settle at the old adapter's exact rounded
  naira amount; original rows remain unchanged and actual received cents are
  posted to the new ledger. New payments always require exact cents.
- Scheduled changes materialize on the next billing/capacity/active-subscription
  operation at or after the boundary. No timer or durable worker was added.
- A crash or ambiguous checkout initialization remains processing and needs
  verification/webhook/manual resolution; automatic recovery is outside R1.
- Unapplied late-payment credits are recorded but not automatically consumed by
  later invoices. No automatic refunds or real provider refund workflow exist.
- Refund records confirm accounting facts only; real transfers require a
  separately authorized provider operation. Triggers enforce append-only writes
  for ordinary SQL, but a database administrator can disable them.
- Opening ledger entries preserve existing stored history; they cannot recover
  undocumented pre-R1 provider differences or missing historic accounting facts.
- Mobile runtime/new native crypto module and real Flutterwave sandbox checkout,
  including account-specific USD support, remain unverified. No real checkout was
  invoked. Device rebuild and manual review are required before release.
- Durable webhook jobs, failed-renewal notifications, settings/quiet hours,
  Redis limiter redesign, routing/sharding redesign and deployment are outside
  R1. Existing implementations were preserved, not declared compliant anew.
- Existing lint warnings remain in untouched auth/shared code. Mobile's test
  script remains a stub; no mobile runtime coverage is claimed.

## 7. Preservation and review state

Authentication, shifts, swaps, push delivery/preferences, Redis caching and
sharding production modules were not rewritten. Invitation changes are limited
to the capacity lock/reservation/revalidation necessary for R1. Existing API
responses retain the ApiResponse envelope and owner/tenant authorization.
The backend regression suites for these areas are included in the full safe run.

Migrations 001-006 have an empty diff against main. Historical NGN plan values,
subscription fields, payment rows and invoices are proved unchanged by the
pre-R1 migration test. New charge history is appended rather than rewriting old
records. All verification writes were to disposable databases. No production
records were reset, edited or converted. Changes remain on the feature branch
for review; no commit, push, merge, deployment or R2-R4 work was performed.

## 8. Complete changed-file inventory

| Change | File | Purpose |
|---|---|---|
| Modified | [.env.example](<C:/Users/HP/Desktop/rota project/.env.example>) | Explain legacy currency fallback and isolated test ports; no live credentials changed. |
| Modified | [.gitignore](<C:/Users/HP/Desktop/rota project/.gitignore>) | Ignore local R1 Jest cache/results. |
| Modified | [AGENTS.md](<C:/Users/HP/Desktop/rota project/AGENTS.md>) | Record financial compatibility rules and disposable verification command. |
| Modified | [README.md](<C:/Users/HP/Desktop/rota project/README.md>) | Expose R1 status and safe test setup link. |
| Modified | [apps/api/__tests__/billing.integration.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/billing.integration.test.ts>) | Real-DB mocked-gateway suite: 39 billing, concurrency, ledger, scheduling and legacy cases. |
| Modified | [apps/api/__tests__/billing.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/billing.test.ts>) | Update legacy regression expectations for fresh paid periods and scheduled reductions. |
| Modified | [apps/api/__tests__/large-dataset.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/large-dataset.test.ts>) | Match reseed timeout to existing 120-second setup; preserve assertions. |
| Modified | [apps/api/__tests__/sharding.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/sharding.test.ts>) | Use configured disposable healthy shard in fault-isolation test. |
| Modified | [apps/api/jest.config.js](<C:/Users/HP/Desktop/rota project/apps/api/jest.config.js>) | Workspace-local Jest cache; serial execution retained. |
| Modified | [apps/api/src/billing/flutterwave.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/billing/flutterwave.ts>) | Exact major-unit decimal strings and original verified amount. |
| Modified | [apps/api/src/billing/proration.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/billing/proration.ts>) | Included-seat pricing, separately floored proration and strict decimal parsing. |
| Modified | [apps/api/src/billing/service.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/billing/service.ts>) | Scheduled changes, capacity/revision locks, exact settlement and ledger transitions. |
| Modified | [apps/api/src/cors.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/cors.ts>) | Allow client Idempotency-Key header. |
| Modified | [apps/api/src/routes/invitations.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/routes/invitations.ts>) | Serialize reservations/acceptance, count resends correctly and revalidate locked invitation. |
| Modified | [apps/api/src/routes/subscription.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/routes/subscription.ts>) | Use idempotent initiation; expose pricing/currency/schedule and owner reconstruction. |
| Modified | [apps/api/src/routes/teams.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/routes/teams.ts>) | Append opening subscription state on team provisioning. |
| Modified | [apps/mobile/app/billing/redirect.tsx](<C:/Users/HP/Desktop/rota project/apps/mobile/app/billing/redirect.tsx>) | Confirm already-processed payments only when backend status is successful. |
| Modified | [apps/mobile/app/subscription/billing.tsx](<C:/Users/HP/Desktop/rota project/apps/mobile/app/subscription/billing.tsx>) | Render history in each record's original currency. |
| Modified | [apps/mobile/app/subscription/index.tsx](<C:/Users/HP/Desktop/rota project/apps/mobile/app/subscription/index.tsx>) | Show complete monthly price and scheduled reduction notice. |
| Modified | [apps/mobile/app/subscription/plans.tsx](<C:/Users/HP/Desktop/rota project/apps/mobile/app/subscription/plans.tsx>) | Render assignment allowances/extras and scheduled/processing results. |
| Modified | [apps/mobile/package.json](<C:/Users/HP/Desktop/rota project/apps/mobile/package.json>) | Add SDK-compatible expo-crypto for client UUIDs. |
| Modified | [apps/mobile/src/api/billing.ts](<C:/Users/HP/Desktop/rota project/apps/mobile/src/api/billing.ts>) | Persist client keys and attach idempotency headers to checkout/seats/renew. |
| Modified | [apps/mobile/src/utils/checkout.ts](<C:/Users/HP/Desktop/rota project/apps/mobile/src/utils/checkout.ts>) | Finish only the matching payment attempt after terminal reconciliation. |
| Modified | [docs/ARCHITECTURE.md](<C:/Users/HP/Desktop/rota project/docs/ARCHITECTURE.md>) | Document amended R1 endpoint and financial contracts. |
| Modified | [docs/BILLING.md](<C:/Users/HP/Desktop/rota project/docs/BILLING.md>) | Replace superseded pricing/math rules; explain compatibility, ledger and safe testing. |
| Modified | [docs/IMPLEMENTATION-STATUS.md](<C:/Users/HP/Desktop/rota project/docs/IMPLEMENTATION-STATUS.md>) | Record R1 verified backend versus unverified device runtime; preserve historical context. |
| Modified | [package-lock.json](<C:/Users/HP/Desktop/rota project/package-lock.json>) | Lock expo-crypto dependency only. |
| Modified | [package.json](<C:/Users/HP/Desktop/rota project/package.json>) | Add test:r1 safe runner script. |
| Modified | [packages/shared/src/index.ts](<C:/Users/HP/Desktop/rota project/packages/shared/src/index.ts>) | Export actual client attempt registry. |
| Modified | [packages/shared/src/schemas.ts](<C:/Users/HP/Desktop/rota project/packages/shared/src/schemas.ts>) | Extend pricing/currency/schedule response types and bound seat inputs. |
| Created | [apps/api/__tests__/billingMigration.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/billingMigration.test.ts>) | Pre-R1 NGN upgrade preservation test on an isolated temporary database. |
| Created | [apps/api/__tests__/financialCalculations.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/financialCalculations.test.ts>) | 28 precise pricing, proration, renewal and currency cases. |
| Created | [apps/api/__tests__/flutterwavePrecision.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/flutterwavePrecision.test.ts>) | 2 actual adapter tests with self-contained dummy config and mocked fetch. |
| Created | [apps/api/__tests__/paymentAttempts.test.ts](<C:/Users/HP/Desktop/rota project/apps/api/__tests__/paymentAttempts.test.ts>) | 6 tests of actual shared client idempotency/storage behavior. |
| Created | [apps/api/migrations/007_billing_financial_integrity.sql](<C:/Users/HP/Desktop/rota project/apps/api/migrations/007_billing_financial_integrity.sql>) | Only new migration: versioned plans, revision/schedule/quote, idempotency and immutable ledger. |
| Created | [apps/api/src/billing/initiation.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/billing/initiation.ts>) | Transactional intent reservation/deduplication and at-most-once initialization. |
| Created | [apps/api/src/billing/ledger.ts](<C:/Users/HP/Desktop/rota project/apps/api/src/billing/ledger.ts>) | Append-only event posting, snapshots, atomic reconstruction and capped refund accounting. |
| Created | [docs/R1-IMPLEMENTATION-REPORT.md](<C:/Users/HP/Desktop/rota project/docs/R1-IMPLEMENTATION-REPORT.md>) | This review report, formulas, verification, limitations and inventory. |
| Created | [packages/shared/src/payment-attempts.ts](<C:/Users/HP/Desktop/rota project/packages/shared/src/payment-attempts.ts>) | Storage-backed stable keys, safe key encoding, retry/reference and in-flight dedupe. |
| Created | [scripts/test-r1.ps1](<C:/Users/HP/Desktop/rota project/scripts/test-r1.ps1>) | Pin isolated database/shard/Redis URLs and dummy provider endpoints; migrate and test serially. |

Total: 40 tracked source/documentation files modified or newly created.
Ignored build output and test caches are not source changes or commit artifacts.
