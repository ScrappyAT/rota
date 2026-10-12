import { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Roles, Role } from '@rota/shared';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { Card } from '../../src/components/ui/Card';
import { typography, spacing, colors } from '../../src/components/ui/theme';

export default function InviteMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(Roles.STAFF);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState('');

  const handleInvite = async () => {
    if (!email.trim()) return Alert.alert('Error', 'Email is required');

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
    <Screen style={styles.container}>
      <Text style={[typography.h2, { marginBottom: spacing.lg }]}>Invite Member</Text>

      <Input
        label="Email Address"
        placeholder="Enter user email"
        value={email}
        onChangeText={setEmail}
        autoCapitalize="none"
        keyboardType="email-address"
        editable={!loading}
      />

      <View style={styles.roleContainer}>
        <Text style={typography.label}>Role</Text>
        <Button
          title={`Currently selected: ${role}`}
          variant="secondary"
          onPress={() => setRole(role === Roles.STAFF ? Roles.MANAGER : Roles.STAFF)}
          style={{ marginTop: spacing.xs }}
        />
      </View>

      <Button
        title={loading ? 'Inviting...' : 'Send Invitation'}
        onPress={handleInvite}
        loading={loading}
      />

      {token ? (
        <Card style={styles.tokenContainer}>
          <Text style={typography.label}>Share this token:</Text>
          <Text style={styles.tokenText}>{token}</Text>
        </Card>
      ) : null}

      <View style={{ marginTop: spacing.xl }}>
        <Button title="Back" variant="ghost" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.xl },
  roleContainer: { marginBottom: spacing.xl, marginTop: spacing.md },
  tokenContainer: {
    marginTop: spacing.xl,
    backgroundColor: colors.secondary,
    borderColor: colors.primary,
  },
  tokenText: {
    fontFamily: 'monospace',
    marginTop: spacing.sm,
    fontSize: 18,
    color: colors.primaryDark,
    fontWeight: 'bold',
  }
});
