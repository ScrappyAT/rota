import { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchShift, unassignUser, assignUsers, updateShift, deleteShift, requestSwap, Shift } from '../../src/api/shifts';
import { fetchMembers, Member } from '../../src/api/members';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { useNetwork } from '../../src/context/NetworkContext';
import { saveCachedShiftDetail, getCachedShiftDetail, saveCachedMembers, getCachedMembers } from '../../src/storage/shiftCache';
import { ErrorState } from '../../src/components/ErrorState';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { formatRange } from '../../src/utils/dates';
import { Screen } from '../../src/components/ui/Screen';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { Input } from '../../src/components/ui/Input';
import { typography, spacing, colors, borderRadius } from '../../src/components/ui/theme';

export default function ShiftDetailScreen() {
  const { shiftId } = useLocalSearchParams<{ shiftId: string }>();
  const { team, role } = useTeam();
  const { user } = useAuth();
  const { isOffline } = useNetwork();
  const queryClient = useQueryClient();
  const teamId = team?.id ?? '';

  const [showPicker, setShowPicker] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [swapMember, setSwapMember] = useState<string>('');
  const [swapReason, setSwapReason] = useState('');
  const [swapMode, setSwapMode] = useState(false);

  const [cachedShift, setCachedShift] = useState<Shift | null>(null);
  const [cachedMembers, setCachedMembers] = useState<Member[] | null>(null);

  // Load persistent cache for this shift
  useEffect(() => {
    let active = true;
    if (user?.id && teamId && shiftId) {
      getCachedShiftDetail(user.id, teamId, shiftId).then((data) => {
        if (!active || !data) return;
        setCachedShift(data);
        const existing = queryClient.getQueryData(['shift', teamId, shiftId]);
        if (!existing) {
          queryClient.setQueryData(['shift', teamId, shiftId], data);
        }
      });
      getCachedMembers(user.id, teamId).then((data) => {
        if (active && data) setCachedMembers(data);
      });
    }
    return () => {
      active = false;
    };
  }, [user?.id, teamId, shiftId]);

  const shiftQuery = useQuery({
    queryKey: ['shift', teamId, shiftId],
    enabled: Boolean(teamId && shiftId),
    queryFn: async () => {
      const data = await fetchShift(teamId, shiftId);
      if (user?.id) {
        saveCachedShiftDetail(user.id, teamId, data).catch(() => {});
      }
      return data;
    },
    retry: (failureCount) => (isOffline ? false : failureCount < 1),
  });

  const membersQuery = useQuery({
    queryKey: ['members', teamId],
    enabled: Boolean(teamId),
    queryFn: async () => {
      const data = await fetchMembers(teamId);
      if (user?.id) {
        saveCachedMembers(user.id, teamId, data).catch(() => {});
      }
      return data;
    },
    retry: (failureCount) => (isOffline ? false : failureCount < 1),
  });

  const isManagerOrOwner = role === 'OWNER' || role === 'MANAGER';
  const shift = shiftQuery.data ?? cachedShift;
  const members = membersQuery.data ?? cachedMembers ?? [];

  const myAssignment = useMemo(() => {
    if (!shift || !user) return null;
    return (shift.assignments ?? []).find((a) => a.userId === user.id) ?? null;
  }, [shift, user]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['shifts', teamId] });
    queryClient.invalidateQueries({ queryKey: ['activity', teamId] });
    queryClient.invalidateQueries({ queryKey: ['swaps', teamId] });
    queryClient.invalidateQueries({ queryKey: ['shift', teamId, shiftId] });
  };

  const guardOffline = (actionName: string): boolean => {
    if (isOffline) {
      Alert.alert('Offline Mode', `Cannot ${actionName} while offline. Please connect to the internet.`);
      return true;
    }
    return false;
  };

  const unassign = useMutation({
    mutationFn: (userId: string) => {
      if (guardOffline('unassign staff')) throw new Error('Offline');
      return unassignUser(teamId, shiftId, userId);
    },
    onSuccess: invalidateAll,
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  const assign = useMutation({
    mutationFn: (userIds: string[]) => {
      if (guardOffline('assign staff')) throw new Error('Offline');
      return assignUsers(teamId, shiftId, userIds);
    },
    onSuccess: () => {
      setSelectedUsers([]);
      setShowPicker(false);
      invalidateAll();
    },
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  const cancelShift = useMutation({
    mutationFn: () => {
      if (guardOffline('update shift')) throw new Error('Offline');
      return updateShift(teamId, shiftId, { status: 'CANCELLED' });
    },
    onSuccess: invalidateAll,
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  const removeShift = useMutation({
    mutationFn: () => {
      if (guardOffline('delete shift')) throw new Error('Offline');
      return deleteShift(teamId, shiftId);
    },
    onSuccess: () => router.back(),
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  const swap = useMutation({
    mutationFn: () => {
      if (guardOffline('request swaps')) throw new Error('Offline');
      return requestSwap(teamId, shiftId, { offeredTo: swapMember || undefined, reason: swapReason || undefined });
    },
    onSuccess: () => {
      setSwapMode(false);
      setSwapMember('');
      setSwapReason('');
      Alert.alert('Done', 'Swap request submitted.');
      invalidateAll();
    },
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  useEffect(() => {
    setSelectedUsers([]);
    setShowPicker(false);
    setSwapMode(false);
  }, [shiftId]);

  if (shiftQuery.isPending && !shift) {
    return <Screen><Text style={typography.body}>Loading shift...</Text></Screen>;
  }

  if (shiftQuery.isError && !shift) {
    return (
      <Screen>
        <ErrorState message={isOffline ? "You are offline and this shift was not cached." : "Could not load this shift."} />
      </Screen>
    );
  }

  if (!shift) {
    return <Screen><ErrorState message="Shift not found." /></Screen>;
  }
  const assignedIds = new Set(shift.assignments?.map((a) => a.userId) ?? []);

  const renderAssignment = ({ item }: { item: Member }) => (
    <View style={styles.memberRow}>
      <Text style={typography.body}>
        {item.firstName} {item.lastName}
      </Text>
      {isManagerOrOwner && (
        <Button
          title="Unassign"
          variant="danger"
          size="small"
          disabled={isOffline}
          onPress={() => unassign.mutate(item.userId)}
        />
      )}
    </View>
  );

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={membersQuery.data?.filter((m) => assignedIds.has(m.userId)) ?? []}
      keyExtractor={(item) => item.userId}
      renderItem={renderAssignment}
      ListHeaderComponent={
        <View>
          {isOffline && (
            <View style={{ marginBottom: spacing.md }}>
              <OfflineBanner
                message="Offline Mode — Viewing cached shift"
                subMessage="Shift modifications are disabled while offline."
              />
            </View>
          )}

          <View style={styles.headerRow}>
            <Text style={[typography.h2, { flex: 1, marginRight: spacing.sm }]}>{shift.title}</Text>
            <View style={[styles.badge, shift.status === 'ACTIVE' ? styles.badgeActive : styles.badgeMuted]}>
              <Text style={[typography.label, shift.status === 'ACTIVE' ? styles.badgeTextActive : styles.badgeTextMuted]}>
                {shift.status}
              </Text>
            </View>
          </View>
          <Text style={[typography.bodySmall, { marginTop: spacing.xs }]}>{formatRange(shift.startsAt, shift.endsAt)}</Text>
          {shift.description ? <Text style={[typography.body, { marginTop: spacing.md }]}>{shift.description}</Text> : null}

          {swapMode ? (
            <Card style={styles.swapBox}>
              <Text style={typography.h3}>Request Swap</Text>
              <Text style={[typography.bodySmall, { marginVertical: spacing.sm }]}>Select a team member:</Text>
              {members
                .filter((m) => m.userId !== user?.id)
                .map((m) => (
                  <TouchableOpacity key={m.userId} onPress={() => setSwapMember(m.userId)} style={styles.memberOption}>
                    <Text style={[typography.body, swapMember === m.userId && { color: colors.primary, fontWeight: 'bold' }]}>
                      {swapMember === m.userId ? '✓ ' : ''}{m.firstName} {m.lastName}
                    </Text>
                  </TouchableOpacity>
                ))}
              <Input
                placeholder="Reason (optional)"
                value={swapReason}
                onChangeText={setSwapReason}
              />
              <View style={styles.buttonRow}>
                <Button title="Request swap" disabled={isOffline} onPress={() => swap.mutate()} />
                <Button title="Cancel" variant="ghost" onPress={() => setSwapMode(false)} />
              </View>
            </Card>
          ) : (
            myAssignment && !isManagerOrOwner && (
              <View style={styles.buttonRow}>
                <Button title="Request swap" disabled={isOffline} onPress={() => setSwapMode(true)} />
              </View>
            )
          )}

          {isManagerOrOwner && (
            <>
              <View style={styles.buttonRow}>
                <Button title="Assign staff" disabled={isOffline} onPress={() => setShowPicker((v) => !v)} />
                <Button
                  title={shift.status === 'ACTIVE' ? 'Cancel shift' : 'Reopen'}
                  variant="secondary"
                  disabled={isOffline}
                  onPress={() => cancelShift.mutate()}
                />
                <Button title="Delete" variant="danger" disabled={isOffline} onPress={() => removeShift.mutate()} />
              </View>

              {showPicker && (
                <Card style={styles.pickerBox}>
                  <Text style={typography.h3}>Select staff to assign</Text>
                  {members.map((m) => (
                    <TouchableOpacity key={m.userId} onPress={() => toggleSelected(selectedUsers, setSelectedUsers, m.userId)} style={styles.memberOption}>
                      <Text style={[typography.body, selectedUsers.includes(m.userId) && { color: colors.primary, fontWeight: 'bold' }]}>
                        {selectedUsers.includes(m.userId) ? '✓ ' : ''}{m.firstName} {m.lastName} ({m.role})
                      </Text>
                    </TouchableOpacity>
                  ))}
                  <View style={styles.buttonRow}>
                    <Button
                      title="Assign selected"
                      disabled={selectedUsers.length === 0}
                      onPress={() => assign.mutate(selectedUsers)}
                    />
                    <Button title="Close" variant="ghost" onPress={() => setShowPicker(false)} />
                  </View>
                </Card>
              )}
            </>
          )}

          <Text style={[typography.h3, { marginTop: spacing.xxl, marginBottom: spacing.md }]}>Assigned Staff</Text>
          {membersQuery.data?.filter((m) => assignedIds.has(m.userId)).length === 0 && (
            <Text style={typography.bodySmall}>Nobody assigned yet.</Text>
          )}
        </View>
      }
    />
  );
}

const toggleSelected = (
  current: string[],
  setter: (v: string[]) => void,
  id: string
) => {
  setter(current.includes(id) ? current.filter((x) => x !== id) : [...current, id]);
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: { padding: spacing.xl, paddingBottom: spacing.xxl * 2 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.round,
  },
  badgeActive: { backgroundColor: colors.success + '20' },
  badgeTextActive: { color: colors.success },
  badgeMuted: { backgroundColor: colors.border },
  badgeTextMuted: { color: colors.textSecondary },
  memberRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  buttonRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg, flexWrap: 'wrap' },
  swapBox: { marginTop: spacing.xl },
  pickerBox: { marginTop: spacing.xl },
  memberOption: {
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  }
});