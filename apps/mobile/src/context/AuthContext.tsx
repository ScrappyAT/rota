import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { User, AuthResponse } from '@rota/shared';
import { router, useSegments } from 'expo-router';
import { authStorage } from '../storage/authStorage';
import { apiClient } from '../api/client';
import { queryClient } from '../query/queryClient';
import { clearUserCache } from '../storage/shiftCache';
import { activateOfflineCache, clearOfflineData } from '../storage/offlineData';
import { clearOfflineIdentity, restoreSessionIdentity, saveOfflineIdentity, selectedTeamKey } from '../storage/offlineSession';
import { postAuthDestination } from '../services/invitationLinks';
import { unregisterCurrentDevice } from '../services/pushNotifications';

interface AuthContextType {
  user: User | null; loading: boolean; readOnlySession: boolean;
  activeTeamId: string | null;
  setActiveTeamId: (id: string | null) => Promise<void>;
  login: (data: AuthResponse) => Promise<void>;
  logout: (allDevices?: boolean) => Promise<void>;
  refreshAuth: () => Promise<void>;
}
const AuthContext = createContext<AuthContextType | undefined>(undefined);
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null), [loading, setLoading] = useState(true);
  const [readOnlySession, setReadOnly] = useState(true), [activeTeamId, setTeam] = useState<string | null>(null);
  const refreshing = useRef<Promise<void> | null>(null), generation = useRef(0);
  const readOnlyRef = useRef(true); readOnlyRef.current = readOnlySession;
  const segments = useSegments();
  const mode = (value: boolean) => { apiClient.setReadOnlySession(value); setReadOnly(value); readOnlyRef.current = value; };
  const clearLocal = async (id: string | null) => {
    generation.current++; mode(true); activateOfflineCache(null);
    setUser(null); setTeam(null);
    // Remove the read lease before potentially slower filesystem cleanup.
    await clearOfflineIdentity(authStorage);
    await queryClient.cancelQueries(); queryClient.clear();
    if (id) { await clearUserCache(id); await clearOfflineData(id); await authStorage.deleteItemAsync(selectedTeamKey(id)); }
  };
  const publish = async (value: User, offline: boolean) => {
    activateOfflineCache(value.id); mode(offline);
    setTeam(await authStorage.getItemAsync(selectedTeamKey(value.id))); setUser(value);
  };
  const refreshAuth = (): Promise<void> => {
    if (refreshing.current) return refreshing.current;
    const version = generation.current;
    const task = (async () => {
      try {
        const identity = await restoreSessionIdentity(authStorage, {
          refresh: async () => { await apiClient.refreshSession(); return apiClient.refreshOutcome; },
          me: () => apiClient.request<User>('/auth/me'),
        });
        if (version !== generation.current) return;
        if (identity.user) {
          if (identity.kind === 'verified') await saveOfflineIdentity(authStorage, identity.user);
          await publish(identity.user, identity.kind !== 'verified');
        } else if (identity.kind === 'invalid') await clearLocal(await authStorage.getItemAsync('userId'));
        else { mode(true); setUser(null); setTeam(null); }

      } catch { if (version === generation.current) { mode(true); setUser(null); setTeam(null); } } finally { refreshing.current = null; setLoading(false); }
    })();
    refreshing.current = task; return task;
  };
  useEffect(() => {
    apiClient.setReadOnlySession(true);
    const offInvalid = apiClient.onAuthInvalid(id => { void clearLocal(id); });
    const offNetwork = apiClient.onNetworkStatusChange(online => { if (online && readOnlyRef.current && !refreshing.current) void refreshAuth(); });
    const app = AppState.addEventListener('change', state => { if (state === 'active' && readOnlyRef.current) void refreshAuth(); });
    void refreshAuth();
    return () => { offInvalid(); offNetwork(); app.remove(); };
  }, []);
  useEffect(() => {
    if (loading) return;
    let active = true;
    const inAuth = segments[0] === '(auth)', invitation = segments[0] === 'teams' && (segments as string[])[1] === 'accept';
    if (!user && !inAuth && !invitation) router.replace('/(auth)/login');
    else if (user && inAuth && (segments as string[])[1] !== 'action') {
      void postAuthDestination(authStorage).then(path => { if (active) router.replace(path); });
    }
    return () => { active = false; };
  }, [user, loading, segments]);
  const login = async (data: AuthResponse) => {
    const previous = await authStorage.getItemAsync('userId');
    await clearLocal(previous);
    await authStorage.setItemAsync('accessToken', data.accessToken);
    await authStorage.setItemAsync('refreshToken', data.refreshToken);
    await authStorage.setItemAsync('userId', data.user.id);
    await saveOfflineIdentity(authStorage, data.user); await publish(data.user, false);
  };
  const logout = async (allDevices = false) => {
    if (allDevices) { const res = await apiClient.request('/auth/logout-all', { method: 'POST', body: '{}' }); if (!res.success) throw new Error(res.error?.message || 'Could not revoke sessions'); }
    const refreshToken = await authStorage.getItemAsync('refreshToken');
    await unregisterCurrentDevice();
    await clearLocal(user?.id ?? await authStorage.getItemAsync('userId'));
    if (refreshToken) await apiClient.request('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) });
    for (const key of ['accessToken', 'refreshToken', 'userId', 'activeTeamId', 'selectedTeamId']) await authStorage.deleteItemAsync(key);
  };
  const setActiveTeamId = async (id: string | null) => {
    if (!user) return; setTeam(id);
    if (id) await authStorage.setItemAsync(selectedTeamKey(user.id), id); else await authStorage.deleteItemAsync(selectedTeamKey(user.id));
  };
  return <AuthContext.Provider value={{ user, loading, readOnlySession, activeTeamId, setActiveTeamId, login, logout, refreshAuth }}>{children}</AuthContext.Provider>;
}
export function useAuth() { const context = useContext(AuthContext); if (!context) throw new Error('AuthProvider required'); return context; }
