import { StyleSheet, View, Text, Button } from 'react-native';
import { useTeam } from '../context/TeamContext';
import { Loading } from './Loading';
import { router } from 'expo-router';

export const TeamGate = ({ children }: { children: React.ReactNode }) => {
  const { teams, loading } = useTeam();

  if (loading) {
    return <Loading message="Loading your teams..." />;
  }

  if (teams.length === 0) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>No team selected</Text>
        <Text style={styles.subtitle}>Create a team or accept an invitation to start scheduling shifts.</Text>
        <View style={styles.actions}>
          <Button title="Create a team" onPress={() => router.push('/teams/create')} />
          <Button title="Accept an invitation" onPress={() => router.push('/teams/accept')} />
        </View>
      </View>
    );
  }

  return <>{children}</>;
};

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  title: { fontSize: 20, fontWeight: 'bold', marginBottom: 8 },
  subtitle: { fontSize: 15, color: '#666', textAlign: 'center', marginBottom: 20 },
  actions: { gap: 10 },
});