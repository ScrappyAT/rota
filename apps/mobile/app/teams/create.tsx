import { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Team } from '@rota/shared';

export default function CreateTeamScreen() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return Alert.alert('Error', 'Team name is required');
    setLoading(true);
    const res = await apiClient.request<Team>('/teams', {
      method: 'POST',
      body: JSON.stringify({ name }),
    });
    setLoading(false);

    if (res.success) {
      Alert.alert('Success', 'Team created');
      router.back();
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to create team');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Create Team</Text>
      <TextInput
        style={styles.input}
        placeholder="Team Name"
        value={name}
        onChangeText={setName}
      />
      <Button title={loading ? 'Creating...' : 'Create'} onPress={handleCreate} disabled={loading} />
      <Button title="Cancel" onPress={() => router.back()} color="gray" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginBottom: 10, borderRadius: 5 }
});
