import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { apiClient } from '../api/client';
import { queryClient } from '../query/queryClient';

interface NetworkContextType {
  isOffline: boolean;
  checkConnection: () => Promise<boolean>;
}

const NetworkContext = createContext<NetworkContextType>({
  isOffline: false,
  checkConnection: async () => true,
});

export function NetworkProvider({ children }: { children: React.ReactNode }) {
  const [isOffline, setIsOffline] = useState(false);
  const wasOffline = useRef(false);

  const checkConnection = useCallback(async (): Promise<boolean> => {
    try {
      const res = await apiClient.getHealth();
      const online = Boolean(res.success);
      setIsOffline(!online);
      return online;
    } catch {
      setIsOffline(true);
      return false;
    }
  }, []);

  // Listen to live API client network success/failure
  useEffect(() => {
    const unsubscribe = apiClient.onNetworkStatusChange((isOnline) => {
      setIsOffline(!isOnline);
    });
    return unsubscribe;
  }, []);

  // When connection transitions from offline to online, refresh cached queries
  useEffect(() => {
    if (wasOffline.current && !isOffline) {
      // Reconnected! Automatically refresh shifts and shifts cache
      queryClient.invalidateQueries({ queryKey: ['shifts'] });
      queryClient.invalidateQueries({ queryKey: ['shift'] });
      queryClient.invalidateQueries({ queryKey: ['members'] });
    }
    wasOffline.current = isOffline;
  }, [isOffline]);

  // Periodic health check while offline to detect reconnection promptly
  useEffect(() => {
    if (!isOffline) return;

    const interval = setInterval(async () => {
      const online = await checkConnection();
      if (online) {
        clearInterval(interval);
      }
    }, 5000);

    return () => clearInterval(interval);
  }, [isOffline, checkConnection]);

  return (
    <NetworkContext.Provider value={{ isOffline, checkConnection }}>
      {children}
    </NetworkContext.Provider>
  );
}

export function useNetwork() {
  return useContext(NetworkContext);
}
