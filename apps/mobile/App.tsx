import React, { useMemo } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createPreferencesStore } from './src/preferences';
import {
  AppPresentationProvider,
  useAppPresentation,
} from './src/presentation/AppPresentation';
import { HomeScreen } from './src/screens/HomeScreen';

export default function App() {
  const preferencesStore = useMemo(() => createPreferencesStore(), []);
  return (
    <SafeAreaProvider>
      <AppPresentationProvider store={preferencesStore}>
        <AppChrome />
      </AppPresentationProvider>
    </SafeAreaProvider>
  );
}

function AppChrome() {
  const { resolvedTheme } = useAppPresentation();
  return (
    <>
      <StatusBar
        barStyle={resolvedTheme === 'dark' ? 'light-content' : 'dark-content'}
      />
      <HomeScreen />
    </>
  );
}
