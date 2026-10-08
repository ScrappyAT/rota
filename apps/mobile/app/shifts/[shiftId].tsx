import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchShift, unassignUser, assignUsers, updateShift, deleteShift, requestSwap } from '../../src/api/shifts';
import { fetchMembers, Member } from '../../src/api/members';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { Loading } from '../../src/components/Loading';
import { ErrorState } from '../../src/components/ErrorState';
import { formatRange } from '../../src/utils/dates';

export default function ShiftDetailScreen() {
  const { shiftId } = useLocalSearchParams<{ shiftId: string }>();
  const { team, role } = useTeam();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const teamId = team?.id ?? '';

  const [showPicker, setShowPicker] = useState(false);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [swapMember, setSwapMember] = useState<string>('');
  const [swapReason, setSwapReason] = useState('');
  const [swapMode, setSwapMode] = useState(false);

  const shiftQuery = useQuery({
    queryKey: ['shift', teamId, shiftId],
    enabled: Boolean(teamId && shiftId),
    queryFn: () => fetchShift(teamId, shiftId),
  });

  const membersQuery = useQuery({
    queryKey: ['members', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchMembers(teamId),
  });

  const isManagerOrOwner = role === 'OWNER' || role === 'MANAGER';

  const myAssignment = useMemo(() => {
    const s = shiftQuery.data;
    if (!s || !user) return null;
    return (s.assignments ?? []).find((a) => a.userId === user.id) ?? null;
  }, [shiftQuery.data, user]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['shifts', teamId] });
    queryClient.invalidateQueries({ queryKey: ['activity', teamId] });
    queryClient.invalidateQueries({ queryKey: ['swaps', teamId] });
    queryClient.invalidateQueries({ queryKey: ['shift', teamId, shiftId] });
  };

  const unassign = useMutation({
    mutationFn: (userId: string) => unassignUser(teamId, shiftId, userId),
    onSuccess: invalidateAll,
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const assign = useMutation({
    mutationFn: (userIds: string[]) => assignUsers(teamId, shiftId, userIds),
    onSuccess: () => {
      setSelectedUsers([]);
      setShowPicker(false);
      invalidateAll();
    },
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const cancelShift = useMutation({
    mutationFn: () => updateShift(teamId, shiftId, { status: 'CANCELLED' }),
    onSuccess: invalidateAll,
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const removeShift = useMutation({
    mutationFn: () => deleteShift(teamId, shiftId),
    onSuccess: () => router.back(),
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const swap = useMutation({
    mutationFn: () => requestSwap(teamId, shiftId, { offeredTo: swapMember || undefined, reason: swapReason || undefined }),
    onSuccess: () => {
      setSwapMode(false);
      setSwapMember('');
      setSwapReason('');
      Alert.alert('Done', 'Swap request submitted.');
      invalidateAll();
    },
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  useEffect(() => {
    setSelectedUsers([]);
    setShowPicker(false);
    setSwapMode(false);
  }, [shiftId]);

  if (shiftQuery.isPending) return <Loading message="Loading shift..." />;
  if (shiftQuery.isError) return <ErrorState message="Could not load this shift." />;

  const shift = shiftQuery.data;
  const assignedIds = new Set(shift.assignments?.map((a) => a.userId) ?? []);
  const members = membersQuery.data ?? [];

  const renderAssignment = ({ item }: { item: Member }) => (
    <View style={styles.memberRow}>
      <Text style={styles.memberName}>
        {item.firstName} {item.lastName}
      </Text>
      {isManagerOrOwner && (
        <Button title="Unassign" color="#ef4444" onPress={() => unassign.mutate(item.userId)} />
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
          <View style={styles.headerRow}>
            <Text style={styles.title}>{shift.title}</Text>
            <Text style={styles.status}>{shift.status}</Text>
          </View>
          <Text style={styles.meta}>{formatRange(shift.startsAt, shift.endsAt)}</Text>
          {shift.description ? <Text style={styles.description}>{shift.description}</Text> : null}

          {!myAssignment?.userId && !isManagerOrOwner ? null : (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Assignments ({shift.assignments?.length ?? 0})</Text>
            </View>
          )}

          {swapMode ? (
            <View style={styles.swapBox}>
              <Text style={styles.sectionTitle}>Request swap for this shift</Text>
              {members
                .filter((m) => m.userId !== user?.id)
                .map((m) => (
                  <Pressable key={m.userId} onPress={() => setSwapMember(m.userId)}>
                    <Text style={[styles.memberName, swapMember === m.userId && styles.selected]}>
                      {swapMember === m.userId ? '✓ ' : ''}
                      {m.firstName} {m.lastName}
                    </Text>
                  </Pressable>
                ))}
              <TextInput
                style={styles.input}
                placeholder="Reason (optional)"
                value={swapReason}
                onChangeText={setSwapReason}
                placeholderTextColor="#9ca3af"
              />
              <View style={styles.buttonRow}>
                <Button title="Request swap" onPress={() => swap.mutate()} />
                <Button title="Cancel" color="#6b7280" onPress={() => setSwapMode(false)} />
              </View>
            </View>
          ) : (
            myAssignment && !isManagerOrOwner && (
              <View style={styles.buttonRow}>
                <Button title="Request swap" onPress={() => setSwapMode(true)} />
              </View>
            )
          )}

          {isManagerOrOwner && (
            <>
              <View style={styles.buttonRow}>
                <Button title="Assign staff" onPress={() => setShowPicker((v) => !v)} />
                <Button title={shift.status === 'ACTIVE' ? 'Cancel shift' : 'Reopen'} onPress={() => cancelShift.mutate()} />
                <Button title="Delete" color="#ef4444" onPress={() => removeShift.mutate()} />
              </View>

              {showPicker && (
                <View style={styles.pickerBox}>
                  <Text style={styles.sectionTitle}>Select staff to assign</Text>
                  {members.map((m) => (
                    <Pressable key={m.userId} onPress={() => toggleSelected(selectedUsers, setSelectedUsers, m.userId)}>
                      <Text style={[styles.memberName, selectedUsers.includes(m.userId) && styles.selected]}>
                        {selectedUsers.includes(m.userId) ? '✓ ' : ''}
                        {m.firstName} {m.lastName} ({m.role})
                      </Text>
                    </Pressable>
                  ))}
                  <View style={styles.buttonRow}>
                    <Button
                      title="Assign selected"
                      disabled={selectedUsers.length === 0}
                      onPress={() => assign.mutate(selectedUsers)}
                    />
                    <Button title="Close" color="#6b7280" onPress={() => setShowPicker(false)} />
                  </View>
                </View>
              )}
            </>
          )}

          <Text style={styles.sectionTitle}>Assigned staff</Text>
          {membersQuery.data?.filter((m) => assignedIds.has(m.userId)).length === 0 && (
            <Text style={styles.empty}>Nobody assigned yet.</Text>
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
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 48 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { fontSize: 22, fontWeight: 'bold', flex: 1, marginRight: 8 },
  status: { fontWeight: '700', color: '#6b7280' },
  meta: { fontSize: 14, color: '#6b7280', marginTop: 6 },
  description: { fontSize: 15, color: '#374151', marginTop: 12 },
  section: { marginTop: 20 },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  memberRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#f3f4f6',
  },
  memberName: { fontSize: 15, color: '#111827', paddingVertical: 4 },
  selected: { color: '#2563eb', fontWeight: '700' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 16, flexWrap: 'wrap' },
  swapBox: { marginTop: 16, padding: 12, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10 },
  pickerBox: { marginTop: 16, padding: 12, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10 },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 10,
    marginTop: 8,
    fontSize: 15,
  },
  empty: { color: '#9ca3af', marginTop: 4 },
});