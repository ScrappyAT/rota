import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

import SpaceMono from '../assets/fonts/SpaceMono-Regular.ttf';

import { useColorScheme } from '@/components/useColorScheme';

export {
  // Catch any errors thrown by the Layout component.
  ErrorBoundary,
} from 'expo-router';

export const unstable_settings = {
  // Ensure that reloading on `/modal` keeps a back button present.
  initialRouteName: '(tabs)',
};

// Prevent the splash screen from auto-hiding before asset loading is complete.
SplashScreen.preventAutoHideAsync();

import { AuthProvider } from '../src/context/AuthContext';
import { TeamProvider } from '../src/context/TeamContext';
import { NetworkProvider } from '../src/context/NetworkContext';
import { NotificationProvider } from '../src/context/NotificationContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/query/queryClient';

export default function RootLayout() {
  const [loaded, error] = useFonts({
    SpaceMono,
  });

  // Expo Router uses Error Boundaries to catch errors in the navigation tree.
  useEffect(() => {
    if (error) throw error;
  }, [error]);

  useEffect(() => {
    if (loaded) {
      SplashScreen.hideAsync();
    }
  }, [loaded]);

  if (!loaded) {
    return null;
  }

  return (
    <AuthProvider>
      <QueryClientProvider client={queryClient}>
        <NetworkProvider>
          <NotificationProvider>
            <TeamProvider>
              <RootLayoutNav />
            </TeamProvider>
          </NotificationProvider>
        </NetworkProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

function RootLayoutNav() {
  const colorScheme = useColorScheme();

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="(auth)" options={{ headerShown: false }} />
        <Stack.Screen name="teams/index" options={{ title: 'Manage Teams' }} />
        <Stack.Screen name="teams/create" options={{ title: 'Create Team' }} />
        <Stack.Screen name="teams/invite" options={{ title: 'Invite Member' }} />
        <Stack.Screen name="teams/accept" options={{ title: 'Join Team' }} />
        <Stack.Screen name="teams/[id]" options={{ title: 'Team Details' }} />
        <Stack.Screen name="shifts/new" options={{ title: 'Create Shift' }} />
        <Stack.Screen name="shifts/[shiftId]" options={{ title: 'Shift Details' }} />
        <Stack.Screen name="billing/redirect" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
      </Stack>
    </ThemeProvider>
  );
}
