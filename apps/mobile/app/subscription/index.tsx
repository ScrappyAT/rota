import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, Alert, RefreshControl, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { Stack, router } from 'expo-router';
import { fetchBillingSummary, renewSubscription } from '../../src/api/billing';
import { useTeam } from '../../src/context/TeamContext';
import { errorMessage } from '../../src/utils/errorMessage';
import { formatDateTime } from '../../src/utils/dates';
import { formatMoney } from '../../src/utils/money';
import { openCheckout } from '../../src/utils/checkout';

const STATUS_COLOR: Record<string, string> = {
  ACTIVE: '#166534',
  PAST_DUE: '#b45309',
  EXPIRED: '#b91c1c',
  CANCELLED: '#6b7280',
};

export default function SubscriptionScreen() {
  const { team, role } = useTeam();
  const teamId = team?.id ?? '';
  const [busy, setBusy] = useState(false);

  const query = useQuery({
    queryKey: ['billing-summary', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchBillingSummary(teamId),
  });

  const data = query.data;
  const sub = data?.subscription;
  const status = sub?.status ?? '';

  const handleRenew = async () => {
    if (!teamId) return;
    setBusy(true);
    try {
      const res = await renewSubscription(teamId);
      if (res.checkoutUrl) {
        await openCheckout(teamId, res.checkoutUrl);
      }
      query.refetch();
      Alert.alert('Renewal', res.checkoutUrl ? 'Payment opened in the browser. It settles when complete.' : 'Subscription renewed.');
    } catch (error) {
      Alert.alert('Error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (query.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>Could not load subscription details.</Text>
      </View>
    );
  }

  if (!data || !sub) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  const capacityLabel = sub.planMaxSeatsExempt ? `${data.seatCapacity}+` : String(data.seatCapacity);

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={query.isRefetching} onRefresh={() => query.refetch()} />}>
      <Stack.Screen options={{ title: 'Subscription' }} />

      <View style={styles.card}>
        <Text style={styles.planName}>{sub.planName}</Text>
        <Text style={[styles.status, { color: STATUS_COLOR[status] ?? '#374151' }]}>{status}</Text>
        <Text style={styles.row}>Seats used: {data.seatsUsed} / {capacityLabel}</Text>
        <Text style={styles.row}>Purchased seats: {sub.seats}</Text>
        <Text style={styles.row}>
          Period: {formatDateTime(sub.periodStartedAt)} – {formatDateTime(sub.periodEndsAt)}
        </Text>
        {sub.graceEndsAt ? <Text style={styles.row}>Grace ends: {formatDateTime(sub.graceEndsAt)}</Text> : null}
        {sub.planPricePerSeatMinor > 0 ? (
          <Text style={styles.row}>Price: {formatMoney(sub.planPricePerSeatMinor)} / seat / month</Text>
        ) : null}
        {!data.billingEnabled ? (
          <Text style={styles.warning}>Payments are not enabled on the server. You can manage plan and seats.</Text>
        ) : null}
      </View>

      {data.pendingPayment ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Pending payment</Text>
          <Text style={styles.row}>{formatMoney(data.pendingPayment.amountMinor, data.pendingPayment.currency)}</Text>
          <Text style={styles.row}>Reference: {data.pendingPayment.txRef}</Text>
          <Text style={styles.hint}>Pull to refresh to see if it has been settled by the payment webhook.</Text>
        </View>
      ) : null}

      {data.latestFailedRenewal ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Last renewal failed</Text>
          <Text style={styles.row}>{formatMoney(data.latestFailedRenewal.amountMinor, data.latestFailedRenewal.currency)}</Text>
          <Text style={styles.hint}>Renew to keep the team active.</Text>
        </View>
      ) : null}

      {role === 'OWNER' ? (
        <View style={styles.actions}>
          <TouchableOpacity style={styles.button} onPress={() => router.push('/subscription/plans')}>
            <Text style={styles.buttonText}>Manage plan and seats</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.button} onPress={() => router.push('/subscription/billing')}>
            <Text style={styles.buttonText}>History &amp; invoices</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.button, styles.secondary]} onPress={handleRenew} disabled={busy || !data.billingEnabled}>
            <Text style={styles.buttonText}>{busy ? 'Renewing...' : 'Renew subscription'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <Text style={styles.hint}>Only owners can manage this team's subscription.</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  error: { color: '#b91c1c', fontSize: 15 },
  card: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 16,
    marginBottom: 12,
  },
  planName: { fontSize: 22, fontWeight: 'bold', color: '#111827' },
  status: { fontSize: 13, fontWeight: '700', marginTop: 2, marginBottom: 8 },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 6, color: '#111827' },
  row: { fontSize: 14, color: '#374151', marginTop: 4 },
  hint: { fontSize: 12, color: '#9ca3af', marginTop: 8 },
  warning: { fontSize: 13, color: '#b45309', marginTop: 10 },
  actions: { marginTop: 8, gap: 10 },
  button: {
    backgroundColor: '#111827',
    borderRadius: 8,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondary: { backgroundColor: '#4b5563' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});