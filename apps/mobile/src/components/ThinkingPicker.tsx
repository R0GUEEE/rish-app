import React, { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Check from 'lucide-react-native/icons/check';

import type { Translator } from '../preferences';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { ConversationThinkingMode } from '../state';
import type { ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

const MODES: readonly ConversationThinkingMode[] = ['off', 'high', 'max'];

export function localizedThinkingDetails(
  mode: ConversationThinkingMode,
  t: Translator,
): { name: string; shortName: string; description: string } {
  return {
    name: t(`thinking.${mode}.name`),
    shortName: t(`thinking.${mode}.shortName`),
    description: t(`thinking.${mode}.description`),
  };
}

export function ThinkingPicker({
  selected,
  visible,
  onClose,
  onSelect,
}: {
  selected: ConversationThinkingMode;
  visible: boolean;
  onClose: () => void;
  onSelect: (mode: ConversationThinkingMode) => void;
}) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="thinking-picker-modal"
      transparent
      visible={visible}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <Pressable
          accessibilityLabel={t('thinking.closePicker')}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="thinking-picker-backdrop"
        />
        <View pointerEvents="box-none" style={styles.anchor}>
          <View
            accessibilityLabel={t('thinking.title')}
            accessibilityRole="radiogroup"
            style={styles.popover}
            testID="thinking-picker-popover"
          >
            {MODES.map((mode, index) => {
              const details = localizedThinkingDetails(mode, t);
              const isSelected = mode === selected;
              return (
                <Pressable
                  accessibilityLabel={t('thinking.use', {
                    mode: details.name,
                  })}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  key={mode}
                  onPress={() => {
                    onSelect(mode);
                    onClose();
                  }}
                  style={({ pressed }) => [
                    styles.option,
                    index > 0 && styles.optionDivider,
                    isSelected && styles.optionSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.check}>
                    {isSelected && (
                      <AppIcon color={colors.accent} icon={Check} size={18} />
                    )}
                  </View>
                  <View style={styles.optionCopy}>
                    <Text style={styles.optionTitle}>{details.name}</Text>
                    <Text numberOfLines={2} style={styles.optionBody}>
                      {details.description}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    overlay: { flex: 1 },
    backdrop: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: 'rgba(0,0,0,0.18)',
    },
    anchor: {
      flex: 1,
      justifyContent: 'flex-end',
      alignItems: 'flex-end',
      paddingRight: 18,
      paddingBottom: 108,
    },
    popover: {
      width: 230,
      backgroundColor: colors.surface,
      overflow: 'hidden',
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingVertical: 7,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.24,
      shadowRadius: 30,
      elevation: 16,
    },
    option: {
      minHeight: 64,
      paddingHorizontal: 15,
      paddingVertical: 10,
      flexDirection: 'row',
      alignItems: 'center',
    },
    optionDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
    },
    optionSelected: {
      backgroundColor: colors.surfaceRaised,
    },
    optionCopy: { flex: 1 },
    optionTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    optionBody: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 3,
    },
    check: {
      width: 22,
      alignItems: 'flex-start',
      marginRight: 8,
    },
    pressed: { opacity: 0.58 },
  });
