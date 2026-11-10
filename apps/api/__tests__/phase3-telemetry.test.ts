import { scrubErrorEvent, telemetryFields, telemetryRoute, validTelemetryDsn } from '@rota/shared';
import { logEvent, requestContext } from '../src/services/observability';

const id = '58da4c16-f125-4c5f-8f9c-6dcd4ac20b66';
const secret = 'DO-NOT-LOG-password-token-card-provider-secret';
describe('Phase 3 strict telemetry allowlist', () => {
  it('drops nested request, auth, provider and exception data instead of serializing it', () => {
    const result = telemetryFields({ requestId: id, userId: id, password: secret, headers: { authorization: secret },
      body: { card: secret }, error: new Error(secret), payload: { email: secret }, durationMs: 1.236, status: 500 });
    expect(result).toEqual({ requestId: id, userId: id, durationMs: 1.24, status: 500 });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it.each(['/auth/password-reset/secret-value?token=hidden', '/teams/user@example.com/activity#hidden', '/unrecognized-sensitive-path'])('redacts dynamic and unknown route segments: %s', value => {
    const result = telemetryRoute(value);
    expect(result).not.toMatch(/secret-value|hidden|@|unrecognized-sensitive/);
  });
  it('bounds malformed paths, methods, IDs, durations and arbitrary job types', () => {
    expect(telemetryRoute('https://secret.example/token')).toBe('/:unknown');
    expect(telemetryRoute('/' + 'a'.repeat(3000))).toBe('/:unknown');
    expect(telemetryFields({ requestId: secret, userId: 'email@example.com', durationMs: NaN, attempt: -1, method: secret, jobType: secret })).toEqual({});
  });
  it('rebuilds SDK events without request data, source snippets, breadcrumbs or arbitrary tags', () => {
    const result = scrubErrorEvent({ event_id: 'a'.repeat(32), timestamp: 1, request: { url: secret, data: secret },
      user: { email: secret, ip_address: secret }, breadcrumbs: [{ message: secret }], contexts: { response: secret },
      extra: { password: secret }, tags: { requestId: id, token: secret },
      exception: { values: [{ value: secret, stacktrace: { frames: [{ vars: { token: secret }, pre_context: [secret] }] } }] } });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.tags).toEqual({ requestId: id });
    expect(Object.keys(result).sort()).toEqual(['event_id', 'exception', 'level', 'tags', 'timestamp', 'type']);
  });
  it.each([undefined, '', 'not-a-dsn', 'http://key@example.invalid/1', 'https://key:secret@example.invalid/1', 'https://key@example.invalid/1?secret=x'])('disables unsafe or absent DSNs: %s', value => {
    expect(validTelemetryDsn(value)).toBeUndefined();
  });
  it('accepts an explicit HTTPS ingestion DSN without private authentication', () => {
    expect(validTelemetryDsn('https://publickey@example.invalid/1')).toBe('https://publickey@example.invalid/1');
  });
  it('correlates concurrent async contexts without leaking user-supplied fields', async () => {
    const sink = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await Promise.all([id, 'c639f5c5-96a0-4e04-92af-15b211caaee0'].map(requestId => requestContext.run({ requestId, userId: () => id }, async () => {
        await Promise.resolve(); logEvent('job.intent_written', { jobId: id, payload: secret, outcome: 'uncommitted' });
      })));
      const records = sink.mock.calls.map(([line]) => JSON.parse(String(line)));
      expect(new Set(records.map(r => r.requestId)).size).toBe(2);
      expect(records.every(r => r.userId === id && r.jobId === id)).toBe(true);
      expect(JSON.stringify(records)).not.toContain(secret);
    } finally { sink.mockRestore(); }
  });
  it('does not throw when the output sink fails', () => {
    const sink = jest.spyOn(console, 'error').mockImplementation(() => { throw new Error(secret); });
    try { expect(() => logEvent('request.error', { error: secret }, 'error')).not.toThrow(); }
    finally { sink.mockRestore(); }
  });
});
