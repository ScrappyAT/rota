import { DEFAULT_SETTINGS, SettingsPatchSchema } from '@rota/shared';
import { nextPermittedDelivery } from '../src/services/quiet-hours';
describe('server quiet-hour delivery windows', () => {
  const settings = (timeZone: string, start = '22:00', end = '06:00') => ({ ...DEFAULT_SETTINGS, timeZone, quietHours: { enabled: true, start, end } });
  it.each([
    ['Africa/Lagos', '2026-11-02T01:00:00Z', '2026-11-02T05:00:00Z'],
    ['Africa/Lagos', '2026-11-01T21:00:00Z', '2026-11-02T05:00:00Z'],
    ['Africa/Lagos', '2026-11-02T05:00:00Z', '2026-11-02T05:00:00Z'],
    ['Asia/Kathmandu', '2026-11-02T18:15:00Z', '2026-11-03T00:15:00Z'],
    ['America/New_York', '2026-03-08T06:30:00Z', '2026-03-08T10:00:00Z'],
    ['America/New_York', '2026-11-01T05:30:00Z', '2026-11-01T11:00:00Z'],
    ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-01T11:00:00Z'],
  ])('obeys %s including local boundaries/DST at %s', (zone, now, expected) => expect(nextPermittedDelivery(settings(zone), new Date(now)).toISOString()).toBe(new Date(expected).toISOString()));
  it('supports a same-day window', () => expect(nextPermittedDelivery(settings('UTC', '12:00', '13:30'), new Date('2026-11-02T12:12:17Z')).toISOString()).toBe('2026-11-02T13:30:00.000Z'));
  it('does not defer when disabled', () => expect(nextPermittedDelivery(DEFAULT_SETTINGS, new Date('2026-11-02T23:00:00Z')).toISOString()).toBe('2026-11-02T23:00:00.000Z'));
  it.each([{ timeZone: 'Mars/Foo' }, { timeZone: '+01:00' }, { quietHours: { enabled: true, start: '22:00', end: '22:00' } }, { quietHours: { enabled: true, start: '25:00', end: '06:00' } }, { theme: 'invalid' }, { updatedAt: '2099-01-01T00:00:00Z' }, {}])('rejects invalid/untrusted settings %#', patch => expect(SettingsPatchSchema.safeParse(patch).success).toBe(false));
});
