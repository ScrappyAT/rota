import { useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';

export default function AcceptInvitationScreen() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAccept = async () => {
    if (!token.trim()) return Alert.alert('Error', 'Token is required');
    setLoading(true);
    const res = await apiClient.request('/invitations/accept', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    setLoading(false);

    if (res.success) {
      Alert.alert('Success', 'Invitation accepted!');
      router.replace('/teams');
    } else {
      Alert.alert('Error', res.error?.message || 'Failed to accept invitation');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>Accept Invitation</Text>
      <TextInput
        style={styles.input}
        placeholder="Paste invitation token here"
        value={token}
        onChangeText={setToken}
      />
      <Button title={loading ? 'Accepting...' : 'Accept'} onPress={handleAccept} disabled={loading} />
      <Button title="Cancel" onPress={() => router.back()} color="gray" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, backgroundColor: '#fff', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20, textAlign: 'center' },
  input: { borderWidth: 1, borderColor: '#ccc', padding: 10, marginBottom: 10, borderRadius: 5 }
});
