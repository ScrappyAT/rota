import { apiClient } from './client';
import { ApiResponse } from '@rota/shared';

export interface DeviceTokenRecord {
  token: string;
  platform: 'android' | 'ios' | 'web';
  pushEnabled: boolean;
  lastUsedAt: string;
}

export interface NotificationPreferences {
  shiftAssigned: boolean;
  swapRequested: boolean;
  swapApproved: boolean;
  swapRejected: boolean;
}

/**
 * Registers an Expo push token for the authenticated user.
 * Idempotent per (user, token) on the backend.
 */
export async function registerDevice(
  token: string,
  platform: 'android' | 'ios' | 'web' = 'android'
): Promise<ApiResponse<{ token: string; platform: string; pushEnabled: boolean }>> {
  return apiClient.request('/devices', {
    method: 'POST',
    body: JSON.stringify({ token, platform }),
  });
}

/**
 * Lists the authenticated user's registered device tokens.
 */
export async function listDevices(): Promise<ApiResponse<{ tokens: DeviceTokenRecord[] }>> {
  return apiClient.request<{ tokens: DeviceTokenRecord[] }>('/devices');
}

/**
 * Unregisters a device token on logout or permission revocation.
 */
export async function unregisterDevice(
  token: string
): Promise<ApiResponse<{ unregistered: boolean }>> {
  return apiClient.request<{ unregistered: boolean }>('/devices', {
    method: 'DELETE',
    body: JSON.stringify({ token }),
  });
}

/**
 * Reads the authenticated user's notification preferences.
 */
export async function getNotificationPreferences(): Promise<ApiResponse<NotificationPreferences>> {
  return apiClient.request<NotificationPreferences>('/devices/preferences');
}

/**
 * Partially updates the authenticated user's notification preferences.
 */
export async function updateNotificationPreferences(
  prefs: Partial<NotificationPreferences>
): Promise<ApiResponse<NotificationPreferences>> {
  return apiClient.request<NotificationPreferences>('/devices/preferences', {
    method: 'PATCH',
    body: JSON.stringify(prefs),
  });
}
