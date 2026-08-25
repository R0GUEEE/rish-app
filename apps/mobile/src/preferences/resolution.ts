import type {
  AppPreferences,
  LocalePreference,
  ResolvedLocale,
  ResolvedTheme,
  ThemeMode,
} from './types';

export const FALLBACK_LOCALE: ResolvedLocale = 'en-US';
export const FALLBACK_THEME: ResolvedTheme = 'dark';

export type SystemLocaleDescriptor = {
  readonly languageTag?: string | null;
  readonly languageCode?: string | null;
  readonly countryCode?: string | null;
};

export type SystemLocale = string | SystemLocaleDescriptor;

function localeTag(locale: SystemLocale): string | null {
  if (typeof locale === 'string') {
    return locale;
  }
  if (typeof locale.languageTag === 'string') {
    return locale.languageTag;
  }
  if (typeof locale.languageCode !== 'string') {
    return null;
  }
  return typeof locale.countryCode === 'string'
    ? `${locale.languageCode}-${locale.countryCode}`
    : locale.languageCode;
}

export function normalizeSystemLocale(
  locale: SystemLocale | null | undefined,
): ResolvedLocale | null {
  if (locale === null || locale === undefined) {
    return null;
  }
  const tag = localeTag(locale)?.trim().replace(/_/gu, '-').toLowerCase();
  if (tag === undefined || tag.length === 0) {
    return null;
  }
  const language = tag.split('-')[0];
  if (language === 'zh') {
    return 'zh-CN';
  }
  if (language === 'en') {
    return 'en-US';
  }
  return null;
}

export function resolveSystemLocale(
  locales: readonly SystemLocale[] | SystemLocale | null | undefined,
): ResolvedLocale {
  const candidates = Array.isArray(locales)
    ? locales
    : locales === null || locales === undefined
    ? []
    : [locales];
  for (const candidate of candidates) {
    const locale = normalizeSystemLocale(candidate);
    if (locale !== null) {
      return locale;
    }
  }
  return FALLBACK_LOCALE;
}

export function resolveLocalePreference(
  preference: LocalePreference,
  systemLocales: readonly SystemLocale[] | SystemLocale | null | undefined,
): ResolvedLocale {
  return preference === 'system'
    ? resolveSystemLocale(systemLocales)
    : preference;
}

export function resolveThemeMode(
  preference: ThemeMode,
  systemTheme: string | null | undefined,
): ResolvedTheme {
  if (preference !== 'system') {
    return preference;
  }
  return systemTheme === 'light' || systemTheme === 'dark'
    ? systemTheme
    : FALLBACK_THEME;
}

export function selectResolvedLocale(
  preferences: AppPreferences,
  systemLocales: readonly SystemLocale[] | SystemLocale | null | undefined,
): ResolvedLocale {
  return resolveLocalePreference(preferences.locale, systemLocales);
}

export function selectResolvedTheme(
  preferences: AppPreferences,
  systemTheme: string | null | undefined,
): ResolvedTheme {
  return resolveThemeMode(preferences.themeMode, systemTheme);
}
