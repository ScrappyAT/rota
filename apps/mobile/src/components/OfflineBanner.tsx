import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { spacing } from './ui/theme';

interface OfflineBannerProps {
  message?: string;
  subMessage?: string;
}

export function OfflineBanner({
  message = 'Offline Mode — Showing cached shifts',
  subMessage = 'Read-only. Reconnect to make changes.',
}: OfflineBannerProps) {
  return (
    <View style={styles.container}>
      <View style={styles.iconContainer}>
        <Ionicons name="cloud-offline-outline" size={18} color="#92400E" />
      </View>
      <View style={styles.textContainer}>
        <Text style={styles.title}>{message}</Text>
        {subMessage ? <Text style={styles.subtitle}>{subMessage}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: '#FEF3C7',
    borderBottomWidth: 1,
    borderBottomColor: '#FDE68A',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconContainer: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  textContainer: {
    flex: 1,
  },
  title: {
    fontSize: 13,
    fontWeight: '600',
    color: '#92400E',
  },
  subtitle: {
    fontSize: 11,
    color: '#B45309',
    marginTop: 1,
  },
});
