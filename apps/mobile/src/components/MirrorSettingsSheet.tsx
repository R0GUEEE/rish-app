import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ArrowLeft from 'lucide-react-native/icons/arrow-left';
import Check from 'lucide-react-native/icons/check';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleCheck from 'lucide-react-native/icons/circle-check';
import Gauge from 'lucide-react-native/icons/gauge';
import Globe from 'lucide-react-native/icons/globe';
import Info from 'lucide-react-native/icons/info';

import {
  MIRROR_CATEGORIES,
  normalizeMirrorBaseUrl,
  type MirrorCategory,
  type MirrorPreferences,
} from '../preferences';
import {
  MIRROR_PRESETS,
  testMirror,
  type MirrorTestResult,
} from '../mirrors/catalog';
import { LocalMirrors, type MirrorApplyResult } from '../native/LocalMirrors';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import { SlidingSurface } from './SlidingSurface';

type TestState = Partial<Record<MirrorCategory, MirrorTestResult>>;
type EditableMirrors = Record<
  MirrorCategory,
  { enabled: boolean; baseUrl: string }
>;

function mirrorCopy(preferences: MirrorPreferences): EditableMirrors {
  return {
    alpine: { ...preferences.alpine },
    pip: { ...preferences.pip },
    npm: { ...preferences.npm },
  };
}

