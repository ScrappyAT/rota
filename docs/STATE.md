# Rota state ownership

Graduation Phase 2, 2026-11-09. This describes implemented ownership. Automated
logic/API checks and native device execution are different evidence; see
`ROTA-GRADUATION-PHASE-2-REPORT.md` for executed results.

## Server state

PostgreSQL remains authoritative. TanStack Query owns mobile server projections;
React Context exposes coordination and query results rather than a second server
cache. API responses are parsed through `dataOrThrow`/`ensureSuccess`.

| Data | Owner / query key | Why / refresh |
|---|---|---|
| Authenticated teams | `TeamContext`, `['teams', userId]` | Query cache plus verified per-user offline directory; refresh after joining/creating and on foreground/reconnect. |
| Selected team's role | `['team-role', teamId, userId]` | Fetched from authorized members; never restored as offline management authority. |
| User settings | `SettingsContext`, `['settings', userId]` | Query + mutation lifecycle; canonical timestamps are supplied by the server. |
| Upcoming assigned shifts | `['shifts', teamId, userId, 'upcoming']` | Complete assigned-only future ACTIVE result; persist only after all cursor pages succeed. |
| Calendar day | `['shifts', teamId, userId, 'calendar', from]` | Infinite query using server from/to/cursor filters, with previous/next/today/date-picker navigation. |
| Shift details / members | `['shift', teamId, shiftId, userId]`, `['members', teamId, userId]` in the detail view | Authorized live reads and existing user/team-partitioned detail cache. Other existing member views retain their team-prefixed query keys. |
| Activity | `['activity', teamId]` | Infinite cursor query, pull to refresh, synchronous next-page gate, stable-ID deduplication and explicit list states. |
| Swap lists and details | `['swaps', teamId]`, `['swap', teamId, swapId]` | Server approval is canonical. Request optimism never transfers an assignment. |
| Requested-swap marker | `['swap-request', userId, teamId, shiftId]` | Pending row appears immediately; server ID replaces temporary ID. Reconcile after settlement, swap actions and push invalidations. |
| Billing catalog / summary / history | Existing `billing-plans`, `billing-summary`, `billing-changes`, `billing-invoices` keys scoped by team | Server calculations/verified payment settlement remain authoritative. No payment changes in Phase 2. |

The shared QueryClient uses 30 seconds stale time, one query retry and TanStack's
five-minute default inactive garbage-collection time. This reduces repeated
navigation fetches while foreground/reconnect/mutation invalidation makes
changes visible promptly. Settings and teams explicitly use the same 30 seconds.
Active query cancellation protects optimistic snapshots from older reads.
Query caches are cancelled/cleared during logout/account replacement. Team-role,
settings and upcoming keys additionally partition users. Team-only legacy keys
are never carried between signed-in accounts.

Auth handshakes and one-time invitation redemption are commands, not independent
server caches. AuthContext coordinates verified identity/session state; the
actual member list, role and settings values come from Query. Context consumers
do not fetch a competing copy of those server resources.

## Client coordination: React state and Context

React state is the single client state tool. Context shares authenticated
identity, verification/read-only mode and selected-team coordination. Component
state owns tab/day selection, forms, native picker visibility and transient
messages. A synchronous single-flight gate covers the interval before React
renders a disabled swap/settings control. No Zustand or second state library was
introduced. Query owns loading/error/pending server states.

## Persisted state and offline security

| State | Storage | Trust boundary |
|---|---|---|
| Access and rotated refresh tokens | Existing `authStorage` -> expo-secure-store on Android/iOS | Never written to filesystem shift storage. Existing web adapter is unchanged and has its previously documented localStorage limitations. |
| Last verified identity | `offlineSessionV1` in the same native SecureStore adapter | Requires matching stored user ID, a refresh credential and a lease younger than 24 hours. Future/rolled-back timestamps are rejected. |
| Selected team | User-specific SecureStore `selectedTeam_<userId>` | Must also occur in that user's verified/cached directory. Unscoped legacy selection is not trusted. |
| Pending invitation | `pendingInvitationV1` in SecureStore | Code/email/expiry survive login, registration and restart. Redemption is still checked by the server. A confirmed destination survives a failed post-redemption team refresh. |
| Upcoming snapshot | Existing filesystem adapter, `offline_v1:<userId>:upcoming:<teamId>` | Includes user/team IDs and last-updated timestamp; contains only results from the assignedTo query, not all-team calendar rows. |
| Offline team directory | `offline_v1:<userId>:teams` | A read projection, never a role grant. Missing memberships revoke local caches. |
| Revoked-team tombstone | `offline_v1:<userId>:revoked:<teamId>` | Hides a revoked team even if a stale directory remains; only a new authoritative directory response can clear the tombstone. |
| Legacy shift-detail/member snapshots | Existing user/team keys in `shiftCache.ts` | Preserved for existing detail views; revoked-team cleanup targets this namespace too. |

On cold launch the app attempts refresh and `/auth/me`. Only a transport failure
permits a valid local read lease. The app labels this offline/read-only, restores
the cached team selection and upcoming rows, and displays their original last
updated time. API transport is bounded to eight seconds per request (a refresh
plus a profile read can require two requests). Empty successful server results
replace old snapshots; partial/failed cursor downloads do not replace complete
snapshots. Elapsed shifts and wrong-team records are excluded on cache reads.

A cached identity never authorizes server business requests: ApiClient rejects
protected reads/writes until refresh + profile verification succeeds. Health/auth
recovery remains possible. Native push registration waits for verified mode.
The server continues validating credentials, roles and tenant membership on every
request. Known refresh revocation clears identity, query state and persistent
schedule data. Logout clears those stores and selection. Cache generations,
serialized writes and session-aware mutation callbacks stop late responses from
repopulating the retired session's data.

Remote revocation cannot be discovered while fully disconnected. A previously
verified user may view already downloaded data until the bounded 24-hour lease
expires or a known denial is received. This is an explicit local read policy,
not a promise that offline credentials are currently valid on the server.

## Optimism, rollback and conflict handling

Swap requests snapshot/cancel the previous list query, prepend a temporary
PENDING request and set the detail marker before awaiting the server. Duplicate
taps share a synchronous claim. Success reconciles the canonical request ID;
failure restores the exact prior pages/marker or removes a newly created cache,
then invalidates relevant reads. Assignment/approval remains server-only.

Settings snapshot/cancel the settings query, merge the patch optimistically,
restore the prior canonical value on error, and replace it with the returned
server value on success. Foreground reads do not interrupt an active settings
write. Server updatedAt/fieldUpdatedAt values are not fabricated by the client.
The server uses field-level last-received-write-wins: another device's most
recently received change wins. It cannot know which offline edit was originally
intended first; a late full quiet-hours edit can overwrite another device's
quiet-hours change. Offline writes are rejected rather than queued.

## Canonical backend state

Membership/permissions, shift assignment invariants and transactions stay on the
server. R1 financial ledger and payment idempotency, R2 transactional outbox and
job attempt/delivery state, R3 refresh/session revocation and replica routing are
unchanged here. See the R1–R3 reports. Phase 1's primary team-list authorization
and billing-boundary corrections remain in their separate review worktree and
must be integrated with their own reviewed changes; Phase 2 does not silently
copy them into its publication diff.
