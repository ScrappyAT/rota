import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, ErrorBoundary as RouterErrorBoundary, ErrorBoundaryProps } from 'expo-router';
import { initializeErrorTracking, reportMobileError, withErrorTracking } from '../src/services/errorTracking';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import 'react-native-reanimated';

import SpaceMono from '../assets/fonts/SpaceMono-Regular.ttf';

import { useColorScheme } from '@/components/useColorScheme';

initializeErrorTracking();

export function ErrorBoundary(props: ErrorBoundaryProps) {
  useEffect(() => { reportMobileError(props.error); }, [props.error]);
  return <RouterErrorBoundary {...props} />;
}

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
import { SettingsProvider,useSettings } from '../src/context/SettingsContext';
import { QueryClientProvider } from '@tanstack/react-query';
import { queryClient } from '../src/query/queryClient';

function RootLayout() {
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
          <SettingsProvider>
            <TeamProvider>
              <NotificationProvider>
              <RootLayoutNav />
              </NotificationProvider>
            </TeamProvider>
          </SettingsProvider>
        </NetworkProvider>
      </QueryClientProvider>
    </AuthProvider>
  );
}

function RootLayoutNav() {
  const systemScheme = useColorScheme();
  const { state } = useSettings();
  const colorScheme = !state.settings || state.settings.theme === 'system' ? systemScheme : state.settings.theme;

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
        <Stack.Screen name="swaps/[swapId]" options={{ title: 'Swap request' }} />
        <Stack.Screen name="billing/redirect" options={{ headerShown: false }} />
        <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
      </Stack>
    </ThemeProvider>
  );
}

export default withErrorTracking(RootLayout);
