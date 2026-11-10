import { ApiResponse, User, UserSchema } from '@rota/shared';
import type { IAuthStorage } from './authStorage';

export const OFFLINE_LEASE_MS = 24 * 60 * 60 * 1000;
const KEY = 'offlineSessionV1';
export async function saveOfflineIdentity(store: IAuthStorage, user: User, now = Date.now()) {
  await store.setItemAsync(KEY, JSON.stringify({ user, verifiedAt: now }));
}
/** A bounded local read lease, never authority for a server request. */
export async function readOfflineIdentity(store: IAuthStorage, now = Date.now()): Promise<User | null> {
  const [raw, id, refresh] = await Promise.all([store.getItemAsync(KEY), store.getItemAsync('userId'), store.getItemAsync('refreshToken')]);
  if (!raw || !id || !refresh) return null;
  try {
    const value = JSON.parse(raw), parsed = UserSchema.safeParse(value.user);
    if (!parsed.success || parsed.data.id !== id || !Number.isFinite(value.verifiedAt) || now < value.verifiedAt || now - value.verifiedAt >= OFFLINE_LEASE_MS) return null;
    return parsed.data;
  } catch { return null; }
}
export const clearOfflineIdentity = (store: IAuthStorage) => store.deleteItemAsync(KEY);
export const selectedTeamKey = (userId: string) => `selectedTeam_${userId}`;

export async function restoreSessionIdentity(store: IAuthStorage, api: {
  refresh: () => Promise<'success' | 'offline' | 'unavailable' | 'invalid'>;
  me: () => Promise<ApiResponse<User>>;
}): Promise<{ user: User | null; kind: 'verified' | 'offline' | 'invalid' | 'unavailable' }> {
  const outcome = await api.refresh();
  if (outcome === 'invalid') return { user: null, kind: 'invalid' };
  const response = outcome === 'success' ? await api.me() : null;
  if (response?.success && response.data) return { user: UserSchema.parse(response.data), kind: 'verified' };
  if (response?.error?.code === 'UNAUTHORIZED') return { user: null, kind: 'invalid' };
  if (outcome === 'offline' || response?.error?.code === 'NETWORK_ERROR') return { user: await readOfflineIdentity(store), kind: 'offline' };
  return { user: null, kind: 'unavailable' };
}
