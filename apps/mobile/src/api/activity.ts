import { apiClient } from './client';
import { dataOrThrow, toQuery } from './ensure';
import { PaginatedResponse } from '@rota/shared';

export interface ActivityEvent {
  id: string;
  teamId: string;
  actorId: string | null;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
  type?: string;
}

export const fetchActivity = async (teamId: string, options: ListOptions = {}): Promise<PaginatedResponse<ActivityEvent>> => {
  const res = await apiClient.request<PaginatedResponse<ActivityEvent>>(
    `/teams/${teamId}/activity${toQuery({
      limit: options.limit ?? 20,
      cursor: options.cursor,
      type: options.type,
    })}`
  );
  return dataOrThrow(res);
};