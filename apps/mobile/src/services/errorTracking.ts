import type { ComponentType } from 'react';
import { scrubErrorEvent, telemetryFields, validTelemetryDsn } from '@rota/shared';

let enabled = false;
let sdk: typeof import('@sentry/react-native') | undefined;
const reported = new WeakSet<object>();
export const initializeErrorTracking = (dsn = process.env.EXPO_PUBLIC_SENTRY_DSN): boolean => {
  if (enabled || !validTelemetryDsn(dsn)) return enabled;
  try {
    // Do not load native instrumentation at all when configuration is absent.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro needs synchronous optional initialization before wrapping the root component.
    const Sentry: typeof import('@sentry/react-native') = require('@sentry/react-native');
    Sentry.init({
      dsn, defaultIntegrations: false,
      integrations: [Sentry.reactNativeErrorHandlersIntegration({ onerror: true, onunhandledrejection: true, patchGlobalPromise: false })],
      sendDefaultPii: false,
      enableNative: false, enableNativeCrashHandling: false, enableNativeNagger: false,
      enableAutoSessionTracking: false, enableAutoPerformanceTracing: false,
      enableLogs: false, tracesSampleRate: 0,
      beforeBreadcrumb: () => null, beforeSendTransaction: () => null,
      beforeSend: (event, hint) => hint.attachments?.length ? null : scrubErrorEvent(event as unknown as Record<string, unknown>),
    });
    sdk = Sentry;
    enabled = true;
  } catch { enabled = false; }
  return enabled;
};
/** Keep raw native/storage/network exceptions and credentials out of logs and SDK scopes. */
export const reportMobileError = (error?: unknown, fields: Record<string, unknown> = {}): void => {
  if (!enabled) return;
  if (error && typeof error === 'object') {
    if (reported.has(error)) return;
    reported.add(error);
  }
  try { sdk?.captureException(new Error('Unexpected Rota mobile failure'), { tags: telemetryFields({ component: 'mobile', ...fields }) }); }
  catch { /* Offline/disabled telemetry must never prevent normal use. */ }
};

export const withErrorTracking = <P extends Record<string, unknown>>(component: ComponentType<P>): ComponentType<P> =>
  sdk ? sdk.wrap(component) : component;
