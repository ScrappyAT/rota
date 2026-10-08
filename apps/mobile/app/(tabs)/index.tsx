import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { fetchShifts } from '../../src/api/shifts';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { TeamGate } from '../../src/components/TeamGate';
import { TeamSelector } from '../../src/components/TeamSelector';
import { ErrorState } from '../../src/components/ErrorState';
import { formatRange } from '../../src/utils/dates';

export default function ShiftsScreen() {
  const { team } = useTeam();
  const { user } = useAuth();

  const teamId = team?.id ?? '';

  const canManage = team !== null;

  const query = useInfiniteQuery({
    queryKey: ['shifts', teamId],
    enabled: Boolean(teamId),
    queryFn: ({ pageParam }) => fetchShifts(teamId, { limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const renderItem = ({ item }: { item: { id: string; title: string; startsAt: string; endsAt: string; status: string } }) => (
    <Pressable style={styles.card} onPress={() => router.push(`/shifts/${item.id}`)}>
      <View style={styles.cardHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {item.title}
        </Text>
        <Text style={[styles.badge, item.status === 'ACTIVE' ? styles.badgeActive : styles.badgeMuted]}>{item.status}</Text>
      </View>
      <Text style={styles.cardMeta}>{formatRange(item.startsAt, item.endsAt)}</Text>
    </Pressable>
  );

  return (
    <View style={styles.container}>
      <TeamGate>
        <TeamSelector />

        {canManage && (
          <View style={styles.actions}>
            {user && (
              <Pressable style={styles.newButton} onPress={() => router.push('/shifts/new')}>
                <Text style={styles.newButtonText}>New Shift</Text>
              </Pressable>
            )}
          </View>
        )}

        {query.isError ? (
          <ErrorState message="Could not load shifts." />
        ) : (
          <FlatList
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            refreshControl={
              <RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />
            }
            onEndReached={() => {
              if (query.hasNextPage) query.fetchNextPage();
            }}
            onEndReachedThreshold={0.4}
            ListFooterComponent={query.isFetchingNextPage ? <ActivityIndicator /> : null}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>
                  {query.isPending ? 'No shifts yet.' : 'No shifts match.'}
                </Text>
              </View>
            }
          />
        )}
      </TeamGate>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  actions: { paddingHorizontal: 12, paddingBottom: 4 },
  newButton: {
    alignSelf: 'flex-start',
    backgroundColor: '#2563eb',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
  },
  newButtonText: { color: '#fff', fontWeight: '600' },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  card: {
    padding: 14,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '600', flex: 1, marginRight: 8 },
  badge: { fontSize: 11, fontWeight: '700', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, overflow: 'hidden' },
  badgeActive: { backgroundColor: '#dcfce7', color: '#166534' },
  badgeMuted: { backgroundColor: '#f3f4f6', color: '#6b7280' },
  cardMeta: { fontSize: 13, color: '#6b7280', marginTop: 6 },
  empty: { paddingVertical: 48, alignItems: 'center' },
  emptyText: { color: '#9ca3af' },
});