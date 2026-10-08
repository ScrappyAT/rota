import { useEffect, useState } from 'react';
import { View, Text, StyleSheet, FlatList, Button, ActivityIndicator, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { apiClient } from '../../src/api/client';

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
    <View style={styles.container}>
      <Text style={styles.title}>Team Members</Text>
      
      {loading ? (
        <ActivityIndicator size="large" />
      ) : (
        <FlatList
          data={members}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <View style={styles.memberCard}>
              <View>
                <Text style={styles.memberName}>{item.firstName} {item.lastName}</Text>
                <Text style={styles.memberRole}>{item.role}</Text>
              </View>
              <Button title="Remove" color="red" onPress={() => removeMember(item.userId)} />
            </View>
          )}
        />
      )}

      <View style={styles.actions}>
        <Button title="Invite Member" onPress={() => router.push(`/teams/${id}/invite`)} />
        <Button title="Back" onPress={() => router.back()} color="gray" />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  memberCard: { padding: 15, borderWidth: 1, borderColor: '#eee', borderRadius: 8, marginBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  memberName: { fontSize: 16, fontWeight: 'bold' },
  memberRole: { fontSize: 14, color: '#666' },
  actions: { marginTop: 20, gap: 10 }
});
