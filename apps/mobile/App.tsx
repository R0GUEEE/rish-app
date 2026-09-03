import React, { useMemo } from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createPreferencesStore } from './src/preferences';
import {
  AppPresentationProvider,
  useAppPresentation,
} from './src/presentation/AppPresentation';
import { HomeScreen } from './src/screens/HomeScreen';
import {
  parseUIPreviewKind,
  UIPreview,
  type UIPreviewKind,
} from './src/preview/UIPreview';

export default function App({
  dshSeedMarkdownDemo,
  dshUIPreview,
}: {
  dshSeedMarkdownDemo?: boolean;
  dshUIPreview?: unknown;
}) {
  const preferencesStore = useMemo(() => createPreferencesStore(), []);
  // Only the launch-argument preview name (-DSHUIPreview <kind>) reaches this
  // prop; anything else renders the real app.
  const uiPreview = parseUIPreviewKind(dshUIPreview);
  return (
    <SafeAreaProvider>
      <AppPresentationProvider store={preferencesStore}>
        <AppChrome
          seedMarkdownDemo={dshSeedMarkdownDemo === true}
          uiPreview={uiPreview}
        />
      </AppPresentationProvider>
    </SafeAreaProvider>
  );
}

function AppChrome({
  seedMarkdownDemo,
  uiPreview,
}: {
  seedMarkdownDemo: boolean;
  uiPreview: UIPreviewKind | null;
}) {
  const { resolvedTheme } = useAppPresentation();
  return (
    <>
      <StatusBar
        barStyle={resolvedTheme === 'dark' ? 'light-content' : 'dark-content'}
      />
      {uiPreview === null ? (
        <HomeScreen seedMarkdownDemo={seedMarkdownDemo} />
      ) : (
        <UIPreview kind={uiPreview} />
      )}
    </>
  );
}
