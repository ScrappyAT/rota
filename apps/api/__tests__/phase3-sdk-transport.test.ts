import { init } from '@sentry/node';
import { serverErrorTrackingOptions } from '../src/services/error-tracking';

describe('Phase 3 actual SDK envelope privacy (in-memory transport, no network)', () => {
  it('scrubs the final SDK error envelope, not only an isolated helper', async () => {
    const envelopes: unknown[] = [];
    const client = init({
      ...serverErrorTrackingOptions('https://publickey@example.invalid/1'),
      transport: () => ({ send: async envelope => { envelopes.push(envelope); return { statusCode: 200 }; }, flush: async () => true }),
    });
    expect(client).toBeDefined();
    try {
      client!.captureEvent({ message: 'secret-password', request: { url: 'https://secret-token.invalid', data: 'secret-password' },
        user: { email: 'secret-email@example.com' }, extra: { provider: 'secret-password' },
        breadcrumbs: [{ message: 'secret-password' }], tags: { requestId: '58da4c16-f125-4c5f-8f9c-6dcd4ac20b66', password: 'secret-password' } });
      await client!.flush(1000);
      expect(envelopes).toHaveLength(1);
      const serialized = JSON.stringify(envelopes);
      expect(serialized).toContain('58da4c16-f125-4c5f-8f9c-6dcd4ac20b66');
      expect(serialized).not.toMatch(/secret-password|secret-token|secret-email/);
      expect(serialized).toContain('RotaError');
    } finally { await client!.close(1000); }
  });
  it('drops attachments before any transport send', async () => {
    const send = jest.fn(async () => ({ statusCode: 200 }));
    const client = init({ ...serverErrorTrackingOptions('https://publickey@example.invalid/1'),
      sendClientReports: false, transport: () => ({ send, flush: async () => true }) });
    try {
      client!.captureEvent({ message: 'secret' }, { attachments: [{ filename: 'credentials.txt', data: 'secret' }] });
      await client!.flush(1000);
      expect(send).not.toHaveBeenCalled();
    } finally { await client!.close(1000); }
  });
});
