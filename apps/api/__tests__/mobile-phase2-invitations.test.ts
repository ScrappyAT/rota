import { invitationFromParams, invitationLink, postAuthDestination, readInvitation, redeemAndSelect, saveInvitation } from '../../mobile/src/services/invitationLinks';
const team = '10000000-0000-4000-8000-000000000001';
const memory = new Map<string, string>();
const store = { getItemAsync: async (key: string) => memory.get(key) ?? null, setItemAsync: async (key: string, value: string) => { memory.set(key, value); }, deleteItemAsync: async (key: string) => { memory.delete(key); } };
beforeEach(() => memory.clear());
it('makes a shareable link using the existing code, preserving leading zeros', () => {
  const url = new URL(invitationLink('012345', 'staff+one@example.test', '2026-11-09T10:00:00Z'));
  expect(url.protocol).toBe('rota:'); expect(url.pathname).toBe('/teams/accept'); expect(url.searchParams.get('code')).toBe('012345'); expect(url.searchParams.get('email')).toBe('staff+one@example.test');
});
it('retains the pending invitation through registration/login and app restart', async () => {
  const pending = invitationFromParams({ code: '012345', email: 'staff@example.test' })!;
  await saveInvitation(store, pending); await store.setItemAsync('accessToken', 'dummy-login-token');
  expect(await postAuthDestination(store)).toBe('/teams/accept'); expect(await readInvitation(store)).toEqual(pending);
});
it.each([{ code: ['123456', '654321'] }, { code: '../auth' }, { code: '12345' }, { code: '123456', email: 'bad' }, { code: '123456', expiresAt: 'invalid' }])('rejects malformed or ambiguous link params %#', params => expect(invitationFromParams(params)).toBeNull());
it('redeems once, refreshes memberships, selects the server-confirmed team and clears the link', async () => {
  const pending = invitationFromParams({ code: '123456' })!; await saveInvitation(store, pending);
  const calls: string[] = [];
  await redeemAndSelect(store, pending, { redeem: async code => { calls.push(code); return { teamId: team }; }, refresh: async () => { calls.push('refresh'); }, select: async id => { calls.push(id); } });
  expect(calls).toEqual(['123456', 'refresh', team]); expect(await readInvitation(store)).toBeNull(); expect(await postAuthDestination(store)).toBe('/');
});
it('retries team synchronization after an accepted invitation without redeeming again', async () => {
  const pending = invitationFromParams({ code: '123456' })!, redeem = jest.fn(async () => ({ teamId: team }));
  await expect(redeemAndSelect(store, pending, { redeem, refresh: async () => { throw new Error('offline'); }, select: async () => {} })).rejects.toThrow('offline');
  const saved = (await readInvitation(store))!; expect(saved.acceptedTeamId).toBe(team);
  const select = jest.fn(async () => {}); await redeemAndSelect(store, saved, { redeem, refresh: async () => {}, select });
  expect(redeem).toHaveBeenCalledTimes(1); expect(select).toHaveBeenCalledWith(team);
});
it('does not refresh or select on a rejected invitation', async () => {
  const refresh = jest.fn(), select = jest.fn();
  await expect(redeemAndSelect(store, invitationFromParams({ code: '123456' })!, { redeem: async () => { throw new Error('Email mismatch'); }, refresh, select })).rejects.toThrow('Email mismatch');
  expect(refresh).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});
