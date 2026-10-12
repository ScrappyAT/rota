import { useState, useEffect } from 'react';
import { View, Text, StyleSheet, Alert, Switch, ActivityIndicator, Platform } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../src/context/AuthContext';
import { useTeam } from '../../src/context/TeamContext';
import { Screen } from '../../src/components/ui/Screen';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors } from '../../src/components/ui/theme';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  NotificationPreferences,
} from '../../src/api/devices';

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const { team, role } = useTeam();

  const [preferences, setPreferences] = useState<NotificationPreferences>({
    shiftAssigned: true,
    swapRequested: true,
    swapApproved: true,
    swapRejected: true,
  });
  const [loadingPrefs, setLoadingPrefs] = useState(true);
  const [prefError, setPrefError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<keyof NotificationPreferences | null>(null);

  const loadPreferences = async () => {
    setLoadingPrefs(true);
    setPrefError(null);
    try {
      const res = await getNotificationPreferences();
      if (res.success && res.data) {
        setPreferences(res.data);
      } else {
        setPrefError(res.error?.message || 'Failed to load preferences');
      }
    } catch {
      setPrefError('Failed to load preferences');
    } finally {
      setLoadingPrefs(false);
    }
  };

  useEffect(() => {
    loadPreferences();
  }, []);

  const handleTogglePreference = async (key: keyof NotificationPreferences, value: boolean) => {
    const previous = preferences[key];
    // Optimistic UI update
    setPreferences((prev) => ({ ...prev, [key]: value }));
    setSavingKey(key);

    try {
      const res = await updateNotificationPreferences({ [key]: value });
      if (!res.success || !res.data) {
        // Rollback on failure
        setPreferences((prev) => ({ ...prev, [key]: previous }));
        Alert.alert(
          'Update Failed',
          res.error?.message || 'Could not update notification setting.'
        );
      } else {
        setPreferences(res.data);
      }
    } catch {
      // Rollback on network exception
      setPreferences((prev) => ({ ...prev, [key]: previous }));
      Alert.alert(
        'Update Failed',
        'Network error. Could not update notification setting.'
      );
    } finally {
      setSavingKey(null);
    }
  };

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

      <Card style={styles.card}>
        <Text style={typography.label}>PUSH NOTIFICATION PREFERENCES</Text>
        <Text style={[typography.bodySmall, { marginTop: spacing.xs, marginBottom: spacing.sm }]}>
          Configure which push notifications you receive.
        </Text>

        {loadingPrefs ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.primary} />
          </View>
        ) : prefError ? (
          <View style={styles.errorContainer}>
            <Text style={[typography.bodySmall, { color: colors.danger }]}>{prefError}</Text>
            <Button
              title="Retry"
              variant="secondary"
              onPress={loadPreferences}
              style={{ marginTop: spacing.sm }}
            />
          </View>
        ) : (
          <View style={styles.prefList}>
            <View style={styles.prefRow}>
              <View style={styles.prefTextContainer}>
                <Text style={styles.prefTitle}>Shift Assignments</Text>
                <Text style={styles.prefDescription}>
                  Alerts when you are assigned to a shift
                </Text>
              </View>
              <Switch
                value={preferences.shiftAssigned}
                onValueChange={(val) => handleTogglePreference('shiftAssigned', val)}
                disabled={savingKey === 'shiftAssigned'}
                trackColor={{ false: '#DFE1E6', true: colors.primary }}
                thumbColor={
                  Platform.OS === 'android'
                    ? preferences.shiftAssigned
                      ? colors.primaryDark
                      : '#FFFFFF'
                    : undefined
                }
              />
            </View>

            <View style={styles.prefDivider} />

            <View style={styles.prefRow}>
              <View style={styles.prefTextContainer}>
                <Text style={styles.prefTitle}>Swap Requests</Text>
                <Text style={styles.prefDescription}>
                  Alerts when a teammate offers a shift swap
                </Text>
              </View>
              <Switch
                value={preferences.swapRequested}
                onValueChange={(val) => handleTogglePreference('swapRequested', val)}
                disabled={savingKey === 'swapRequested'}
                trackColor={{ false: '#DFE1E6', true: colors.primary }}
                thumbColor={
                  Platform.OS === 'android'
                    ? preferences.swapRequested
                      ? colors.primaryDark
                      : '#FFFFFF'
                    : undefined
                }
              />
            </View>

            <View style={styles.prefDivider} />

            <View style={styles.prefRow}>
              <View style={styles.prefTextContainer}>
                <Text style={styles.prefTitle}>Swap Approvals</Text>
                <Text style={styles.prefDescription}>
                  Alerts when your swap request is approved
                </Text>
              </View>
              <Switch
                value={preferences.swapApproved}
                onValueChange={(val) => handleTogglePreference('swapApproved', val)}
                disabled={savingKey === 'swapApproved'}
                trackColor={{ false: '#DFE1E6', true: colors.primary }}
                thumbColor={
                  Platform.OS === 'android'
                    ? preferences.swapApproved
                      ? colors.primaryDark
                      : '#FFFFFF'
                    : undefined
                }
              />
            </View>

            <View style={styles.prefDivider} />

            <View style={styles.prefRow}>
              <View style={styles.prefTextContainer}>
                <Text style={styles.prefTitle}>Swap Rejections</Text>
                <Text style={styles.prefDescription}>
                  Alerts when your swap request is rejected
                </Text>
              </View>
              <Switch
                value={preferences.swapRejected}
                onValueChange={(val) => handleTogglePreference('swapRejected', val)}
                disabled={savingKey === 'swapRejected'}
                trackColor={{ false: '#DFE1E6', true: colors.primary }}
                thumbColor={
                  Platform.OS === 'android'
                    ? preferences.swapRejected
                      ? colors.primaryDark
                      : '#FFFFFF'
                    : undefined
                }
              />
            </View>
          </View>
        )}
      </Card>

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