import { ApiResponse } from '@rota/shared';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Throw on failure so React Query can capture the error state. */
export function dataOrThrow<T>(res: ApiResponse<T>): T {
  if (!res.success) {
    throw new ApiError(res.error?.code ?? 'UNKNOWN_ERROR', res.error?.message ?? 'Request failed');
  }
  return res.data as T;
}

/** Ensure request succeeded without requiring a data payload (for void mutations like delete, approve, reject). */
export function ensureSuccess(res: ApiResponse<unknown>): void {
  if (!res.success) {
    throw new ApiError(res.error?.code ?? 'UNKNOWN_ERROR', res.error?.message ?? 'Request failed');
  }
}

const toQuery = (params: Record<string, string | number | undefined>) => {
  const search = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== '') search.set(key, String(value));
  });
  const s = search.toString();
  return s ? `?${s}` : '';
};

export { toQuery };