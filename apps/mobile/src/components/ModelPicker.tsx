import React, { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Check from 'lucide-react-native/icons/check';

import { useAppPresentation } from '../presentation/AppPresentation';
import type { Translator } from '../preferences';
import type { ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

export type SupportedModel =
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash-vision-exp';

export const modelDetails: Record<
  SupportedModel,
  { name: string; eyebrow: string; description: string }
> = {
  'deepseek-v4-flash': {
    name: 'V4 Flash',
    eyebrow: 'FAST · DEFAULT',
    description: 'Quick everyday work with strong agent capability.',
  },
  'deepseek-v4-pro': {
    name: 'V4 Pro',
    eyebrow: 'DEEP · PRECISE',
    description: 'More deliberate reasoning for difficult tasks.',
  },
  'deepseek-v4-flash-vision-exp': {
    name: 'Flash Exp',
    eyebrow: 'VISION · EXPERIMENTAL',
    description: 'Multimodal image and text understanding.',
  },
};

export function localizedModelDetails(
  model: SupportedModel,
  t: Translator,
): { name: string; eyebrow: string; description: string } {
  switch (model) {
    case 'deepseek-v4-flash':
      return {
        name: t('model.flash.name'),
        eyebrow: t('model.flash.eyebrow'),
        description: t('model.flash.description'),
      };
    case 'deepseek-v4-pro':
      return {
        name: t('model.pro.name'),
        eyebrow: t('model.pro.eyebrow'),
        description: t('model.pro.description'),
      };
    case 'deepseek-v4-flash-vision-exp':
      return {
        name: t('model.vision.name'),
        eyebrow: t('model.vision.eyebrow'),
        description: t('model.vision.description'),
      };
  }
}

type Props = {
  placement?: 'composer' | 'settings';
  selected: SupportedModel;
  visible: boolean;
  onClose: () => void;
  onSelect: (model: SupportedModel) => void;
};

export function ModelPicker({
  placement = 'composer',
  selected,
  visible,
  onClose,
  onSelect,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const models = Object.keys(modelDetails) as SupportedModel[];

  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="model-picker-modal"
      transparent
      visible={visible}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <Pressable
          accessibilityLabel={t('model.closePicker')}
          accessibilityRole="button"
          onPress={onClose}
          style={styles.backdrop}
          testID="model-picker-backdrop"
        />
        <View
          pointerEvents="box-none"
          style={[
            styles.anchor,
            placement === 'settings'
              ? [styles.settingsAnchor, { paddingBottom: insets.bottom + 18 }]
              : styles.composerAnchor,
          ]}
          testID="model-picker-anchor"
        >
          <View
            accessibilityLabel={t('model.title')}
            accessibilityRole="radiogroup"
            style={[
              styles.popover,
              placement === 'settings' && styles.settingsPopover,
            ]}
            testID="model-picker-popover"
          >
            {models.map((model, index) => {
              const details = localizedModelDetails(model, t);
              const isSelected = model === selected;
              return (
                <Pressable
                  accessibilityLabel={t('model.use', { model: details.name })}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: isSelected }}
                  key={model}
                  onPress={() => {
                    onSelect(model);
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
    },
    composerAnchor: {
      alignItems: 'flex-start',
      paddingLeft: 18,
      paddingBottom: 108,
    },
    settingsAnchor: {
      alignItems: 'stretch',
      paddingHorizontal: 18,
    },
    popover: {
      width: 286,
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
    settingsPopover: { width: 'auto' },
    option: {
      minHeight: 66,
      paddingHorizontal: 15,
      paddingVertical: 11,
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
    optionTitle: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '700',
    },
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
