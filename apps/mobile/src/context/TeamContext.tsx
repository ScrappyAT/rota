import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import * as SecureStore from 'expo-secure-store';
import { apiClient } from '../api/client';
import { dataOrThrow } from '../api/ensure';
import { useAuth } from './AuthContext';
import { Team } from '@rota/shared';

export type TeamRole = 'OWNER' | 'MANAGER' | 'STAFF';

interface TeamMember {
  userId: string;
  role: TeamRole;
}

interface TeamContextType {
  teams: Team[];
  team: Team | null;
  role: TeamRole | null;
  loading: boolean;
  selectTeam: (teamId: string) => Promise<void>;
  refreshTeams: () => Promise<void>;
}

const TeamContext = createContext<TeamContextType | undefined>(undefined);

const SELECTED_TEAM_KEY = 'selectedTeamId';

export function TeamProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [teams, setTeams] = useState<Team[]>([]);
  const [teamId, setTeamId] = useState<string | null>(null);
  const [roles, setRoles] = useState<Record<string, TeamRole>>({});
  const [loading, setLoading] = useState(true);

  const loadTeams = useCallback(async () => {
    if (!user) {
      setTeams([]);
      setTeamId(null);
      setRoles({});
      setLoading(false);
      return;
    }

    try {
      const list = dataOrThrow(await apiClient.request<Team[]>('/teams'));
      setTeams(list);

      let selected = await SecureStore.getItemAsync(SELECTED_TEAM_KEY);
      if (!selected || !list.some((t) => t.id === selected)) {
        selected = list[0]?.id ?? null;
        if (selected) await SecureStore.setItemAsync(SELECTED_TEAM_KEY, selected);
      }
      setTeamId(selected);

      const nextRoles: Record<string, TeamRole> = {};
      await Promise.all(
        list.map(async (t) => {
          try {
            const members = dataOrThrow(await apiClient.request<TeamMember[]>(`/teams/${t.id}/members`));
            const me = members.find((m) => m.userId === user.id);
            if (me && selected === t.id) nextRoles[t.id] = me.role;
          } catch {
            // Isolation failures hide the team; skip role resolution.
          }
        })
      );
      setRoles(nextRoles);
    } catch {
      setTeams([]);
      setTeamId(null);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    setLoading(true);
    loadTeams();
  }, [loadTeams]);

  const selectTeam = useCallback(async (nextId: string) => {
    setTeamId(nextId);
    await SecureStore.setItemAsync(SELECTED_TEAM_KEY, nextId);
    await loadTeams();
  }, [loadTeams]);

  const team = useMemo(() => teams.find((t) => t.id === teamId) ?? null, [teams, teamId]);
  const role = teamId ? (roles[teamId] ?? null) : null;

  return (
    <TeamContext.Provider value={{ teams, team, role, loading, selectTeam, refreshTeams: loadTeams }}>
      {children}
    </TeamContext.Provider>
  );
}

export function useTeam() {
  const context = useContext(TeamContext);
  if (!context) {
    throw new Error('useTeam must be used within a TeamProvider');
  }
  return context;
}