# R3 — Authentication, security and read routing

Status: local implementation for review; no commit/push/deployment.
Date: 2026-11-02. Branch: `codex/r3-auth-security-routing`.
Base: `origin/main` = `1c5be5dd24834c181a9da2da1a5b3a08e25cd09d`
(R1/R2 merged). Original PDF, Part 2 Task A pages 14–21 is authoritative.
PDF requirements are the specification, not authorization to publish/deploy.

## Requirement disposition

| R3 requirement | Result and exact implementation evidence |
|---|---|
| Password reset | `routes/auth.ts` request/confirm routes; `services/auth-email.ts:requestAuthEmail/consumeAction` and migration 009. Generic enqueue response, 256-bit tokens, SHA-256 digests, 15-minute expiry, atomic consumption and global revocation. |
| Alternative auth | Magic link selected: existing email identities, SecureStore/AuthResponse and R2 outbox require no Google native SDK/client credential setup. `handleAuthEmail` delivers; `consumeAction` issues the standard session. This signs in existing accounts; signup remains email/password. |
| Logout-all | `POST /auth/logout-all`, `services/sessions.ts:revokeAll`, primary checks in `middleware/auth.ts:authenticate`. Both access and refresh tokens on all devices stop working. |
| Refresh races/replay | `lockUser/findRefresh/issueSession` inside one `transaction`; old-token revocation and new-session insertion are atomic. Reuse commits global epoch/session/token revocation before 401. |
| Swap role enforcement | `routes/swaps.ts` approval adds `requireRole([OWNER,MANAGER])`, rechecks role and locks the pending request `FOR UPDATE OF sr`; requester/proposed staff cannot approve. Rejection/cancellation rules otherwise retained. |
| Zod validation | `packages/shared/src/schemas.ts` strict request objects; `middleware/validation.ts` rejects malformed UUID/query shapes and bounded bodies; team/invite/role/renewal/device bodies now strict. `pagination.ts:decodeCursor` validates timestamp/UUID before SQL. Signed-provider metadata remains allowed by the webhook schema. |
| Redis IP/user quotas | `middleware/rate-limit-redis.ts:redisRateLimit/sensitiveLimit`, mounted in index/auth/invitations/subscription/billing. Atomic Lua INCR+expiry, hashed IPv6-normalized IP/account keys, fail-closed sensitive routes, Retry-After. |
| Read/primary routing | `services/read-routing.ts:routedRead/readQuery/fenceWrites/needsPrimary`; explicit roster/team/calendar/activity read sites. Auth, permission, settings, financial state and workers use primary. Read errors fall back; no automatic write promotion. |
| Preserve sharding | Existing `src/sharding/` unchanged; two physical shard test DBs still exercised. `SHARDING.md` explains partitioning versus replication. |
| Grace behavior | PDF p19 says grace, owner notification, then restriction. `billing/service.ts:assertCanGrow/assertSubscriptionActive` now permit PAST_DUE only while grace_ends_at is future; capacity checks remain. Existing lazy/durable expiry and notification/reconciliation paths retained. |
| Advisories | Four compatible lockfile patches, no forced major upgrade. 20 production-graph and 50 full-graph advisory package entries remain; detailed disposition below. |

## Migration 009 and data safeguards

`009_auth_security_routing.sql` adds:

- `users.auth_version` (integer, default 0): authoritative global revocation epoch.
- `auth_sessions`: per-device/family UUID, user FK/index and revocation timestamp.
- Nullable `refresh_tokens.session_id` and `token_digest`, with indexes. Existing
  bcrypt hashes, expiry/revocation timestamps and token rows remain unchanged.
- `auth_action_tokens`: user/purpose, unique digest, expiry/consumption timestamps;
  indexed by user/purpose. Raw tokens are absent from this table.
- `AUTH_EMAIL` in the outbox kind constraint, preserving every prior kind/row.
- `user_write_fences`: one durable primary-read lease per user, FK cascade.

Migration is additive and uses the existing transactional migration runner.
Migrations 001–008 were compared byte-for-byte (normalized working-tree line
endings) against origin/main and are unchanged. The migration compatibility test
creates a separate disposable database, applies 001–008, inserts an old refresh
record, applies 009 and compares every original field. It verifies nullable new
fields and epoch zero. It drops only the database it successfully created.

