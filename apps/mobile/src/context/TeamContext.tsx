import { createContext, useContext, useEffect } from 'react';
import { AppState } from 'react-native';
import { Team } from '@rota/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api/client';
import { dataOrThrow } from '../api/ensure';
import { useAuth } from './AuthContext';
import { clearTeamCache } from '../storage/shiftCache';
import { revokeOfflineTeam, getOfflineTeams, saveOfflineTeams, offlineEpoch } from '../storage/offlineData';
export type TeamRole = 'OWNER' | 'MANAGER' | 'STAFF';
interface TeamContextType { teams: Team[]; team: Team | null; role: TeamRole | null; loading: boolean; selectTeam: (id: string) => Promise<void>; refreshTeams: () => Promise<void> }
const TeamContext = createContext<TeamContextType | undefined>(undefined);
export function TeamProvider({ children }: { children: React.ReactNode }) {
  const { user, readOnlySession, activeTeamId, setActiveTeamId } = useAuth(), client = useQueryClient(), id = user?.id ?? '';
  const key = ['teams', id] as const;
  const options = { queryKey: key, staleTime: 30_000, queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const epoch = offlineEpoch();
    const teams = dataOrThrow(await apiClient.request<Team[]>('/teams', { signal }));
    if (signal.aborted || epoch !== offlineEpoch()) throw new Error('Discarded stale team refresh');
    const previous = await getOfflineTeams(id);
    for (const removed of previous.filter(t => !teams.some(next => next.id === t.id))) {
      await revokeOfflineTeam(id, removed.id); await clearTeamCache(id, removed.id);
      client.removeQueries({ predicate: query => query.queryKey.includes(removed.id) });
    }
    if (!signal.aborted) await saveOfflineTeams(id, teams, offlineEpoch()); return teams;
  } };
  const query = useQuery({ ...options, enabled: Boolean(id) && !readOnlySession });
  const teams = query.data ?? [];
  useEffect(() => {
    let active = true;
    if (id && readOnlySession) void getOfflineTeams(id).then(saved => { if (active) client.setQueryData(key, saved); });
    return () => { active = false; };
  }, [id, readOnlySession, client]);
  useEffect(() => {
    if (!id || !query.data) return;
    if (!activeTeamId || !teams.some(t => t.id === activeTeamId)) void setActiveTeamId(teams[0]?.id ?? null);
  }, [id, query.data, activeTeamId]);
  const role = useQuery({ queryKey: ['team-role', activeTeamId, id], enabled: Boolean(activeTeamId && id) && !readOnlySession,
    queryFn: async () => { const rows = dataOrThrow(await apiClient.request<{ userId: string; role: TeamRole }[]>(`/teams/${activeTeamId}/members`)); return rows.find(m => m.userId === id)?.role ?? null; } });
  useEffect(() => {
    const app = AppState.addEventListener('change', state => { if (state === 'active' && id && !readOnlySession) void client.invalidateQueries({ queryKey: ['teams', id] }); });
    const off = apiClient.onTeamAccessLost(teamId => {
      const allowed = (client.getQueryData<Team[]>(['teams', id]) ?? []).filter(t => t.id !== teamId);
      client.setQueryData(['teams', id], allowed);
      client.removeQueries({ predicate: q => q.queryKey.includes(teamId) });
      if (activeTeamId === teamId) void setActiveTeamId(allowed[0]?.id ?? null);
      void (async () => {
        await revokeOfflineTeam(id, teamId); await clearTeamCache(id, teamId);
        // Keep the durable tombstone until an authoritative team refresh permits rejoining.
      })();
    });
    return () => { app.remove(); off(); };
  }, [id, readOnlySession, activeTeamId, client]);
  const refreshTeams = async () => { if (readOnlySession) return; await client.fetchQuery({ ...options, staleTime: 0 }); };
  const selectTeam = async (teamId: string) => {
    let allowed = client.getQueryData<Team[]>(key) ?? [];
    if (!readOnlySession && !allowed.some(t => t.id === teamId)) { await refreshTeams(); allowed = client.getQueryData<Team[]>(key) ?? []; }
    if (!allowed.some(t => t.id === teamId)) throw new Error('This team is no longer available to your account');
    await setActiveTeamId(teamId);
  };
  return <TeamContext.Provider value={{ teams, team: teams.find(t => t.id === activeTeamId) ?? null, role: readOnlySession ? null : role.data ?? null, loading: Boolean(id && !query.data && query.isFetching), selectTeam, refreshTeams }}>{children}</TeamContext.Provider>;
}
export function useTeam() { const value = useContext(TeamContext); if (!value) throw new Error('TeamProvider required'); return value; }
