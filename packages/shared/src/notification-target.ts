const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export const notificationTarget = (input: unknown): {
  teamId: string;
  path: string;
  params: Record<string, string>;
} | null => {
  if (!input || typeof input !== 'object')
    return null;
  const data = input as Record<string, unknown>;
  if (!uuid(data.teamId))
    return null;
  if (typeof data.event === 'string' && data.event.startsWith('billing_'))
    return { teamId: data.teamId, path: '/subscription', params: { teamId: data.teamId } };
  if (typeof data.event === 'string' && data.event.startsWith('swap_') && uuid(data.swapId))
    return { teamId: data.teamId, path: '/swaps/[swapId]', params: { teamId: data.teamId, swapId: data.swapId } };
  if (uuid(data.shiftId))
    return { teamId: data.teamId, path: '/shifts/[shiftId]', params: { teamId: data.teamId, shiftId: data.shiftId } };
  if (data.event === 'shift_deleted')
    return { teamId: data.teamId, path: '/(tabs)', params: { teamId: data.teamId } };
  return null;
};
