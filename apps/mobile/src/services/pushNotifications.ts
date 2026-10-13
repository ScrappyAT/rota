import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { authStorage } from '../storage/authStorage';
import { AsyncStorage } from '../storage/asyncStorage';
import { registerDevice, unregisterDevice } from '../api/devices';
import { router } from 'expo-router';

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
  } catch (err) {
    console.warn('[push] Failed to set notification handler:', err);
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
  } catch (err) {
    console.warn('[push] Failed to set notification channels:', err);
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
      console.log(`[push] Notification permission not granted (status: ${finalStatus})`);
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

    const maskedToken = token.length > 12 ? `${token.slice(0, 10)}...` : '***';

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
      console.log(`[push] Registered device token: ${maskedToken} (platform: ${platform})`);
    } else {
      console.warn(`[push] Backend registration failed:`, res.error?.message);
    }

    return token;
  } catch (err) {
    // Graceful handling for missing native modules or network failures
    const message = err instanceof Error ? err.message : String(err);
    console.warn('[push] Push notification setup unavailable:', message);
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
      const maskedToken = token.length > 12 ? `${token.slice(0, 10)}...` : '***';
      console.log(`[push] Unregistering device token: ${maskedToken}`);
      await unregisterDevice(token);
      await authStorage.deleteItemAsync('devicePushToken');
    }
  } catch (err) {
    console.warn(
      '[push] Unregister device token failed (best-effort):',
      err instanceof Error ? err.message : String(err)
    );
  }
}

/**
 * Validates notification payload and navigates to the relevant screen.
 */
export function handleNotificationPayload(data: unknown): void {
  if (!data || typeof data !== 'object') return;

  const payload = data as Record<string, unknown>;
  const event = typeof payload.event === 'string' ? payload.event : '';
  const shiftId = typeof payload.shiftId === 'string' ? payload.shiftId : '';

  const isUuid = (val: string): boolean =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

  try {
    if (event === 'shift_assigned' && shiftId && isUuid(shiftId)) {
      router.push(`/shifts/${shiftId}`);
    } else if (
      event === 'swap_requested' ||
      event === 'swap_approved' ||
      event === 'swap_rejected'
    ) {
      router.push('/(tabs)/swaps');
    } else if (shiftId && isUuid(shiftId)) {
      router.push(`/shifts/${shiftId}`);
    }
  } catch (err) {
    console.warn('[push] Navigation on notification failed:', err);
  }
}
