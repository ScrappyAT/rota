import {
  saveCachedShifts,
  getCachedShifts,
  saveCachedShiftDetail,
  getCachedShiftDetail,
  saveCachedMembers,
  getCachedMembers,
  clearUserCache,
  clearAllShiftCache,
} from '../src/storage/shiftCache';
import { AsyncStorage } from '../src/storage/asyncStorage';
import { Shift } from '../src/api/shifts';
import { Member } from '../src/api/members';

const dummyShift1: Shift = {
  id: 'shift-1',
  teamId: 'team-alpha',
  createdBy: 'user-1',
  title: 'Morning Shift',
  description: 'Front desk',
  startsAt: '2026-10-12T08:00:00Z',
  endsAt: '2026-10-12T16:00:00Z',
  status: 'ACTIVE',
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
  assignments: [
    {
      shiftId: 'shift-1',
      userId: 'user-1',
      assignedBy: 'user-1',
      createdAt: '2026-10-11T00:00:00Z',
      firstName: 'Alice',
      lastName: 'Smith',
    },
  ],
};

const dummyShift2: Shift = {
  id: 'shift-2',
  teamId: 'team-alpha',
  createdBy: 'user-1',
  title: 'Evening Shift',
  description: null,
  startsAt: '2026-10-12T16:00:00Z',
  endsAt: '2026-10-13T00:00:00Z',
  status: 'ACTIVE',
  createdAt: '2026-10-11T00:00:00Z',
  updatedAt: '2026-10-11T00:00:00Z',
};

const dummyMembers: Member[] = [
  {
    id: 'mem-1',
    teamId: 'team-alpha',
    userId: 'user-1',
    role: 'OWNER',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Smith',
  },
  {
    id: 'mem-2',
    teamId: 'team-alpha',
    userId: 'user-2',
    role: 'STAFF',
    email: 'bob@example.com',
    firstName: 'Bob',
    lastName: 'Jones',
  },
];

async function runTests() {
  console.log('--- Starting Shift Cache & Isolation Tests ---');

  // 1. Reset storage
  await clearAllShiftCache();
  console.log('✔ Storage reset clean');

  // 2. Test AsyncStorage basic primitives
  await AsyncStorage.setItem('test_key', 'hello_world');
  const stored = await AsyncStorage.getItem('test_key');
  if (stored !== 'hello_world') throw new Error(`AsyncStorage getItem mismatch: expected hello_world, got ${stored}`);
  await AsyncStorage.removeItem('test_key');
  const deleted = await AsyncStorage.getItem('test_key');
  if (deleted !== null) throw new Error('AsyncStorage removeItem failed');
  console.log('✔ AsyncStorage basic primitives working');

  // 3. Test Shift Caching and Retrieval
  await saveCachedShifts('user-1', 'team-alpha', [dummyShift1, dummyShift2], 'cursor-123');
  const cachedShifts = await getCachedShifts('user-1', 'team-alpha');
  if (!cachedShifts || cachedShifts.items.length !== 2) {
    throw new Error('Failed to retrieve cached shifts for user-1');
  }
  if (cachedShifts.items[0].id !== 'shift-1' || cachedShifts.items[1].id !== 'shift-2') {
    throw new Error('Cached shift items mismatch');
  }
  if (cachedShifts.nextCursor !== 'cursor-123') {
    throw new Error('Cached nextCursor mismatch');
  }
  console.log('✔ Shift list caching & retrieval verified');

  // 4. Test User Isolation (user-2 cannot see user-1's cached shifts)
  const user2Shifts = await getCachedShifts('user-2', 'team-alpha');
  if (user2Shifts !== null) {
    throw new Error('User isolation breach: user-2 retrieved user-1 cached shifts');
  }
  console.log('✔ User isolation verified: user-2 cannot access user-1 cache');

  // 5. Test Team Isolation (user-1 cannot see team-beta shifts from team-alpha cache)
  const teamBetaShifts = await getCachedShifts('user-1', 'team-beta');
  if (teamBetaShifts !== null) {
    throw new Error('Team isolation breach: retrieved shifts for un-cached team-beta');
  }
  console.log('✔ Team isolation verified: team-alpha cache does not leak to team-beta');

  // 6. Test Individual Shift Detail Auto-caching
  const cachedDetail1 = await getCachedShiftDetail('user-1', 'team-alpha', 'shift-1');
  if (!cachedDetail1 || cachedDetail1.title !== 'Morning Shift') {
    throw new Error('Pre-cached individual shift detail not found or mismatched');
  }
  console.log('✔ Individual shift detail auto-caching verified');

  // 7. Test Member Caching
  await saveCachedMembers('user-1', 'team-alpha', dummyMembers);
  const cachedMems = await getCachedMembers('user-1', 'team-alpha');
  if (!cachedMems || cachedMems.length !== 2 || cachedMems[0].firstName !== 'Alice') {
    throw new Error('Cached members mismatch');
  }
  console.log('✔ Member caching & offline fallback verified');

  // 8. Test Logout Cache Purge
  // Save data for user-2 as well
  await saveCachedShifts('user-2', 'team-alpha', [dummyShift2]);

  // Now simulate user-1 logout
  await clearUserCache('user-1');

  const user1AfterLogout = await getCachedShifts('user-1', 'team-alpha');
  const user1DetailAfterLogout = await getCachedShiftDetail('user-1', 'team-alpha', 'shift-1');
  if (user1AfterLogout !== null || user1DetailAfterLogout !== null) {
    throw new Error('User-1 cache not purged after logout');
  }

  // Ensure user-2 data was NOT affected by user-1 logout
  const user2AfterLogout = await getCachedShifts('user-2', 'team-alpha');
  if (!user2AfterLogout || user2AfterLogout.items.length !== 1) {
    throw new Error('User-2 cache was improperly purged when user-1 logged out');
  }
  console.log('✔ Logout cache eviction verified: user-1 purged while user-2 preserved');

  console.log('--- ALL CACHE ISOLATION AND OFFLINE TESTS PASSED ---');
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});

export { runTests };
