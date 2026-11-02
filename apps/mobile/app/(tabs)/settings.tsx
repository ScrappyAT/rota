import { Text, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../src/context/AuthContext';
import { useTeam } from '../../src/context/TeamContext';
import { Screen } from '../../src/components/ui/Screen';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors } from '../../src/components/ui/theme';
import { ServerSettings } from '../../src/components/ServerSettings';

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { team, role } = useTeam();

  const handleSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Are you sure you want to sign out?',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            await logout();
            router.replace('/(auth)/login');
          }
        },
      ]
    );
  };

  return (
    <Screen style={styles.container}>
      <Card style={styles.card}>
        <Text style={typography.label}>ACCOUNT</Text>
        <Text style={[typography.h3, { marginTop: spacing.sm }]}>
          {user?.firstName} {user?.lastName}
        </Text>
        <Text style={typography.bodySmall}>{user?.email}</Text>
      </Card>

      <Card style={styles.card}>
        <Text style={typography.label}>TEAM MANAGEMENT</Text>
        <Text style={[typography.body, { marginVertical: spacing.sm }]}>
          {team ? `${team.name} (Role: ${role})` : 'No team selected'}
        </Text>
        <Button
          title="Switch or Manage Teams"
          variant="secondary"
          onPress={() => router.push('/teams')}
          style={{ marginTop: spacing.xs }}
        />
      </Card>

      {role === 'OWNER' && team && (
        <Card style={styles.card}>
          <Text style={typography.label}>BILLING & SUBSCRIPTION</Text>
          <Text style={[typography.bodySmall, { marginVertical: spacing.sm }]}>
            Manage your plan and billing history.
          </Text>
          <Button
            title="Subscription Settings"
            variant="secondary"
            onPress={() => router.push('/subscription')}
          />
        </Card>
      )}

      <Card style={styles.card}><ServerSettings /></Card>

      <Button title="Log out of all devices" variant="danger" onPress={async()=>{try{await logout(true);}catch(error){Alert.alert('Logout failed',error instanceof Error?error.message:'Try again');}}} />
      <Button
        title="Sign Out"
        variant="danger"
        onPress={handleSignOut}
        style={styles.signOutButton}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.md },
  card: {
    marginBottom: spacing.md,
  },
  loadingContainer: {
    paddingVertical: spacing.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorContainer: {
    paddingVertical: spacing.sm,
  },
  prefList: {
    marginTop: spacing.xs,
  },
  prefRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.sm,
  },
  prefTextContainer: {
    flex: 1,
    paddingRight: spacing.md,
  },
  prefTitle: {
    fontSize: 15,
    fontWeight: '500',
    color: colors.text,
  },
  prefDescription: {
    fontSize: 13,
    color: colors.textSecondary,
    marginTop: 2,
  },
  prefDivider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: 2,
  },
  signOutButton: {
    marginTop: spacing.xl,
    marginBottom: spacing.xxl,
  }
});