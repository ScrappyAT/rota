import { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing } from '../../src/components/ui/theme';

export default function AcceptInvitationScreen() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAccept = async () => {
    if (!token.trim()) return Alert.alert('Error', 'Token is required');

    setLoading(true);
    const res = await apiClient.request('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    setLoading(false);

    if (res.success) {
      Alert.alert('Success', 'You have joined the team');
      router.replace('/');
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to accept invitation');
    }
  };

  return (
    <Screen style={styles.container}>
      <Text style={[typography.h2, { marginBottom: spacing.lg }]}>Join a Team</Text>
      <Text style={[typography.body, { marginBottom: spacing.xl }]}>
        Enter the invitation token provided by your team manager or owner.
      </Text>

      <Input
        label="Invitation Token"
        placeholder="Paste token here"
        value={token}
        onChangeText={setToken}
        editable={!loading}
      />

      <View style={styles.actions}>
        <Button
          title={loading ? 'Joining...' : 'Join Team'}
          onPress={handleAccept}
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
  container: { padding: spacing.xl, paddingTop: spacing.xxl },
  actions: { marginTop: spacing.xl, gap: spacing.md }
});
