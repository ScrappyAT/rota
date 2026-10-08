import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Button, ActivityIndicator, Alert } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Team } from '@rota/shared';

export default function TeamsScreen() {
  const [teams, setTeams] = useState<Team[]>([]);
  const [loading, setLoading] = useState(true);

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

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Your Teams</Text>
      
      {loading ? (
        <ActivityIndicator size="large" />
      ) : (
        <FlatList
          data={teams}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <View style={styles.teamCard}>
              <Text style={styles.teamName}>{item.name}</Text>
              <Button title="Manage" onPress={() => router.push(`/teams/${item.id}`)} />
            </View>
          )}
          ListEmptyComponent={<Text>You are not part of any teams.</Text>}
        />
      )}

      <View style={styles.actions}>
        <Button title="Create New Team" onPress={() => router.push('/teams/create')} />
        <Button title="Accept Invitation" onPress={() => router.push('/teams/accept')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  teamCard: { padding: 15, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  teamName: { fontSize: 18 },
  actions: { marginTop: 20, gap: 10 }
});
