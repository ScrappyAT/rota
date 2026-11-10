import { AsyncLocalStorage } from 'node:async_hooks';
import { TelemetryEvent, TELEMETRY_EVENTS, telemetryFields } from '@rota/shared';

export const requestContext = new AsyncLocalStorage<{ requestId: string; userId: () => string | undefined }>();
export const contextFields = (): Record<string, unknown> => {
  const context = requestContext.getStore();
  return context ? { requestId: context.requestId, userId: context.userId() } : {};
};
/** Only fixed event names and validated scalar fields reach the sink. Logging must never break a request/job. */
export const logEvent = (event: TelemetryEvent, fields: Record<string, unknown> = {}, level: 'info' | 'warn' | 'error' = 'info'): void => {
  try {
    if (!TELEMETRY_EVENTS.includes(event)) return;
    const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...telemetryFields({ ...contextFields(), ...fields }) });
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  } catch { /* A broken telemetry sink must not change application behavior. */ }
};