Future rollout order (documented only; not performed): configure the new mail
secrets first, apply additive 009, upgrade/restart every worker, then enable the
new API/mobile flows. Old workers do not know AUTH_EMAIL and must not consume
those jobs. Do not run mixed old/new workers while emitting new auth jobs.
Existing queued financial/push jobs retain their kinds and R2 recovery rules.

No USD catalog/legacy NGN conversion, ledger rewrite, payment-idempotency rewrite
or subscription revision change is included. `billing/ledger.ts`, `proration.ts`,
`initiation.ts`, `flutterwave.ts`, `job-runtime.ts`, `push-delivery.ts` and
`src/sharding/` are unchanged. R1/R2 regression exercises the prior invariants.
All mutations performed during verification were on pinned disposable services.

## Security and compatibility model

Credential mutations lock the user row first. Password login compares bcrypt
under that lock, preventing an old-password login from racing past a reset.
Refresh finds the token by SHA-256 digest for new rows or by the original bcrypt
hash for legacy rows, checks expiry/revocation, revokes the old row and issues
one descendant in one transaction. A matching used token causes committed
revocation, not a rollback disguised by 401. Strict replay handling also treats
a legitimate duplicate refresh as compromise: one response may succeed, then
its new access token is invalidated by the duplicate. Reauthenticate after this
case. No grace mechanism silently accepts a used token.

New access JWTs retain the existing public user shape, use HS256, expire in
15 minutes and add `av`/`sid`. Authentication queries primary for the current
epoch and active session on every call; outages fail closed. No subscription,
financial status or revocation authority is cached. Legacy JWTs without these
claims remain accepted only at epoch zero, within their existing expiry. An
existing valid opaque refresh upgrades lazily; no bulk session invalidation
is needed on migration. Logout-all/reset/replay invalidates legacy JWTs too.
Individual legacy access JWTs lack a session ID and can expire naturally within
15 minutes; logout-all is available for immediate global revocation.

Reset/magic request APIs enqueue encrypted work identically for known/unknown
emails and return the same generic 200 response. The worker resolves the user,
creates one token and an encrypted delivery job transactionally, then sends from
a separate durable worker. Action links never consume on GET; the mobile screen
requires a tap/POST. New same-purpose requests invalidate older issued links.
Reset consumes outstanding action links and revokes sessions. Wrong-purpose,
expired, used or malformed links do not issue sessions. Login uses bcrypt even
for unknown users, with generic invalid-credential responses.

AES-256-GCM uses a separate 32-byte AUTH_MAIL_KEY and random 12-byte IVs. Both
recipient and token payloads are encrypted; the token table only stores digests.
The delivery UUID is the Resend-compatible Idempotency-Key, stable across retries.
R2 SQL attempt/dead tracking, advisory locks and retry budget apply unchanged.
Delivery rechecks expiry/use, so stale queued links are skipped. The provider's
24-hour deduplication window exceeds token lifetime, but this is a provider
contract, not universal exactly-once email. Keep the encryption key stable while
jobs exist; versioned key-ring/retention automation is not implemented.

Mobile login offers reset and magic-link requests; `(auth)/action.tsx` consumes
a valid link explicitly and stores sessions through existing AuthContext/
SecureStore. Logout-all is in settings. Startup and automatic refresh now share
one in-flight promise. Revoked-refresh responses notify AuthContext to clear
user/team/offline data; transient refresh failures retain credentials. No actual
device, live email inbox or Android app-link behavior was exercised.

## Rate limits, validation and routing boundaries

All sensitive quotas use Redis, not in-process state. Default outer auth budget
is 100/IP/15min plus a principal budget. Login 30/IP/account, reset/magic request
5/IP/account, action consumption 10/IP/principal, logout-all 30/IP/user,
invitation acceptance 15/IP/user, invitation routes 100/IP/user and billing
mutations 30/IP/user. Webhook ingress has 300/IP. Outer team/invitation budgets
remain configurable. Settings/devices retain their existing optional fail-open
availability policy; credential/invite/payment paths fail closed with 503.
A Lua script makes counter+expiry atomic and repairs missing TTLs. Requests
which exceed quotas return 429 and Retry-After. IPv6 addresses use the library's
subnet normalization. Production defaults do not trust forwarded IP headers;
configure a known proxy topology before deployment, not blanket trust-proxy.

