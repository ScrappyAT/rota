import {
  prefColumn,
  buildExpoMessage,
  classifyExpoResponse,
  formatShiftDate,
  NotificationEvent,
} from '../src/services/notifications';

const baseEvent = (overrides: Partial<NotificationEvent> = {}): NotificationEvent => ({
  teamId: '00000000-0000-0000-0000-000000000001',
  userId: '00000000-0000-0000-0000-000000000002',
  type: 'SHIFT_ASSIGNED',
  title: 'New shift assigned',
  body: 'You have a shift on Mon.',
  data: { teamId: '00000000-0000-0000-0000-000000000001', event: 'shift_assigned' },
  eventKey: 'shift_assigned:shift-1:user-1',
  ...overrides,
});

describe('prefColumn', () => {
  it('maps each notification type to its preferences column', () => {
    expect(prefColumn('SHIFT_ASSIGNED')).toBe('shift_assigned');
    expect(prefColumn('SWAP_REQUESTED')).toBe('swap_requested');
    expect(prefColumn('SWAP_APPROVED')).toBe('swap_approved');
    expect(prefColumn('SWAP_REJECTED')).toBe('swap_rejected');
  });
});

describe('buildExpoMessage', () => {
  it('includes recipients, title, body, data and a default sound', () => {
    const message = buildExpoMessage(baseEvent(), ['token-1', 'token-2']);
    expect(message).toEqual({
      to: ['token-1', 'token-2'],
      title: 'New shift assigned',
      body: 'You have a shift on Mon.',
      data: { teamId: baseEvent().teamId, event: 'shift_assigned' },
      sound: 'default',
    });
  });

  it('caps recipients at 100 tokens per request', () => {
    const tokens = Array.from({ length: 150 }, (_, i) => `token-${i}`);
    expect(buildExpoMessage(baseEvent(), tokens).to).toHaveLength(100);
  });
});

describe('classifyExpoResponse', () => {
  const tokens = ['token-a', 'token-b', 'token-c'];

  it('counts ok entries and keeps all tokens', () => {
    const result = classifyExpoResponse({ data: [{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }] }, tokens);
    expect(result).toEqual({ okCount: 3, invalidTokens: [] });
  });

  it('flags DeviceNotRegistered and InvalidPushToken as permanent', () => {
    const payload = {
      data: [
        { status: 'ok' },
        { status: 'error', details: { error: 'DeviceNotRegistered' } },
        { status: 'error', details: { error: 'InvalidPushToken' } },
      ],
    };
    expect(classifyExpoResponse(payload, tokens)).toEqual({
      okCount: 1,
      invalidTokens: ['token-b', 'token-c'],
    });
  });

  it('ignores transient/message errors without pruning the token', () => {
    const payload = {
      data: [
        { status: 'error', details: { error: 'MessageTooBig' } },
        { status: 'error', details: { error: 'InternalServerError' } },
      ],
    };
    expect(classifyExpoResponse(payload, tokens)).toEqual({ okCount: 0, invalidTokens: [] });
  });

  it('tolerates a missing or malformed data array', () => {
    expect(classifyExpoResponse(null, tokens)).toEqual({ okCount: 0, invalidTokens: [] });
    expect(classifyExpoResponse({ data: 'nope' }, tokens)).toEqual({ okCount: 0, invalidTokens: [] });
    expect(classifyExpoResponse({}, tokens)).toEqual({ okCount: 0, invalidTokens: [] });
  });
});

describe('formatShiftDate', () => {
  it('formats valid ISO input for humans', () => {
    const out = formatShiftDate('2026-10-12T09:00:00.000Z');
    expect(out).toMatch(/2026/);
    expect(out).toMatch(/12 Oct/);
  });

  it('returns an empty string for invalid input', () => {
    expect(formatShiftDate('not-a-date')).toBe('');
    expect(formatShiftDate(new Date('invalid'))).toBe('');
  });
});