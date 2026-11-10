import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useAuth } from './AuthContext';
import { useTeam } from './TeamContext';
import { queryClient } from '../query/queryClient';
import {
  registerForPushNotificationsAsync,
  handleNotificationPayload,
} from '../services/pushNotifications';

interface NotificationContextValue {
  pushToken: string | null;
  isRegistered: boolean;
}

const NotificationContext = createContext<NotificationContextValue>({
  pushToken: null,
  isRegistered: false,
});

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const { user, readOnlySession } = useAuth();
  const { selectTeam } = useTeam();
  const selectTeamRef=useRef(selectTeam);
  selectTeamRef.current=selectTeam;
  const [pushToken, setPushToken] = useState<string | null>(null);
  const [isRegistered, setIsRegistered] = useState(false);

  const foregroundSubRef = useRef<{ remove: () => void } | null>(null);
  const responseSubRef = useRef<{ remove: () => void } | null>(null);

  useEffect(() => {
    // Unsupported on web: prevent Expo push notification listeners from registering on web
    if (Platform.OS === 'web') {
      setPushToken(null);
      setIsRegistered(false);
      return;
    }

    if (!user?.id || readOnlySession) {
      setPushToken(null);
      setIsRegistered(false);
      return;
    }

    let isMounted = true;

    // 1. Register for push notifications after authentication
    registerForPushNotificationsAsync(user.id).then((token) => {
      if (isMounted && token) {
        setPushToken(token);
        setIsRegistered(true);
      }
    });

    // 2. Set up foreground notification listener (refreshes queries on arrival)
    try {
      foregroundSubRef.current = Notifications.addNotificationReceivedListener(() => {
        // Automatically refresh active queries so the schedule/swaps update
        queryClient.invalidateQueries({ queryKey: ['shifts'] });
        queryClient.invalidateQueries({ queryKey: ['swaps'] });
        queryClient.invalidateQueries({ queryKey: ['swap-request'] });
        queryClient.invalidateQueries({ queryKey: ['activity'] });
      });
    } catch {
      console.warn('[push] Operation unavailable');
    }

    // 3. Set up notification response listener (user tapped notification)
    try {
      responseSubRef.current = Notifications.addNotificationResponseReceivedListener(
        (response) => {
          const data = response.notification.request.content.data;
          void handleNotificationPayload(data,selectTeamRef.current);
        }
      );
    } catch {
      console.warn('[push] Operation unavailable');
    }

    // 4. Handle cold launch from a notification (terminated state)
    try {
      Notifications.getLastNotificationResponseAsync().then((response) => {
        if (response && isMounted) {
          const data = response.notification.request.content.data;
          void handleNotificationPayload(data,selectTeamRef.current);
        }
      });
    } catch {
      console.warn('[push] Operation unavailable');
    }

    // Clean up listeners on user change or unmount to avoid duplicates
    return () => {
      isMounted = false;
      if (foregroundSubRef.current) {
        foregroundSubRef.current.remove();
        foregroundSubRef.current = null;
      }
      if (responseSubRef.current) {
        responseSubRef.current.remove();
        responseSubRef.current = null;
      }
    };
  }, [user?.id, readOnlySession]);

  return (
    <NotificationContext.Provider value={{ pushToken, isRegistered }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