Requests have a 32 KiB body cap, collection maximum 100 entries, traversal cap
1,000 nodes and depth 20 before constrained Zod validation. Password creation
also enforces bcrypt's 72-byte boundary, without rewriting existing hashes.
Existing correct mobile payloads and invitation token alias remain supported.
Invalid pagination cursors retain 400 INVALID_CURSOR and invalid limits retain
their existing API error contract. Provider callback query names remain valid.

The primary pool defaults to 10 connections, two-second acquisition/15-second
statement limits and 30-second idle transaction timeout. The optional read pool
has 10 connections, one-second acquisition/three-second statement limits.
Ten per endpoint bounds each API process at 20 with reads configured; allow
another primary pool per worker and budget total instances against PostgreSQL.
Use provider pooling/PgBouncer where needed.

Read routing is opt-in through READ_DATABASE_URL and explicit trusted SELECT
sites, not automatic SQL rewriting. Read endpoints execute in READ ONLY
transactions; failed queries/connections roll back and fall back to primary.
Authentication/authorization, individual shift/swap details, all settings and
all financial reads remain primary. No write falls back to a replica.

Before authenticated mutations, a durable user_write_fences upsert grants a
conservative five-minute primary lease across all devices/API instances. This
also covers a process dying after business COMMIT. During it Redis reads are
bypassed; authoritative results may refresh cache. An invalid request can create
a harmless lease. Reads already in progress when another request writes are not
linearizable; other users can see normal lag. Lag beyond the lease requires
monitoring and disabling read routing. The feature does not provision replicas,
promote primaries, or claim bounded production replication lag.

The PDF p15 explicitly permits a separate read connection string when the
provider has no replicas. That option is implemented. General regression uses
a second pool to the disposable primary; six routing drills use an independent
PostgreSQL read DB with stale marker data/schema failure/unavailable pool.
This verifies routing, lease decisions, SQL read-only behavior and fallback,
not physical WAL replication. The two unchanged hash shards contain disjoint
teams and must never be configured as replicas.

Grace access keeps the configured SUBSCRIPTION_GRACE_DAYS=14. PDF does not set
an exact day count. PAST_DUE now allows existing protected shift creation and
invitation/acceptance gates before grace expiry; afterwards those gates deny.
Calendar reads remain available. Existing shift-edit/cancel/swap/membership
policies are preserved; the brief does not precisely define every restricted
operation, so no broader blanket lockout was invented. Owner failure notices,
expiry jobs, exact money, ledger and late-payment safeguards remain R1/R2.

## Verification

Executed against isolated PostgreSQL/Redis and mocked external providers:

| Check | Observed result |
|---|---|
| Full API regression with --detectOpenHandles | **373 tests / 31 suites passed**, 0 failed/skipped/todo, zero detected open handles; 128.426 seconds. |
| Root workspace test gate through default R3 runner | **Passed: 373 tests / 31 API suites**, then mobile stub passed; shared has no separate runner. Default run took 77.435 seconds. |
| npm run typecheck | Passed API, mobile and shared. |
| npm run lint | Passed, zero errors; one pre-existing unused Team warning in shared/src/types.ts. Expo also notes its legacy lint configuration. |
| npm run build:api | Passed shared build followed by API TypeScript build. |
| git diff --check | Passed. |
| Old migrations | 001–008 unchanged against origin/main. |
| File/credential review | 54 intended source/test/migration/doc/config files; no actual env/dumps/build/cache/temp files or high-confidence private-key/provider/GitHub/AWS signatures among changes. Test credentials are explicit disposable values. Nothing staged. |

New/expanded focused evidence:

