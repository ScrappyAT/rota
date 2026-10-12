import { useQuery } from '@tanstack/react-query';
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Stack } from 'expo-router';
import { fetchChanges, fetchInvoices } from '../../src/api/billing';
import { useTeam } from '../../src/context/TeamContext';
import { formatDateTime } from '../../src/utils/dates';
import { formatMoney } from '../../src/utils/money';

export default function BillingHistoryScreen() {
  const { team } = useTeam();
  const teamId = team?.id ?? '';

  const changes = useQuery({
    queryKey: ['billing-changes', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchChanges(teamId, { limit: 50 }),
  });

  const invoices = useQuery({
    queryKey: ['billing-invoices', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchInvoices(teamId, { limit: 50 }),
  });

  if (changes.isError || invoices.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>Could not load billing history.</Text>
      </View>
    );
  }

  if (!changes.data || !invoices.data) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={changes.isRefetching || invoices.isRefetching}
          onRefresh={() => { changes.refetch(); invoices.refetch(); }}
        />
      }>
      <Stack.Screen options={{ title: 'History & invoices' }} />

      <Text style={styles.section}>Change history</Text>
      {changes.data.items.length === 0 ? (
        <Text style={styles.empty}>No plan or seat changes yet.</Text>
      ) : (
        changes.data.items.map((change) => (
          <View key={change.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.primary}>{change.type}</Text>
              <Text style={styles.muted}>{formatMoney(change.amountMinor)}</Text>
            </View>
            <Text style={styles.muted}>
              {change.fromPlanCode ?? '—'} → {change.toPlanCode ?? '—'} · seats {change.fromSeats ?? '—'} → {change.toSeats ?? '—'} · {change.status}
            </Text>
            <Text style={styles.time}>{formatDateTime(change.createdAt)}</Text>
          </View>
        ))
      )}
      {changes.data.hasMore ? <Text style={styles.empty}>Showing the most recent 50 changes.</Text> : null}

      <Text style={styles.section}>Invoices</Text>
      {invoices.data.items.length === 0 ? (
        <Text style={styles.empty}>No invoices yet.</Text>
      ) : (
        invoices.data.items.map((invoice) => (
          <View key={invoice.id} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.primary}>{invoice.description}</Text>
              <Text style={styles.muted}>{formatMoney(invoice.amountMinor)}</Text>
            </View>
            <Text style={styles.muted}>Status: {invoice.status}</Text>
            <Text style={styles.time}>{formatDateTime(invoice.createdAt)}</Text>
          </View>
        ))
      )}
      {invoices.data.hasMore ? <Text style={styles.empty}>Showing the most recent 50 invoices.</Text> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff', padding: 16 },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, backgroundColor: '#fff' },
  error: { color: '#b91c1c', fontSize: 15 },
  section: { fontSize: 16, fontWeight: '700', color: '#111827', marginTop: 12, marginBottom: 8 },
  card: {
    borderWidth: 1,
    borderColor: '#e5e7eb',
    borderRadius: 10,
    padding: 12,
    marginBottom: 10,
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  primary: { fontSize: 15, fontWeight: '600', color: '#111827' },
  muted: { fontSize: 13, color: '#6b7280', marginTop: 2 },
  time: { fontSize: 12, color: '#9ca3af', marginTop: 4 },
  empty: { fontSize: 13, color: '#9ca3af', paddingVertical: 12, textAlign: 'center' },
});