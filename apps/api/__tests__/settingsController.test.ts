import { DEFAULT_SETTINGS, SettingsController, UserSettings, notificationTarget } from '@rota/shared';
const initial = (): UserSettings => ({ ...DEFAULT_SETTINGS, notificationTypes: { shiftAssigned: true, swapRequested: true, swapApproved: true, swapRejected: true }, updatedAt: '2026-11-02T00:00:00.000Z', fieldUpdatedAt: { theme: '2026-11-02T00:00:00.000Z' } });
describe('actual mobile settings coordinator', () => {
  it('foreground refresh observes another device\'s server state', async () => {
    const remote = initial(), controller = new SettingsController({ get: async () => ({ ...remote }), patch: async () => remote });
    await controller.refresh();
    remote.theme = 'dark';
    await controller.refresh();
    expect(controller.state.settings?.theme).toBe('dark');
  });
  it('updates optimistically and rolls back a rejected write', async () => {
    let reject: (error: Error) => void = () => { };
    const controller = new SettingsController({ get: async () => initial(), patch: () => new Promise((_, r) => { reject = r; }) });
    await controller.refresh();
    const saving = controller.update({ theme: 'dark' });
    expect(controller.state.settings?.theme).toBe('dark');
    expect(controller.state.saving).toBe(true);
    reject(new Error('offline'));
    await expect(saving).rejects.toThrow();
    expect(controller.state.settings?.theme).toBe('system');
    expect(controller.state.error).toContain('rolled back');
  });
  it('does not overwrite a pending optimistic change during foreground refresh', async () => {
    let resolve: (value: UserSettings) => void = () => { };
    const get = jest.fn(async () => initial());
    const controller = new SettingsController({ get, patch: () => new Promise(r => { resolve = r; }) });
    await controller.refresh();
    const saving = controller.update({ theme: 'dark' });
    await controller.refresh();
    expect(get).toHaveBeenCalledTimes(1);
    resolve({ ...initial(), theme: 'dark' });
    await saving;
    expect(controller.state.settings?.theme).toBe('dark');
  });
  it('ignores an older read that completes after a newer one', async () => {
    let resolve: (value: UserSettings) => void = () => { };
    let calls = 0;
    const controller = new SettingsController({ get: () => ++calls === 1 ? new Promise(r => { resolve = r; }) : Promise.resolve({ ...initial(), theme: 'dark' }), patch: async () => initial() });
    const older = controller.refresh();
    await controller.refresh();
    resolve(initial());
    await older;
    expect(controller.state.settings?.theme).toBe('dark');
  });
  it('disposes old-user state and listeners at logout', async () => {
    let resolve: (value: UserSettings) => void = () => { };
    const controller = new SettingsController({ get: () => new Promise(r => { resolve = r; }), patch: async () => initial() });
    const listener = jest.fn();
    controller.subscribe(listener);
    const pending = controller.refresh();
    controller.dispose();
    resolve(initial());
    await pending;
    expect(listener).not.toHaveBeenCalled();
    expect(controller.state.settings).toBeNull();
  });
});
describe('shared notification destination used by the mobile handler', () => {
  const team = '10000000-0000-4000-8000-000000000001', shift = '10000000-0000-4000-8000-000000000002', swap = '10000000-0000-4000-8000-000000000003';
  it('carries the target team to its exact shift', () => expect(notificationTarget({ teamId: team, shiftId: shift, event: 'shift_assigned' })).toEqual({ teamId: team, path: '/shifts/[shiftId]', params: { teamId: team, shiftId: shift } }));
  it('carries the target team and swap to the swaps screen', () => expect(notificationTarget({ teamId: team, swapId: swap, event: 'swap_approved' })?.params).toEqual({ teamId: team, swapId: swap }));
  it('routes billing to that team\'s subscription', () => expect(notificationTarget({ teamId: team, event: 'billing_renewal_failed' })?.path).toBe('/subscription'));
  it('routes deleted shifts to the calendar', () => expect(notificationTarget({ teamId: team, event: 'shift_deleted' })?.path).toBe('/(tabs)'));
  it.each([null, { event: 'swap_approved', teamId: team }, { teamId: '../../other', shiftId: shift }, { teamId: team, shiftId: '../../auth' }])('rejects missing or malformed destinations %#', input => expect(notificationTarget(input)).toBeNull());
});
