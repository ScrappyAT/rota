import { useRef } from 'react';
import { pageRequestGate, uniqueItems } from '../../src/query/mobileState';
import { useNetwork } from '../../src/context/NetworkContext';
import { Button } from '../../src/components/ui/Button';
import { FlatList, RefreshControl, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchActivity } from '../../src/api/activity';
import { useTeam } from '../../src/context/TeamContext';
import { TeamGate } from '../../src/components/TeamGate';
import { TeamSelector } from '../../src/components/TeamSelector';
import { ErrorState } from '../../src/components/ErrorState';
import { timeAgo } from '../../src/utils/dates';

interface ActivityItem {
  id: string;
  type: string;
  actorId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

const TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  SHIFT_CREATED: { bg: '#dbeafe', fg: '#1d4ed8' },
  SHIFT_UPDATED: { bg: '#fef3c7', fg: '#92400e' },
  SHIFT_DELETED: { bg: '#fee2e2', fg: '#b91c1c' },
  SHIFT_ASSIGNED: { bg: '#dcfce7', fg: '#166534' },
  SHIFT_UNASSIGNED: { bg: '#f3f4f6', fg: '#6b7280' },
  SWAP_REQUESTED: { bg: '#ede9fe', fg: '#6d28d9' },
  SWAP_APPROVED: { bg: '#dcfce7', fg: '#166534' },
  SWAP_REJECTED: { bg: '#fee2e2', fg: '#b91c1c' },
  SWAP_CANCELLED: { bg: '#f3f4f6', fg: '#6b7280' },
  MEMBER_JOINED: { bg: '#cffafe', fg: '#155e75' },
};

const defaultColor = { bg: '#f3f4f6', fg: '#374151' };

const payloadDetail = (type: string, payload: Record<string, unknown>): string => {
  const title = payload.shiftTitle as string | undefined;
  if (title) return title;
  const name = payload.actorName as string | undefined;
  if (name) return name;
  const email = payload.email as string | undefined;
  if (email) return email;
  return type.replace(/_/g, ' ').toLowerCase();
};

export default function ActivityScreen() {
  const { team } = useTeam();
  const teamId = team?.id ?? '';
  const { isOffline } = useNetwork();
  const gate = useRef(pageRequestGate());

  const query = useInfiniteQuery({
    queryKey: ['activity', teamId],
    enabled: Boolean(teamId) && !isOffline,
    queryFn: ({ pageParam }) => fetchActivity(teamId, { limit: 20, cursor: pageParam ?? undefined }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const items = uniqueItems(query.data?.pages.flatMap((p) => p.items) ?? []);

  const renderItem = ({ item }: { item: ActivityItem }) => {
    const color = TYPE_COLORS[item.type] ?? defaultColor;
    return (
      <View style={styles.card}>
        <View style={[styles.badge, { backgroundColor: color.bg }]}>
          <Text style={[styles.badgeText, { color: color.fg }]}>{item.type}</Text>
        </View>
        <Text style={styles.detail}>{payloadDetail(item.type, item.payload)}</Text>
        <Text style={styles.time}>{timeAgo(item.createdAt)}</Text>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <TeamGate>
        <TeamSelector />
        {query.isError && !items.length ? (
          <View><ErrorState message="Could not load activity." /><Button title="Retry" disabled={isOffline} onPress={() => { void (query.isFetchNextPageError ? query.fetchNextPage({ cancelRefetch: false }) : query.refetch()); }} /></View>
        ) : (
          <FlatList
            ListHeaderComponent={query.isError && !query.isFetchNextPageError ? <View><Text>Could not refresh activity.</Text><Button title="Retry refresh" disabled={isOffline} onPress={() => { void query.refetch(); }} /></View> : null}
            data={items}
            keyExtractor={(item) => item.id}
            renderItem={renderItem}
            contentContainerStyle={styles.list}
            refreshControl={
              <RefreshControl refreshing={query.isRefetching && !query.isFetchingNextPage} onRefresh={() => { if (!isOffline) void query.refetch(); }} />
            }
            onEndReached={() => {
              void gate.current(!isOffline && Boolean(query.hasNextPage) && !query.isFetching, () => query.fetchNextPage({ cancelRefetch: false }));
            }}
            onEndReachedThreshold={0.4}
            ListFooterComponent={query.isFetchingNextPage ? <ActivityIndicator accessibilityLabel="Loading more activity" /> : query.isFetchNextPageError ? <View><Text>Could not load more activity.</Text><Button title="Retry next page" disabled={isOffline} onPress={() => { void gate.current(!query.isFetching, () => query.fetchNextPage({ cancelRefetch: false })); }} /></View> : !query.hasNextPage && items.length > 0 ? <Text style={styles.empty}>You have reached the end.</Text> : null}
            ListEmptyComponent={
              isOffline ? <Text>Connect to load activity.</Text> : query.isPending ? <ActivityIndicator accessibilityLabel="Loading activity" /> : <Text style={styles.empty}>No activity yet.</Text>
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
  card: {
    padding: 12,
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    marginBottom: 10,
  },
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginBottom: 6,
  },
  badgeText: { fontSize: 11, fontWeight: '700' },
  detail: { fontSize: 15, color: '#111827' },
  time: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  empty: { textAlign: 'center', color: '#9ca3af', paddingVertical: 48 },
});