import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQueryClient } from '@tanstack/react-query';
import { useTeam } from '../../src/context/TeamContext';
import { fetchPaymentStatus, verifyPayment } from '../../src/api/billing';

export default function BillingRedirectScreen() {
  const { team, loading: teamLoading } = useTeam();
  const teamId = team?.id ?? '';
  const queryClient = useQueryClient();
  const params = useLocalSearchParams<{
    status?: string;
    tx_ref?: string;
    transaction_id?: string;
  }>();

  const [message, setMessage] = useState('Confirming payment...');
  const handled = useRef(false);

  useEffect(() => {
    if (teamLoading) return;
    if (handled.current) return;
    handled.current = true;

    async function handleRedirect() {
      const statusLower = params.status?.toLowerCase();
      const txRef = params.tx_ref;
      const transactionId = params.transaction_id;

      if (statusLower === 'cancelled') {
        setMessage('Checkout was cancelled.');
        if (teamId) {
          await queryClient.invalidateQueries({ queryKey: ['billing-summary', teamId] });
        }
        router.replace('/subscription');
        return;
      }

      if (statusLower === 'failed') {
        setMessage('Payment failed.');
        if (teamId) {
          await queryClient.invalidateQueries({ queryKey: ['billing-summary', teamId] });
        }
        router.replace('/subscription');
        return;
      }

      // If we have transaction credentials, verify immediately
      if (teamId && txRef && transactionId) {
        try {
          const res = await verifyPayment(teamId, txRef, transactionId);
          if (res.outcome === 'SUCCESS') {
            setMessage('Payment verified!');
          } else if (res.outcome === 'ALREADY_PROCESSED') {
            setMessage('Payment confirmed!');
          }
        } catch {
          // If direct verify throws or was ALREADY_PROCESSED, verify specific status
          try {
            const check = await fetchPaymentStatus(teamId, txRef);
            if (check.status === 'SUCCESSFUL') {
              setMessage('Payment confirmed!');
            }
          } catch {
            // Webhook may still be in-flight
          }
        }
      }

      if (teamId) {
        await queryClient.invalidateQueries({ queryKey: ['billing-summary', teamId] });
        await queryClient.invalidateQueries({ queryKey: ['billing-plans', teamId] });
      }

      // Navigate cleanly to the subscription screen, replacing redirect in stack
      router.replace('/subscription');
    }

    handleRedirect();
  }, [teamLoading, teamId, params.status, params.tx_ref, params.transaction_id, queryClient]);

  return (
    <View style={styles.container}>
      <ActivityIndicator size="large" color="#111827" />
      <Text style={styles.text}>{message}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff',
    padding: 24,
  },
  text: {
    marginTop: 16,
    fontSize: 16,
    fontWeight: '600',
    color: '#111827',
  },
});
