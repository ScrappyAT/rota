# Observability and incident tracing

Implemented locally in Graduation Phase 3. No production telemetry account,
collector, alert or delivery was configured or exercised.

## Request records

`apps/api/src/middleware/request-logging.ts` precedes CORS/parsers/validation.
It creates a cryptographic UUID, returns `X-Request-ID` (also CORS-exposed), and
emits one `request.finished` record on finish/abort. Incoming IDs are ignored.
AsyncLocalStorage correlates related error/outbox records without adding fields
to job payloads or changing idempotency comparisons.

```json
{"timestamp":"2026-11-10T14:14:00.000Z","level":"info","event":"request.finished","requestId":"58da4c16-f125-4c5f-8f9c-6dcd4ac20b66","route":"/teams/:id/subscription/checkout","method":"POST","durationMs":12.4,"status":202,"outcome":"success"}
```

This is an illustrative schema, not production evidence. `userId` is included
only after authentication assigns a valid UUID. Query/fragment and dynamic path
segments never appear. Outcome is based on status: <400 success, 4xx client_error,
5xx server_error; a premature close is aborted. HTTP success does not prove
payment settlement. Request errors preserve the API response envelope.

## Jobs and correlation

`job.intent_written`: requestId/userId where available, jobId/jobType, teamId,
paymentId when the payload supplies a UUID. It means **uncommitted intent**:
the caller can still roll back. A worker execution confirms a persisted job.

`job.queue_started`/`job.queue_failed` describe BullMQ delivery attempts,
including failures before the database can be claimed. `attempt` here is the
BullMQ delivery count. `job.started`/`job.completed`/`job.retry`/`job.dead` describe
the durable PostgreSQL attempt count. These counts can differ after stalls or
replays. `job.deferred` is scheduling rather than a failure; an early deferral
may have attempt=0. `job.skipped` covers already-terminal/missing work.
`job.dispatch_retry` and terminal dispatch errors describe Redis publication.
Completion/failure/deferral include measured duration; retry records include
bounded backoff delay and failure count. Payloads and provider error text are
excluded. Existing `job_attempts` retains start/finish/outcome after restart;
interrupted attempts are marked when reclaimed. No migration was needed.

A hard kill can prevent a final log. PostgreSQL remains authoritative; missing
completion records must be investigated using durable state, not assumed sent.
Telemetry does not change retry budgets, advisory locks, claim fences, ledger
settlement or uncertain push-send handling.

## Investigating “my payment failed at 3:14 PM”

1. Establish the user's time zone/date; convert to UTC. Use authenticated UUID,
   timestamp window and `/teams/:id/subscription/...` route to find a request ID.
   Never ask for a password, access token, card details or provider secret.
2. Search the same request ID for `request.error` and `job.intent_written`.
   Follow jobId through queue/durable attempt events. Logs do not contain raw
   transaction references, customer emails or checkout URLs.
3. With approved read-only database access, inspect the payment's own team,
   state, revision/ledger entries and related outbox/attempt metadata. Example
   parameterized diagnostic query (not executed against production here):

```sql
SELECT o.id, o.kind, o.status, o.attempts, a.attempt,
       a.started_at, a.finished_at, a.outcome
FROM job_outbox o
LEFT JOIN webhook_events e
  ON o.kind = 'PAYMENT_WEBHOOK' AND o.payload->>'eventKey' = e.event_key
JOIN payment_transactions p
  ON p.id::text = o.payload->>'paymentId'
  OR p.tx_ref = e.payload->'data'->>'tx_ref'
LEFT JOIN job_attempts a ON a.outbox_id = o.id
WHERE p.id = $1::uuid AND p.team_id = $2::uuid
ORDER BY a.started_at, a.attempt;
```

4. Check terminal/manual-review state. An ambiguous initialization must use
   read-only verification of its original reference; never initialize a second
   charge. Unknown push sends cannot be replayed automatically. Do not modify
   ledger/history to make an incident appear resolved.

Request-to-job correlation is held in logs, not added to the DB schema. Collector
retention/search/access control must be configured for tracing across restarts;
without retained stdout, historical request IDs cannot be reconstructed from
PostgreSQL alone. This is an operational limitation, not exactly-once tracing.

## Error tracking configuration and privacy

Server: optional `SENTRY_DSN`, Node SDK 11.11.0, supported Node 24 runtime.
Mobile: optional `EXPO_PUBLIC_SENTRY_DSN`, Expo-recommended React Native SDK
7.11.0. Invalid/empty/non-HTTPS DSNs disable reporting. These are ingestion
identifiers; private `SENTRY_AUTH_TOKEN` is neither required nor bundled.
Tests explicitly blank all telemetry credentials and use a memory transport.

Server default integrations and automatic data collection are disabled;
manual 5xx/worker/fatal capture uses fixed errors. Mobile lazily loads the SDK
only with valid configuration; its explicit JS error integration handles global
errors/Hermes rejections without replacing Promise. Expo Router boundaries and
root wrapping report render failures. Expected offline transport failures remain
local; handled API 5xx may include a validated server request ID. JSC rejection
tracking is not promised when Promise patching is disabled.

The final shared scrubber rebuilds events with only fixed exception text,
event ID/time and validated tags (UUIDs, normalized route/method, bounded numeric
metrics, fixed job type/outcome/component). It drops stack/source/locals, bodies,
headers, cookies, IP/email/user context, query strings, arbitrary extras/tags,
breadcrumbs and SDK request/device contexts. Events with attachments are dropped.
No screenshots/replay, native crash transport, automatic console ingestion,
performance traces or source-map upload are configured. This deliberately trades
stack-level diagnosis for a narrow privacy boundary; use safe correlation and
controlled reproduction. Review any future expansion separately.

The API/worker fatal handlers emit a fixed event and terminate with code 1 after
a best-effort SDK flush bounded to 600ms. This does not resume a corrupted process.
SIGKILL, early module-load failures before handler installation, or host failure
cannot guarantee telemetry delivery. Library/OS/development tooling diagnostics
outside Rota's configured sinks are not covered by these application tests.

## Tests and operation

- `phase3-telemetry.test.ts`: allowlist, secrets/nesting, malformed input, route
  privacy, concurrent contexts, broken log sink and DSN validation.
- `phase3-request-logging.test.ts`: HTTP success/authenticated metadata, 400 JSON/
  Zod errors, 404, 500 envelope, unique request IDs and no secret logging.
- `phase3-error-tracking.test.ts`: mocked native/server adapters; absent/invalid
  configuration, init/capture failure, attachments and mobile deduplication.
- `phase3-sdk-transport.test.ts`: actual server SDK, final envelope inspected in
  memory. No ingestion endpoint is contacted.
- `phase3-fatal-errors.test.ts`: child processes exit 1 for uncaught/rejected
  failures without printing injected credentials.
- `phase3-jobs.integration.test.ts`: real PostgreSQL/Redis/BullMQ, completion,
  replay, retries/dead state, deferral and transaction rollback/correlation.

Before rollout choose retention, access policy and budget; configure 5xx/dead-job/
queue-age alerts; validate an approved synthetic event in staging; document the
on-call operator and verify clock synchronization. SDK transport failure is
best-effort and does not block requests, retry jobs or settle payments.

Implementation references: [Sentry Node options](https://docs.sentry.io/platforms/javascript/guides/node/configuration/options/),
[Sentry Expo setup](https://docs.sentry.io/platforms/react-native/guides/expo/),
[Expo SDK 57](https://docs.expo.dev/versions/v57.0.0/). Installed SDK types were
used to verify the exact Node11/React Native7 option names.
