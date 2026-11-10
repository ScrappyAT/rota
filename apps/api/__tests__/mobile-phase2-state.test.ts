import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { DEFAULT_SETTINGS, UserSettings } from '@rota/shared';
import { localDayRange, pageRequestGate, settingsKey, settingsMutation, singleFlight, swapMarkerKey, swapMutation, uniqueItems } from '../../mobile/src/query/mobileState';
import type { Shift } from '../../mobile/src/api/shifts';
import type { SwapRequest } from '../../mobile/src/api/swaps';
const initial = (): UserSettings => ({ ...DEFAULT_SETTINGS, notificationTypes: { shiftAssigned: true, swapRequested: true, swapApproved: true, swapRejected: true }, updatedAt: '2026-11-09T00:00:00Z', fieldUpdatedAt: { theme: '2026-11-09T00:00:00Z' } });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function until(predicate: () => boolean) { for (let n = 0; n < 100 && !predicate(); n++) await new Promise(resolve => setImmediate(resolve)); expect(predicate()).toBe(true); }
let client: QueryClient;
beforeEach(() => { client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } }); });
afterEach(() => { client.clear(); });
const shift: Shift = { id: 'shift', teamId: 'team', title: 'Morning', description: null, createdBy: 'owner', startsAt: '2027-01-01T09:00:00Z', endsAt: '2027-01-01T17:00:00Z', status: 'ACTIVE', createdAt: '', updatedAt: '' };
const row: SwapRequest = { id: 'server-swap', shiftId: shift.id, requestedBy: 'user', offeredTo: null, status: 'PENDING', reason: null, reviewedBy: null, reviewedAt: null, createdAt: '', shiftTitle: shift.title, shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt };

