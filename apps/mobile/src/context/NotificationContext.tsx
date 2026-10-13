import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { useAuth } from './AuthContext';
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
  const { user } = useAuth();
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

    if (!user?.id) {
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
        queryClient.invalidateQueries({ queryKey: ['activity'] });
      });
    } catch (err) {
      console.warn('[push] Failed to add foreground notification listener:', err);
    }

    // 3. Set up notification response listener (user tapped notification)
    try {
      responseSubRef.current = Notifications.addNotificationResponseReceivedListener(
        (response) => {
          const data = response.notification.request.content.data;
          handleNotificationPayload(data);
        }
      );
    } catch (err) {
      console.warn('[push] Failed to add notification response listener:', err);
    }

    // 4. Handle cold launch from a notification (terminated state)
    try {
      Notifications.getLastNotificationResponseAsync().then((response) => {
        if (response && isMounted) {
          const data = response.notification.request.content.data;
          handleNotificationPayload(data);
        }
      });
    } catch (err) {
      console.warn('[push] Failed to check last notification response:', err);
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
  }, [user?.id]);

  return (
    <NotificationContext.Provider value={{ pushToken, isRegistered }}>
      {children}
    </NotificationContext.Provider>
  );
}

export function useNotifications() {
  return useContext(NotificationContext);
}
