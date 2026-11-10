import { notificationTarget,Team } from '@rota/shared';
import { apiClient } from '../api/client';
import { dataOrThrow } from '../api/ensure';
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { authStorage } from '../storage/authStorage';
import { AsyncStorage } from '../storage/asyncStorage';
import { registerDevice, unregisterDevice } from '../api/devices';
import { router,Href } from 'expo-router';

// Default EAS Project ID from app.json
const FALLBACK_PROJECT_ID = '8294edea-eb20-41b3-b9f3-154b44593873';

// Configure foreground notification behavior (native only; unsupported on web without service worker)
if (Platform.OS !== 'web') {
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
  } catch {
    console.warn('[push] Operation unavailable');
  }
}

/**
 * Configure Android notification channels for shifts and swaps using the system default sound.
 */
export async function setupNotificationChannels(): Promise<void> {
  if (Platform.OS !== 'android') return;

  try {
    // If the 'shifts' channel was previously created with an invalid custom sound,
    // delete it so it can be recreated cleanly with the Android system default sound.
    try {
      const existingShifts = await Notifications.getNotificationChannelAsync('shifts');
      if (existingShifts && existingShifts.sound === 'custom') {
        await Notifications.deleteNotificationChannelAsync('shifts');
      }
    } catch {
      // Best-effort channel migration check
    }

    await Notifications.setNotificationChannelAsync('default', {
      name: 'General',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0052CC',
    });

    await Notifications.setNotificationChannelAsync('shifts', {
      name: 'Shifts & Swaps',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#0052CC',
    });
  } catch {
    console.warn('[push] Operation unavailable');
  }
}

/**
 * Request notification permissions and register the Expo push token with the backend.
 * Idempotent: Skips re-registration if the token is already registered for this user.
 * Never logs full push tokens.
 */
export async function registerForPushNotificationsAsync(userId: string): Promise<string | null> {
  if (!userId) return null;
  if (Platform.OS === 'web') return null;

  try {
    // 1. Android notification channels
    await setupNotificationChannels();

    // 2. Permission check & request
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;

    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }

    if (finalStatus !== 'granted') {
      console.warn('[push] Operation unavailable');
      return null;
    }

    // 3. Resolve EAS Project ID
    const projectId =
      Constants.expoConfig?.extra?.eas?.projectId ??
      Constants.easConfig?.projectId ??
      FALLBACK_PROJECT_ID;

    // 4. Obtain Expo Push Token
    const tokenResponse = await Notifications.getExpoPushTokenAsync({
      projectId,
    });
    const token = tokenResponse.data;

    if (!token) {
      console.warn('[push] No push token returned from Expo');
      return null;
    }

    // 5. Check if already registered for this user
    const cacheKey = `push_token:${userId}:device`;
    const cachedToken = await AsyncStorage.getItem(cacheKey);

    if (cachedToken === token) {
      // Already registered with backend for this user session
      return token;
    }

    // 6. Register with backend
    const platform =
      Platform.OS === 'android' ? 'android' : Platform.OS === 'ios' ? 'ios' : 'web';

    const res = await registerDevice(token, platform);

    if (res.success) {
      await AsyncStorage.setItem(cacheKey, token);
      await authStorage.setItemAsync('devicePushToken', token);
      console.warn('[push] Operation unavailable');
    } else {
      console.warn('[push] Operation unavailable');
    }

    return token;
  } catch {
    // Graceful handling for missing native modules or network failures
    console.warn('[push] Operation unavailable');
    return null;
  }
}

/**
 * Unregisters the current device push token on user logout.
 * Never logs full push tokens.
 */
export async function unregisterCurrentDevice(): Promise<void> {
  try {
    const token = await authStorage.getItemAsync('devicePushToken');
    if (token) {
      console.warn('[push] Operation unavailable');
      await unregisterDevice(token);
      await authStorage.deleteItemAsync('devicePushToken');
    }
  } catch {
    console.warn('[push] Device cleanup unavailable');
  }
}

/**
 * Validates notification payload and navigates to the relevant screen.
 */
export async function handleNotificationPayload(data: unknown, selectTeam: (teamId:string)=>Promise<void>): Promise<void> {
  const target=notificationTarget(data); if(!target)return;
  try {
    // Membership is checked before switching context or navigating to another team.
    dataOrThrow(await apiClient.request<Team>(`/teams/${target.teamId}`));
    await selectTeam(target.teamId);
    router.push({pathname:target.path,params:target.params} as Href);
  }catch{console.warn('[push] Notification destination is unavailable');}
}
