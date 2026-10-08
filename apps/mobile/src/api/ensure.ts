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
  if (!res.success || res.data === undefined) {
    throw new ApiError(res.error?.code ?? 'UNKNOWN_ERROR', res.error?.message ?? 'Request failed');
  }
  return res.data;
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