import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { Stack } from 'expo-router';
import * as Linking from 'expo-linking';
import { createCheckout, fetchBillingSummary, fetchPlans } from '../../src/api/billing';
import { useTeam } from '../../src/context/TeamContext';
import { errorMessage } from '../../src/utils/errorMessage';
import { formatMoney } from '../../src/utils/money';
import { openCheckout } from '../../src/utils/checkout';

export default function PlansScreen() {
  const { team, role } = useTeam();
  const teamId = team?.id ?? '';
  const [selected, setSelected] = useState<string>('');
  const [seatsText, setSeatsText] = useState('');
  const [busy, setBusy] = useState(false);

  const summary = useQuery({
    queryKey: ['billing-summary', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchBillingSummary(teamId),
  });

  const plans = useQuery({
    queryKey: ['billing-plans', teamId],
    enabled: Boolean(teamId),
    queryFn: () => fetchPlans(teamId),
  });

  const currentCode = summary.data?.subscription.planCode ?? '';
  const currentSeats = summary.data?.subscription.seats ?? 1;

  const handleChoose = async () => {
    if (!teamId || !selected) return;
    const seats = parseInt(seatsText, 10);
    const seatsInput = Number.isNaN(seats) ? undefined : seats;
    setBusy(true);
    try {
      const returnUrl = Linking.createURL('billing/redirect');
      const res = await createCheckout(
        teamId,
        seatsInput ? { planCode: selected, seats: seatsInput, returnUrl } : { planCode: selected, returnUrl }
      );
      if (res.checkoutUrl) {
        const outcome = await openCheckout(teamId, res.checkoutUrl, res.payment?.txRef);
        if (outcome === 'settled') {
          Alert.alert('Success', 'Your plan change is complete.');
        } else if (outcome === 'cancelled') {
          Alert.alert('Payment cancelled', 'You cancelled the checkout. Your plan was not changed.');
        } else if (outcome === 'failed') {
          Alert.alert('Payment failed', 'The payment could not be completed. Your card was not charged.');
        } else {
          Alert.alert('Payment pending', 'Your payment is being verified and will update once confirmed. Pull down to refresh.');
        }
      } else {
        Alert.alert('Success', 'Plan change applied.');
      }
      summary.refetch();
      plans.refetch();
    } catch (error) {
      Alert.alert('Error', errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  if (summary.isError || plans.isError) {
    return (
      <View style={styles.centered}>
        <Text style={styles.error}>Could not load plans.</Text>
      </View>
    );
  }

  if (!plans.data || !summary.data) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      refreshControl={<RefreshControl refreshing={plans.isRefetching} onRefresh={() => { plans.refetch(); summary.refetch(); }} />}>
      <Stack.Screen options={{ title: 'Plans' }} />

      <View>
        {plans.data.map((plan) => {
          const isCurrent = plan.code === currentCode;
          const isSelected = plan.code === selected;
          const pricePerSeatMinor = plan.pricePerSeatMinor ?? plan.price_per_seat_minor ?? 0;
          const maxSeats = plan.maxSeats ?? plan.max_seats ?? 0;
          const isFree = plan.isFree ?? plan.is_free ?? pricePerSeatMinor === 0;

          return (
            <TouchableOpacity
              key={plan.code}
              style={[styles.card, isSelected ? styles.cardSelected : null]}
              onPress={() => {
                setSelected(plan.code);
                setSeatsText(String(currentSeats));
              }}>
              <View style={styles.cardHeader}>
                <Text style={styles.planName}>{plan.name}</Text>
                {isCurrent ? <Text style={styles.tagCurrent}>Current</Text> : null}
              </View>
              <Text style={styles.row}>
                {isFree || pricePerSeatMinor === 0
                  ? 'Free'
                  : `${formatMoney(pricePerSeatMinor)} / seat / month`}
              </Text>
              <Text style={styles.row}>Up to {maxSeats === 0 ? 'unlimited' : maxSeats} seats</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {selected ? (
        <View style={styles.selection}>
          <Text style={styles.cardTitle}>Selected: {selected}</Text>
          <TextInput
            style={styles.input}
            value={seatsText}
            onChangeText={setSeatsText}
            keyboardType="number-pad"
            placeholder={`Seats (default ${currentSeats})`}
          />
          <Text style={styles.hint}>Adding seats or upgrading charges a prorated amount for the rest of the period.</Text>
          <TouchableOpacity
            style={[styles.button, { opacity: busy ? 0.6 : 1 }]}
            onPress={handleChoose}
            disabled={busy || role !== 'OWNER'}>
            <Text style={styles.buttonText}>{busy ? 'Opening checkout...' : 'Choose this plan'}</Text>
          </TouchableOpacity>
          {role !== 'OWNER' ? <Text style={styles.hint}>Only owners can change the plan.</Text> : null}
        </View>
      ) : null}
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
    marginBottom: 10,
  },
  cardSelected: { borderColor: '#111827', borderWidth: 2 },
  cardHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  planName: { fontSize: 18, fontWeight: '700', color: '#111827' },
  tagCurrent: { fontSize: 11, fontWeight: '700', color: '#166534', backgroundColor: '#dcfce7', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8 },
  row: { fontSize: 14, color: '#374151', marginTop: 4 },
  selection: { marginTop: 12, padding: 16, backgroundColor: '#f9fafb', borderRadius: 10 },
  cardTitle: { fontSize: 16, fontWeight: '700', marginBottom: 8, color: '#111827' },
  input: {
    borderWidth: 1,
    borderColor: '#d1d5db',
    borderRadius: 8,
    padding: 10,
    marginBottom: 10,
    backgroundColor: '#fff',
  },
  hint: { fontSize: 12, color: '#9ca3af', marginBottom: 12 },
  button: { backgroundColor: '#111827', borderRadius: 8, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});