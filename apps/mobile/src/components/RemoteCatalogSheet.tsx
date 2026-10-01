import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Download from 'lucide-react-native/icons/download';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import {
  fetchRemoteCatalog,
  type MarketplaceCatalog,
  type RemoteCatalogRefusal,
} from '../marketplace';
import { AppIcon } from './AppIcon';

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Called with a catalog that passed every digest. */
  onLoaded: (catalog: MarketplaceCatalog) => void;
  /** Injected so a test can drive the fetch without a network. */
  fetchImpl?: typeof fetch;
};

const REFUSAL_KEYS = {
  not_https: 'marketplace.loadRefused.notHttps',
  insecure_redirect: 'marketplace.loadRefused.insecureRedirect',
  network: 'marketplace.loadRefused.network',
  timeout: 'marketplace.loadRefused.timeout',
  too_large: 'marketplace.loadRefused.tooLarge',
  invalid_catalog: 'marketplace.loadRefused.invalidCatalog',
  digest_missing: 'marketplace.loadRefused.digestMissing',
  digest_mismatch: 'marketplace.loadRefused.digestMismatch',
} as const satisfies Record<RemoteCatalogRefusal, string>;

/**
 * Fetches a catalog from an address a person typed.
 *
 * The address is read as it is typed and the fetch runs on demand; a catalog
 * is handed on only after every entry matched the digest it arrived with, so
 * what the marketplace then shows is what the publisher wrote.
 */
export function RemoteCatalogSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<RemoteCatalogRefusal | null>(null);

  const fetchCatalog = async () => {
    setBusy(true);
    setRefusal(null);
    const result = await fetchRemoteCatalog(url, {
      ...(props.fetchImpl === undefined ? {} : { fetchImpl: props.fetchImpl }),
    });
    setBusy(false);
    if (!result.ok) {
      setRefusal(result.reason);
      return;
    }
    props.onLoaded(result.catalog);
  };

  const status =
    refusal === null ? null : t(REFUSAL_KEYS[refusal]);

  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      transparent
      visible={props.visible}
    >
      <Pressable
        accessibilityLabel={t('common.close')}
        onPress={props.onClose}
        style={styles.backdrop}
      />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}>
        <View style={styles.handle} />
        <Text style={styles.eyebrow}>{t('marketplace.eyebrow')}</Text>
        <Text style={styles.title}>{t('marketplace.loadTitle')}</Text>
        <Text style={styles.hint}>{t('marketplace.loadHint')}</Text>
        <Text style={styles.fieldLabel}>{t('marketplace.loadUrl')}</Text>
        <TextInput
          accessibilityLabel={t('marketplace.loadUrl')}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!busy}
          onChangeText={value => {
            setUrl(value);
            setRefusal(null);
          }}
          placeholder="https://example.com/catalog.json"
          placeholderTextColor={colors.faint}
          style={styles.input}
          testID="catalog-url"
          value={url}
        />
        {status !== null && (
          <Text style={styles.refusal} testID="catalog-refusal">
            {status}
          </Text>
        )}
        <Pressable
          accessibilityLabel={t('marketplace.loadAction')}
          accessibilityRole="button"
          accessibilityState={{ disabled: busy || url.trim().length === 0 }}
          disabled={busy || url.trim().length === 0}
          onPress={() => {
            fetchCatalog().catch(() => undefined);
          }}
          style={({ pressed }) => [
            styles.fetch,
            (busy || url.trim().length === 0) && styles.disabled,
            pressed && styles.pressed,
          ]}
          testID="catalog-fetch"
        >
          <AppIcon color={colors.background} icon={Download} size={16} />
          <Text style={styles.fetchText}>
            {busy ? t('marketplace.loading') : t('marketplace.loadAction')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t('common.close')}
          accessibilityRole="button"
          onPress={props.onClose}
          style={({ pressed }) => [styles.done, pressed && styles.pressed]}
        >
          <Text style={styles.doneText}>{t('common.close')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: colors.scrim },
    sheet: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 29,
      borderTopRightRadius: 29,
      paddingTop: 10,
      paddingHorizontal: 20,
    },
    handle: {
      alignSelf: 'center',
      width: 42,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.line,
      marginBottom: 21,
    },
    eyebrow: {
      color: colors.accent,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 2,
    },
    title: {
      color: colors.text,
      fontFamily: fonts.display,
      fontSize: 24,
      marginTop: 8,
    },
    hint: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 10,
    },
    fieldLabel: {
      color: colors.faint,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.4,
      marginTop: 16,
      marginBottom: 6,
    },
    input: {
      minHeight: 44,
      borderRadius: 14,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 12,
      paddingHorizontal: 13,
      paddingVertical: 10,
    },
    refusal: { color: colors.warning, fontSize: 11, marginTop: 10 },
    fetch: {
      height: 48,
      borderRadius: 15,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 14,
    },
    fetchText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    disabled: { opacity: 0.35 },
    done: {
      height: 48,
      borderRadius: 15,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.line,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 10,
    },
    doneText: { color: colors.text, fontSize: 14, fontWeight: '700' },
    pressed: { opacity: 0.7 },
  });
