import { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Team } from '@rota/shared';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing } from '../../src/components/ui/theme';
import { useTeam } from '../../src/context/TeamContext';

export default function CreateTeamScreen() {
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const { selectTeam } = useTeam();

  const handleCreate = async () => {
    if (!name.trim()) return Alert.alert('Error', 'Team name is required');
    setLoading(true);
    const res = await apiClient.request<Team>('/teams', {
      method: 'POST',
      body: JSON.stringify({ name: name.trim() }),
    });
    setLoading(false);

    if (res.success && res.data) {
      Alert.alert('Success', 'Team created successfully');
      await selectTeam(res.data.id);
      router.replace('/');
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to create team');
    }
  };

  return (
    <Screen style={styles.container}>
      <Text style={[typography.h2, styles.title]}>Create a New Team</Text>

      <Input
        label="Team Name"
        placeholder="e.g. Downtown Clinic"
        value={name}
        onChangeText={setName}
        editable={!loading}
        autoCapitalize="words"
        returnKeyType="done"
        onSubmitEditing={handleCreate}
      />

      <View style={styles.actions}>
        <Button
          title={loading ? 'Creating...' : 'Create Team'}
          onPress={handleCreate}
          loading={loading}
        />
        <Button
          title="Cancel"
          variant="ghost"
          onPress={() => router.back()}
          disabled={loading}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.xl,
    paddingTop: spacing.xxl,
  },
  title: {
    marginBottom: spacing.xl,
  },
  actions: {
    marginTop: spacing.xl,
    gap: spacing.md,
  }
});
