import { Team } from '@rota/shared';
import type { Shift } from '../api/shifts';
import { AsyncStorage } from './asyncStorage';

let activeUser: string | null = null, generation = 0;
let writes: Promise<unknown> = Promise.resolve();
export const activateOfflineCache = (id: string | null) => { activeUser = id; generation++; };
export const offlineEpoch = () => generation;
export const offlineSessionCurrent = (id: string, epoch: number) => activeUser === id && generation === epoch;
const key = (user: string, resource: string) => `offline_v1:${user}:${resource}`;
export interface UpcomingSnapshot { userId: string; teamId: string; cachedAt: number; items: Shift[] }
async function write(user: string, resource: string, value: unknown, epoch: number) {
  const pending = writes.catch(() => {}).then(async () => {
    if (activeUser === user && generation === epoch) await AsyncStorage.setItem(key(user, resource), JSON.stringify(value));
  });
  writes = pending; await pending;
}
export async function saveOfflineTeams(userId: string, teams: Team[], epoch = generation) {
  await write(userId, 'teams', { userId, teams }, epoch);
  if (activeUser === userId && epoch === generation) await Promise.all(teams.map(t => AsyncStorage.removeItem(key(userId, `revoked:${t.id}`))));
}
export async function getOfflineTeams(userId: string): Promise<Team[]> {
  if (activeUser !== userId) return [];
  try {
    const raw = await AsyncStorage.getItem(key(userId, 'teams')); const value = raw ? JSON.parse(raw) : null;
    if (value?.userId !== userId || !Array.isArray(value.teams)) return [];
    const allowed = await Promise.all((value.teams as Team[]).map(async t => await AsyncStorage.getItem(key(userId, `revoked:${t.id}`)) ? null : t));
    return allowed.filter((t): t is Team => t !== null);
  } catch { return []; }
}
export async function saveUpcoming(userId: string, teamId: string, items: Shift[], epoch = generation): Promise<UpcomingSnapshot> {
  // List rows lack assignments; only the assignedTo query may call this writer.
  const value = { userId, teamId, cachedAt: Date.now(), items: items.filter(s => s.teamId === teamId && s.status === 'ACTIVE') };
  await write(userId, `upcoming:${teamId}`, value, epoch); return value;
}
export async function getUpcoming(userId: string, teamId: string, now = Date.now()): Promise<UpcomingSnapshot | null> {
  if (activeUser !== userId) return null;
  try {
    if (await AsyncStorage.getItem(key(userId, `revoked:${teamId}`))) return null;
    const raw = await AsyncStorage.getItem(key(userId, `upcoming:${teamId}`)); const value = raw ? JSON.parse(raw) : null;
    if (value?.userId !== userId || value?.teamId !== teamId || !Array.isArray(value.items) || !Number.isFinite(value.cachedAt)) return null;
    return { ...value, items: value.items.filter((s: Shift) => s.teamId === teamId && s.status === 'ACTIVE' && Date.parse(s.startsAt) >= now) };
  } catch { return null; }
}
export async function clearOfflineData(userId: string, teamId?: string) {
  generation++;
  await writes.catch(() => {});
  const keys = await AsyncStorage.getAllKeys();
  const exact = key(userId, `upcoming:${teamId}`);
  await Promise.all(keys.filter(k => teamId ? k === exact : k.startsWith(`offline_v1:${userId}:`)).map(k => AsyncStorage.removeItem(k)));
}
export async function revokeOfflineTeam(userId: string, teamId: string) {
  await clearOfflineData(userId, teamId);
  await write(userId, `revoked:${teamId}`, true, generation);
}
