import { ApiResponse } from '@rota/shared';

describe('Mutation Response Contract, 204 Handling, and Post-Deletion Lifecycle', () => {
  class ApiError extends Error {
    constructor(
      public readonly code: string,
      message: string
    ) {
      super(message);
      this.name = 'ApiError';
    }
  }

  // Pure implementations matching mobile src/api/ensure.ts
  function dataOrThrow<T>(res: ApiResponse<T>): T {
    if (!res.success) {
      throw new ApiError(res.error?.code ?? 'UNKNOWN_ERROR', res.error?.message ?? 'Request failed');
    }
    return res.data as T;
  }

  function ensureSuccess(res: ApiResponse<unknown>): void {
    if (!res.success) {
      throw new ApiError(res.error?.code ?? 'UNKNOWN_ERROR', res.error?.message ?? 'Request failed');
    }
  }

  // Pure implementation matching mobile src/api/client.ts response parser
  async function parseFetchResponse<T>(response: {
    status: number;
    ok: boolean;
    text: () => Promise<string>;
  }): Promise<ApiResponse<T>> {
    if (response.status === 204 || response.status === 205) {
      return { success: true } as ApiResponse<T>;
    }

    const text = await response.text();
    if (!text || text.trim() === '') {
      return {
        success: response.ok,
        ...(response.ok
          ? {}
          : {
              error: {
                code: `HTTP_${response.status}`,
                message: `Request failed with status ${response.status}`,
              },
            }),
      } as ApiResponse<T>;
    }

    try {
      const data = JSON.parse(text);
      return data as ApiResponse<T>;
    } catch {
      if (!response.ok) {
        return {
          success: false,
          error: {
            code: `HTTP_${response.status}`,
            message: `Request failed with status ${response.status}`,
          },
        };
      }
      return { success: true } as ApiResponse<T>;
    }
  }

  describe('dataOrThrow and ensureSuccess on void mutation responses', () => {
    it('does not throw on { success: true } when data is undefined (shift delete, swap approve)', () => {
      const voidSuccess: ApiResponse<void> = { success: true };

      expect(() => ensureSuccess(voidSuccess)).not.toThrow();
      expect(dataOrThrow(voidSuccess)).toBeUndefined();
    });

    it('returns payload when data is present on { success: true, data: T }', () => {
      const shiftData = { id: 'shift-123', title: 'Morning Shift' };
      const res: ApiResponse<typeof shiftData> = { success: true, data: shiftData };

      expect(() => ensureSuccess(res)).not.toThrow();
      expect(dataOrThrow(res)).toEqual(shiftData);
    });

    it('throws ApiError with genuine backend error code and message on failure', () => {
      const failure: ApiResponse<void> = {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Shift not found' },
      };

      expect(() => ensureSuccess(failure)).toThrow(ApiError);
      expect(() => dataOrThrow(failure)).toThrow(ApiError);

      try {
        ensureSuccess(failure);
      } catch (err) {
        const apiErr = err as ApiError;
        expect(apiErr.code).toBe('NOT_FOUND');
        expect(apiErr.message).toBe('Shift not found');
      }
    });

    it('preserves authorization and conflict error messages accurately', () => {
      const forbidden: ApiResponse<void> = {
        success: false,
        error: { code: 'FORBIDDEN', message: 'Only managers can approve swaps' },
      };

      try {
        ensureSuccess(forbidden);
      } catch (err) {
        const apiErr = err as ApiError;
        expect(apiErr.code).toBe('FORBIDDEN');
        expect(apiErr.message).toBe('Only managers can approve swaps');
      }
    });

    it('falls back to Request failed when error details are absent on failure', () => {
      const bareFailure: ApiResponse<void> = { success: false };

      try {
        ensureSuccess(bareFailure);
      } catch (err) {
        const apiErr = err as ApiError;
        expect(apiErr.code).toBe('UNKNOWN_ERROR');
        expect(apiErr.message).toBe('Request failed');
      }
    });
  });

  describe('HTTP response parsing (204 No Content, empty body, non-JSON)', () => {
    it('parses HTTP 204 No Content as { success: true } without JSON parse errors', async () => {
      const mock204 = {
        status: 204,
        ok: true,
        text: async () => '',
      };

      const result = await parseFetchResponse<void>(mock204);
      expect(result).toEqual({ success: true });
      expect(() => ensureSuccess(result)).not.toThrow();
    });

    it('parses HTTP 205 Reset Content as { success: true }', async () => {
      const mock205 = {
        status: 205,
        ok: true,
        text: async () => '',
      };

      const result = await parseFetchResponse<void>(mock205);
      expect(result).toEqual({ success: true });
    });

    it('parses HTTP 200 with empty body as { success: true }', async () => {
      const mockEmpty200 = {
        status: 200,
        ok: true,
        text: async () => '   ',
      };

      const result = await parseFetchResponse<void>(mockEmpty200);
      expect(result).toEqual({ success: true });
    });

    it('parses HTTP non-JSON error pages (e.g. Nginx 502 HTML) as structured failure', async () => {
      const mock502Html = {
        status: 502,
        ok: false,
        text: async () => '<html><body>502 Bad Gateway</body></html>',
      };

      const result = await parseFetchResponse<void>(mock502Html);
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('HTTP_502');
      expect(result.error?.message).toContain('502');
    });

    it('parses standard Express JSON responses correctly', async () => {
      const mockExpressSuccess = {
        status: 200,
        ok: true,
        text: async () => JSON.stringify({ success: true }),
      };

      const result = await parseFetchResponse<void>(mockExpressSuccess);
      expect(result).toEqual({ success: true });
      expect(() => ensureSuccess(result)).not.toThrow();
    });
  });

  describe('Post-deletion cache lifecycle and refetch prevention', () => {
    it('prunes deleted shift from local storage list and detail cache', async () => {
      const store = new Map<string, string>();
      const makeShiftsKey = (u: string, t: string) => `shifts:${u}:${t}`;
      const makeShiftDetailKey = (u: string, t: string, s: string) => `shift_detail:${u}:${t}:${s}`;

      const userId = 'u1';
      const teamId = 't1';
      const shiftId = 's1';

      // Seed initial cache
      const initialShifts = [
        { id: 's1', teamId, title: 'Shift 1' },
        { id: 's2', teamId, title: 'Shift 2' },
      ];
      store.set(makeShiftsKey(userId, teamId), JSON.stringify({ items: initialShifts }));
      store.set(makeShiftDetailKey(userId, teamId, shiftId), JSON.stringify(initialShifts[0]));

      // Pure simulation of removeCachedShiftDetail
      const removeCachedShiftDetail = async (u: string, t: string, s: string) => {
        store.delete(makeShiftDetailKey(u, t, s));
        const raw = store.get(makeShiftsKey(u, t));
        if (raw) {
          const parsed = JSON.parse(raw);
          const filtered = parsed.items.filter((item: { id: string }) => item.id !== s);
          store.set(makeShiftsKey(u, t), JSON.stringify({ ...parsed, items: filtered }));
        }
      };

      await removeCachedShiftDetail(userId, teamId, shiftId);

      // Detail cache must be removed
      expect(store.get(makeShiftDetailKey(userId, teamId, shiftId))).toBeUndefined();

      // List cache must have s1 pruned
      const updatedListRaw = store.get(makeShiftsKey(userId, teamId));
      expect(updatedListRaw).toBeDefined();
      const updatedList = JSON.parse(updatedListRaw!);
      expect(updatedList.items).toHaveLength(1);
      expect(updatedList.items[0].id).toBe('s2');
    });

    it('simulates query cache removal preventing 404 refetch on deleted shift', () => {
      const queryCache = new Map<string, unknown>();
      const removedQueries: string[] = [];
      const invalidatedQueries: string[] = [];

      const queryClient = {
        removeQueries: ({ queryKey }: { queryKey: string[] }) => {
          const key = queryKey.join(':');
          queryCache.delete(key);
          removedQueries.push(key);
        },
        invalidateQueries: ({ queryKey }: { queryKey: string[] }) => {
          invalidatedQueries.push(queryKey.join(':'));
        },
      };

      const teamId = 't-alpha';
      const shiftId = 's-deleted';

      // Detail query in cache
      queryCache.set(`shift:${teamId}:${shiftId}`, { id: shiftId, title: 'Morning' });

      // Action: delete shift success hook
      queryClient.removeQueries({ queryKey: ['shift', teamId, shiftId] });
      queryClient.invalidateQueries({ queryKey: ['shifts', teamId] });
      queryClient.invalidateQueries({ queryKey: ['activity', teamId] });
      queryClient.invalidateQueries({ queryKey: ['swaps', teamId] });

      // Verification: detail query removed, collections invalidated
      expect(queryCache.has(`shift:${teamId}:${shiftId}`)).toBe(false);
      expect(removedQueries).toContain(`shift:${teamId}:${shiftId}`);
      expect(invalidatedQueries).toEqual([
        `shifts:${teamId}`,
        `activity:${teamId}`,
        `swaps:${teamId}`,
      ]);
    });
  });
});
