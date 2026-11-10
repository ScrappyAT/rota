/** Telemetry is an allowlist, never a serialization of requests, errors or payloads. */
export const TELEMETRY_EVENTS = [
  'request.finished', 'request.error', 'job.intent_written', 'job.started',
  'job.completed', 'job.deferred', 'job.retry', 'job.dead', 'job.skipped',
  'job.dispatch_retry', 'job.connection_error', 'worker.poll_error', 'process.error',
  'cache.error', 'database.error', 'redis.error', 'push.error', 'mobile.error', 'job.queue_started', 'job.queue_failed',
] as const;
export type TelemetryEvent = typeof TELEMETRY_EVENTS[number];
export const JOB_TYPES = ['DOMAIN_EVENT', 'NOTIFICATION', 'PAYMENT_WEBHOOK', 'PAYMENT_INITIALIZE',
  'PAYMENT_RECONCILE', 'PAYMENT_VERIFY', 'BILLING_RECHECK', 'AUTH_EMAIL'] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const telemetryId = (value: unknown): string | undefined =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : undefined;
const SEGMENTS = new Set(('health auth login register refresh logout logout-all password-reset magic-link request consume '
  + 'teams members invitations accept shifts assignments swaps approve reject activity devices billing plans subscription '
  + 'checkout seats renew payments verify webhook settings notifications preferences me cancel downgrade').split(' '));
/** Strip query/fragment and all dynamic path values, including unmatched/error routes. */
export const telemetryRoute = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 2048) return '/:unknown';
  return '/' + value.split(/[?#]/, 1)[0].split('/').filter(Boolean).slice(0, 16)
    .map(segment => SEGMENTS.has(segment) ? segment : ':id').join('/');
};
export const telemetryFields = (input: Record<string, unknown>): Record<string, string | number> => {
  const output: Record<string, string | number> = {};
  for (const key of ['requestId', 'userId', 'jobId', 'teamId', 'paymentId']) {
    const id = telemetryId(input[key]);
    if (id) output[key] = id;
  }
  if (input.route !== undefined) output.route = telemetryRoute(input.route);
  if (typeof input.method === 'string' && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(input.method)) output.method = input.method;
  for (const key of ['durationMs', 'attempt', 'retryInMs', 'status', 'failureCount']) {
    const n = input[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1e12) output[key] = Math.round(n * 100) / 100;
  }
  if (['api', 'worker', 'mobile', 'render', 'storage', 'push'].includes(String(input.component))) output.component = String(input.component);
  if (JOB_TYPES.includes(input.jobType as typeof JOB_TYPES[number])) output.jobType = String(input.jobType);
  if (['success', 'client_error', 'server_error', 'aborted', 'deferred', 'retry', 'dead', 'duplicate', 'uncommitted', 'unexpected'].includes(String(input.outcome))) output.outcome = String(input.outcome);
  return output;
};
/** Drop arbitrary SDK fields rather than trying to recognize every possible secret. */
export const scrubErrorEvent = (event: Record<string, unknown>): {
  type: undefined; level: 'error'; event_id?: string; timestamp?: number;
  tags: Record<string, string | number>;
  exception: { values: { type: string; value: string }[] };
} => {
  const tags = event.tags && typeof event.tags === 'object' ? telemetryFields(event.tags as Record<string, unknown>) : {};
  return {
    type: undefined,
    ...(typeof event.event_id === 'string' && /^[0-9a-f]{32}$/.test(event.event_id) ? { event_id: event.event_id } : {}),
    ...(typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? { timestamp: event.timestamp } : {}),
    level: 'error',
    tags,
    // Error messages, stacks/source snippets, breadcrumbs and SDK request/user contexts can all contain credentials.
    exception: { values: [{ type: 'RotaError', value: 'Unexpected application failure; correlate using safe tags' }] },
  };
};
/** Credentials are optional. Invalid or non-HTTPS DSNs disable delivery without affecting the app. */
export const validTelemetryDsn = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 512) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.username && !url.password && /^\/\d+$/.test(url.pathname)
      && !url.search && !url.hash ? value : undefined;
  } catch { return undefined; }
};
