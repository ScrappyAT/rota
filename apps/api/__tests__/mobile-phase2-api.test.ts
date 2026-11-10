import { apiClient } from '../../mobile/src/api/client';
import { authStorage } from '../../mobile/src/storage/authStorage';
const mockSecure = new Map<string, string>();
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }), { virtual: true });
jest.mock('expo-secure-store', () => ({ getItemAsync: async (key: string) => mockSecure.get(key) ?? null, setItemAsync: async (key: string, value: string) => { mockSecure.set(key, value); }, deleteItemAsync: async (key: string) => { mockSecure.delete(key); } }), { virtual: true });
const response = (status: number, data: unknown) => ({ status, ok: status >= 200 && status < 300, json: async () => data, text: async () => JSON.stringify(data) } as Response);
let fetchMock: jest.SpyInstance;
beforeEach(async () => { mockSecure.clear(); apiClient.setReadOnlySession(false); fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'));  await authStorage.setItemAsync('userId', 'user'); await authStorage.setItemAsync('refreshToken', 'dummy-refresh'); });
afterEach(() => { fetchMock.mockRestore(); });
it('blocks protected reads and writes in restored offline mode without sending a request', async () => {
  apiClient.setReadOnlySession(true); await authStorage.setItemAsync('accessToken', 'expired-access');
  expect((await apiClient.request('/teams')).error?.code).toBe('OFFLINE_READ_ONLY');
  expect((await apiClient.request('/teams/team/shifts', { method: 'POST', body: '{}' })).error?.code).toBe('OFFLINE_READ_ONLY');
  expect(fetchMock).not.toHaveBeenCalled();
});
it('shares one refresh request and stores both rotated credentials through the native adapter', async () => {
  fetchMock.mockResolvedValue(response(200, { success: true, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } }));
  expect(await Promise.all([apiClient.refreshSession(), apiClient.refreshSession()])).toEqual([true, true]);
  expect(fetchMock).toHaveBeenCalledTimes(1); expect(mockSecure.get('refreshToken')).toBe('new-refresh'); expect(mockSecure.get('accessToken')).toBe('new-access');
});
it('keeps credentials on transport failure and marks the outcome offline', async () => {
  fetchMock.mockRejectedValue(new Error('offline')); expect(await apiClient.refreshSession()).toBe(false);
  expect(apiClient.refreshOutcome).toBe('offline'); expect(mockSecure.get('refreshToken')).toBe('dummy-refresh');
});
it('announces server revocation and removes native credentials', async () => {
  const invalid = jest.fn(), off = apiClient.onAuthInvalid(invalid);
  fetchMock.mockResolvedValue(response(401, { success: false })); expect(await apiClient.refreshSession()).toBe(false);
  expect(invalid).toHaveBeenCalledWith('user'); expect(mockSecure.has('refreshToken')).toBe(false); off();
});
it('does not overwrite a newly logged-in account with an old refresh response', async () => {
  let finish!: (response: Response) => void; fetchMock.mockImplementation(() => new Promise<Response>(resolve => { finish = resolve; }));
  const pending = apiClient.refreshSession(); while (!finish) await new Promise(resolve => setImmediate(resolve));
  await authStorage.setItemAsync('userId', 'new-user'); await authStorage.setItemAsync('refreshToken', 'new-account-token');
  finish(response(200, { success: true, data: { accessToken: 'old-user-access', refreshToken: 'old-user-refresh' } }));
  expect(await pending).toBe(false); expect(mockSecure.get('refreshToken')).toBe('new-account-token');
});
it('purges a team only on an authoritative missing-membership response', async () => {
  const lost = jest.fn(), off = apiClient.onTeamAccessLost(lost), team = '10000000-0000-4000-8000-000000000002';
  fetchMock.mockResolvedValueOnce(response(404, { success: false, error: { code: 'NOT_FOUND', message: 'Team not found' } }));
  await apiClient.request(`/teams/${team}/shifts`); expect(lost).toHaveBeenCalledWith(team);
  lost.mockClear(); fetchMock.mockResolvedValueOnce(response(403, { success: false, error: { code: 'FORBIDDEN', message: 'Insufficient permissions' } }));
  await apiClient.request(`/teams/${team}/shifts`, { method: 'POST' }); expect(lost).not.toHaveBeenCalled(); off();
});
it('bounds a stalled request so cold offline startup cannot hang indefinitely', async () => {
  jest.useFakeTimers();
  try {
    fetchMock.mockImplementation((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = apiClient.request('/health');
    await jest.advanceTimersByTimeAsync(8000);
    expect((await pending).error?.code).toBe('NETWORK_ERROR'); expect(jest.getTimerCount()).toBe(0);
  } finally { jest.useRealTimers(); }
});
