import { User } from '@rota/shared';
import { activateOfflineCache, clearOfflineData, getOfflineTeams, getUpcoming, offlineEpoch, revokeOfflineTeam, saveOfflineTeams, saveUpcoming } from '../../mobile/src/storage/offlineData';
import { clearOfflineIdentity, OFFLINE_LEASE_MS, readOfflineIdentity, restoreSessionIdentity, saveOfflineIdentity } from '../../mobile/src/storage/offlineSession';
import { loadUpcoming } from '../../mobile/src/query/upcoming';
import type { Shift } from '../../mobile/src/api/shifts';
jest.mock('../../mobile/src/api/shifts', () => ({ fetchShifts: jest.fn() }));
const mockFiles = new Map<string, string>();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///phase2/', getInfoAsync: async (path: string) => ({ exists: mockFiles.has(path) || path.endsWith('/') }),
  makeDirectoryAsync: async () => {}, writeAsStringAsync: async (path: string, value: string) => { mockFiles.set(path, value); },
  readAsStringAsync: async (path: string) => mockFiles.get(path), deleteAsync: async (path: string) => { mockFiles.delete(path); },
  readDirectoryAsync: async (path: string) => [...mockFiles.keys()].filter(key => key.startsWith(path)).map(key => key.slice(path.length)),
}), { virtual: true });
const user: User = { id: '10000000-0000-4000-8000-000000000001', email: 'staff@example.test', firstName: 'Offline', lastName: 'User', createdAt: '2026-11-09T00:00:00Z' };
const team = '10000000-0000-4000-8000-000000000002';
const credentials = new Map<string, string>();
const store = { getItemAsync: async (key: string) => credentials.get(key) ?? null, setItemAsync: async (key: string, value: string) => { credentials.set(key, value); }, deleteItemAsync: async (key: string) => { credentials.delete(key); } };
const shift = (id = 'shift', teamId = team): Shift => ({ id, teamId, title: id, description: null, status: 'ACTIVE', startsAt: '2027-01-01T09:00:00Z', endsAt: '2027-01-01T17:00:00Z', createdAt: '', updatedAt: '', createdBy: user.id });
beforeEach(async () => { credentials.clear(); credentials.set('userId', user.id); credentials.set('refreshToken', 'dummy-opaque-token'); activateOfflineCache(user.id); await clearOfflineData(user.id); });
it('restores a previously verified identity during a transport outage without needing a current access JWT', async () => {
  await saveOfflineIdentity(store, user);
  const me = jest.fn(); const result = await restoreSessionIdentity(store, { refresh: async () => 'offline', me });
  expect(result).toEqual({ user, kind: 'offline' }); expect(me).not.toHaveBeenCalled();
});
it('rejects expired local leases, missing credentials, mismatched accounts and clock rollback', async () => {
  const now = Date.now(); await saveOfflineIdentity(store, user, now);
  expect(await readOfflineIdentity(store, now + OFFLINE_LEASE_MS)).toBeNull();
  expect(await readOfflineIdentity(store, now - 1)).toBeNull();
  credentials.set('userId', 'other'); expect(await readOfflineIdentity(store, now)).toBeNull();
  credentials.set('userId', user.id); credentials.delete('refreshToken'); expect(await readOfflineIdentity(store, now)).toBeNull();
});
it('never restores offline data following known session revocation', async () => {
  await saveOfflineIdentity(store, user);
  expect(await restoreSessionIdentity(store, { refresh: async () => 'invalid', me: jest.fn() })).toEqual({ user: null, kind: 'invalid' });
  await clearOfflineIdentity(store); expect(await readOfflineIdentity(store)).toBeNull();
});
it('requires a successful authoritative profile before returning verified mode', async () => {
  expect(await restoreSessionIdentity(store, { refresh: async () => 'success', me: async () => ({ success: true, data: user }) })).toEqual({ user, kind: 'verified' });
  expect(await restoreSessionIdentity(store, { refresh: async () => 'success', me: async () => ({ success: false, error: { code: 'UNAUTHORIZED', message: 'revoked' } }) })).toEqual({ user: null, kind: 'invalid' });
});
it('persists assigned-only upcoming pages together and retains server empty responses', async () => {
  const fetch = jest.fn().mockResolvedValueOnce({ items: [shift('a')], nextCursor: 'next', hasMore: true }).mockResolvedValueOnce({ items: [shift('b')], nextCursor: null, hasMore: false });
  await loadUpcoming(user.id, team, fetch);
  expect(fetch.mock.calls[0][1]).toMatchObject({ assignedTo: user.id, status: 'ACTIVE', limit: 100 });
  expect(fetch.mock.calls[1][1]).toMatchObject({ cursor: 'next' });
  expect((await getUpcoming(user.id, team))?.items.map(s => s.id)).toEqual(['a', 'b']);
  await loadUpcoming(user.id, team, async () => ({ items: [], nextCursor: null, hasMore: false }));
  expect((await getUpcoming(user.id, team))?.items).toEqual([]);
});
it('does not replace a complete cache with a failed or repeated-cursor partial page', async () => {
  await saveUpcoming(user.id, team, [shift('original')]);
  const fetch = jest.fn().mockResolvedValue({ items: [shift('partial')], nextCursor: 'same', hasMore: true });
  await expect(loadUpcoming(user.id, team, fetch)).rejects.toThrow('repeated cursor');
  expect((await getUpcoming(user.id, team))?.items[0].id).toBe('original');
});
it('isolates users/teams, rejects foreign-team rows and filters elapsed shifts', async () => {
  await saveUpcoming(user.id, team, [shift(), shift('foreign', 'other-team'), { ...shift('past'), startsAt: '2020-01-01T00:00:00Z' }]);
  expect((await getUpcoming(user.id, team))?.items.map(s => s.id)).toEqual(['shift']);
  expect(await getUpcoming('other-user', team)).toBeNull(); expect(await getUpcoming(user.id, 'other-team')).toBeNull();
});
it('reads saved shifts and teams after the repository and its memory cache restart', async () => {
  await saveUpcoming(user.id, team, [shift()]);
  await saveOfflineTeams(user.id, [{ id: team, name: 'Team', ownerId: user.id, createdAt: '2026-11-09T00:00:00Z' }]);
  jest.resetModules();
  const restarted: typeof import('../../mobile/src/storage/offlineData') = require('../../mobile/src/storage/offlineData');
  restarted.activateOfflineCache(user.id);
  expect((await restarted.getUpcoming(user.id, team))?.items).toHaveLength(1); expect(await restarted.getOfflineTeams(user.id)).toHaveLength(1);
});
it('clears revoked-team data while retaining other teams and rejects writes from an old session', async () => {
  await saveUpcoming(user.id, team, [shift()]); await saveUpcoming(user.id, 'other-team', [shift('other', 'other-team')]);
  const epoch = offlineEpoch(); await clearOfflineData(user.id, team);
  await saveUpcoming(user.id, team, [shift('late')], epoch);
  expect(await getUpcoming(user.id, team)).toBeNull(); expect((await getUpcoming(user.id, 'other-team'))?.items).toHaveLength(1);
});
it('logout clears files and prevents a late fetch from repopulating them', async () => {
  await saveUpcoming(user.id, team, [shift()]); const epoch = offlineEpoch();
  activateOfflineCache(null); await clearOfflineData(user.id); await saveUpcoming(user.id, team, [shift('late')], epoch);
  activateOfflineCache(user.id); expect(await getUpcoming(user.id, team)).toBeNull(); expect(await getOfflineTeams(user.id)).toEqual([]);
  expect([...mockFiles.values()].join('')).not.toContain('dummy-opaque-token');
});
it('persists a revoked-team tombstone even if the saved team directory was stale', async () => {
  const directory = [{ id: team, name: 'Team', ownerId: user.id, createdAt: '2026-11-09T00:00:00Z' }];
  await saveOfflineTeams(user.id, directory); await saveUpcoming(user.id, team, [shift()]);
  await revokeOfflineTeam(user.id, team);
  activateOfflineCache(user.id); expect(await getOfflineTeams(user.id)).toEqual([]); expect(await getUpcoming(user.id, team)).toBeNull();
  // Only a verified server directory may restore a membership.
  await saveOfflineTeams(user.id, directory); expect(await getOfflineTeams(user.id)).toHaveLength(1);
});
