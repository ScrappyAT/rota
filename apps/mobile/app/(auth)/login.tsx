import { useState } from 'react';
import { View, Text, StyleSheet, Alert } from 'react-native';
import { router } from 'expo-router';
import { apiClient } from '../../src/api/client';
import { useAuth } from '../../src/context/AuthContext';
import { AuthResponse } from '@rota/shared';
import { Screen } from '../../src/components/ui/Screen';
import { Input } from '../../src/components/ui/Input';
import { Button } from '../../src/components/ui/Button';
import { typography, spacing } from '../../src/components/ui/theme';

export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();

  const handleLogin = async () => {
    if (!email || !password) {
      return Alert.alert('Error', 'Please enter email and password');
    }
    setLoading(true);
    const res = await apiClient.request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    setLoading(false);

    if (res.success && res.data) {
      await login(res.data);
      router.replace('/');
    } else {
      Alert.alert('Login failed', res.error?.message || 'Unknown error');
    }
  };

  return (
    <Screen style={styles.container}>
      <View style={styles.header}>
        <Text style={typography.h1}>Welcome Back</Text>
        <Text style={[typography.body, { marginTop: spacing.sm }]}>Sign in to Rota</Text>
      </View>

      <View style={styles.form}>
        <Input
          label="Email Address"
          placeholder="Enter your email"
          value={email}
          onChangeText={setEmail}
          autoCapitalize="none"
          keyboardType="email-address"
          editable={!loading}
          returnKeyType="next"
        />
        <Input
          label="Password"
          placeholder="Enter your password"
          value={password}
          onChangeText={setPassword}
          secureTextEntry
          editable={!loading}
          returnKeyType="done"
          onSubmitEditing={handleLogin}
        />
        <Button
          title={loading ? 'Logging in...' : 'Login'}
          onPress={handleLogin}
          loading={loading}
          style={styles.button}
        />
      </View>

      <View style={styles.footer}>
        <Text style={typography.bodySmall}>Don't have an account?</Text>
        <Button
          title="Create an account"
          variant="ghost"
          onPress={() => router.push('/(auth)/register')}
          disabled={loading}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.xl,
    paddingTop: spacing.xxl,
  },
  header: {
    marginBottom: spacing.xl,
    alignItems: 'center',
  },
  form: {
    width: '100%',
  },
  button: {
    marginTop: spacing.md,
  },
  footer: {
    marginTop: spacing.xxl,
    alignItems: 'center',
  }
});
