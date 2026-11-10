import type { PaginatedResponse } from '@rota/shared';
import { fetchShifts, Shift, ListOptions } from '../api/shifts';
import { offlineEpoch, saveUpcoming } from '../storage/offlineData';

/** Persist one complete assigned-only result, including an authoritative empty list. */
export async function loadUpcoming(userId: string, teamId: string, fetcher: (team: string, options: ListOptions) => Promise<PaginatedResponse<Shift>> = fetchShifts) {
  const epoch = offlineEpoch(), items: Shift[] = [], cursors = new Set<string>();
  const from = new Date().toISOString(); let cursor: string | undefined;
  do {
    const page = await fetcher(teamId, { assignedTo: userId, status: 'ACTIVE', from, cursor, limit: 100 });
    items.push(...page.items);
    cursor = page.nextCursor ?? undefined;
    if (cursor && cursors.has(cursor)) throw new Error('Upcoming shifts returned a repeated cursor; retry refresh');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return saveUpcoming(userId, teamId, [...new Map(items.map(s => [s.id, s])).values()], epoch);
}
