import { createContext, useContext, useEffect } from 'react';
import { AppState } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SettingsPatch, UserSettings } from '@rota/shared';
import { apiClient } from '../api/client';
import { dataOrThrow } from '../api/ensure';
import { useAuth } from './AuthContext';
import { offlineEpoch, offlineSessionCurrent } from '../storage/offlineData';
import { settingsKey, settingsMutation, singleFlight } from '../query/mobileState';
const SettingsContext = createContext<{
  controller: { update: (value: SettingsPatch) => Promise<unknown>; refresh: () => Promise<unknown> } | null;
  state: { settings: UserSettings | null; saving: boolean; loading: boolean; error: string | null };
} | null>(null);
export function SettingsProvider({ children }: { children: React.ReactNode }) {
  const { user, readOnlySession } = useAuth(), client = useQueryClient(), id = user?.id ?? '';
  const epoch = offlineEpoch();
  const mutation = useMutation(settingsMutation(client, id, async value => {
    if (readOnlySession) throw new Error('Reconnect to change settings');
    return dataOrThrow(await apiClient.request<UserSettings>('/settings', { method: 'PATCH', body: JSON.stringify(value) }));
  }, () => offlineSessionCurrent(id, epoch)));
  const query = useQuery({ queryKey: settingsKey(id), enabled: Boolean(id) && !readOnlySession && !mutation.isPending, staleTime: 30_000,
    queryFn: async () => dataOrThrow(await apiClient.request<UserSettings>('/settings')) });
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => { if (state === 'active' && id && !readOnlySession && !client.isMutating({ mutationKey: settingsKey(id) })) void client.invalidateQueries({ queryKey: settingsKey(id) }); });
    return () => sub.remove();
  }, [id, readOnlySession, client]);
  const controller = user ? {
    update: (value: SettingsPatch) => singleFlight('settings:' + id, () => mutation.mutateAsync(value)),
    refresh: () => readOnlySession ? Promise.resolve() : query.refetch(),
  } : null;
  const error = mutation.error ? 'Could not save settings; your change was rolled back' : query.error?.message ?? null;
  return <SettingsContext.Provider value={{ controller, state: { settings: query.data ?? null, saving: mutation.isPending || readOnlySession, loading: query.isFetching, error } }}>{children}</SettingsContext.Provider>;
}
export function useSettings() { const value = useContext(SettingsContext); if (!value) throw new Error('SettingsProvider required'); return value; }
