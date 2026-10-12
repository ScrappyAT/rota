import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Screen } from '../../src/components/ui/Screen';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors } from '../../src/components/ui/theme';

export default function TeamMembersScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [members, setMembers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (id) loadMembers();
  }, [id]);

  const loadMembers = async () => {
    setLoading(true);
    const res = await apiClient.request<any[]>(`/teams/${id}/members`);
    setLoading(false);
    if (res.success && res.data) {
      setMembers(res.data);
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to load members');
    }
  };

  const removeMember = async (userId: string) => {
    const res = await apiClient.request(`/teams/${id}/members/${userId}`, { method: 'DELETE' });
    if (res.success) {
      loadMembers();
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to remove member');
    }
  };

  return (
    <Screen style={styles.container}>
      <Text style={[typography.h2, { marginBottom: spacing.lg }]}>Team Members</Text>

      {loading ? (
        <ActivityIndicator size="large" color={colors.primary} />
      ) : (
        <FlatList
          data={members}
          keyExtractor={item => item.id}
          scrollEnabled={false}
          renderItem={({ item }) => (
            <Card style={styles.memberCard}>
              <View>
                <Text style={typography.h3}>{item.firstName} {item.lastName}</Text>
                <Text style={typography.bodySmall}>{item.role}</Text>
              </View>
              <Button
                title="Remove"
                variant="danger"
                size="small"
                onPress={() => removeMember(item.userId)}
              />
            </Card>
          )}
          ListEmptyComponent={
            <Text style={typography.bodySmall}>No members found.</Text>
          }
        />
      )}

      <View style={styles.actions}>
        <Button
          title="Invite New Member"
          onPress={() => router.push({ pathname: '/teams/invite', params: { id } })}
        />
        <Button title="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.md },
  memberCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  actions: {
    marginTop: spacing.xl,
    gap: spacing.md,
  }
});
