import { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors, borderRadius } from '../../src/components/ui/theme';

export default function AcceptInvitationScreen() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAccept = async () => {
    const cleanedCode = code.trim().replace(/\s+/g, '');
    if (!cleanedCode) {
      return Alert.alert('Error', 'Please enter your 6-digit invitation code.');
    }

    if (cleanedCode.length < 6) {
      return Alert.alert('Invalid Code', 'Invitation codes are 6 numeric digits.');
    }

    setLoading(true);
    const res = await apiClient.request('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ code: cleanedCode, token: cleanedCode }),
    });
    setLoading(false);

    if (res.success) {
      Alert.alert('Success!', 'You have joined the team.');
      router.replace('/');
    } else {
      const codeError = res.error?.code;
      const message = res.error?.message || 'Failed to accept invitation.';

      if (codeError === 'FORBIDDEN') {
        Alert.alert(
          'Email Mismatch',
          'This invitation code was sent to a different email address. Please sign in with the invited email account.'
        );
      } else if (codeError === 'TOO_MANY_REQUESTS') {
        Alert.alert(
          'Too Many Attempts',
          'Too many failed attempts. Please wait 15 minutes before trying again.'
        );
      } else if (codeError === 'INVALID_TOKEN' || codeError === 'INVALID_CODE') {
        Alert.alert(
          'Invalid or Expired Code',
          'This 6-digit invitation code is invalid, already used, or has expired (codes expire after 15 minutes).'
        );
      } else {
        Alert.alert('Error', message);
      }
    }
  };

  return (
    <Screen style={styles.container}>
      <Text style={[typography.h2, { marginBottom: spacing.sm }]}>Join a Team</Text>
      <Text style={[typography.body, { marginBottom: spacing.lg, color: colors.textSecondary }]}>
        Enter the 6-digit invitation code provided by your team manager or owner.
      </Text>

      <View style={styles.infoBox}>
        <Text style={styles.infoText}>
          💡 Invitation codes expire after 15 minutes and can only be used once. You must be signed in with the email that received the invitation.
        </Text>
      </View>

      <Input
        label="6-Digit Invitation Code"
        placeholder="e.g. 123456"
        value={code}
        onChangeText={setCode}
        keyboardType="number-pad"
        maxLength={6}
        autoFocus
        editable={!loading}
        style={styles.codeInput}
      />

      <View style={styles.actions}>
        <Button
          title={loading ? 'Joining Team...' : 'Join Team'}
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
  infoBox: {
    backgroundColor: '#F0F7FF',
    borderColor: '#C5DCFA',
    borderWidth: 1,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginBottom: spacing.xl,
  },
  infoText: {
    ...typography.bodySmall,
    color: colors.primaryDark,
    lineHeight: 20,
  },
  codeInput: {
    fontSize: 22,
    letterSpacing: 4,
    fontFamily: 'monospace',
    fontWeight: 'bold',
  },
  actions: { marginTop: spacing.xl, gap: spacing.md },
});
