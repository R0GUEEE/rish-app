import React, { useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
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
  MAX_TRANSFER_BYTES,
  parseLibraryTransfer,
  type LibraryTransfer,
  type TransferRefusal,
} from '../libraryTransfer';
import { AppIcon } from './AppIcon';

type Props = {
  visible: boolean;
  onClose: () => void;
  onImport: (transfer: LibraryTransfer) => void;
};

const REFUSAL_KEYS = {
  not_json: 'marketplace.importRefused.notJson',
  not_a_transfer: 'marketplace.importRefused.notTransfer',
  too_large: 'marketplace.importRefused.tooLarge',
  invalid_entry: 'marketplace.importRefused.invalidEntry',
} as const satisfies Record<TransferRefusal, string>;

/**
 * Reads a shared library back from a pasted document.
 *
 * The document is parsed as it is pasted, so a person sees whether it can be
 * read before they press anything, and nothing is imported until the whole
 * document has been accepted.
 */
export function LibraryImportSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [text, setText] = useState('');

  const parsed = useMemo(() => parseLibraryTransfer(text), [text]);
  const reason =
    text.trim().length === 0 || parsed.ok
      ? null
      : t(REFUSAL_KEYS[parsed.reason]);

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
        <Text style={styles.title}>{t('marketplace.importTitle')}</Text>
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
        >
          <Text style={styles.hint}>{t('marketplace.importHint')}</Text>
          <TextInput
            accessibilityLabel={t('marketplace.importTitle')}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={MAX_TRANSFER_BYTES}
            multiline
            onChangeText={setText}
            placeholder={t('marketplace.importPlaceholder')}
            placeholderTextColor={colors.faint}
            style={styles.input}
            testID="library-import-text"
            value={text}
          />
          {reason !== null && (
            <Text style={styles.reason} testID="library-import-reason">
              {reason}
            </Text>
          )}
        </ScrollView>
        <Pressable
          accessibilityLabel={t('marketplace.importAction')}
          accessibilityRole="button"
          accessibilityState={{ disabled: !parsed.ok }}
          disabled={!parsed.ok}
          onPress={() => {
            if (parsed.ok) props.onImport(parsed.transfer);
          }}
          style={({ pressed }) => [
            styles.import,
            !parsed.ok && styles.disabled,
            pressed && parsed.ok && styles.pressed,
          ]}
          testID="library-import-action"
        >
          <AppIcon color={colors.background} icon={Download} size={16} />
          <Text style={styles.importText}>
            {t('marketplace.importAction')}
          </Text>
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
      fontSize: 24,
      marginTop: 8,
    },
    scroll: { maxHeight: 380, marginTop: 12 },
    scrollContent: { paddingBottom: 4 },
    hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
    input: {
      minHeight: 150,
      borderRadius: 14,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontFamily: fonts.mono,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      textAlignVertical: 'top',
    },
    reason: { color: colors.warning, fontSize: 11, marginTop: 10 },
    import: {
      height: 48,
      borderRadius: 15,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 12,
    },
    importText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    disabled: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
  });
