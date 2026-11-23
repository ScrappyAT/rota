# Rota graduation submission evidence

Reviewed 23 November 2026 against the original Dev & Design HQ PDF, Part 2 Task A
and page 34. This document provides the authoritative submission evidence status for
Rota. Completion of an artifact and availability of its submission link are tracked
as separate facts.

| Required evidence | Current evidence | Status / Operational Note |
|---|---|---|
| Public source repository | [ScrappyAT/rota](https://github.com/ScrappyAT/rota); release branch [`codex/graduation-release-2026-11-10`](https://github.com/ScrappyAT/rota/tree/codex/graduation-release-2026-11-10) contains all integrated milestones (R1, R2, R3, combined supervisor PR #5, reconciliation safeguards PR #6) | **Completed & published on GitHub** |
| Android preview APK | [Installable preview APK](https://expo.dev/artifacts/eas/r197ay-RMlQSdm-zTC_w1I4b_gD85C3_c0NBXPBYi8w.apk) — [Expo build details](https://expo.dev/accounts/scrappy4rls-team/projects/rota/builds/947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf) (Build ID: `947dc9d2-f999-43a8-b3e4-3b9a4c8a23cf`, finished 10 November 2026). User-confirmed physical Android acceptance completed on 18 November 2026. | **Completed & verified on device** (Reported artifact expiry: **24 November 2026** per Expo build metadata) |
| Backend deployment | [https://rota-production-84ef.up.railway.app](https://rota-production-84ef.up.railway.app); `/health` returns HTTP 200 OK (`{"success":true,"data":{"status":"ok","db":"ok","redis":"ok","timestamp":"..."}}`). Supervised combined API + background worker deployed in single container via `apps/api/src/combined-server.ts`. | **Completed & verified live** |
| Architecture & technical docs | [ARCHITECTURE.md](ARCHITECTURE.md), [SECURITY.md](SECURITY.md), [SHARDING.md](SHARDING.md), [OBSERVABILITY.md](OBSERVABILITY.md), [LEARNING-LOG.md](LEARNING-LOG.md), [BILLING.md](BILLING.md) | **Completed & verified** |
| Automated tests | **478 tests across 44 suites** passed in historical 10 November 2026 integrated-release run (136.167s); TypeScript, lint, builds, and supervisor smoke tests passed. Subsequent PR #5 supervisor suite (3 tests) and PR #6 reconciliation suite (14 tests) reported separately. | **Completed & verified** |
| 10,000-record dataset & cursor pagination | Deterministic 10,000-row activity seed script; keyset cursor pagination on `(created_at, id)` with composite index; zero OFFSET; [PAGINATION.md](PAGINATION.md) | **Completed & verified** |
| 200-VU load test report | [load-tests/REPORT.md](../load-tests/REPORT.md) and [PERFORMANCE-REPORT.md](PERFORMANCE-REPORT.md) (200-VU activity feed benchmark before/after Redis caching: p95 1,271.55ms → 710.95ms; 60-VU peak workload: 30,115 requests, 0% errors, 62.7ms p95) | **Completed & verified** (historical execution retained) |
| Three-minute demo video | [Official Rota Demo Video](https://drive.google.com/file/d/1-39i6l2UYL1paP3qimbb0Ga-dg96-V2e/view?usp=sharing) (Google Drive, uploaded with "Anyone with the link can view"; anonymous access verified HTTP 200). Covers auth, shift creation/assignment, swap request, manager notification, swap approval, and shift deletion. | **Completed & verified** |
| LinkedIn engineering post | **Published**: [LinkedIn engineering post](https://lnkd.in/p/edPwxhTV) (HTTP 200 confirmed) | **Completed & verified** |
| Portfolio Rota case study | Case study drafted in [ROTA-CASE-STUDY.md](ROTA-CASE-STUDY.md) and prepared on branch `feat/rota-case-study` in portfolio repository. Live portfolio is at [https://samuel-emmanuel-portfolio.vercel.app/](https://samuel-emmanuel-portfolio.vercel.app/). | **Draft ready on review branch; dedicated page pending deployment to live portfolio** |
| Production app-store billing review | [README.md](../README.md) documents store policies for Rota B2B subscriptions vs. Matinee physical cinema tickets per assessment page 14. | **Completed & verified** |
| Central graduation submission | [final-task-samuel-emmanuel/SUBMISSION.md](https://github.com/ScrappyAT/final-task-samuel-emmanuel/blob/main/SUBMISSION.md) updated with live Railway backend, physical Android acceptance, Google Drive demo link, and Flutterwave USD payment proof. | **Completed locally; ready for submission update** |

---

## Final sign-off sequence

- [x] Integrate and verify all milestone source, tests, and documentation on release branch (`codex/graduation-release-2026-11-10`).
- [x] Run full test suite: historical baseline of 478 tests across 44 suites passing (10 November 2026), with subsequent PR #5 supervisor and PR #6 reconciliation suites passing, TypeScript clean, lint clean, builds clean.
- [x] Deploy combined Express API + BullMQ background worker supervisor to Railway (`https://rota-production-84ef.up.railway.app`).
- [x] Verify live backend healthcheck: `/health` returns HTTP 200 with `status: ok`, `db: ok`, `redis: ok`.
- [x] Verify live background worker processing: `NOTIFICATION` and `PAYMENT_RECONCILE` jobs running successfully with safe bounded retries.
- [x] Complete end-to-end Flutterwave sandbox USD checkout:
  - Plan: Starter ($20 USD/mo, 5 seats) via `POST /teams/:teamId/subscription/checkout`.
  - Test card and OTP verification succeeded.
  - Subscription transitioned to `ACTIVE`.
  - Invoice marked `PAID`.
  - Application logic commits the corresponding `CHARGE` entry to the append-only `financial_ledger` table upon settlement (not independently queried in production DB).
- [x] Complete physical Android acceptance on Samsung device:
  - Shift creation and team-member assignment (user-confirmed).
  - Assigned shift visibility for staff (user-confirmed).
  - Shift swap submission and manager approval (user-confirmed).
  - Activity feed updates (user-confirmed; keyset cursor pagination gaplessness and boundary stability verified by automated integration tests).
  - Push notification delivery and settings (user-confirmed; quiet-hours calculation logic verified by automated tests).
- [x] Verify installable Android preview APK download link and SHA256 checksum (reported expiry: **24 November 2026** per Expo build metadata).
- [x] Supply publicly shareable URL for the graduation demo video: [Google Drive Demo Video](https://drive.google.com/file/d/1-39i6l2UYL1paP3qimbb0Ga-dg96-V2e/view?usp=sharing) (public access verified HTTP 200).
- [ ] Publish dedicated Rota case-study page to [portfolio website](https://samuel-emmanuel-portfolio.vercel.app/) (case study prepared in `docs/ROTA-CASE-STUDY.md` and portfolio branch `feat/rota-case-study`).
- [ ] Submit central graduation submission form per assessment instructions.

---

## November 18, 2026 Live Production & Device Verification Update

On 18 November 2026, the complete end-to-end deployment, payment lifecycle, and physical mobile device flows were verified:

1. **Combined Supervisor Deployment**:
   - Single-container supervisor (`apps/api/src/combined-server.ts`) deployed on Railway (`dynamic-tenderness` service, domain `rota-production-84ef.up.railway.app`).
   - Runs both Express API (port 8080) and BullMQ background worker concurrently within Railway resource limits.
   - If either process encounters an unhandled fatal error, the supervisor exits with failure so Railway orchestrator automatically restarts the container.
   - Live health check verified: `GET https://rota-production-84ef.up.railway.app/health` returns HTTP 200 with `{"success":true,"data":{"status":"ok","db":"ok","redis":"ok","timestamp":"2026-11-23T..."}}`.

2. **Flutterwave USD Subscription Flow**:
   - Verified live with team "Mayo" choosing the Starter plan ($20 USD/mo, 5 seats).
   - Client generated an idempotency key and called `POST /teams/:teamId/subscription/checkout`.
   - Generated Flutterwave checkout URL, opened hosted sandbox payment modal.
   - Authorized via Flutterwave test card and OTP verification.
   - Settled and reconciled: subscription state updated to `ACTIVE`, subscription history recorded `FREE → STARTER_USD_V1` as `PAID`, $20 invoice marked `PAID`.
   - The application logic commits the corresponding `CHARGE` transaction with matching reference to the append-only `financial_ledger` table upon settlement (not independently queried in production DB).
   - PR #6 merged to provide robust error categorization, 5-minute initialization deferral for `QUEUED` checkouts, and accurate `updated_at` claim-age tracking for `CLAIMED` checkouts.

3. **Physical Android Device Acceptance**:
   - Installable APK (built via EAS SDK 57, package `com.scrappy4rlsteam.rota`, reported expiry **24 November 2026**) installed and tested on a physical Samsung device.
   - **Shifts**: Owner/manager created shifts, assigned staff members, verified real-time assignment visibility on staff accounts (user-confirmed).
   - **Swaps**: Staff requested swap with a teammate; manager approved swap; assignments atomically swapped; activity feed appended event (user-confirmed).
   - **Activity Feed**: Activity updates rendered in real-time (user-confirmed; keyset cursor pagination gaplessness and boundary stability verified by automated tests).
   - **Push & Preferences**: Push notifications received; settings screen accessible (user-confirmed; quiet-hours calculation logic and cold-restart session persistence verified by automated test suites).
