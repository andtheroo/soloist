import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { AppState } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Provider } from 'react-redux';
import { PersistGate } from 'redux-persist/integration/react';

import { setServerUrlOverride } from '../src/api/client';
import { toDayKey } from '../src/game/streak';
import { persistor, store, useAppSelector } from '../src/store';
import { progressionActions } from '../src/store/progressionSlice';
import { Centered } from '../src/ui/components';
import { colors } from '../src/ui/theme';
import { useOrientation } from '../src/ui/useOrientation';

/** Refill hearts and reconcile streaks after rehydration and on every foreground. */
const reconcileDay = () => {
  const now = new Date();
  store.dispatch(progressionActions.dayChanged({ day: toDayKey(now), now: now.getTime() }));
};

const onRehydrated = () => {
  setServerUrlOverride(store.getState().settings.serverUrl);
  reconcileDay();
};

function AppEffects() {
  const serverUrl = useAppSelector((s) => s.settings.serverUrl);
  useEffect(() => setServerUrlOverride(serverUrl), [serverUrl]);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => s === 'active' && reconcileDay());
    return () => sub.remove();
  }, []);
  useOrientation('portrait');
  return null;
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <Provider store={store}>
        <PersistGate persistor={persistor} onBeforeLift={onRehydrated} loading={<Centered spinner text="Loading…" />}>
          <AppEffects />
          <StatusBar style="light" />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: colors.bg },
              headerTintColor: colors.text,
              headerShadowVisible: false,
              contentStyle: { backgroundColor: colors.bg },
            }}
          >
            <Stack.Screen name="index" options={{ title: 'Soloist' }} />
            <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="skill/[id]" options={{ title: '' }} />
            <Stack.Screen name="lesson/[id]" options={{ headerShown: false, gestureEnabled: false }} />
            <Stack.Screen name="practice/[chartId]" options={{ headerShown: false }} />
            <Stack.Screen name="tuner" options={{ title: 'Tuner' }} />
            <Stack.Screen name="profile" options={{ title: 'Your progress' }} />
            <Stack.Screen name="settings" options={{ title: 'Settings' }} />
            <Stack.Screen name="calibrate" options={{ title: 'Latency check', presentation: 'modal' }} />
          </Stack>
        </PersistGate>
      </Provider>
    </SafeAreaProvider>
  );
}
