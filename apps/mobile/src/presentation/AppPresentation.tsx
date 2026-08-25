import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useColorScheme } from 'react-native';

import {
  createTranslator,
  createPreferencesStore,
  selectResolvedLocale,
  selectResolvedTheme,
  type AppPreferences,
  type PreferencesStore,
  type ResolvedLocale,
  type ResolvedTheme,
  type Translator,
} from '../preferences';
import { darkColors, lightColors, type ThemePalette } from '../theme';

type AppPresentationValue = {
  colors: ThemePalette;
  locale: ResolvedLocale;
  preferences: AppPreferences;
  resolvedTheme: ResolvedTheme;
  store: PreferencesStore;
  t: Translator;
};

const fallbackStore = createPreferencesStore();
const fallbackPreferences = fallbackStore.getState();
const AppPresentationContext = createContext<AppPresentationValue>({
  colors: darkColors,
  locale: 'en-US',
  preferences: fallbackPreferences,
  resolvedTheme: 'dark',
  store: fallbackStore,
  t: createTranslator('en-US'),
});

function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return 'en-US';
  }
}

export function AppPresentationProvider({
  children,
  store,
}: React.PropsWithChildren<{ store: PreferencesStore }>) {
  const systemTheme = useColorScheme();
  const [preferences, setPreferences] = useState(() => store.getState());
  useEffect(() => store.subscribe(setPreferences), [store]);

  const resolvedTheme = selectResolvedTheme(preferences, systemTheme);
  const locale = selectResolvedLocale(preferences, systemLocale());
  const value = useMemo<AppPresentationValue>(
    () => ({
      colors: resolvedTheme === 'light' ? lightColors : darkColors,
      locale,
      preferences,
      resolvedTheme,
      store,
      t: createTranslator(locale),
    }),
    [locale, preferences, resolvedTheme, store],
  );

  return (
    <AppPresentationContext.Provider value={value}>
      {children}
    </AppPresentationContext.Provider>
  );
}

export function useAppPresentation(): AppPresentationValue {
  return useContext(AppPresentationContext);
}