it('shows an optimistic swap before the provider resolves and reconciles its ID', async () => {
  const remote = deferred<SwapRequest>(), send = jest.fn(() => remote.promise);
  const observer = new MutationObserver(client, swapMutation(client, 'user', 'team', shift, send));
  const result = observer.mutate({ reason: 'Appointment' });
  await until(() => Boolean(client.getQueryData(swapMarkerKey('user', 'team', shift.id))));
  expect(client.getQueryData(['swaps', 'team'])).toMatchObject({ pages: [{ items: [{ id: 'optimistic:shift', status: 'PENDING', reason: 'Appointment' }] }] });
  remote.resolve(row); await result;
  expect(client.getQueryData(['swaps', 'team'])).toMatchObject({ pages: [{ items: [{ id: row.id }] }] });
});
it('restores the exact previous swap pages and marker on rejection', async () => {
  const previous = { pages: [{ items: [row], nextCursor: 'cursor' }], pageParams: [undefined] };
  client.setQueryData(['swaps', 'team'], previous);
  const remote = deferred<SwapRequest>(), observer = new MutationObserver(client, swapMutation(client, 'user', 'team', shift, () => remote.promise));
  const result = observer.mutate({}); const rejected = expect(result).rejects.toThrow('Not assigned');
  await until(() => Boolean(client.getQueryData(swapMarkerKey('user', 'team', shift.id))));
  remote.reject(new Error('Not assigned')); await rejected;
  expect(client.getQueryData(['swaps', 'team'])).toEqual(previous);
  expect(client.getQueryData(swapMarkerKey('user', 'team', shift.id))).toBeUndefined();
});
it('removes a newly created optimistic cache on failure and preserves other teams', async () => {
  client.setQueryData(['swaps', 'other-team'], { secret: 'untouched' });
  const observer = new MutationObserver(client, swapMutation(client, 'user', 'team', shift, async () => { throw new Error('Offline'); }));
  await expect(observer.mutate({})).rejects.toThrow('Offline');
  expect(client.getQueryData(['swaps', 'team'])).toBeUndefined();
  expect(client.getQueryData(['swaps', 'other-team'])).toEqual({ secret: 'untouched' });
});
it('claims duplicate taps synchronously and allows a deliberate retry after failure', async () => {
  const remote = deferred<SwapRequest>(), send = jest.fn(() => remote.promise);
  const observer = new MutationObserver(client, swapMutation(client, 'user', 'team', shift, send));
  const one = singleFlight('tap', () => observer.mutate({})), two = singleFlight('tap', () => observer.mutate({}));
  expect(one).toBe(two); const failure = expect(one).rejects.toThrow('Rejected');
  await until(() => send.mock.calls.length === 1); remote.reject(new Error('Rejected')); await failure;
  expect(send).toHaveBeenCalledTimes(1);
  expect(await singleFlight('tap', async () => 'retry')).toBe('retry');
});
it('updates settings optimistically, retains server timestamps and rolls back failure', async () => {
  const previous = initial(); client.setQueryData(settingsKey('u'), previous);
  const remote = deferred<UserSettings>(), observer = new MutationObserver(client, settingsMutation(client, 'u', () => remote.promise));
  const result = observer.mutate({ theme: 'dark' }); const rejected = expect(result).rejects.toThrow('Offline');
  await until(() => client.getQueryData<UserSettings>(settingsKey('u'))?.theme === 'dark');
  expect(client.getQueryData<UserSettings>(settingsKey('u'))?.fieldUpdatedAt).toEqual(previous.fieldUpdatedAt);
  remote.reject(new Error('Offline')); await rejected; expect(client.getQueryData(settingsKey('u'))).toEqual(previous);
});
it('stores canonical settings timestamps and isolates accounts', async () => {
  client.setQueryData(settingsKey('other'), initial()); client.setQueryData(settingsKey('u'), initial());
  const saved = { ...initial(), theme: 'dark' as const, updatedAt: '2026-11-09T01:00:00Z', fieldUpdatedAt: { theme: '2026-11-09T01:00:00Z' } };
  await new MutationObserver(client, settingsMutation(client, 'u', async () => saved)).mutate({ theme: 'dark' });
  expect(client.getQueryData(settingsKey('u'))).toEqual(saved); expect(client.getQueryData(settingsKey('other'))).toEqual(initial());
});
it('cancels an older settings read so it cannot overwrite a newer save', async () => {
  client.setQueryData(settingsKey('u'), initial()); const old = deferred<UserSettings>();
  const reading = client.fetchQuery({ queryKey: settingsKey('u'), queryFn: () => old.promise }).catch(() => undefined);
  const saved = { ...initial(), theme: 'dark' as const };
  await new MutationObserver(client, settingsMutation(client, 'u', async () => saved)).mutate({ theme: 'dark' });
  old.resolve(initial()); await reading; expect(client.getQueryData(settingsKey('u'))).toEqual(saved);
});
it('ignores a settings response arriving after logout rather than recreating old cache', async () => {
  let active = true; const remote = deferred<UserSettings>();
  client.setQueryData(settingsKey('u'), initial());
  const observer = new MutationObserver(client, settingsMutation(client, 'u', () => remote.promise, () => active));
  const pending = observer.mutate({ theme: 'dark' });
  await until(() => client.getQueryData<UserSettings>(settingsKey('u'))?.theme === 'dark');
  active = false; client.clear(); remote.resolve({ ...initial(), theme: 'dark' }); await pending;
  expect(client.getQueryData(settingsKey('u'))).toBeUndefined();
});
it('does not restore optimistic swap data after its session has been cleared', async () => {
  let active = true; const remote = deferred<SwapRequest>();
  const observer = new MutationObserver(client, swapMutation(client, 'user', 'team', shift, () => remote.promise, () => active));
  const pending = observer.mutate({});
  await until(() => Boolean(client.getQueryData(swapMarkerKey('user', 'team', shift.id))));
  active = false; client.clear(); remote.resolve(row); await pending;
  expect(client.getQueryData(['swaps', 'team'])).toBeUndefined();
  expect(client.getQueryData(swapMarkerKey('user', 'team', shift.id))).toBeUndefined();
});
it('rejects a queued swap that starts after logout before creating optimistic state or sending', async () => {
  const send = jest.fn(async () => row);
  const observer = new MutationObserver(client, swapMutation(client, 'user', 'team', shift, send, () => false));
  await expect(observer.mutate({})).rejects.toThrow('Session changed');
  expect(send).not.toHaveBeenCalled(); expect(client.getQueryData(['swaps', 'team'])).toBeUndefined();
});
it.each(['settings', 'swap'] as const)('fences %s if logout occurs while cancelling an older read', async kind => {
  let active = true; const cancellation = deferred<void>();
  const cancel = jest.spyOn(client, 'cancelQueries').mockReturnValue(cancellation.promise);
  const sendSettings = jest.fn(async () => initial()), sendSwap = jest.fn(async () => row);
  const pending = kind === 'settings'
    ? new MutationObserver(client, settingsMutation(client, 'u', sendSettings, () => active)).mutate({ theme: 'dark' })
    : new MutationObserver(client, swapMutation(client, 'u', 'team', shift, sendSwap, () => active)).mutate({});
  const rejected = expect(pending).rejects.toThrow('Session changed');
  await until(() => cancel.mock.calls.length > 0);
  active = false; client.clear(); cancellation.resolve(); await rejected;
  expect(sendSettings).not.toHaveBeenCalled(); expect(sendSwap).not.toHaveBeenCalled();
  expect(client.getQueryCache().getAll()).toHaveLength(0); cancel.mockRestore();
});
it('guards fast next-page events and releases its claim after errors', async () => {
  const gate = pageRequestGate(), remote = deferred<void>(), fetch = jest.fn(() => remote.promise);
  const one = gate(true, fetch); await gate(true, fetch); await gate(false, fetch); expect(fetch).toHaveBeenCalledTimes(1);
  remote.resolve(); await one;
  await expect(gate(true, async () => { throw new Error('failed page'); })).rejects.toThrow();
  const retry = jest.fn(async () => {}); await gate(true, retry); expect(retry).toHaveBeenCalledTimes(1);
});
it('deduplicates overlapping pages while preserving first-seen ordering', () => {
  expect(uniqueItems([{ id: 'a', value: 1 }, { id: 'b', value: 2 }, { id: 'a', value: 3 }])).toEqual([{ id: 'a', value: 3 }, { id: 'b', value: 2 }]);
});
it('uses local day boundaries and calendar arithmetic across month ends', () => {
  const day = new Date(2026, 10, 30, 15); const range = localDayRange(day);
  expect(new Date(range.from).getHours()).toBe(0); expect(new Date(range.to).getHours()).toBe(23);
  day.setDate(day.getDate() + 1); expect(new Date(localDayRange(day).from).getDate()).toBe(1);
});