export function MirrorSettingsSheet({
  visible,
  onClose,
  onDismiss,
  onPreferencesChanged,
}: {
  visible: boolean;
  onClose: () => void;
  onDismiss: () => void;
  onPreferencesChanged: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { colors, preferences, store, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [drafts, setDrafts] = useState<EditableMirrors>(() =>
    mirrorCopy(preferences.mirrors),
  );
  const [results, setResults] = useState<TestState>({});
  const [testing, setTesting] = useState<MirrorCategory | 'all' | null>(null);
  const [applying, setApplying] = useState(false);
  const [receipt, setReceipt] = useState<MirrorApplyResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setDrafts(mirrorCopy(preferences.mirrors));
    setResults({});
    setError(null);
    if (LocalMirrors.isAvailable()) {
      LocalMirrors.status()
        .then(setReceipt)
        .catch(caught =>
          setError(caught instanceof Error ? caught.message : String(caught)),
        );
    }
  }, [preferences.mirrors, visible]);

  const updateCategory = useCallback(
    (
      category: MirrorCategory,
      update: Partial<MirrorPreferences[MirrorCategory]>,
    ) => {
      setDrafts(current => ({
        ...current,
        [category]: { ...current[category], ...update },
      }));
      setResults(current => ({ ...current, [category]: undefined }));
      setError(null);
    },
    [],
  );

  const runCategoryTest = useCallback(
    async (category: MirrorCategory) => {
      setTesting(category);
      setError(null);
      try {
        const result = await testMirror(category, drafts[category].baseUrl);
        setResults(current => ({ ...current, [category]: result }));
      } finally {
        setTesting(null);
      }
    },
    [drafts],
  );

  const detectFastest = useCallback(async () => {
    setTesting('all');
    setError(null);
    try {
      const detected = await Promise.all(
        MIRROR_CATEGORIES.map(async category => {
          const tested = await Promise.all(
            MIRROR_PRESETS[category].map(async preset => ({
              preset,
              result: await testMirror(category, preset.baseUrl),
            })),
          );
          const fastest = tested
            .filter(item => item.result.ok)
            .sort(
              (left, right) =>
                (left.result.latencyMs ?? Number.MAX_SAFE_INTEGER) -
                (right.result.latencyMs ?? Number.MAX_SAFE_INTEGER),
            )[0];
          return { category, fastest };
        }),
      );
      setDrafts(current => {
        const next = mirrorCopy(current);
        detected.forEach(({ category, fastest }) => {
          if (fastest !== undefined) {
            next[category] = {
              enabled: !fastest.preset.official,
              baseUrl: fastest.preset.baseUrl,
            };
          }
        });
        return next;
      });
      setResults(current => {
        const next = { ...current };
        detected.forEach(({ category, fastest }) => {
          if (fastest !== undefined) next[category] = fastest.result;
        });
        return next;
      });
    } finally {
      setTesting(null);
    }
  }, []);

  const normalizedDrafts = useMemo(() => {
    const entries = MIRROR_CATEGORIES.map(
      category =>
        [category, normalizeMirrorBaseUrl(drafts[category].baseUrl)] as const,
    );
    return entries.every(([, baseUrl]) => baseUrl !== null)
      ? ({
          alpine: {
            enabled: drafts.alpine.enabled,
            baseUrl: entries[0][1] as string,
          },
          pip: {
            enabled: drafts.pip.enabled,
            baseUrl: entries[1][1] as string,
          },
          npm: {
            enabled: drafts.npm.enabled,
            baseUrl: entries[2][1] as string,
          },
        } satisfies MirrorPreferences)
      : null;
  }, [drafts]);

  const apply = useCallback(async () => {
    if (normalizedDrafts === null) {
      setError(t('mirrors.invalidUrl'));
      return;
    }
    if (!LocalMirrors.isAvailable()) {
      setError(t('mirrors.nativeUnavailable'));
      return;
    }
    setApplying(true);
    setError(null);
    try {
      const nextReceipt = await LocalMirrors.apply(normalizedDrafts);
      MIRROR_CATEGORIES.forEach(category => {
        store.setMirror(category, normalizedDrafts[category]);
      });
      onPreferencesChanged();
      setReceipt(nextReceipt);
      setDrafts(mirrorCopy(normalizedDrafts));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApplying(false);
    }
  }, [normalizedDrafts, onPreferencesChanged, store, t]);

  return (
    <SlidingSurface
      accessibilityLabel={t('mirrors.title')}
      closeAccessibilityLabel={t('mirrors.close')}
      onClose={onClose}
      onDismiss={onDismiss}
      visible={visible}
      widthRatio={1}
      scrim={false}
    >
      <View
        style={[
          styles.root,
          { paddingTop: insets.top + 10, paddingBottom: insets.bottom + 12 },
        ]}
      >
        <View style={styles.header}>
          <Pressable
            accessibilityLabel={t('mirrors.close')}
            accessibilityRole="button"
            onPress={onClose}
            style={styles.close}
          >
            <AppIcon color={colors.text} icon={ArrowLeft} size={21} />
          </Pressable>
          <View style={styles.flex}>
            <Text style={styles.eyebrow}>{t('mirrors.eyebrow')}</Text>
            <Text accessibilityRole="header" style={styles.title}>
              {t('mirrors.title')}
            </Text>
          </View>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.description}>{t('mirrors.description')}</Text>
          <View style={styles.boundaryCard}>
            <AppIcon color={colors.accent} icon={Info} size={17} />
            <Text style={styles.boundaryText}>
              {t('mirrors.runtimeBoundary')}
            </Text>
          </View>

          <Pressable
            accessibilityLabel={t('mirrors.detectFastest')}
            accessibilityRole="button"
            accessibilityState={{ busy: testing === 'all' }}
            disabled={testing !== null}
            onPress={() => detectFastest().catch(() => undefined)}
            style={({ pressed }) => [
              styles.detectButton,
              testing !== null && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {testing === 'all' && (
              <ActivityIndicator color={colors.background} />
            )}
            {testing !== 'all' && (
              <AppIcon color={colors.background} icon={Gauge} size={18} />
            )}
            <Text style={styles.detectText}>
              {testing === 'all'
                ? t('mirrors.detecting')
                : t('mirrors.detectFastest')}
            </Text>
          </Pressable>

          {MIRROR_CATEGORIES.map(category => (
            <MirrorCard
              category={category}
              key={category}
              preference={drafts[category]}
              result={results[category]}
              testing={testing === category}
              onChange={update => updateCategory(category, update)}
              onTest={() => runCategoryTest(category).catch(() => undefined)}
            />
          ))}

          {error !== null && (
            <Text
              accessibilityLiveRegion="assertive"
              accessibilityRole="alert"
              style={styles.error}
            >
              {error}
            </Text>
          )}
          {receipt !== null && (
            <View accessibilityLiveRegion="polite" style={styles.receipt}>
              <View style={styles.receiptHeading}>
                <AppIcon color={colors.success} icon={CircleCheck} size={17} />
                <Text style={styles.receiptTitle}>{t('mirrors.staged')}</Text>
              </View>
              <Text style={styles.receiptBody}>
                {t('mirrors.guestPending')}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityLabel={t('mirrors.apply')}
            accessibilityRole="button"
            accessibilityState={{ busy: applying, disabled: applying }}
            disabled={applying}
            onPress={() => apply().catch(() => undefined)}
            style={({ pressed }) => [
              styles.applyButton,
              applying && styles.disabled,
              pressed && styles.pressed,
            ]}
          >
            {applying && <ActivityIndicator color={colors.background} />}
            {!applying && (
              <AppIcon color={colors.background} icon={Check} size={18} />
            )}
            <Text style={styles.applyText}>
              {applying ? t('mirrors.applying') : t('mirrors.apply')}
            </Text>
          </Pressable>
        </ScrollView>
      </View>
    </SlidingSurface>
  );
}

function MirrorCard({
  category,
  preference,
  result,
  testing,
  onChange,
  onTest,
}: {
  category: MirrorCategory;
  preference: MirrorPreferences[MirrorCategory];
  result?: MirrorTestResult;
  testing: boolean;
  onChange: (update: Partial<MirrorPreferences[MirrorCategory]>) => void;
  onTest: () => void;
}) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const presets = MIRROR_PRESETS[category];
  const selected = presets.find(
    preset => preset.baseUrl === preference.baseUrl,
  );
  const resultLabel = testing
    ? t('mirrors.testing')
    : result?.ok
    ? `${result.latencyMs ?? 0} ms`
    : result?.error === 'timeout'
    ? t('mirrors.timeout')
    : result === undefined
    ? null
    : t('mirrors.failed');

  return (
    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <View style={styles.cardIcon}>
          <AppIcon color={colors.textDim} icon={Globe} size={18} />
        </View>
        <View style={styles.flex}>
          <Text style={styles.cardTitle}>
            {t(`mirrors.category.${category}`)}
          </Text>
          <Text style={styles.cardMeta}>
            {selected?.name ?? preference.baseUrl}
          </Text>
        </View>
        {resultLabel !== null && (
          <View style={styles.resultStatus}>
            {testing ? (
              <ActivityIndicator color={colors.accent} size="small" />
            ) : (
              <AppIcon
                color={result?.ok ? colors.success : colors.danger}
                icon={result?.ok ? CircleCheck : CircleAlert}
                size={14}
              />
            )}
            <Text style={[styles.latency, result?.ok && styles.latencyReady]}>
              {resultLabel}
            </Text>
          </View>
        )}
      </View>

      <View style={styles.toggleRow}>
        <Text style={styles.toggleLabel}>{t('mirrors.enable')}</Text>
        <Switch
          accessibilityLabel={`${t('mirrors.enable')} ${t(
            `mirrors.category.${category}`,
          )}`}
          onValueChange={enabled => onChange({ enabled })}
          value={preference.enabled}
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.presets}
      >
        {presets.map(preset => {
          const active = preset.baseUrl === preference.baseUrl;
          return (
            <Pressable
              accessibilityLabel={preset.name}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              key={preset.id}
              onPress={() => onChange({ baseUrl: preset.baseUrl })}
              style={[styles.preset, active && styles.presetActive]}
            >
              <Text
                style={[styles.presetText, active && styles.presetTextActive]}
              >
                {preset.name}
              </Text>
              {preset.official && (
                <Text style={styles.official}>{t('mirrors.official')}</Text>
              )}
            </Pressable>
          );
        })}
      </ScrollView>

      <TextInput
        accessibilityLabel={`${t('mirrors.customUrl')} ${t(
          `mirrors.category.${category}`,
        )}`}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        onChangeText={baseUrl => onChange({ baseUrl })}
        placeholder={t('mirrors.customUrl')}
        placeholderTextColor={colors.faint}
        style={styles.urlInput}
        value={preference.baseUrl}
      />
      <Pressable
        accessibilityLabel={`${t('mirrors.test')} ${t(
          `mirrors.category.${category}`,
        )}`}
        accessibilityRole="button"
        accessibilityState={{ busy: testing }}
        disabled={testing}
        onPress={onTest}
        style={({ pressed }) => [styles.testButton, pressed && styles.pressed]}
      >
        {testing && <ActivityIndicator color={colors.textDim} size="small" />}
        {!testing && <AppIcon color={colors.textDim} icon={Gauge} size={15} />}
        <Text style={styles.testText}>
          {testing ? t('mirrors.testing') : t('mirrors.test')}
        </Text>
      </Pressable>
    </View>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 18,
    },
    flex: { flex: 1 },
    header: {
      height: 64,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    eyebrow: {
      color: colors.accent,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.7,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 27,
      marginTop: 4,
    },
    close: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    content: { paddingTop: 8, paddingBottom: 34 },
    description: { color: colors.muted, fontSize: 13, lineHeight: 19 },
    boundaryCard: {
      backgroundColor: colors.surfaceWarm,
      borderRadius: 15,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 9,
      padding: 13,
      marginTop: 12,
    },
    boundaryText: {
      flex: 1,
      color: colors.textDim,
      fontSize: 11,
      lineHeight: 17,
    },
    detectButton: {
      minHeight: 48,
      borderRadius: 15,
      backgroundColor: colors.text,
      marginTop: 14,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    detectText: { color: colors.background, fontSize: 13, fontWeight: '800' },
    card: {
      borderRadius: 19,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 14,
      marginTop: 12,
    },
    cardHeader: { flexDirection: 'row', alignItems: 'flex-start' },
    cardIcon: {
      width: 32,
      height: 32,
      borderRadius: 10,
      backgroundColor: colors.surfaceRaised,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 10,
    },
    cardTitle: { color: colors.text, fontSize: 16, fontWeight: '700' },
    cardMeta: { color: colors.muted, fontSize: 10, marginTop: 4 },
    latency: { color: colors.danger, fontFamily: fonts.mono, fontSize: 10 },
    latencyReady: { color: colors.success },
    resultStatus: { flexDirection: 'row', alignItems: 'center', gap: 5 },
    toggleRow: {
      minHeight: 48,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 7,
    },
    toggleLabel: { color: colors.textDim, fontSize: 12, fontWeight: '600' },
    presets: { marginHorizontal: -2, marginTop: 4 },
    preset: {
      minHeight: 42,
      borderRadius: 13,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 12,
      marginHorizontal: 3,
      justifyContent: 'center',
    },
    presetActive: {
      backgroundColor: colors.surfaceWarm,
      borderWidth: 1,
      borderColor: colors.accentSoft,
    },
    presetText: { color: colors.muted, fontSize: 11, fontWeight: '600' },
    presetTextActive: { color: colors.text },
    official: { color: colors.accent, fontSize: 8, marginTop: 2 },
    urlInput: {
      minHeight: 46,
      borderRadius: 13,
      backgroundColor: colors.background,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 10,
      paddingHorizontal: 12,
      marginTop: 12,
    },
    testButton: {
      alignSelf: 'flex-start',
      minHeight: 44,
      borderRadius: 13,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      paddingHorizontal: 14,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      marginTop: 9,
    },
    testText: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    error: {
      color: colors.danger,
      fontSize: 11,
      lineHeight: 17,
      marginTop: 12,
    },
    receipt: {
      borderRadius: 15,
      backgroundColor: colors.surfaceWarm,
      padding: 13,
      marginTop: 12,
    },
    receiptHeading: { flexDirection: 'row', alignItems: 'center', gap: 7 },
    receiptTitle: { color: colors.success, fontSize: 12, fontWeight: '700' },
    receiptBody: { color: colors.muted, fontSize: 10, marginTop: 4 },
    applyButton: {
      minHeight: 50,
      borderRadius: 16,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 14,
    },
    applyText: { color: colors.background, fontSize: 13, fontWeight: '800' },
    disabled: { opacity: 0.45 },
    pressed: { opacity: 0.65, transform: [{ scale: 0.99 }] },
  });
