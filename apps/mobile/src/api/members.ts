import { apiClient } from './client';
import { dataOrThrow } from './ensure';

export interface Member {
  id: string;
  teamId: string;
  userId: string;
  role: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface TeamResponse {
  id: string;
  name: string;
  ownerId: string;
  createdAt: string;
}

export const fetchMembers = async (teamId: string): Promise<Member[]> => {
  const res = await apiClient.request<Member[]>(`/teams/${teamId}/members`);
  return dataOrThrow(res);
};