import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, ActivityIndicator, Alert } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSwaps, approveSwap, rejectSwap, cancelSwap } from '../../src/api/swaps';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { TeamGate } from '../../src/components/TeamGate';
import { TeamSelector } from '../../src/components/TeamSelector';
import { ErrorState } from '../../src/components/ErrorState';
import { formatRange, timeAgo } from '../../src/utils/dates';

interface SwapItem {
  id: string;
  shiftId: string;
  requestedBy: string;
  offeredTo: string | null;
  status: string;
  reason: string | null;
  shiftTitle: string;
  shiftStartsAt: string;
  shiftEndsAt: string;
  createdAt: string;
}

const shortId = (id: string | null) => (id ? id.slice(0, 8) : '—');

export default function SwapsScreen() {
  const { team, role } = useTeam();
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const teamId = team?.id ?? '';

  const query = useInfiniteQuery({
    queryKey: ['swaps', teamId],
    enabled: Boolean(teamId),
    queryFn: ({ pageParam }) => fetchSwaps(teamId, { limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const invalidateAll = () =>
    queryClient.invalidateQueries({ queryKey: ['swaps', teamId] });

  const approve = useMutation({
    mutationFn: (swapId: string) => approveSwap(teamId, swapId),
    onSuccess: invalidateAll,
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const reject = useMutation({
    mutationFn: (swapId: string) => rejectSwap(teamId, swapId, 'Rejected from the app'),
    onSuccess: invalidateAll,
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const cancel = useMutation({
    mutationFn: (swapId: string) => cancelSwap(teamId, swapId),
    onSuccess: invalidateAll,
    onError: (e) => Alert.alert('Error', (e as Error).message),
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];

  const isManagerOrOwner = role === 'OWNER' || role === 'MANAGER';

  const renderItem = ({ item }: { item: SwapItem }) => {
    const pending = item.status === 'PENDING';
    return (
      <View style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {item.shiftTitle}
          </Text>
          <Text style={styles.status}>{item.status}</Text>
        </View>
        <Text style={styles.cardMeta}>{formatRange(item.shiftStartsAt, item.shiftEndsAt)}</Text>
        <Text style={styles.cardMeta}>Requested by {shortId(item.requestedBy)} · offered to {shortId(item.offeredTo)}</Text>
        {item.reason ? <Text style={styles.reason}>“{item.reason}”</Text> : null}
        <Text style={styles.time}>{timeAgo(item.createdAt)}</Text>

        {pending && (
          <View style={styles.actions}>
            {isManagerOrOwner && (
              <>
                <Pressable style={[styles.button, styles.approve]} onPress={() => approve.mutate(item.id)}>
                  <Text style={styles.buttonText}>Approve</Text>
                </Pressable>
                <Pressable style={[styles.button, styles.reject]} onPress={() => reject.mutate(item.id)}>
                  <Text style={styles.buttonText}>Reject</Text>
                </Pressable>
              </>
            )}
            {user && item.requestedBy === user.id && (
              <Pressable style={[styles.button, styles.cancel]} onPress={() => cancel.mutate(item.id)}>
                <Text style={styles.buttonText}>Cancel</Text>
              </Pressable>
            )}
          </View>
        )}
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <TeamGate>
        <TeamSelector />
        {query.isError ? (
          <ErrorState message="Could not load swap requests." />
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
              query.isPending ? null : <Text style={styles.empty}>No swap requests.</Text>
            }
          />
        )}
      </TeamGate>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  list: { paddingHorizontal: 12, paddingBottom: 24 },
  card: { padding: 14, borderWidth: 1, borderColor: '#e5e7eb', borderRadius: 10, marginBottom: 10 },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardTitle: { fontSize: 16, fontWeight: '600', flex: 1, marginRight: 8 },
  status: { fontSize: 12, fontWeight: '700', color: '#6b7280' },
  cardMeta: { fontSize: 13, color: '#6b7280', marginTop: 4 },
  reason: { fontStyle: 'italic', color: '#374151', marginTop: 6 },
  time: { fontSize: 12, color: '#9ca3af', marginTop: 6 },
  actions: { flexDirection: 'row', gap: 10, marginTop: 12 },
  button: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 8 },
  approve: { backgroundColor: '#16a34a' },
  reject: { backgroundColor: '#ef4444' },
  cancel: { backgroundColor: '#6b7280' },
  buttonText: { color: '#fff', fontWeight: '600' },
  empty: { textAlign: 'center', color: '#9ca3af', paddingVertical: 48 },
});