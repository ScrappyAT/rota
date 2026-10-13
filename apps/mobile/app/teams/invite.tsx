import { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { Roles, Role } from '@rota/shared';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { Card } from '../../src/components/ui/Card';
import { typography, spacing, colors, borderRadius } from '../../src/components/ui/theme';
import { copyToClipboard } from '../../src/utils/clipboard';

export default function InviteMemberScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(Roles.STAFF);
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [copied, setCopied] = useState(false);

  const handleInvite = async () => {
    if (!email.trim()) return Alert.alert('Error', 'Email is required');

    setLoading(true);
    setCopied(false);
    const res = await apiClient.request<{ code?: string; token: string; expiresAt?: string }>(`/invitations/team/${id}`, {
      method: 'POST',
      body: JSON.stringify({ email: email.trim(), role }),
    });
    setLoading(false);

    if (res.success && res.data) {
      const invitationCode = res.data.code || res.data.token;
      setCode(invitationCode);
      if (res.data.expiresAt) {
        const date = new Date(res.data.expiresAt);
        setExpiresAt(date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      }
      Alert.alert('Success', '6-digit invitation code generated! Share this code with the user.');
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to invite member');
    }
  };

  const handleCopy = async () => {
    if (!code) return;
    const ok = await copyToClipboard(code);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
      Alert.alert('Copied!', 'Invitation code copied to clipboard.');
    } else {
      Alert.alert('Invitation Code', `Code: ${code}`);
    }
  };

  return (
    <Screen style={styles.container}>
      <Text style={[typography.h2, { marginBottom: spacing.sm }]}>Invite Member</Text>
      <Text style={[typography.bodySmall, { marginBottom: spacing.lg }]}>
        Generate a secure 6-digit numeric code to invite a teammate.
      </Text>

      <Input
        label="Email Address"
        placeholder="Enter user email (e.g. staff@example.com)"
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
        title={loading ? 'Generating Code...' : 'Send Invitation'}
        onPress={handleInvite}
        loading={loading}
      />

      {code ? (
        <Card style={styles.codeCard}>
          <Text style={styles.codeTitle}>Invitation Code</Text>
          <View style={styles.codeBox}>
            <Text style={styles.codeDigits}>
              {code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
            </Text>
          </View>

          <View style={styles.metaRow}>
            <Text style={styles.metaBadge}>⏱ Expires in 15 minutes{expiresAt ? ` (${expiresAt})` : ''}</Text>
            <Text style={styles.metaBadge}>🔒 Single-use</Text>
          </View>

          <Text style={styles.instructions}>
            Share this 6-digit code with <Text style={{ fontWeight: 'bold' }}>{email}</Text>. They must sign in with this email to accept.
          </Text>

          <Button
            title={copied ? '✓ Copied to Clipboard!' : 'Copy Code'}
            variant="secondary"
            onPress={handleCopy}
            style={styles.copyButton}
          />
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
  codeCard: {
    marginTop: spacing.xl,
    backgroundColor: '#F0F7FF',
    borderColor: colors.primary,
    borderWidth: 1,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    alignItems: 'center',
  },
  codeTitle: {
    ...typography.label,
    color: colors.primaryDark,
    textTransform: 'uppercase',
    letterSpacing: 1,
  },
  codeBox: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1.5,
    borderColor: colors.primary,
    borderRadius: borderRadius.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xl,
    marginVertical: spacing.md,
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 2,
  },
  codeDigits: {
    fontSize: 32,
    fontWeight: '800',
    color: colors.primaryDark,
    letterSpacing: 6,
    fontFamily: 'monospace',
    textAlign: 'center',
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  metaBadge: {
    ...typography.bodySmall,
    backgroundColor: '#E1EDFB',
    color: colors.primaryDark,
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.sm,
    borderRadius: borderRadius.sm,
    fontWeight: '600',
    overflow: 'hidden',
  },
  instructions: {
    ...typography.bodySmall,
    color: colors.textSecondary,
    textAlign: 'center',
    marginVertical: spacing.sm,
  },
  copyButton: {
    marginTop: spacing.sm,
    width: '100%',
  },
});
