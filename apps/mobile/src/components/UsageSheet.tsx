import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { formatBytes } from '../format/bytes';
import {
  summarizeContextUsage,
  type UsageConversation,
} from '../usage/contextUsage';

type Props = {
  visible: boolean;
  conversations: readonly UsageConversation[];
  onClose: () => void;
};

/** Thousands separators without depending on the device locale. */
function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

/**
 * What the app spent, as far as it can honestly say.
 *
 * The scope line is part of the screen rather than a footnote: this app does
 * not record model tokens or cost anywhere, so a sheet headed "Usage" that
 * showed only context estimates would be read as a bill. Saying what is absent
 * is the difference between an estimate and a claim.
 */
export function UsageSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const summary = useMemo(
    () => summarizeContextUsage(props.conversations),
    [props.conversations],
  );
  const tokens = formatCount(summary.totalEstimatedTokens);

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
      <View
        style={[styles.sheet, { paddingBottom: insets.bottom + 18 }]}
        testID="usage-sheet"
      >
        <View style={styles.handle} />
        <Text style={styles.eyebrow}>{t('usage.eyebrow')}</Text>
        <Text style={styles.title}>{t('usage.title')}</Text>
        <Text style={styles.scope}>{t('usage.scope')}</Text>

        {summary.conversations === 0 ? (
          <Text style={styles.empty}>{t('usage.empty')}</Text>
        ) : (
          <>
            <View style={styles.totals}>
              <View style={styles.total}>
                <Text style={styles.totalValue} testID="usage-total-tokens">
                  {tokens}
                </Text>
                <Text style={styles.totalLabel}>
                  {t('usage.estimatedTokensLabel')}
                </Text>
              </View>
              <View style={styles.total}>
                <Text style={styles.totalValue}>
                  {formatBytes(summary.totalContextBytes)}
                </Text>
                <Text style={styles.totalLabel}>{t('usage.contextLabel')}</Text>
              </View>
              <View style={styles.total}>
                <Text style={styles.totalValue}>
                  {formatCount(summary.conversations)}
                </Text>
                <Text style={styles.totalLabel}>{t('usage.chatsLabel')}</Text>
              </View>
              <View style={styles.total}>
                <Text style={styles.totalValue}>
                  {formatCount(summary.includedFiles)}
                </Text>
                <Text style={styles.totalLabel}>{t('usage.filesLabel')}</Text>
              </View>
            </View>

            <ScrollView
              style={styles.list}
              contentContainerStyle={styles.listContent}
              testID="usage-list"
            >
              {summary.entries.map(entry => (
                <View
                  key={entry.conversationId}
                  style={styles.row}
                  testID={`usage-row-${entry.conversationId}`}
                >
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={styles.rowName}>
                      {entry.conversationTitle}
                    </Text>
                    <Text numberOfLines={1} style={styles.rowMeta}>
                      {`${entry.projectName} · ${formatBytes(entry.contextBytes)} · ${formatCount(entry.includedFiles)}${
                        entry.omittedFiles > 0
                          ? ` (+${formatCount(entry.omittedFiles)})`
                          : ''
                      }`}
                    </Text>
                  </View>
                  <Text style={styles.rowTokens}>
                    {`~${formatCount(entry.estimatedTokens)}`}
                  </Text>
                </View>
              ))}
            </ScrollView>
          </>
        )}
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
      fontSize: 26,
      marginTop: 8,
    },
    scope: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 18,
      marginTop: 10,
    },
    empty: {
      color: colors.muted,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 18,
    },
    totals: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginTop: 18,
    },
    total: {
      flexGrow: 1,
      minWidth: 104,
      borderRadius: 15,
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.line,
      borderWidth: 1,
      paddingHorizontal: 14,
      paddingVertical: 12,
      gap: 5,
    },
    totalValue: {
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 18,
    },
    totalLabel: {
      color: colors.muted,
      fontSize: 8,
      fontWeight: '800',
      letterSpacing: 1,
    },
    list: { maxHeight: 260, marginTop: 14 },
    listContent: { gap: 8 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      minHeight: 52,
      borderRadius: 15,
      backgroundColor: colors.surfaceRaised,
      borderColor: colors.line,
      borderWidth: 1,
      paddingHorizontal: 14,
    },
    rowText: { flex: 1, minWidth: 0 },
    rowName: { color: colors.text, fontSize: 15, fontWeight: '700' },
    rowMeta: {
      color: colors.muted,
      fontSize: 8,
      fontFamily: fonts.mono,
      marginTop: 5,
    },
    rowTokens: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 12,
    },
  });
