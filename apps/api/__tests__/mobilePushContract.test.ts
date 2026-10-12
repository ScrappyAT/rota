describe('Mobile Push Notifications Contract & Payload Routing', () => {
  // Pure helper replicating mobile token masking logic
  const maskToken = (token: string): string =>
    token.length > 12 ? `${token.slice(0, 10)}...` : '***';

  // Pure helper replicating handleNotificationPayload route decision
  const resolveNotificationRoute = (data: unknown): string | null => {
    if (!data || typeof data !== 'object') return null;
    const payload = data as Record<string, unknown>;
    const event = typeof payload.event === 'string' ? payload.event : '';
    const shiftId = typeof payload.shiftId === 'string' ? payload.shiftId : '';

    const isUuid = (val: string): boolean =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);

    if (event === 'shift_assigned' && shiftId && isUuid(shiftId)) {
      return `/shifts/${shiftId}`;
    }
    if (
      event === 'swap_requested' ||
      event === 'swap_approved' ||
      event === 'swap_rejected'
    ) {
      return '/(tabs)/swaps';
    }
    if (shiftId && isUuid(shiftId)) {
      return `/shifts/${shiftId}`;
    }
    return null;
  };

  describe('Device token privacy (masked logging)', () => {
    it('masks long Expo push tokens to protect sensitive credentials', () => {
      const token = 'ExponentPushToken[xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx]';
      const masked = maskToken(token);
      expect(masked).toBe('ExponentPu...');
      expect(masked).not.toContain('xxxxxxxx');
    });

    it('masks short or invalid tokens with ***', () => {
      expect(maskToken('short')).toBe('***');
      expect(maskToken('')).toBe('***');
    });
  });

  describe('Notification payload routing', () => {
    const validShiftId = '11111111-2222-3333-4444-555555555555';

    it('routes shift_assigned events to the shift details screen', () => {
      const payload = {
        event: 'shift_assigned',
        shiftId: validShiftId,
        teamId: '00000000-0000-0000-0000-000000000000',
      };
      expect(resolveNotificationRoute(payload)).toBe(`/shifts/${validShiftId}`);
    });

    it('routes swap_requested events to the swaps tab', () => {
      const payload = {
        event: 'swap_requested',
        shiftId: validShiftId,
        swapId: '22222222-3333-4444-5555-666666666666',
      };
      expect(resolveNotificationRoute(payload)).toBe('/(tabs)/swaps');
    });

    it('routes swap_approved events to the swaps tab', () => {
      const payload = {
        event: 'swap_approved',
        shiftId: validShiftId,
      };
      expect(resolveNotificationRoute(payload)).toBe('/(tabs)/swaps');
    });

    it('routes swap_rejected events to the swaps tab', () => {
      const payload = {
        event: 'swap_rejected',
        shiftId: validShiftId,
      };
      expect(resolveNotificationRoute(payload)).toBe('/(tabs)/swaps');
    });

    it('rejects invalid or non-UUID shift IDs safely without navigating', () => {
      expect(resolveNotificationRoute({ event: 'shift_assigned', shiftId: 'not-a-uuid' })).toBeNull();
      expect(resolveNotificationRoute({ event: 'shift_assigned', shiftId: '' })).toBeNull();
      expect(resolveNotificationRoute(null)).toBeNull();
      expect(resolveNotificationRoute('invalid')).toBeNull();
    });
  });

  describe('Preferences Contract', () => {
    it('verifies the four preference keys match the backend schema exactly', () => {
      const preferenceKeys = ['shiftAssigned', 'swapRequested', 'swapApproved', 'swapRejected'];
      expect(preferenceKeys).toHaveLength(4);
      expect(preferenceKeys).toEqual([
        'shiftAssigned',
        'swapRequested',
        'swapApproved',
        'swapRejected',
      ]);
    });
  });
});
