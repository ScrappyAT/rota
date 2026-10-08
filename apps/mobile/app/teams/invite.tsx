import { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Roles, Role } from '@rota/shared';

export default function InviteMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(Roles.STAFF);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState('');

  const handleInvite = async () => {
    setLoading(true);
    const res = await apiClient.request<{ token: string }>(`/invitations/team/${id}`, {
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    setLoading(false);

    if (res.success && res.data) {
      setToken(res.data.token);
      Alert.alert('Success', 'Invitation created. Share this token with the user.');
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to invite member');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Invite Member</Text>
      <TextInput
        style={styles.input}
        placeholder="Email Address"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <View style={styles.roleContainer}>
        <Button title={`Role: ${role}`} onPress={() => setRole(role === Roles.STAFF ? Roles.MANAGER : Roles.STAFF)} />
      </View>
      <Button title={loading ? 'Inviting...' : 'Invite'} onPress={handleInvite} disabled={loading} />
      
      {token ? (
        <View style={styles.tokenContainer}>
          <Text style={styles.tokenLabel}>Share this token:</Text>
          <Text style={styles.tokenText}>{token}</Text>
        </View>
      ) : null}
      
      <Button title="Back" onPress={() => router.back()} color="gray" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginBottom: 10, borderRadius: 5 },
  roleContainer: { marginBottom: 20 },
  tokenContainer: { marginTop: 20, padding: 15, backgroundColor: '#eef', borderRadius: 8, marginBottom: 20 },
  tokenLabel: { fontWeight: 'bold' },
  tokenText: { fontFamily: 'monospace', marginTop: 5 }
});
