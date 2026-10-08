import { apiClient } from './client';
import { dataOrThrow, toQuery } from './ensure';
import { PaginatedResponse } from '@rota/shared';

export interface SwapRequest {
  id: string;
  shiftId: string;
  requestedBy: string;
  offeredTo: string | null;
  status: string;
  reason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  shiftTitle: string;
  shiftStartsAt: string;
  shiftEndsAt: string;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
  status?: string;
}

export const fetchSwaps = async (teamId: string, options: ListOptions = {}): Promise<PaginatedResponse<SwapRequest>> => {
  const res = await apiClient.request<PaginatedResponse<SwapRequest>>(
    `/teams/${teamId}/swaps${toQuery({
      limit: options.limit ?? 20,
      cursor: options.cursor,
      status: options.status,
    })}`
  );
  return dataOrThrow(res);
};

export const approveSwap = async (teamId: string, swapId: string): Promise<void> => {
  const res = await apiClient.request(`/teams/${teamId}/swaps/${swapId}/approve`, { method: 'POST' });
  dataOrThrow(res);
};

export const rejectSwap = async (teamId: string, swapId: string, reason?: string): Promise<void> => {
  const res = await apiClient.request(`/teams/${teamId}/swaps/${swapId}/reject`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
  dataOrThrow(res);
};

export const cancelSwap = async (teamId: string, swapId: string): Promise<void> => {
  const res = await apiClient.request(`/teams/${teamId}/swaps/${swapId}/cancel`, { method: 'POST' });
  dataOrThrow(res);
};