| Test file | Cases | Behavior exercised |
|---|---:|---|
| r3-auth.integration.test.ts | 18 | Non-enumerating encrypted enqueue, reset/new password, cross-device revocation, RESET/MAGIC expiry, wrong-purpose/new-link invalidation, concurrent consume, concurrent refresh/replay, expired credentials, legacy token upgrade, logout one/all, forged owner denial, mail retry/dedup/tamper, malformed/oversized bodies and actual API quotas. |
| r3-policy.integration.test.ts | 5 | Staff/requester/replacement/outsider approval denial, manager/owner concurrent approval with single transfer, strict body/cursor/query denial, staff deletion denial, primary membership authorization despite cache, in-grace access/post-grace restriction, actual invite/payment quotas without financial work. |
| r3-routing.integration.test.ts | 6 | Separate read DB, stale-replica lease routing/expiry, schema failure and unavailable-pool primary fallback, READ ONLY secondary enforcement, cache bypass/authoritative refresh. |
| r3Migration.test.ts | 1 | Upgrade from 001–008 with unchanged legacy refresh fields and zero-version compatibility. |
| rate-limit.test.ts | 4 | Shared quota across app instances, positive TTL, outage fail-closed, principal quota across IPs, atomic concurrent enforcement. |

Existing regression includes 39 billing integration cases, 26 billing unit
cases, 28 financial calculations, ledger/migration history, R2 workers/recovery,
settings/quiet hours, 11 sharding tests, tenant/role checks, cache and pagination
at volume, push delivery with mocked providers and shared/mobile contracts.
Some legacy tests use mocks/unit contracts; new auth/policy/routing integrations
use real PostgreSQL/Redis. The read DB is deliberately a simulation. No mobile
runtime/EAS build, image deployment or real provider test is claimed.

Failure history is retained rather than concealed: first exploratory regression
had 40 failures, mostly stale in-memory rate mocks, quotas leaking across tests,
the previous staff-approval assumption and cache assumptions. Tests now isolate
only Redis limiter keys between cases; production limits remain active. Cache
bypass still permits authoritative primary results to populate cache; security
keys remain when cache is disabled. A later run passed 370/371; the 30-bcrypt
quota exercise exceeded Jest's default five seconds. Only that real-work test
received a 20-second budget. All final 373 passed. The default workspace test
initially warned about npm forwarding --runInBand; the runner now invokes npm
test directly, with serial maxWorkers=1 already enforced by Jest config.
No EPERM recurrence, forceExit, weakened assertions or database mocks in new
integration tests. Results/logs/audit JSON are ignored in .r1-test-cache; exact
summary is recorded here for review.

## Dependency investigation

The original 24 production-graph advisory package entries were reproduced
(7 high,16 moderate,1 low,0 critical). Compatible `npm update body-parser qs
node-forge ip-address --ignore-scripts --no-audit` changed only four lockfile
entries; no direct major version or security-check configuration was changed.

| Dependency/path | Before → after | Disposition |
|---|---|---|
| Express → body-parser | 1.20.8 → 1.20.9 | High compressed-body DoS patched; directly exposed API parser was highest priority. |
| express-rate-limit → ip-address | 10.7.3 → 10.7.5 | Compatible IP parsing DoS patch, relevant to new IPv6 limiter keys. |
| Express/Superagent → qs | 6.16.0 → 6.16.2 | Compatible query serialization fix; lockfile resolves patched version. |
| Expo CLI/signing → node-forge | 1.4.0 → 1.4.2 | High cryptographic/DoS advisories patched without changing Expo SDK. |

After: production graph **20 entries (5 high,14 moderate,1 low,0 critical)**.
Full development+production graph: **50 (5 high,41 moderate,4 low,0 critical)**.
These counts include meta-vulnerable dependants and are not distinct CVE counts.
Audit commands still exit nonzero; security is not declared clean.

Highest remaining runtime concern: Zod 3.25.76 has a constrained-collection
memory advisory patched in >=4.6.6, which is a major migration. HTTP
byte/collection/depth caps reduce this request attack surface but do not remove
the advisory or prove every Zod use is safe. A reviewed major upgrade remains.
The Expo Router → query-string → decode-uri-component decoding DoS chain also
remains high. Upstream audit suggests Expo Router 58.0.29, outside the installed
SDK 57 range; no unverified override/major upgrade was forced. Treat malformed
external links as a remaining runtime risk pending an SDK-compatible upstream
patch or reviewed SDK migration.

