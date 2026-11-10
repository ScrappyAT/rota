import { InfiniteData, MutationOptions, QueryClient } from '@tanstack/react-query';
import { SettingsPatch, UserSettings, mergeSettings } from '@rota/shared';
import type { SwapRequest } from '../api/swaps';
import type { Shift } from '../api/shifts';

const flights = new Map<string, Promise<unknown>>();
/** Claims synchronously, before React can render a disabled button. */
export function singleFlight<T>(key: string, action: () => Promise<T>): Promise<T> {
  const pending = flights.get(key); if (pending) return pending as Promise<T>;
  const result = Promise.resolve().then(action).finally(() => { if (flights.get(key) === result) flights.delete(key); });
  flights.set(key, result); return result;
}
export function pageRequestGate() {
  let busy = false;
  return async (canFetch: boolean, fetch: () => Promise<unknown>) => {
    if (busy || !canFetch) return;
    busy = true; try { await fetch(); } finally { busy = false; }
  };
}
export const uniqueItems = <T extends { id: string }>(items: T[]) => [...new Map(items.map(item => [item.id, item])).values()];
export function localDayRange(day: Date) {
  const start = new Date(day); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1); end.setMilliseconds(-1);
  return { from: start.toISOString(), to: end.toISOString() };
}
export const settingsKey = (userId: string) => ['settings', userId] as const;
export function settingsMutation(client: QueryClient, userId: string, patch: (value: SettingsPatch) => Promise<UserSettings>, isCurrent = () => true): MutationOptions<UserSettings, Error, SettingsPatch, UserSettings | undefined> {
  const key = settingsKey(userId);
  return {
    mutationKey: key,
    mutationFn: value => { if (!isCurrent()) throw new Error('Session changed; retry after signing in'); return patch(value); },
    onMutate: async value => { if (!isCurrent()) throw new Error('Session changed; retry after signing in'); await client.cancelQueries({ queryKey: key }); if (!isCurrent()) throw new Error('Session changed; retry after signing in'); const previous = client.getQueryData<UserSettings>(key); if (previous) client.setQueryData(key, mergeSettings(previous, value)); return previous; },
    onError: (_error, _value, previous) => { if (isCurrent() && previous) client.setQueryData(key, previous); },
    onSuccess: value => { if (isCurrent()) client.setQueryData(key, value); },
    onSettled: () => isCurrent() ? client.invalidateQueries({ queryKey: key }) : undefined,
  };
}
type SwapPage = InfiniteData<{ items: SwapRequest[]; nextCursor?: string | null }, string | undefined>;
export interface SwapInput { offeredTo?: string; reason?: string }
export const swapMarkerKey = (user: string, team: string, shift: string) => ['swap-request', user, team, shift] as const;
export function swapMutation(client: QueryClient, userId: string, teamId: string, shift: Shift, send: (value: SwapInput) => Promise<SwapRequest>, isCurrent = () => true): MutationOptions<SwapRequest, Error, SwapInput, { previous?: SwapPage; marker?: SwapRequest }> {
  const key = ['swaps', teamId] as const, markerKey = swapMarkerKey(userId, teamId, shift.id);
  return {
    mutationFn: value => { if (!isCurrent()) throw new Error('Session changed; retry after signing in'); return send(value); },
    onMutate: async input => {
      if (!isCurrent()) throw new Error('Session changed; retry after signing in');
      await client.cancelQueries({ queryKey: key });
      if (!isCurrent()) throw new Error('Session changed; retry after signing in');
      const previous = client.getQueryData<SwapPage>(key), marker = client.getQueryData<SwapRequest>(markerKey);
      const optimistic: SwapRequest = { id: 'optimistic:' + shift.id, shiftId: shift.id, requestedBy: userId, offeredTo: input.offeredTo ?? null, reason: input.reason ?? null, status: 'PENDING', reviewedBy: null, reviewedAt: null, createdAt: new Date().toISOString(), shiftTitle: shift.title, shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt };
      const data = previous ?? { pages: [{ items: [], nextCursor: null }], pageParams: [undefined] };
      client.setQueryData<SwapPage>(key, { ...data, pages: data.pages.map((p, i) => i === 0 ? { ...p, items: [optimistic, ...p.items] } : p) });
      client.setQueryData(markerKey, optimistic); return { previous, marker };
    },
    onError: (_e, _input, snapshot) => {
      if (!isCurrent()) return;
      if (snapshot?.previous) client.setQueryData(key, snapshot.previous); else client.removeQueries({ queryKey: key, exact: true });
      if (snapshot?.marker) client.setQueryData(markerKey, snapshot.marker); else client.removeQueries({ queryKey: markerKey, exact: true });
    },
    onSuccess: row => {
      if (!isCurrent()) return;
      client.setQueryData(markerKey, row);
      client.setQueryData<SwapPage>(key, data => data ? { ...data, pages: data.pages.map(p => ({ ...p, items: p.items.map(s => s.id === 'optimistic:' + shift.id ? { ...s, ...row } : s) })) } : data);
    },
    onSettled: async () => { if (!isCurrent()) return; await Promise.all([client.invalidateQueries({ queryKey: key }), client.invalidateQueries({ queryKey: ['activity', teamId] }), client.invalidateQueries({ queryKey: ['shift', teamId, shift.id] }), client.invalidateQueries({ queryKey: markerKey })]); },
  };
}
