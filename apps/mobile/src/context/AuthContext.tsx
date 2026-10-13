import { createContext, useContext, useEffect, useState } from 'react';
import { authStorage } from '../storage/authStorage';
import { User, AuthResponse } from '@rota/shared';
import { apiClient } from '../api/client';
import { queryClient } from '../query/queryClient';
import { clearUserCache } from '../storage/shiftCache';
import { unregisterCurrentDevice } from '../services/pushNotifications';
import { router, useSegments } from 'expo-router';

interface AuthContextType {
  user: User | null;
  loading: boolean;
  activeTeamId: string | null;
  setActiveTeamId: (id: string | null) => Promise<void>;
  login: (data: AuthResponse) => Promise<void>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [activeTeamId, setActiveTeamIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const segments = useSegments();

  const setActiveTeamId = async (id: string | null) => {
    setActiveTeamIdState(id);
    if (id) {
      await authStorage.setItemAsync('activeTeamId', id);
    } else {
      await authStorage.deleteItemAsync('activeTeamId');
    }
  };

  useEffect(() => {
    refreshAuth();
  }, []);

  useEffect(() => {
    if (loading) return;

    const inAuthGroup = segments[0] === '(auth)';

    if (!user && !inAuthGroup) {
      router.replace('/(auth)/login');
    } else if (user && inAuthGroup) {
      router.replace('/');
    }
  }, [user, loading, segments]);

  const login = async (data: AuthResponse) => {
    setUser(data.user);
    await authStorage.setItemAsync('accessToken', data.accessToken);
    await authStorage.setItemAsync('refreshToken', data.refreshToken);
    await authStorage.setItemAsync('userId', data.user.id);
  };

  const logout = async () => {
    await unregisterCurrentDevice();
    if (user?.id) {
      await clearUserCache(user.id);
    }
    queryClient.clear();

    const refreshToken = await authStorage.getItemAsync('refreshToken');
    if (refreshToken) {
      await apiClient.request('/auth/logout', {
        method: 'POST',
        body: JSON.stringify({ refreshToken }),
      });
    }
    setUser(null);
    setActiveTeamIdState(null);
    await authStorage.deleteItemAsync('accessToken');
    await authStorage.deleteItemAsync('refreshToken');
    await authStorage.deleteItemAsync('userId');
    await authStorage.deleteItemAsync('activeTeamId');
  };

  let isRefreshing = false;

  const refreshAuth = async () => {
    if (isRefreshing) return;
    isRefreshing = true;
    try {
      const refreshToken = await authStorage.getItemAsync('refreshToken');
      const userId = await authStorage.getItemAsync('userId');
      const savedTeamId = await authStorage.getItemAsync('activeTeamId');

      if (savedTeamId) {
        setActiveTeamIdState(savedTeamId);
      }

      if (refreshToken && userId) {
        const res = await apiClient.request<AuthResponse>('/auth/refresh', {
          method: 'POST',
          body: JSON.stringify({ refreshToken, userId }),
        });

        if (res.success && res.data) {
          setUser(res.data.user);
          await authStorage.setItemAsync('accessToken', res.data.accessToken);
          await authStorage.setItemAsync('refreshToken', res.data.refreshToken);
        } else {
          setUser(null);
          await authStorage.deleteItemAsync('accessToken');
          await authStorage.deleteItemAsync('refreshToken');
          await authStorage.deleteItemAsync('userId');
        }
      }
    } catch {
      setUser(null);
    } finally {
      isRefreshing = false;
      setLoading(false);
    }
  };

  return (
    <AuthContext.Provider value={{ user, loading, activeTeamId, setActiveTeamId, login, logout, refreshAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
