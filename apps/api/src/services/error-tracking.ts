import * as Sentry from '@sentry/node';
import { scrubErrorEvent, telemetryFields, validTelemetryDsn } from '@rota/shared';
import { contextFields, logEvent } from './observability';

export const serverErrorTrackingOptions = (safeDsn: string): Sentry.NodeOptions => ({
  dsn: safeDsn, defaultIntegrations: false, integrations: [], includeServerName: false,
  dataCollection: {
    userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
    graphQL: { document: false, variables: false }, genAI: { inputs: false, outputs: false },
    mcp: { inputs: false, outputs: false }, databaseQueryData: false, queues: false,
    stackFrameVariables: false, frameContextLines: 0,
  },
  beforeSendLog: () => null, beforeSendMetric: () => null,
  tracesSampleRate: 0, tracePropagationTargets: [], beforeBreadcrumb: () => null,
  beforeSendTransaction: () => null,
  beforeSend: (event, hint) => hint.attachments?.length ? null : scrubErrorEvent(event as unknown as Record<string, unknown>),
});

let enabled = false;
export const initializeErrorTracking = (dsn = process.env.SENTRY_DSN): boolean => {
  const safeDsn = validTelemetryDsn(dsn);
  if (!safeDsn || enabled) return enabled;
  try {
    Sentry.init(serverErrorTrackingOptions(safeDsn));
    enabled = true;
  } catch { enabled = false; }
  return enabled;
};
/** Never give the SDK the original Error (it may contain SQL, provider bodies, URLs or credentials). */
export const captureFailure = (fields: Record<string, unknown> = {}): void => {
  if (!enabled) return;
  try { Sentry.captureException(new Error('Unexpected Rota failure'), { tags: telemetryFields({ component: 'api', ...contextFields(), ...fields }) }); }
  catch { /* Telemetry is optional. */ }
};
/** Main entry points only: terminate after a bounded best-effort flush, without Node printing raw errors. */
export const installFatalErrorHandlers = (): void => {
  const fatal = () => {
    logEvent('process.error', { outcome: 'unexpected' }, 'error');
    captureFailure();
    const timer = setTimeout(() => process.exit(1), 600);
    void Promise.resolve().then(() => Sentry.flush(500)).catch(() => false).finally(() => { clearTimeout(timer); process.exit(1); });
  };
  process.once('uncaughtException', fatal);
  process.once('unhandledRejection', fatal);
};
