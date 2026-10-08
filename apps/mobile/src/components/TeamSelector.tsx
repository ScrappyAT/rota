import { ScrollView, Pressable, Text, StyleSheet } from 'react-native';
import { useTeam } from '../context/TeamContext';

export const TeamSelector = () => {
  const { teams, team, selectTeam } = useTeam();

  if (teams.length <= 1) return null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      testID="team-selector">
      {teams.map((t) => {
        const active = t.id === team?.id;
        return (
          <Pressable
            key={t.id}
            style={[styles.chip, active && styles.chipActive]}
            onPress={() => selectTeam(t.id)}>
            <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
              {t.name}
            </Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  row: { paddingHorizontal: 12, paddingVertical: 8, gap: 8 },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: '#eee',
  },
  chipActive: { backgroundColor: '#2563eb' },
  chipText: { color: '#333', fontWeight: '500' },
  chipTextActive: { color: '#fff' },
});