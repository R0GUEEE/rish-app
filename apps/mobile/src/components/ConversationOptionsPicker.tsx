import React, { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Check from 'lucide-react-native/icons/check';

import type { Translator } from '../preferences';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { ConversationThinkingMode } from '../state';
import type { ThemePalette } from '../theme';
import {
  localizedModelDetails,
  modelDetails,
  type SupportedModel,
} from './ModelPicker';
import { AppIcon } from './AppIcon';

const MODELS = Object.keys(modelDetails) as SupportedModel[];
const THINKING_MODES: readonly ConversationThinkingMode[] = [
  'off',
  'high',
  'max',
];

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

type Props = {
  disabled?: boolean;
  model: SupportedModel;
  thinkingMode: ConversationThinkingMode;
  visible: boolean;
  onClose: () => void;
  onSelectModel: (model: SupportedModel) => void;
  onSelectThinkingMode: (mode: ConversationThinkingMode) => void;
};

/**
 * One anchored panel that keeps both conversation-scoped choices editable at
 * the same time. Selections apply immediately and never dismiss the panel on
 * their own; dismissal is explicit.
 */
export function ConversationOptionsPicker({
  disabled = false,
  model,
  thinkingMode,
  visible,
  onClose,
  onSelectModel,
  onSelectThinkingMode,
}: Props) {
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="conversation-options-modal"
      transparent
      visible={visible}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <Pressable
          accessibilityLabel={t('options.close')}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="conversation-options-backdrop"
        />
        <View
          pointerEvents="box-none"
          style={styles.anchor}
          testID="conversation-options-anchor"
        >
          <View
            accessibilityLabel={t('options.title')}
            accessibilityRole="dialog"
            style={styles.popover}
            testID="conversation-options-popover"
          >
            <Text style={styles.eyebrow}>{t('model.eyebrow')}</Text>
            <View
              accessibilityLabel={t('model.title')}
              accessibilityRole="radiogroup"
            >
              {MODELS.map((candidate, index) => {
                const details = localizedModelDetails(candidate, t);
                const isSelected = candidate === model;
                return (
                  <Pressable
                    accessibilityLabel={t('model.use', {
                      model: details.name,
                    })}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isSelected, disabled }}
                    disabled={disabled}
                    key={candidate}
                    onPress={() => onSelectModel(candidate)}
                    style={({ pressed }) => [
                      styles.option,
                      index > 0 && styles.optionDivider,
                      isSelected && styles.optionSelected,
                      disabled && styles.optionDisabled,
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
            <View style={styles.sectionDivider} />
            <Text style={styles.eyebrow}>{t('thinking.eyebrow')}</Text>
            <View
              accessibilityLabel={t('thinking.title')}
              accessibilityRole="radiogroup"
            >
              {THINKING_MODES.map((mode, index) => {
                const details = localizedThinkingDetails(mode, t);
                const isSelected = mode === thinkingMode;
                return (
                  <Pressable
                    accessibilityLabel={t('thinking.use', {
                      mode: details.name,
                    })}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: isSelected, disabled }}
                    disabled={disabled}
                    key={mode}
                    onPress={() => onSelectThinkingMode(mode)}
                    style={({ pressed }) => [
                      styles.option,
                      index > 0 && styles.optionDivider,
                      isSelected && styles.optionSelected,
                      disabled && styles.optionDisabled,
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
            <Pressable
              accessibilityLabel={t('common.done')}
              accessibilityRole="button"
              onPress={onClose}
              style={({ pressed }) => [
                styles.doneRow,
                pressed && styles.menuItemPressed,
              ]}
              testID="conversation-options-done"
            >
              <Text style={styles.doneText}>{t('common.done')}</Text>
            </Pressable>
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
      alignItems: 'flex-start',
      paddingLeft: 18,
      paddingBottom: 108,
    },
    popover: {
      width: 300,
      backgroundColor: colors.surface,
      overflow: 'hidden',
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingTop: 12,
      paddingBottom: 6,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.24,
      shadowRadius: 30,
      elevation: 16,
    },
    eyebrow: {
      color: colors.muted,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.2,
      paddingHorizontal: 15,
      marginBottom: 3,
    },
    option: {
      minHeight: 60,
      paddingHorizontal: 15,
      paddingVertical: 9,
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
      marginTop: 2,
    },
    check: {
      width: 22,
      alignItems: 'flex-start',
      marginRight: 8,
    },
    sectionDivider: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      marginTop: 7,
      marginBottom: 9,
    },
    doneRow: {
      minHeight: 44,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 4,
      marginHorizontal: 10,
      marginBottom: 3,
    },
    doneText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
    menuItemPressed: { backgroundColor: colors.surfaceRaised },
    pressed: { opacity: 0.58 },
    optionDisabled: { opacity: 0.45 },
  });
