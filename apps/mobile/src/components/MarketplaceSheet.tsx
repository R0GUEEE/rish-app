import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Download from 'lucide-react-native/icons/download';
import Share from 'lucide-react-native/icons/share';
import RefreshCw from 'lucide-react-native/icons/refresh-cw';
import Check from 'lucide-react-native/icons/check';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import {
  marketplaceEntryId,
  marketplaceEntryName,
  marketplaceEntryVersion,
  marketplaceInstallState,
  type MarketplaceCatalog,
  type MarketplaceEntry,
} from '../marketplace';
import { AppIcon } from './AppIcon';

type Props = {
  visible: boolean;
  catalog: MarketplaceCatalog;
  /** Installed versions by id, for the library each entry belongs to. */
  installedVersions: Readonly<Record<string, string>>;
  onClose: () => void;
  onInstall: (entry: MarketplaceEntry) => void;
  /** Shares the libraries as a document another device can read back. */
  onExportLibrary: () => void;
  onImportLibrary: () => void;
};

export function MarketplaceSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);

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
        <Text style={styles.title}>{t('marketplace.title')}</Text>
        <Text style={styles.source} testID="marketplace-source">
          {t('marketplace.source', { source: props.catalog.source })}
        </Text>
        {props.catalog.entries.length === 0 && (
          <Text style={styles.empty} testID="marketplace-empty">
            {t('marketplace.empty')}
          </Text>
        )}
        <ScrollView contentContainerStyle={styles.list} style={styles.scroll}>
          {props.catalog.entries.map(entry => {
            const id = marketplaceEntryId(entry);
            const version = marketplaceEntryVersion(entry);
            const installed =
              props.installedVersions[`${entry.kind}:${id}`] ?? null;
            const state = marketplaceInstallState(entry, installed);
            const label =
              state === 'not_installed'
                ? t('marketplace.install')
                : state === 'update_available'
                  ? t('marketplace.update')
                  : t('marketplace.installed');
            return (
              <View
                key={`${entry.kind}:${id}`}
                style={styles.row}
                testID={`marketplace-entry-${entry.kind}-${id}`}
              >
                <View style={styles.rowHeader}>
                  <Text style={styles.kind}>
                    {entry.kind === 'plugin'
                      ? t('marketplace.kind.plugin')
                      : t('marketplace.kind.skill')}
                  </Text>
                  <Text numberOfLines={1} style={styles.rowName}>
                    {marketplaceEntryName(entry)}
                  </Text>
                  <Text style={styles.rowVersion}>{version}</Text>
                </View>
                <Text style={styles.publisher}>
                  {t('marketplace.publisher', { publisher: entry.publisher })}
                </Text>
                <Text style={styles.summary}>{entry.summary}</Text>
                <Pressable
                  accessibilityLabel={t('marketplace.action', {
                    action: label,
                    name: marketplaceEntryName(entry),
                  })}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: state === 'installed' }}
                  disabled={state === 'installed'}
                  onPress={() => props.onInstall(entry)}
                  style={({ pressed }) => [
                    styles.action,
                    state === 'installed' && styles.installed,
                    pressed && state !== 'installed' && styles.pressed,
                  ]}
                  testID={`marketplace-action-${entry.kind}-${id}`}
                >
                  <AppIcon
                    color={
                      state === 'installed' ? colors.muted : colors.background
                    }
                    icon={
                      state === 'not_installed'
                        ? Download
                        : state === 'update_available'
                          ? RefreshCw
                          : Check
                    }
                    size={15}
                  />
                  <Text
                    style={[
                      styles.actionText,
                      state === 'installed' && styles.installedText,
                    ]}
                  >
                    {label}
                  </Text>
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
        <Pressable
          accessibilityLabel={t('marketplace.exportLibrary')}
          accessibilityRole="button"
          onPress={props.onExportLibrary}
          style={({ pressed }) => [
            styles.transfer,
            pressed && styles.pressed,
          ]}
          testID="marketplace-export-library"
        >
          <AppIcon color={colors.text} icon={Share} size={16} />
          <Text style={styles.transferText}>
            {t('marketplace.exportLibrary')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t('marketplace.importLibrary')}
          accessibilityRole="button"
          onPress={props.onImportLibrary}
          style={({ pressed }) => [
            styles.transfer,
            pressed && styles.pressed,
          ]}
          testID="marketplace-import-library"
        >
          <AppIcon color={colors.text} icon={Download} size={16} />
          <Text style={styles.transferText}>
            {t('marketplace.importLibrary')}
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
      maxHeight: '86%',
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
      fontSize: 26,
      marginTop: 8,
    },
    source: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 10,
    },
    empty: {
      color: colors.textDim,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 14,
    },
    scroll: { maxHeight: 420, marginTop: 14 },
    list: { gap: 10, paddingBottom: 4 },
    row: {
      borderRadius: 16,
      backgroundColor: colors.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 13,
    },
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    kind: {
      color: colors.accent,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1.4,
    },
    rowName: { flex: 1, color: colors.text, fontSize: 14, fontWeight: '700' },
    rowVersion: {
      color: colors.faint,
      fontFamily: fonts.mono,
      fontSize: 9,
    },
    publisher: { color: colors.faint, fontSize: 10, marginTop: 5 },
    summary: {
      color: colors.textDim,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 8,
    },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      minHeight: 42,
      borderRadius: 13,
      backgroundColor: colors.text,
      marginTop: 11,
    },
    actionText: { color: colors.background, fontSize: 12, fontWeight: '700' },
    installed: {
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.line,
    },
    installedText: { color: colors.muted },
    transfer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      minHeight: 44,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.line,
      marginTop: 10,
    },
    transferText: { color: colors.text, fontSize: 13, fontWeight: '700' },
    done: {
      height: 48,
      borderRadius: 15,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.line,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 14,
    },
    doneText: { color: colors.text, fontSize: 14, fontWeight: '700' },
    pressed: { opacity: 0.6, transform: [{ scale: 0.987 }] },
  });
