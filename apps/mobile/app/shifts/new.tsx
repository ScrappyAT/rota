import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert, Platform } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import DateTimePicker from '@react-native-community/datetimepicker';
import { createShift } from '../../src/api/shifts';
import { fetchMembers, Member } from '../../src/api/members';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { useNetwork } from '../../src/context/NetworkContext';
import { getCachedMembers } from '../../src/storage/shiftCache';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors, borderRadius } from '../../src/components/ui/theme';

export default function NewShiftScreen() {
  const { team } = useTeam();
  const { user } = useAuth();
  const { isOffline } = useNetwork();
  const queryClient = useQueryClient();
  const teamId = team?.id ?? '';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  const [startsAt, setStartsAt] = useState(new Date());
  const [endsAt, setEndsAt] = useState(new Date(Date.now() + 8 * 3600 * 1000));

  const [showStartPicker, setShowStartPicker] = useState(false);
  const [showStartMode, setShowStartMode] = useState<'date' | 'time'>('date');

  const [showEndPicker, setShowEndPicker] = useState(false);
  const [showEndMode, setShowEndMode] = useState<'date' | 'time'>('date');

  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [cachedMembers, setCachedMembers] = useState<Member[] | null>(null);

  useEffect(() => {
    if (user?.id && teamId) {
      getCachedMembers(user.id, teamId).then((m) => {
        if (m) setCachedMembers(m);
      });
    }
  }, [user?.id, teamId]);

  const membersQuery = useQuery({
    queryKey: ['members', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchMembers(teamId),
    retry: (failureCount) => (isOffline ? false : failureCount < 1),
  });

  const create = useMutation({
    mutationFn: async () => {
      if (isOffline) {
        Alert.alert('Offline Mode', 'Cannot create shifts while offline. Please connect to the internet.');
        throw new Error('Offline');
      }
      return createShift(teamId, {
        title: title.trim(),
        description: description.trim() || undefined,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        assigneeIds: assigneeIds.length ? assigneeIds : undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shifts', teamId] });
      queryClient.invalidateQueries({ queryKey: ['activity', teamId] });
      Alert.alert('Success', 'Shift created successfully');
      router.back();
    },
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  const handleStartDateChange = (event: any, selectedDate?: Date) => {
    setShowStartPicker(Platform.OS === 'ios');
    if (selectedDate) {
      setStartsAt(selectedDate);
      if (Platform.OS === 'android' && showStartMode === 'date') {
        setShowStartMode('time');
        setShowStartPicker(true);
      }
    }
  };

  const handleEndDateChange = (event: any, selectedDate?: Date) => {
    setShowEndPicker(Platform.OS === 'ios');
    if (selectedDate) {
      setEndsAt(selectedDate);
      if (Platform.OS === 'android' && showEndMode === 'date') {
        setShowEndMode('time');
        setShowEndPicker(true);
      }
    }
  };

  const members = membersQuery.data ?? cachedMembers ?? [];

  return (
    <Screen style={styles.container} scrollable={true}>
      {isOffline && (
        <View style={{ marginBottom: spacing.md }}>
          <OfflineBanner
            message="Offline Mode"
            subMessage="Shift creation is disabled while offline."
          />
        </View>
      )}

      <Text style={[typography.h2, { marginBottom: spacing.lg }]}>Create Shift</Text>

      <Input
        label="Title"
        placeholder="e.g. Morning Shift"
        value={title}
        onChangeText={setTitle}
        editable={!create.isPending}
      />

      <Input
        label="Description (optional)"
        placeholder="Notes for the team"
        value={description}
        onChangeText={setDescription}
        editable={!create.isPending}
      />

      <View style={styles.datePickerContainer}>
        <Text style={typography.label}>Start Date & Time</Text>
        <TouchableOpacity
          style={styles.datePickerButton}
          onPress={() => { setShowStartMode('date'); setShowStartPicker(true); }}
        >
          <Text style={typography.body}>{startsAt.toLocaleString()}</Text>
        </TouchableOpacity>
        {showStartPicker && (
          <DateTimePicker
            value={startsAt}
            mode={showStartMode}
            is24Hour={true}
            display="default"
            onChange={handleStartDateChange}
          />
        )}
      </View>

      <View style={styles.datePickerContainer}>
        <Text style={typography.label}>End Date & Time</Text>
        <TouchableOpacity
          style={styles.datePickerButton}
          onPress={() => { setShowEndMode('date'); setShowEndPicker(true); }}
        >
          <Text style={typography.body}>{endsAt.toLocaleString()}</Text>
        </TouchableOpacity>
        {showEndPicker && (
          <DateTimePicker
            value={endsAt}
            mode={showEndMode}
            is24Hour={true}
            display="default"
            onChange={handleEndDateChange}
            minimumDate={startsAt}
          />
        )}
      </View>

      <Text style={[typography.label, { marginTop: spacing.lg, marginBottom: spacing.sm }]}>Assign Staff</Text>

      {members.length === 0 ? (
        <Text style={typography.bodySmall}>No team members found.</Text>
      ) : (
        <View style={styles.membersList}>
          {members.map(member => (
            <TouchableOpacity
              key={member.userId}
              style={[
                styles.memberItem,
                assigneeIds.includes(member.userId) && styles.memberItemSelected
              ]}
              onPress={() => {
                setAssigneeIds(prev =>
                  prev.includes(member.userId)
                    ? prev.filter(id => id !== member.userId)
                    : [...prev, member.userId]
                );
              }}
            >
              <Text style={[
                typography.body,
                assigneeIds.includes(member.userId) && { color: colors.primary, fontWeight: 'bold' }
              ]}>
                {member.firstName} {member.lastName} ({member.role})
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <View style={styles.actions}>
        <Button
          title={isOffline ? 'Create Shift (Offline)' : create.isPending ? 'Creating...' : 'Create Shift'}
          disabled={!title.trim() || create.isPending || isOffline}
          onPress={() => create.mutate()}
        />
        <Button
          title="Cancel"
          variant="ghost"
          onPress={() => router.back()}
          disabled={create.isPending}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.xl },
  datePickerContainer: {
    marginBottom: spacing.md,
  },
  datePickerButton: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    padding: spacing.md,
    marginTop: spacing.xs,
  },
  membersList: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: borderRadius.md,
    overflow: 'hidden',
  },
  memberItem: {
    padding: spacing.md,
    backgroundColor: colors.card,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  memberItemSelected: {
    backgroundColor: colors.secondary,
  },
  actions: {
    marginTop: spacing.xxl,
    marginBottom: spacing.xxl,
    gap: spacing.md,
  }
});