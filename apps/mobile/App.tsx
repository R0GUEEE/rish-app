import { DshModelCatalog } from './src/models/native';
import React, { useMemo, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { createPreferencesStore } from './src/preferences';
import {
  AppPresentationProvider,
  useAppPresentation,
} from './src/presentation/AppPresentation';
import { HomeScreen } from './src/screens/HomeScreen';
import { resolveAdaptiveLayout } from './src/layout/adaptive';
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
  const [catalogReady, setCatalogReady] = useState(
    !DshModelCatalog.isAvailable(),
  );
  const [catalogError, setCatalogError] = useState(false);
  const [catalogRetry, setCatalogRetry] = useState(0);
  useEffect(() => {
    let active = true;
    DshModelCatalog.refresh()
      .then(() => {
        if (active) setCatalogReady(true);
      })
      .catch(() => {
        if (active) setCatalogError(true);
      });
    return () => {
      active = false;
    };
  }, [catalogRetry]);
  const preferencesStore = useMemo(() => createPreferencesStore(), []);
  // Only the launch-argument preview name (-DSHUIPreview <kind>) reaches this
  // prop; anything else renders the real app.
  const uiPreview = parseUIPreviewKind(dshUIPreview);
  if (!catalogReady)
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
        {catalogError ? (
          <Pressable
            onPress={() => {
              setCatalogError(false);
              setCatalogRetry(n => n + 1);
            }}
          >
            <Text>模型目录加载失败，点击重试 / Retry loading models</Text>
          </Pressable>
        ) : (
          <ActivityIndicator />
        )}
      </View>
    );
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
  const { width } = useWindowDimensions();
  const layout = resolveAdaptiveLayout(width);
  return (
    <View
      style={styles.appRoot}
      testID={layout.isWide ? 'app-wide-layout' : 'app-narrow-layout'}
    >
      <StatusBar
        barStyle={resolvedTheme === 'dark' ? 'light-content' : 'dark-content'}
      />
      {uiPreview === null ? (
        <HomeScreen seedMarkdownDemo={seedMarkdownDemo} />
      ) : (
        <UIPreview kind={uiPreview} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  appRoot: { flex: 1 },
});
