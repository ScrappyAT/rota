import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Alert, TouchableOpacity } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Team } from '@rota/shared';
import { Screen } from '../../src/components/ui/Screen';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors, borderRadius } from '../../src/components/ui/theme';
import { useTeam } from '../../src/context/TeamContext';

export default function TeamsScreen() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);
  const { team, selectTeam } = useTeam();
  const activeTeamId = team?.id;

  useEffect(() => {
    loadTeams();
  }, []);

  const loadTeams = async () => {
    setLoading(true);
    const res = await apiClient.request<Team[]>('/teams');
    setLoading(false);
    if (res.success && res.data) {
      setTeams(res.data);
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to load teams');
    }
  };

  const handleSelectTeam = async (id: string) => {
    await selectTeam(id);
    router.replace('/');
  };

  return (
    <Screen style={styles.container}>
      <Text style={[typography.h2, { marginBottom: spacing.lg }]}>Your Teams</Text>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} />
      ) : (
        <FlatList
          data={teams}
          keyExtractor={item => item.id}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <TouchableOpacity onPress={() => handleSelectTeam(item.id)} activeOpacity={0.8}>
              <Card style={[styles.teamCard, activeTeamId === item.id ? styles.activeCard : undefined]}>
                <View>
                  <Text style={typography.h3}>{item.name}</Text>
                  {activeTeamId === item.id && (
                    <Text style={[typography.label, { color: colors.primary, marginTop: spacing.xs }]}>
                      Currently Active
                    </Text>
                  )}
                </View>
                <Button
                  title="Manage"
                  size="small"
                  variant="secondary"
                  onPress={() => router.push(`/teams/${item.id}`)}
                />
              </Card>
            </TouchableOpacity>
          )}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={typography.bodySmall}>You are not part of any teams.</Text>
            </View>
          }
        />
      )}

      <View style={styles.actions}>
        <Button title="Create New Team" onPress={() => router.push('/teams/create')} />
        <Button title="Join with Invitation" variant="secondary" onPress={() => router.push('/teams/accept')} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
  },
  teamCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.lg,
  },
  activeCard: {
    borderColor: colors.primary,
    borderWidth: 2,
  },
  emptyState: {
    padding: spacing.xl,
    alignItems: 'center',
    backgroundColor: colors.card,
    borderRadius: borderRadius.lg,
  },
  actions: {
    marginTop: spacing.xl,
    gap: spacing.md,
  }
});
