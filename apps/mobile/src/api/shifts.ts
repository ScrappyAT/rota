import { apiClient } from './client';
import { dataOrThrow, ensureSuccess, toQuery } from './ensure';
import { PaginatedResponse } from '@rota/shared';

export interface Shift {
  id: string;
  teamId: string;
  createdBy: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  assignments?: Assignment[];
}

export interface Assignment {
  shiftId: string;
  userId: string;
  assignedBy: string;
  createdAt: string;
  firstName?: string;
  lastName?: string;
}

export interface ListOptions {
  limit?: number;
  cursor?: string;
  status?: string;
  assignedTo?: string;
}

export const fetchShifts = async (teamId: string, options: ListOptions = {}): Promise<PaginatedResponse<Shift>> => {
  const res = await apiClient.request<PaginatedResponse<Shift>>(
    `/teams/${teamId}/shifts${toQuery({
      limit: options.limit ?? 20,
      cursor: options.cursor,
      status: options.status,
      assignedTo: options.assignedTo,
    })}`
  );
  return dataOrThrow(res);
};

export const fetchShift = async (teamId: string, shiftId: string): Promise<Shift> => {
  const res = await apiClient.request<Shift>(`/teams/${teamId}/shifts/${shiftId}`);
  return dataOrThrow(res);
};

export const createShift = async (
  teamId: string,
  input: { title: string; description?: string; startsAt: string; endsAt: string; assigneeIds?: string[] }
): Promise<Shift> => {
  const res = await apiClient.request<Shift>(`/teams/${teamId}/shifts`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return dataOrThrow(res);
};

export const updateShift = async (
  teamId: string,
  shiftId: string,
  input: Partial<{ title: string; description: string | null; startsAt: string; endsAt: string; status: string }>
): Promise<Shift> => {
  const res = await apiClient.request<Shift>(`/teams/${teamId}/shifts/${shiftId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
  return dataOrThrow(res);
};

export const deleteShift = async (teamId: string, shiftId: string): Promise<void> => {
  const res = await apiClient.request(`/teams/${teamId}/shifts/${shiftId}`, { method: 'DELETE' });
  ensureSuccess(res);
};

export const assignUsers = async (teamId: string, shiftId: string, userIds: string[]): Promise<Assignment[]> => {
  const res = await apiClient.request<Assignment[]>(`/teams/${teamId}/shifts/${shiftId}/assignments`, {
    method: 'POST',
    body: JSON.stringify({ userIds }),
  });
  return dataOrThrow(res);
};

export const unassignUser = async (teamId: string, shiftId: string, userId: string): Promise<void> => {
  const res = await apiClient.request(`/teams/${teamId}/shifts/${shiftId}/assignments/${userId}`, {
    method: 'DELETE',
  });
  ensureSuccess(res);
};

export const requestSwap = async (
  teamId: string,
  shiftId: string,
  input: { offeredTo?: string; reason?: string }
): Promise<unknown> => {
  const res = await apiClient.request(`/teams/${teamId}/shifts/${shiftId}/swaps`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return dataOrThrow(res);
};