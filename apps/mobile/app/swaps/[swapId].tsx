import { Text, View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTeam } from '../../src/context/TeamContext';
import { useAuth } from '../../src/context/AuthContext';
import { useNetwork } from '../../src/context/NetworkContext';
import { fetchSwap, approveSwap, rejectSwap } from '../../src/api/swaps';
import { Screen } from '../../src/components/ui/Screen';
import { Button } from '../../src/components/ui/Button';
import { formatRange } from '../../src/utils/dates';
export default function SwapDetailScreen() {
  const { swapId, teamId: targetTeam } = useLocalSearchParams<{
    swapId: string;
    teamId?: string;
  }>();
  const { team, role } = useTeam();
  const { user } = useAuth();
  const { isOffline } = useNetwork();
  const client = useQueryClient();
  const teamId = targetTeam ?? team?.id ?? '';
  const query = useQuery({ queryKey: ['swap', teamId, swapId], queryFn: () => fetchSwap(teamId, swapId), enabled: Boolean(teamId && swapId) });
  const change = useMutation({
    mutationFn: async (approve: boolean) => {
      if (isOffline)
        throw new Error('Reconnect to review a swap');
      if (approve)
        await approveSwap(teamId, swapId);
      else
        await rejectSwap(teamId, swapId);
    }, onSuccess: () => {
      void query.refetch(); for (const key of ['swaps', 'shifts', 'shift', 'activity'])
        void client.invalidateQueries({ queryKey: [key, teamId] });
    }
  });
  if (query.isPending)
    return <Screen><Text>Loading swap...</Text></Screen>;
  if (query.isError || !query.data)
    return <Screen><Text>This swap is unavailable or you no longer have access.</Text><Button title="Retry" onPress={() => { void query.refetch(); }} /></Screen>;
  const swap = query.data;
  const mayApprove=swap.status==='PENDING'&&(role==='OWNER'||role==='MANAGER');
  const mayReview = swap.status === 'PENDING' && (mayApprove || swap.offeredTo === user?.id);
  return <Screen><Stack.Screen options={{ title: 'Swap request' }} /><View style={{ gap: 12 }}>
    <Text>{swap.shiftTitle}</Text><Text>{formatRange(swap.shiftStartsAt, swap.shiftEndsAt)}</Text>
    <Text>Requested by {swap.requesterName ?? swap.requesterEmail}</Text><Text>{swap.reason}</Text><Text>{swap.status}</Text>
    {mayReview ? <><Button title="Approve" disabled={!mayApprove || change.isPending || isOffline} onPress={() => change.mutate(true)} /><Button title="Reject" disabled={change.isPending || isOffline} onPress={() => change.mutate(false)} /></> : null}
    {change.isError ? <Text>{change.error.message}</Text> : null}
  </View></Screen>;
}
