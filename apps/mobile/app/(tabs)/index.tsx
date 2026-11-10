import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Platform, RefreshControl, Text, View } from 'react-native';
import DateTimePicker from '@react-native-community/datetimepicker';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import { fetchShifts, Shift } from '../../src/api/shifts';
import { useAuth } from '../../src/context/AuthContext';
import { useTeam } from '../../src/context/TeamContext';
import { useNetwork } from '../../src/context/NetworkContext';
import { getUpcoming } from '../../src/storage/offlineData';
import { loadUpcoming } from '../../src/query/upcoming';
import { localDayRange, pageRequestGate, uniqueItems } from '../../src/query/mobileState';
import { TeamGate } from '../../src/components/TeamGate';
import { TeamSelector } from '../../src/components/TeamSelector';
import { OfflineBanner } from '../../src/components/OfflineBanner';
import { Screen } from '../../src/components/ui/Screen';
import { Button } from '../../src/components/ui/Button';
import { Card } from '../../src/components/ui/Card';
import { formatRange } from '../../src/utils/dates';
export default function ShiftsScreen() {
  const { user } = useAuth(), { team, role } = useTeam(), { isOffline } = useNetwork(), client = useQueryClient();
  const userId = user?.id ?? '', teamId = team?.id ?? '';
  const [day, setDay] = useState(new Date()), [picker, setPicker] = useState(false), [view, setView] = useState<'upcoming' | 'calendar'>('upcoming');
  const gate = useRef(pageRequestGate());
  const upcomingKey = ['shifts', teamId, userId, 'upcoming'] as const;
  const upcoming = useQuery({ queryKey: upcomingKey, enabled: Boolean(userId && teamId) && !isOffline,
    queryFn: () => loadUpcoming(userId, teamId), staleTime: 30_000 });
  useEffect(() => {
    let active = true;
    if (userId && teamId) void getUpcoming(userId, teamId).then(saved => {
      if (active && saved && (!client.getQueryState(upcomingKey)?.dataUpdatedAt || client.getQueryState(upcomingKey)!.dataUpdatedAt < saved.cachedAt)) client.setQueryData(upcomingKey, saved, { updatedAt: saved.cachedAt });
    });
    return () => { active = false; };
  }, [userId, teamId, client, isOffline]);
  const range = localDayRange(day);
  const calendar = useInfiniteQuery({ queryKey: ['shifts', teamId, userId, 'calendar', range.from], enabled: Boolean(teamId) && !isOffline && view === 'calendar',
    queryFn: ({ pageParam }) => fetchShifts(teamId, { ...range, limit: 20, cursor: pageParam }), initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined });
  const ownView = view === 'upcoming' || isOffline;
  const items = ownView ? upcoming.data?.items.filter(s => Date.parse(s.startsAt) >= Date.now()) ?? [] : uniqueItems(calendar.data?.pages.flatMap(p => p.items) ?? []);
  const pending = ownView ? upcoming.isFetching : calendar.isPending;
  const error = ownView ? upcoming.error : calendar.error;
  const refresh = async () => { if (!isOffline) { if (ownView) await upcoming.refetch(); else await calendar.refetch(); } };
  const move = (delta: number) => { const next = new Date(day); next.setDate(next.getDate() + delta); setDay(next); };
  const row = ({ item }: { item: Shift }) => <Card><Button variant="ghost" title={item.title} disabled={isOffline} onPress={() => router.push({ pathname: '/shifts/[shiftId]', params: { shiftId: item.id, teamId } })} /><Text>{formatRange(item.startsAt, item.endsAt)}</Text><Text>{item.status}</Text></Card>;
  return <Screen scrollable={false}><TeamGate>
    <TeamSelector />
    {isOffline ? <OfflineBanner message="Offline / read-only" subMessage="Showing your saved upcoming shifts. Reconnect to verify your session and make changes." /> : null}
    <View style={{ flexDirection: 'row', gap: 8 }}><Button title="My upcoming shifts" onPress={() => setView('upcoming')} /><Button title="Team calendar" disabled={isOffline} onPress={() => setView('calendar')} /></View>
    {ownView ? <Text>Last updated: {upcoming.data ? new Date(upcoming.data.cachedAt).toLocaleString() : 'No saved shifts yet'}</Text> : <>
      <View style={{ flexDirection: 'row', gap: 8 }}><Button title="Previous day" onPress={() => move(-1)} /><Button title="Today" onPress={() => setDay(new Date())} /><Button title="Next day" onPress={() => move(1)} /></View>
      <Button title={day.toLocaleDateString()} variant="secondary" onPress={() => setPicker(true)} />
      {picker ? <DateTimePicker value={day} mode="date" onChange={(_event, value) => { setPicker(Platform.OS === 'ios'); if (value) setDay(value); }} /> : null}
    </>}
    {(role === 'OWNER' || role === 'MANAGER') && !isOffline ? <Button title="Create shift" onPress={() => router.push('/shifts/new')} /> : null}
    {error && !isOffline ? <View><Text accessibilityRole="alert">Could not refresh shifts. {error.message}</Text><Button title="Retry" onPress={() => { void refresh(); }} /></View> : null}
    <FlatList data={items} keyExtractor={item => item.id} renderItem={row} refreshControl={<RefreshControl refreshing={!isOffline && (ownView ? upcoming.isFetching : calendar.isRefetching)} onRefresh={() => { void refresh(); }} />}
      onEndReached={() => { void gate.current(!ownView && !isOffline && Boolean(calendar.hasNextPage) && !calendar.isFetching, () => calendar.fetchNextPage({ cancelRefetch: false })); }}
      ListEmptyComponent={pending && !isOffline ? <ActivityIndicator accessibilityLabel="Loading shifts" /> : <Text>{isOffline && !upcoming.data ? 'No saved upcoming shifts for this account and team.' : ownView ? 'No upcoming assigned shifts.' : 'No shifts on this day.'}</Text>}
      ListFooterComponent={!ownView && calendar.isFetchingNextPage ? <ActivityIndicator /> : null} />
  </TeamGate></Screen>;
}
