import { useState, useEffect } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View, ActivityIndicator, TouchableOpacity, Alert } from 'react-native';
import { useInfiniteQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import { fetchShifts } from '../../src/api/shifts';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { useNetwork } from '../../src/context/NetworkContext';
import { saveCachedShifts, getCachedShifts, CachedShiftsData } from '../../src/storage/shiftCache';
import { queryClient } from '../../src/query/queryClient';
import { TeamGate } from '../../src/components/TeamGate';
import { TeamSelector } from '../../src/components/TeamSelector';
import { ErrorState } from '../../src/components/ErrorState';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { formatRange } from '../../src/utils/dates';
import { Screen } from '../../src/components/ui/Screen';
import { Card } from '../../src/components/ui/Card';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing, colors, borderRadius } from '../../src/components/ui/theme';

export default function ShiftsScreen() {
  const { team, role } = useTeam();
  const { user } = useAuth();
  const { isOffline } = useNetwork();
  const teamId = team?.id ?? '';
  const canManage = role === 'OWNER' || role === 'MANAGER';

  const [cachedData, setCachedData] = useState<CachedShiftsData | null>(null);

  // Load persistent cache on mount or when user/team changes
  useEffect(() => {
    let active = true;
    if (user?.id && teamId) {
      getCachedShifts(user.id, teamId).then((data) => {
        if (!active || !data) return;
        setCachedData(data);

        // Pre-populate query client if no active in-memory cache exists
        const existing = queryClient.getQueryData(['shifts', teamId]);
        if (!existing && data.items.length > 0) {
          queryClient.setQueryData(['shifts', teamId], {
            pages: [{ items: data.items, nextCursor: data.nextCursor }],
            pageParams: [undefined],
          });
        }
      });
    }
    return () => {
      active = false;
    };
  }, [user?.id, teamId]);

  const query = useInfiniteQuery({
    queryKey: ['shifts', teamId],
    enabled: Boolean(teamId),
    queryFn: async ({ pageParam }) => {
      const res = await fetchShifts(teamId, { limit: 20, cursor: pageParam ?? undefined });
      if (user?.id && res.items) {
        saveCachedShifts(user.id, teamId, res.items, res.nextCursor ?? undefined).catch(() => {});
      }
      return res;
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    retry: (failureCount) => (isOffline ? false : failureCount < 1),
  });

  const queryItems = query.data?.pages.flatMap((p) => p.items) ?? [];
  // Use live query items if available, otherwise seamlessly fallback to persistent cache
  const items = queryItems.length > 0 ? queryItems : (cachedData?.items ?? []);
  const hasShifts = items.length > 0;

  const handleCreateShiftPress = () => {
    if (isOffline) {
      Alert.alert('Offline Mode', 'Cannot create shifts while offline. Please connect to the internet.');
      return;
    }
    router.push('/shifts/new');
  };

  const renderItem = ({ item }: { item: { id: string; title: string; startsAt: string; endsAt: string; status: string } }) => (
    <TouchableOpacity activeOpacity={0.8} onPress={() => router.push(`/shifts/${item.id}`)}>
      <Card style={styles.card}>
        <View style={styles.cardHeader}>
          <Text style={[typography.h3, { flex: 1, marginRight: spacing.sm }]} numberOfLines={1}>
            {item.title}
          </Text>
          <View style={[styles.badge, item.status === 'ACTIVE' ? styles.badgeActive : styles.badgeMuted]}>
            <Text style={[typography.label, item.status === 'ACTIVE' ? styles.badgeTextActive : styles.badgeTextMuted]}>
              {item.status}
            </Text>
          </View>
        </View>
        <Text style={[typography.bodySmall, { marginTop: spacing.xs }]}>{formatRange(item.startsAt, item.endsAt)}</Text>
      </Card>
    </TouchableOpacity>
  );

  return (
    <Screen style={styles.container} scrollable={false}>
      <TeamGate>
        {isOffline && <OfflineBanner />}

        <View style={styles.header}>
          <TeamSelector />
        </View>

        {canManage && user && (
          <View style={styles.actions}>
            <Button
              title={isOffline ? "Create Shift (Offline)" : "Create Shift"}
              onPress={handleCreateShiftPress}
              disabled={isOffline}
            />
          </View>
        )}

        {query.isError && !hasShifts ? (
          <ErrorState message={isOffline ? "You are offline and no cached shifts were found." : "Could not load shifts."} />
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
              if (!isOffline && query.hasNextPage) query.fetchNextPage();
            }}
            onEndReachedThreshold={0.4}
            ListFooterComponent={query.isFetchingNextPage ? <ActivityIndicator color={colors.primary} style={{ margin: spacing.md }} /> : null}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={typography.bodySmall}>
                  {query.isPending && !hasShifts
                    ? 'Loading shifts...'
                    : isOffline && !hasShifts
                    ? 'You are offline and no shifts have been cached yet.'
                    : 'No shifts match.'}
                </Text>
              </View>
            }
          />
        )}
      </TeamGate>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: 0 },
  header: {
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
  },
  actions: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    paddingTop: spacing.sm,
  },
  list: {
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.xxl,
    paddingTop: spacing.sm,
  },
  card: {
    marginBottom: spacing.md,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  badge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: borderRadius.round,
  },
  badgeActive: { backgroundColor: colors.success + '20' },
  badgeTextActive: { color: colors.success },
  badgeMuted: { backgroundColor: colors.border },
  badgeTextMuted: { color: colors.textSecondary },
  empty: { paddingVertical: spacing.xxl, alignItems: 'center' },
});