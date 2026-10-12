# Phase 4 Test Report — Seat-Based Subscriptions & Flutterwave Billing

Executed 2026-10-08 against the live local Docker Postgres (5440) and Redis
(6380), migrated through `004` (`npm run db:migrate`).

## Gates

| Gate | Command | Result |
|---|---|---|
| API integration + unit | `npm test -w @rota/api` | **93 tests passed** (6 suites) |
| API typecheck | `npx tsc --noEmit` (apps/api) | PASS |
| Shared build + typecheck | `npm run build -w @rota/shared`, root `npm run typecheck` | PASS |
| Mobile typecheck | `npm run typecheck -w @rota/mobile` | PASS |
| Mobile lint | `npx expo lint` (apps/mobile) | 1 error, 1 warning — both pre-existing (`app/_layout.tsx` require import, unused var in `AuthContext.tsx`); no new issues in billing code |

## Coverage

### `__tests__/billing.test.ts` — pure math & transitions (25 tests)

- `monthlyAmount`, `proratedChargeMinor` rounding and zero-accrue behaviour,
  `daysRemainingInPeriod` clamping/ceil, `addDays`.
- `transitionStatus`: ACTIVE→EXPIRED on period end; ACTIVE→no-op when not due;
  PAST_DUE→EXPIRED when grace elapses; PAST_DUE stays when grace open.
- `computeChange`: upgrade/ADD_SEATS charges; downgrade/REDUCE_SEATS zero with
  immediate apply; seat bounds; plan max-seat rejection.
- `computeRenewal`: FREE → no payment; paid → full-month `PENDING`.

### `__tests__/billing.integration.test.ts` — live DB, gateway mocked (25 tests)

The Flutterwave module is mocked (`initializeCheckout`,
`verifyTransaction`) so no network/credentials are needed; webhook
`verif-hash` validation stays real and is driven by `FLW_SECRET_HASH`.

1. Team creation provisions a FREE subscription (active, period set).
2. Summary reports plan, seats, usage, capacity, billing flags.
3. Managers are 403, foreign owners 404 (tenant isolation holds).
4. Paid upgrade to GROWTH with 5 seats → 201, `PENDING` payment, checkout URL,
   expected prorated amount.
5. Verify success applies the upgrade (`PLAN_UPGRADE`, payment `SUCCESSFUL`).
6. Replaying verification is idempotent (`ALREADY_PROCESSED`).
7–8. A second checkout works; managers cannot check out.
9–10. Removing a member and inviting (within capacity) succeed.
11. Inviting past seat capacity → 403 `SEAT_LIMIT_EXCEEDED`; pending invites
    consume capacity.
12. Downgrade to STARTER applies immediately at zero charge.
13. Adding seats creates a prorated paid change that settles on verify.
14. Reducing seats applies immediately.
15. A failed renewal moves an ACTIVE subscription to `PAST_DUE` with a grace
    window (change + payment `FAILED`).
16. `PAST_DUE` teams cannot be invited (403 `SUBSCRIPTION_REQUIRED`).
17. Grace expiry → `EXPIRED`; shift creation blocked (403 `SUBSCRIPTION_REQUIRED`).
18. A successful renewal reactivates and reopens shift creation.
19. The webhook settles a pending payment (`charge.completed`).
20. Duplicate webhook events are ignored (`reason: duplicate`).
21. Wrong `verif-hash` → 401.
22. Webhook for an unknown/not-pending tx_ref → `no-pending`.
23. A non-numeric gateway amount rolls the whole settlement back
    (400 `PAYMENT_MISMATCH`, subscription unchanged, payment still `PENDING`).
24. A currency mismatch is rejected and nothing is applied.
25. Plans listed in price order; change history + invoices paginate.

Every suite that mutates shared tables clears them in `beforeAll`; Jest runs
with `maxWorkers: 1` so suites never race on the shared Postgres instance.

## Regression

The pre-existing suites still pass alongside the new ones (43 → 93 total):
`health.test.ts` (1), `rate-limit.test.ts` (1), `integration.test.ts` (19),
`phase3.test.ts` (22), `billing.test.ts` (25), `billing.integration.test.ts`
(25).

## Not verified / outstanding

- **Real gateway flow**: no Flutterwave sandbox credentials were available, so
  the hosted checkout page, real card payment, and callback redirect were not
  exercised. Mocked paths cover the equivalent API contract.
- **Mobile runtime**: subscription screens type-check and lint clean but were
  not run on an emulator/device (no Android toolchain available).
- Live sandbox webhook signatures and redirect parameter shapes should be
  confirmed with real credentials before production use.