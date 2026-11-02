import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { AppState } from 'react-native';
import { SettingsController, SettingsPatch } from '@rota/shared';
import { apiClient } from '../api/client';
import { dataOrThrow } from '../api/ensure';
import { UserSettings } from '@rota/shared';
import { useAuth } from './AuthContext';
const SettingsContext = createContext<{
  controller: SettingsController | null;
  state: SettingsController['state'];
} | null>(null);
export function SettingsProvider({ children }: {
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const controller = useMemo(() => user?.id ? new SettingsController({
    get: async () => dataOrThrow(await apiClient.request<UserSettings>('/settings')),
    patch: async (patch: SettingsPatch) => dataOrThrow(await apiClient.request<UserSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) })),
  }) : null, [user?.id]);
  const [, render] = useState(0);
  useEffect(() => {
    if (!controller)
      return;
    const unsubscribe = controller.subscribe(() => render(value => value + 1));
    void controller.refresh();
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active')
        void controller.refresh();
    });
    return () => { sub.remove(); unsubscribe(); controller.dispose(); };
  }, [controller]);
  const state = controller?.state ?? { settings: null, saving: false, loading: false, error: null };
  return <SettingsContext.Provider value={{ controller, state }}>{children}</SettingsContext.Provider>;
}
export const useSettings = () => {
  const context = useContext(SettingsContext);
  if (!context)
    throw new Error('SettingsProvider is required');
  return context;
};
