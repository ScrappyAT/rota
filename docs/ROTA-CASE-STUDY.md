# Rota — team scheduling with financial and operational integrity

Repository case-study draft for later portfolio integration. This file is not
proof of a published portfolio case study. It describes verified code/local
tests; the separate graduation worktrees still require review and integration.

## Problem and product

Small restaurants, clinics and shops need a shared schedule, clear manager/staff
permissions and a way to exchange shifts without losing track of approvals.
Rota combines team invitations, shifts, assignments, swaps and activity in an
Expo mobile app with an Express/PostgreSQL API.

## Engineering decisions

- Roles belong to each team, allowing one person to manage one business and
  work as staff in another. Primary membership checks precede tenant data reads.
- Timestamp/UUID cursor pagination and composite indexes keep activity walks
  stable across equal timestamps. A deterministic 10,000-row dataset and
  regression walks test filtering, ordering and tenant isolation.
- R1 keeps currency-specific integer amounts, separate-floor proration,
  end-period reductions, client idempotency and an append-only ledger. Historical
  NGN remains NGN; new assignment plans are versioned USD records.
- R2 commits jobs with business changes in a PostgreSQL outbox; BullMQ workers
  process provider operations with bounded retries. Unknown external outcomes
  require reconciliation rather than automatic second charges or duplicate sends.
- R3 provides reset/magic links, revocation/replay protection, shared Redis
  quotas, and primary/read routing separate from a two-DB hash-sharding demo.
- Graduation corrections address billing-boundary grace, stale membership and
  mobile offline/optimistic flows. Phase 3 adds privacy-limited request/job
  correlation and optional server/mobile Sentry tracking.

## Evidence and limits

[Architecture](ARCHITECTURE.md), [security](SECURITY.md),
[sharding](SHARDING.md), [learning log](LEARNING-LOG.md),
[phase verification](ROTA-GRADUATION-PHASE-3-REPORT.md).
Historical 200-user cache comparison improved p95 from 1,271.55ms to 710.95ms
with zero HTTP errors; its own latency thresholds were missed. This is local
benchmark evidence, not production capacity. Fresh regression totals are in the
phase report. Payment/mail/push providers are mocked in these tests.

The demo was recorded 14 October 2026 and its LinkedIn post is published.
A working updated APK, the demo share URL, current backend verification and a
published portfolio page remain submission evidence work. Native/device testing
of the new changes and live Sentry ingestion are not claimed.
