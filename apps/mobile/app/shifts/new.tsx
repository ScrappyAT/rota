import { useMemo, useState } from 'react';
import { Alert, Button, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createShift } from '../../src/api/shifts';
import { fetchMembers } from '../../src/api/members';
import { useTeam } from '../../src/context/TeamContext';
import { Loading } from '../../src/components/Loading';
import { formatDateTime } from '../../src/utils/dates';

const START_PRESETS = [
  { key: 'today-9', label: 'Today 09:00', dayOffset: 0, hour: 9 },
  { key: 'today-13', label: 'Today 13:00', dayOffset: 0, hour: 13 },
  { key: 'today-17', label: 'Today 17:00', dayOffset: 0, hour: 17 },
  { key: 'tomorrow-9', label: 'Tomorrow 09:00', dayOffset: 1, hour: 9 },
];

const DURATIONS = [
  { key: '4', label: '4h', hours: 4 },
  { key: '8', label: '8h', hours: 8 },
  { key: '12', label: '12h', hours: 12 },
];

const buildDateTime = (dayOffset: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
};

export default function NewShiftScreen() {
  const { team } = useTeam();
  const queryClient = useQueryClient();
  const teamId = team?.id ?? '';

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startKey, setStartKey] = useState('tomorrow-9');
  const [durationKey, setDurationKey] = useState('8');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);

  const membersQuery = useQuery({
    queryKey: ['members', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchMembers(teamId),
  });

  const create = useMutation({
    mutationFn: async () => {
      const start = START_PRESETS.find((s) => s.key === startKey)!;
      const duration = DURATIONS.find((d) => d.key === durationKey)!;
      const startsAt = buildDateTime(start.dayOffset, start.hour);
      const endsAt = new Date(new Date(startsAt).getTime() + duration.hours * 3600_000).toISOString();
      return createShift(teamId, {
        title: title.trim(),
        description: description.trim() || undefined,
        startsAt,
        endsAt,
        assigneeIds: assigneeIds.length ? assigneeIds : undefined,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['shifts', teamId] });
      queryClient.invalidateQueries({ queryKey: ['activity', teamId] });
      Alert.alert('Done', 'Shift created.');
      router.back();
    },
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const selectedStart = useMemo(() => START_PRESETS.find((s) => s.key === startKey)!, [startKey]);
  const selectedDuration = useMemo(() => DURATIONS.find((d) => d.key === durationKey)!, [durationKey]);
  const previewStart = buildDateTime(selectedStart.dayOffset, selectedStart.hour);
  const previewEnd = new Date(new Date(previewStart).getTime() + selectedDuration.hours * 3600_000).toISOString();

  const members = membersQuery.data ?? [];

  return (
    <FlatList
      style={styles.container}
      contentContainerStyle={styles.content}
      data={members}
      keyExtractor={(item) => item.userId}
      renderItem={({ item }) => (
        <Pressable
          onPress={() =>
            setAssigneeIds((cur) =>
              cur.includes(item.userId) ? cur.filter((id) => id !== item.userId) : [...cur, item.userId]
            )
          }>
          <Text style={[styles.memberName, assigneeIds.includes(item.userId) && styles.selected]}>
            {assigneeIds.includes(item.userId) ? '✓ ' : ''}
            {item.firstName} {item.lastName} ({item.role})
          </Text>
        </Pressable>
      )}
      ListHeaderComponent={
        <View>
          <Text style={styles.label}>Title</Text>
          <TextInput style={styles.input} placeholder="e.g. Evening kitchen shift" value={title} onChangeText={setTitle} placeholderTextColor="#9ca3af" />

          <Text style={styles.label}>Description (optional)</Text>
          <TextInput style={styles.input} placeholder="Notes for the team" value={description} onChangeText={setDescription} placeholderTextColor="#9ca3af" />

          <Text style={styles.label}>Start</Text>
          <View style={styles.chips}>
            {START_PRESETS.map((s) => (
              <Pressable key={s.key} style={[styles.chip, startKey === s.key && styles.chipActive]} onPress={() => setStartKey(s.key)}>
                <Text style={[styles.chipText, startKey === s.key && styles.chipTextActive]}>{s.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Duration</Text>
          <View style={styles.chips}>
            {DURATIONS.map((d) => (
              <Pressable key={d.key} style={[styles.chip, durationKey === d.key && styles.chipActive]} onPress={() => setDurationKey(d.key)}>
                <Text style={[styles.chipText, durationKey === d.key && styles.chipTextActive]}>{d.label}</Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.preview}>
            {formatDateTime(previewStart)} → {formatDateTime(previewEnd)}
          </Text>

          <Text style={styles.sectionTitle}>Assign staff (optional)</Text>
          {members.length === 0 && <Text style={styles.empty}>No staff to assign.</Text>}

          <View style={styles.buttonRow}>
            <Button
              title="Create shift"
              disabled={!title.trim() || create.isPending}
              onPress={() => create.mutate()}
            />
            <Button title="Cancel" color="#6b7280" onPress={() => router.back()} />
          </View>
          {create.isPending && <Loading message="Creating shift..." />}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  content: { padding: 20, paddingBottom: 48 },
  label: { fontSize: 14, fontWeight: '600', marginTop: 16, marginBottom: 6, color: '#374151' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 10,
    fontSize: 15,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 16, backgroundColor: '#eee' },
  chipActive: { backgroundColor: '#2563eb' },
  chipText: { color: '#333', fontWeight: '500' },
  chipTextActive: { color: '#fff' },
  preview: { marginTop: 12, fontSize: 13, color: '#374151' },
  sectionTitle: { fontSize: 16, fontWeight: '600', marginTop: 20, marginBottom: 8 },
  memberName: { fontSize: 15, color: '#111827', paddingVertical: 6 },
  selected: { color: '#2563eb', fontWeight: '700' },
  buttonRow: { flexDirection: 'row', gap: 10, marginTop: 20 },
  empty: { color: '#9ca3af' },
});