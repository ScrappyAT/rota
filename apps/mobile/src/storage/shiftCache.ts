import { AsyncStorage } from './asyncStorage';
import { Shift } from '../api/shifts';
import { Member } from '../api/members';

export interface CachedShiftsData {
  userId: string;
  teamId: string;
  cachedAt: number;
  items: Shift[];
  nextCursor?: string;
}

export interface CachedShiftDetail {
  userId: string;
  teamId: string;
  shiftId: string;
  cachedAt: number;
  shift: Shift;
}

export interface CachedMembersData {
  userId: string;
  teamId: string;
  cachedAt: number;
  members: Member[];
}

const SHIFTS_KEY_PREFIX = 'shifts';
const SHIFT_DETAIL_KEY_PREFIX = 'shift_detail';
const MEMBERS_KEY_PREFIX = 'members';

export function makeShiftsKey(userId: string, teamId: string): string {
  return `${SHIFTS_KEY_PREFIX}:${userId}:${teamId}`;
}

export function makeShiftDetailKey(userId: string, teamId: string, shiftId: string): string {
  return `${SHIFT_DETAIL_KEY_PREFIX}:${userId}:${teamId}:${shiftId}`;
}

export function makeMembersKey(userId: string, teamId: string): string {
  return `${MEMBERS_KEY_PREFIX}:${userId}:${teamId}`;
}

/**
 * Save fetched shifts for a given user and team.
 * Also persists each shift individually so detail views work offline.
 */
export async function saveCachedShifts(
  userId: string,
  teamId: string,
  items: Shift[],
  nextCursor?: string
): Promise<void> {
  if (!userId || !teamId) return;

  const payload: CachedShiftsData = {
    userId,
    teamId,
    cachedAt: Date.now(),
    items,
    nextCursor,
  };

  const key = makeShiftsKey(userId, teamId);
  await AsyncStorage.setItem(key, JSON.stringify(payload));

  // Also pre-cache each individual shift for detail views
  await Promise.all(
    items.map((shift) => saveCachedShiftDetail(userId, teamId, shift))
  );
}

/**
 * Retrieve cached shifts for a given user and team.
 */
export async function getCachedShifts(
  userId: string,
  teamId: string
): Promise<CachedShiftsData | null> {
  if (!userId || !teamId) return null;

  const key = makeShiftsKey(userId, teamId);
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;

  try {
    const parsed: CachedShiftsData = JSON.parse(raw);
    // Verify user and team isolation
    if (parsed.userId !== userId || parsed.teamId !== teamId) {
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[shiftCache] Failed to parse cached shifts:', err);
    return null;
  }
}

/**
 * Save an individual shift detail for offline viewing.
 */
export async function saveCachedShiftDetail(
  userId: string,
  teamId: string,
  shift: Shift
): Promise<void> {
  if (!userId || !teamId || !shift?.id) return;

  const payload: CachedShiftDetail = {
    userId,
    teamId,
    shiftId: shift.id,
    cachedAt: Date.now(),
    shift,
  };

  const key = makeShiftDetailKey(userId, teamId, shift.id);
  await AsyncStorage.setItem(key, JSON.stringify(payload));
}

/**
 * Retrieve a cached individual shift.
 */
export async function getCachedShiftDetail(
  userId: string,
  teamId: string,
  shiftId: string
): Promise<Shift | null> {
  if (!userId || !teamId || !shiftId) return null;

  const key = makeShiftDetailKey(userId, teamId, shiftId);
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;

  try {
    const parsed: CachedShiftDetail = JSON.parse(raw);
    if (parsed.userId !== userId || parsed.teamId !== teamId) {
      return null;
    }
    return parsed.shift;
  } catch (err) {
    console.warn('[shiftCache] Failed to parse cached shift detail:', err);
    return null;
  }
}

/**
 * Remove a cached individual shift (e.g. after deletion).
 * Also prunes it from the cached shifts list so it does not reappear offline.
 */
export async function removeCachedShiftDetail(
  userId: string,
  teamId: string,
  shiftId: string
): Promise<void> {
  if (!userId || !teamId || !shiftId) return;

  const key = makeShiftDetailKey(userId, teamId, shiftId);
  await AsyncStorage.removeItem(key);

  const cachedList = await getCachedShifts(userId, teamId);
  if (cachedList && cachedList.items) {
    const filtered = cachedList.items.filter((s) => s.id !== shiftId);
    if (filtered.length !== cachedList.items.length) {
      await saveCachedShifts(userId, teamId, filtered, cachedList.nextCursor);
    }
  }
}

/**
 * Save team members for assignment details offline.
 */
export async function saveCachedMembers(
  userId: string,
  teamId: string,
  members: Member[]
): Promise<void> {
  if (!userId || !teamId) return;

  const payload: CachedMembersData = {
    userId,
    teamId,
    cachedAt: Date.now(),
    members,
  };

  const key = makeMembersKey(userId, teamId);
  await AsyncStorage.setItem(key, JSON.stringify(payload));
}

/**
 * Retrieve cached team members.
 */
export async function getCachedMembers(
  userId: string,
  teamId: string
): Promise<Member[] | null> {
  if (!userId || !teamId) return null;

  const key = makeMembersKey(userId, teamId);
  const raw = await AsyncStorage.getItem(key);
  if (!raw) return null;

  try {
    const parsed: CachedMembersData = JSON.parse(raw);
    if (parsed.userId !== userId || parsed.teamId !== teamId) {
      return null;
    }
    return parsed.members;
  } catch (err) {
    console.warn('[shiftCache] Failed to parse cached members:', err);
    return null;
  }
}

/**
 * Clear all cached shift and member data for a specific user (e.g. on logout or account switch).
 * Strictly guarantees that another user logging in cannot access previous sensitive schedules.
 */
export async function clearUserCache(userId: string): Promise<void> {
  if (!userId) return;

  const allKeys = await AsyncStorage.getAllKeys();
  const userKeys = allKeys.filter((key) => key.includes(`:${userId}:`));

  await Promise.all(userKeys.map((key) => AsyncStorage.removeItem(key)));
}

/**
 * Clear all cache entries (for maintenance or testing).
 */
export async function clearAllShiftCache(): Promise<void> {
  const allKeys = await AsyncStorage.getAllKeys();
  const shiftKeys = allKeys.filter(
    (key) =>
      key.startsWith(`${SHIFTS_KEY_PREFIX}:`) ||
      key.startsWith(`${SHIFT_DETAIL_KEY_PREFIX}:`) ||
      key.startsWith(`${MEMBERS_KEY_PREFIX}:`)
  );

  await Promise.all(shiftKeys.map((key) => AsyncStorage.removeItem(key)));
}
