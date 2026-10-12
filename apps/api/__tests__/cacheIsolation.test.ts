/**
 * Focused tests for Mobile Shift Cache Isolation and Security
 *
 * Verifies that the caching key scheme and storage logic maintain strict
 * isolation between authenticated users and teams, and that logout properly evicts
 * user data.
 */

describe('Mobile Shift Cache Isolation & Security', () => {
  interface ShiftItem {
    id: string;
    teamId: string;
    title: string;
    startsAt: string;
    endsAt: string;
    status: string;
  }

  interface CachedShiftsPayload {
    userId: string;
    teamId: string;
    cachedAt: number;
    items: ShiftItem[];
    nextCursor?: string;
  }

  // Pure mock of the AsyncStorage abstraction
  const store = new Map<string, string>();

  const makeShiftsKey = (userId: string, teamId: string) => `shifts:${userId}:${teamId}`;
  const makeShiftDetailKey = (userId: string, teamId: string, shiftId: string) => `shift_detail:${userId}:${teamId}:${shiftId}`;

  const saveCachedShifts = async (userId: string, teamId: string, items: ShiftItem[], nextCursor?: string) => {
    const payload: CachedShiftsPayload = { userId, teamId, cachedAt: Date.now(), items, nextCursor };
    store.set(makeShiftsKey(userId, teamId), JSON.stringify(payload));
    for (const item of items) {
      store.set(makeShiftDetailKey(userId, teamId, item.id), JSON.stringify(item));
    }
  };

  const getCachedShifts = async (userId: string, teamId: string): Promise<CachedShiftsPayload | null> => {
    const raw = store.get(makeShiftsKey(userId, teamId));
    if (!raw) return null;
    const parsed: CachedShiftsPayload = JSON.parse(raw);
    if (parsed.userId !== userId || parsed.teamId !== teamId) return null;
    return parsed;
  };

  const clearUserCache = async (userId: string) => {
    for (const key of Array.from(store.keys())) {
      if (key.includes(`:${userId}:`)) {
        store.delete(key);
      }
    }
  };

  beforeEach(() => {
    store.clear();
  });

  it('correctly persists and retrieves cached shifts for an authenticated user and team', async () => {
    const shifts: ShiftItem[] = [
      { id: 's1', teamId: 't1', title: 'Morning', startsAt: '2026-10-12T08:00:00Z', endsAt: '2026-10-12T16:00:00Z', status: 'ACTIVE' },
    ];

    await saveCachedShifts('u1', 't1', shifts, 'cursor-1');
    const result = await getCachedShifts('u1', 't1');

    expect(result).not.toBeNull();
    expect(result?.items).toHaveLength(1);
    expect(result?.items[0].title).toBe('Morning');
    expect(result?.nextCursor).toBe('cursor-1');
  });

  it('strictly isolates cache between different users on the same team', async () => {
    const u1Shifts: ShiftItem[] = [
      { id: 's1', teamId: 't1', title: 'User 1 Shift', startsAt: '2026-10-12T08:00:00Z', endsAt: '2026-10-12T16:00:00Z', status: 'ACTIVE' },
    ];

    await saveCachedShifts('u1', 't1', u1Shifts);

    // User 2 queries for their cached shifts on the same team
    const u2Result = await getCachedShifts('u2', 't1');
    expect(u2Result).toBeNull();
  });

  it('strictly isolates cache between different teams for the same user', async () => {
    const t1Shifts: ShiftItem[] = [
      { id: 's1', teamId: 't1', title: 'Team 1 Shift', startsAt: '2026-10-12T08:00:00Z', endsAt: '2026-10-12T16:00:00Z', status: 'ACTIVE' },
    ];

    await saveCachedShifts('u1', 't1', t1Shifts);

    // Querying team 2 should not leak team 1 shifts
    const t2Result = await getCachedShifts('u1', 't2');
    expect(t2Result).toBeNull();
  });

  it('purges all user-specific cache on logout while preserving other users cache', async () => {
    await saveCachedShifts('u1', 't1', [{ id: 's1', teamId: 't1', title: 'Shift 1', startsAt: '', endsAt: '', status: 'ACTIVE' }]);
    await saveCachedShifts('u2', 't1', [{ id: 's2', teamId: 't1', title: 'Shift 2', startsAt: '', endsAt: '', status: 'ACTIVE' }]);

    // User 1 logs out
    await clearUserCache('u1');

    expect(await getCachedShifts('u1', 't1')).toBeNull();
    expect(store.get(makeShiftDetailKey('u1', 't1', 's1'))).toBeUndefined();

    // User 2 cache must remain untouched
    const u2Result = await getCachedShifts('u2', 't1');
    expect(u2Result).not.toBeNull();
    expect(u2Result?.items).toHaveLength(1);
  });
});
