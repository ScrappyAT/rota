jest.mock('@sentry/node', () => ({ init: jest.fn(), captureException: jest.fn(), flush: jest.fn(async () => true) }));
jest.mock('@sentry/react-native', () => ({ init: jest.fn(), captureException: jest.fn(), wrap: (component: unknown) => component, reactNativeErrorHandlersIntegration: jest.fn(() => ({ name: 'ReactNativeErrorHandlers' })) }));
import * as serverSdk from '@sentry/node';
import * as mobileSdk from '@sentry/react-native';
import { initializeErrorTracking as initializeServer, captureFailure } from '../src/services/error-tracking';
import { initializeErrorTracking as initializeMobile, reportMobileError } from '../../mobile/src/services/errorTracking';

describe('Phase 3 optional server/mobile Sentry configuration', () => {
  it('does nothing when configuration is absent or malformed', () => {
    expect(initializeServer('')).toBe(false);
    expect(initializeMobile('invalid')).toBe(false);
    captureFailure(); reportMobileError(new Error('secret'));
    expect(serverSdk.init).not.toHaveBeenCalled(); expect(mobileSdk.init).not.toHaveBeenCalled();
    expect(serverSdk.captureException).not.toHaveBeenCalled(); expect(mobileSdk.captureException).not.toHaveBeenCalled();
  });
  it('survives SDK initialization failures without affecting the application', () => {
    jest.mocked(serverSdk.init).mockImplementationOnce(() => { throw new Error('secret'); });
    jest.mocked(mobileSdk.init).mockImplementationOnce(() => { throw new Error('secret'); });
    expect(initializeServer('https://key@example.invalid/1')).toBe(false);
    expect(initializeMobile('https://key@example.invalid/1')).toBe(false);
  });
  it('enables only scrubbed error delivery, with tracing, logs, breadcrumbs, PII and native crashes disabled', () => {
    expect(initializeServer('https://key@example.invalid/1')).toBe(true);
    expect(initializeMobile('https://key@example.invalid/1')).toBe(true);
    for (const sdk of [serverSdk, mobileSdk]) {
      const options = jest.mocked(sdk.init).mock.calls.slice(-1)[0]![0]!;
      expect(options).toMatchObject({ defaultIntegrations: false, tracesSampleRate: 0 });
      expect(options.beforeBreadcrumb!({ message: 'secret' }, {})).toBeNull();
      expect(options.beforeSendTransaction!({ type: 'transaction' }, {})).toBeNull();
      expect(options.beforeSend!({ type: undefined, message: 'secret', request: { data: 'secret' } }, {})).not.toHaveProperty('request');
      expect(options.beforeSend!({ type: undefined }, { attachments: [{ filename: 'secret', data: 'secret' }] })).toBeNull();
    }
    expect(jest.mocked(mobileSdk.init).mock.calls.slice(-1)[0]![0]).toMatchObject({ enableNative: false, enableNativeCrashHandling: false });
    expect(jest.mocked(serverSdk.init).mock.calls.slice(-1)[0]![0]).toMatchObject({ dataCollection: { userInfo: false, httpHeaders: false, httpBodies: [], queues: false, databaseQueryData: false, stackFrameVariables: false } });
    expect(jest.mocked(mobileSdk.init).mock.calls.slice(-1)[0]![0]).toMatchObject({ sendDefaultPii: false });
  });
  it('captures fixed exceptions only and deduplicates the same mobile error object', () => {
    const error = new Error('password-token-provider-secret');
    reportMobileError(error, { token: error.message }); reportMobileError(error);
    captureFailure({ token: error.message });
    expect(mobileSdk.captureException).toHaveBeenCalledTimes(1);
    expect(serverSdk.captureException).toHaveBeenCalledTimes(1);
    for (const sdk of [serverSdk, mobileSdk]) {
      const [captured, context] = jest.mocked(sdk.captureException).mock.calls[0];
      expect((captured as Error).message).not.toContain(error.message);
      expect(JSON.stringify(context)).not.toContain(error.message);
    }
  });
  it('survives SDK capture failures', () => {
    jest.mocked(serverSdk.captureException).mockImplementationOnce(() => { throw new Error('secret'); });
    jest.mocked(mobileSdk.captureException).mockImplementationOnce(() => { throw new Error('secret'); });
    expect(() => captureFailure()).not.toThrow(); expect(() => reportMobileError()).not.toThrow();
  });
});