Registry review confirms @expo/metro-config 57.0.13 is already the latest
SDK-57 patch and still depends on glob ^13 (the advisory needs a newer major).
Prebuild patch 57.0.19 exists (installed 57.0.17), but its meta-finding reaches
shared Expo config dependencies; no unrelated toolchain bump is presented as a
security fix without evidence that it removes that vulnerable path.

Other findings mostly concern Expo/config/build tooling and glob/minimatch,
uuid/xcode/deepmerge plus development test/lint chains. Their normal API HTTP
reachability is lower, but they are not dismissed: the current Dockerfile
retains all workspace production dependencies when pruning, so mobile tooling
can still be present in the API image. No container hardening/deployment scope
was started. Audit recommendations include incompatible Expo 51, picker 8,
splash 55, Jest 25 and TypeScript-ESLint downgrades/major changes. These were
recorded rather than applied blindly. Dependency integrity checks remain on.

| Remaining production graph package | Severity | Immediate advisory/dependency path |
|---|---|---|
| `@expo/cli` | high | @expo/config, @expo/config-plugins, @expo/inline-modules, @expo/metro-config, @expo/prebuild-config, glob, zod |
| `@expo/config` | moderate | @expo/config-plugins, deepmerge, glob |
| `@expo/config-plugins` | moderate | glob, xcode |
| `@expo/fingerprint` | moderate | glob, minimatch |
| `@expo/inline-modules` | moderate | @expo/config-plugins |
| `@expo/local-build-cache-provider` | moderate | @expo/config |
| `@expo/metro-config` | moderate | @expo/config, glob |
| `@expo/prebuild-config` | moderate | @expo/config, @expo/config-plugins |
| `@react-native-community/datetimepicker` | moderate | expo |
| `decode-uri-component` | high | https://github.com/advisories/GHSA-vcc3-ghjq-m6fr, https://github.com/advisories/GHSA-qr28-fpjm-wq7f |
| `deepmerge` | low | https://github.com/advisories/GHSA-gcqx-w48m-w2h4 |
| `expo` | moderate | @expo/cli, @expo/config, @expo/config-plugins, @expo/fingerprint, @expo/local-build-cache-provider, @expo/metro-config |
| `expo-router` | high | query-string |
| `expo-splash-screen` | moderate | @expo/config-plugins |
| `glob` | moderate | https://github.com/advisories/GHSA-3g3m-2fjr-6pw4, minimatch |
| `minimatch` | moderate | https://github.com/advisories/GHSA-g3hv-75wg-m249 |
| `query-string` | high | decode-uri-component |
| `uuid` | moderate | https://github.com/advisories/GHSA-w5hq-g745-h8pq |
| `xcode` | moderate | uuid |
| `zod` | high | https://github.com/advisories/GHSA-mrhx-c7xc-m3w5 |


Primary references consulted:

- [Original PDF](C:/Users/HP/Downloads/final-graduation-task%20%281%29.pdf), pages 14–21.
- [OWASP reset guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html).
- [Body-parser patched advisory](https://github.com/advisories/GHSA-27r3-jxmh-p828).
- [Zod remaining major-version fix](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
- [Resend sending API/idempotency contract](https://resend.com/docs/api-reference/emails/send-email).
- [Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/) and [Router](https://docs.expo.dev/versions/v57.0.0/sdk/router/) checked before mobile API changes.

## Remaining risks and assessment boundaries

1. Live mail requires a verified sender/provider key and stable secret encryption
   key. Delivery was mocked; no real messages were sent. Mail secrets are now
   required at production startup, so review service configuration before a
   future release. Owned HTTPS verified app links are preferable to the existing
   custom rota scheme, which another installed application could register.
2. Replica provisioning, WAL replication, production lag metrics/failover and
   least-privilege reader credentials remain operational work. The PDF's
   permitted read-connection simulation is verified, not a deployed replica.
3. Twenty production advisory entries and fifty full-graph entries remain;
   Zod/Expo decoder runtime paths need planned compatible upstream fixes or
   reviewed major migrations. No audit-fix force/omission was used.
4. Strict refresh replay may force re-login after a lost response or
   cross-process duplicate. The client single-flight mechanism reduces local
   races; no used-token acceptance grace is introduced.
5. Mobile actions, revocation UI, custom-scheme link opening and actual email
   receipt need a device/manual check. Compilation/lint is not runtime proof.
6. Request-ID/error-tracker/load-test/release evidence and other R4 assessment
   work were not reopened. Existing published demo/post completion is retained;
   this milestone does not mark those completed artifacts pending again.
7. Grace expiry restricts the existing protected operations described above;
   the PDF does not enumerate a complete operation-by-operation freeze policy.
   No R1 money/data-model conflict or automatic NGN→USD conversion was added.

## Complete changed-file inventory

54 intended modified/created files. Generated dist, logs, JSON results,
actual environment files, caches and disposable DB state are not part of this inventory.

- `.env.example`
- `AGENTS.md`
- `README.md`
- `apps/api/__tests__/cache.test.ts`
- `apps/api/__tests__/helpers/r3-cleanup.ts`
- `apps/api/__tests__/push.integration.test.ts`
- `apps/api/__tests__/r3-auth.integration.test.ts`
- `apps/api/__tests__/r3-policy.integration.test.ts`
- `apps/api/__tests__/r3-routing.integration.test.ts`
- `apps/api/__tests__/r3Migration.test.ts`
- `apps/api/__tests__/rate-limit.test.ts`
- `apps/api/__tests__/security.test.ts`
- `apps/api/jest.config.js`
- `apps/api/migrations/009_auth_security_routing.sql`
- `apps/api/src/billing/service.ts`
- `apps/api/src/db.ts`
- `apps/api/src/env.ts`
- `apps/api/src/index.ts`
- `apps/api/src/middleware/auth.ts`
- `apps/api/src/middleware/rate-limit-redis.ts`
- `apps/api/src/middleware/validation.ts`
- `apps/api/src/pagination.ts`
- `apps/api/src/routes/activity.ts`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/billing.ts`
- `apps/api/src/routes/devices.ts`
- `apps/api/src/routes/invitations.ts`
- `apps/api/src/routes/shifts.ts`
- `apps/api/src/routes/subscription.ts`
- `apps/api/src/routes/swaps.ts`
- `apps/api/src/routes/teams.ts`
- `apps/api/src/services/auth-email.ts`
- `apps/api/src/services/cache.ts`
- `apps/api/src/services/job-handlers.ts`
- `apps/api/src/services/outbox.ts`
- `apps/api/src/services/read-routing.ts`
- `apps/api/src/services/sessions.ts`
- `apps/mobile/app/(auth)/_layout.tsx`
- `apps/mobile/app/(auth)/action.tsx`
- `apps/mobile/app/(auth)/login.tsx`
- `apps/mobile/app/(tabs)/settings.tsx`
- `apps/mobile/app/swaps/[swapId].tsx`
- `apps/mobile/src/api/client.ts`
- `apps/mobile/src/context/AuthContext.tsx`
- `docs/ARCHITECTURE.md`
- `docs/IMPLEMENTATION-STATUS.md`
- `docs/R3-IMPLEMENTATION-REPORT.md`
- `docs/SECURITY.md`
- `docs/SHARDING.md`
- `infrastructure/docker-compose.r3-tests.yml`
- `package-lock.json`
- `package.json`
- `packages/shared/src/schemas.ts`
- `scripts/test-r3.ps1`

## Publication and preservation check

Branch remains local and uncommitted; nothing is staged. HEAD remains the
merged main base above. No push/merge/deploy was performed. No production
migration, real payment, real push or actual email was initiated. Existing
ordinary development/production databases and unrelated Docker containers were
not touched. SQL migrations 001–008 and historical billing records were not
rewritten. Final status is intentionally dirty with this R3 implementation
awaiting review.
All five named R3 disposable containers and their test volumes were removed
after verification; unrelated existing containers remained running.
