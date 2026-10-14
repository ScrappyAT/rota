import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View, ActivityIndicator, Alert } from 'react-native';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchSwaps, approveSwap, rejectSwap, cancelSwap } from '../../src/api/swaps';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { useNetwork } from '../../src/context/NetworkContext';
import { TeamGate } from '../../src/components/TeamGate';
import { TeamSelector } from '../../src/components/TeamSelector';
import { ErrorState } from '../../src/components/ErrorState';
import { OfflineBanner } from '../../src/components/OfflineBanner';
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
  requesterName?: string | null;
  requesterEmail?: string | null;
  offeredToName?: string | null;
  offeredToEmail?: string | null;
}

const formatRequester = (item: SwapItem) =>
  item.requesterName || item.requesterEmail || (item.requestedBy ? item.requestedBy.slice(0, 8) : 'Teammate');

const formatOfferedTo = (item: SwapItem) => {
  if (!item.offeredTo) {
    return 'Open request (any teammate)';
  }
  const name = item.offeredToName || item.offeredToEmail || item.offeredTo.slice(0, 8);
  return `Offered to ${name}`;
};

export default function SwapsScreen() {
  const { team, role } = useTeam();
  const { user } = useAuth();
  const { isOffline } = useNetwork();
  const queryClient = useQueryClient();
  const teamId = team?.id ?? '';

  const query = useInfiniteQuery({
    queryKey: ['swaps', teamId],
    enabled: Boolean(teamId),
    queryFn: ({ pageParam }) => fetchSwaps(teamId, { limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: (failureCount) => (isOffline ? false : failureCount < 1),
  });

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ['swaps', teamId] });
    queryClient.invalidateQueries({ queryKey: ['shifts', teamId] });
    queryClient.invalidateQueries({ queryKey: ['shift', teamId] });
    queryClient.invalidateQueries({ queryKey: ['activity', teamId] });
  };

  const guardOffline = (action: string) => {
    if (isOffline) {
      Alert.alert('Offline Mode', `Cannot ${action} swaps while offline. Please connect to the internet.`);
      return true;
    }
    return false;
  };

  const approve = useMutation({
    mutationFn: (swapId: string) => {
      if (guardOffline('approve')) throw new Error('Offline');
      return approveSwap(teamId, swapId);
    },
    onSuccess: invalidateAll,
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  const reject = useMutation({
    mutationFn: (swapId: string) => {
      if (guardOffline('reject')) throw new Error('Offline');
      return rejectSwap(teamId, swapId, 'Rejected from the app');
    },
    onSuccess: invalidateAll,
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
  });

  const cancel = useMutation({
    mutationFn: (swapId: string) => {
      if (guardOffline('cancel')) throw new Error('Offline');
      return cancelSwap(teamId, swapId);
    },
    onSuccess: invalidateAll,
    onError: (e) => {
      if ((e as Error).message !== 'Offline') Alert.alert('Error', (e as Error).message);
    },
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
        <Text style={styles.cardMeta}>
          Requested by {formatRequester(item)} · {formatOfferedTo(item)}
        </Text>
        {item.reason ? <Text style={styles.reason}>“{item.reason}”</Text> : null}
        <Text style={styles.time}>{timeAgo(item.createdAt)}</Text>

        {pending && (
          <View style={styles.actions}>
            {isManagerOrOwner && (
              <>
                <Pressable
                  style={[styles.button, styles.approve, (approve.isPending || reject.isPending) && { opacity: 0.6 }]}
                  disabled={approve.isPending || reject.isPending}
                  onPress={() => approve.mutate(item.id)}
                >
                  <Text style={styles.buttonText}>{approve.isPending ? 'Approving...' : 'Approve'}</Text>
                </Pressable>
                <Pressable
                  style={[styles.button, styles.reject, (approve.isPending || reject.isPending) && { opacity: 0.6 }]}
                  disabled={approve.isPending || reject.isPending}
                  onPress={() => reject.mutate(item.id)}
                >
                  <Text style={styles.buttonText}>{reject.isPending ? 'Rejecting...' : 'Reject'}</Text>
                </Pressable>
              </>
            )}
            {user && item.requestedBy === user.id && (
              <Pressable
                style={[styles.button, styles.cancel, cancel.isPending && { opacity: 0.6 }]}
                disabled={cancel.isPending}
                onPress={() => cancel.mutate(item.id)}
              >
                <Text style={styles.buttonText}>{cancel.isPending ? 'Cancelling...' : 'Cancel'}</Text>
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
        {isOffline && (
          <OfflineBanner
            message="Offline Mode"
            subMessage="Managing swaps requires an internet connection."
          />
        )}
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