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
  | 'deepseek-v4-flash-vision-exp'
  | 'claude-sonnet-5'
  | 'claude-opus-5'
  | 'claude-haiku-4-5-20251001'
  | 'claude-fable-5-1'
  | 'gpt-5.6'
  | 'gpt-5.6-mini'
  | 'gpt-5.6-nano'
  | 'GLM-5.3'
  | 'GLM-5.3-Flash';

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
  'claude-sonnet-5': {
    name: 'Sonnet 5',
    eyebrow: 'CLAUDE · DEFAULT',
    description: 'Balanced Claude Code work with dependable tool use.',
  },
  'claude-opus-5': {
    name: 'Opus 5',
    eyebrow: 'DEEP · DELIBERATE',
    description: 'Deepest reasoning for the hardest tasks.',
  },
  'claude-haiku-4-5-20251001': {
    name: 'Haiku 4.5',
    eyebrow: 'FAST · LIGHT',
    description: 'Quick, light Claude Code rounds.',
  },
  'claude-fable-5-1': {
    name: 'Fable 5.1',
    eyebrow: 'CREATIVE · EXPERIMENTAL',
    description: 'Experimental Claude Code model for creative work.',
  },
  'gpt-5.6': {
    name: 'GPT-5.6',
    eyebrow: 'CODEX · DEFAULT',
    description: 'OpenAI Codex work with reasoning and tools.',
  },
  'gpt-5.6-mini': {
    name: 'GPT-5.6 Mini',
    eyebrow: 'FAST · COMPACT',
    description: 'Faster Codex rounds for everyday work.',
  },
  'gpt-5.6-nano': {
    name: 'GPT-5.6 Nano',
    eyebrow: 'FASTEST · NANO',
    description: 'Smallest and fastest Codex model.',
  },
  'GLM-5.3': {
    name: 'GLM-5.3',
    eyebrow: 'GLM · DEFAULT',
    description: 'Zhipu GLM reasoning and tool work over Messages transport.',
  },
  'GLM-5.3-Flash': {
    name: 'GLM-5.3 Flash',
    eyebrow: 'FAST · FLASH',
    description: 'Faster Zhipu GLM rounds for everyday work.',
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
    case 'claude-sonnet-5':
      return {
        name: t('model.sonnet.name'),
        eyebrow: t('model.sonnet.eyebrow'),
        description: t('model.sonnet.description'),
      };
    case 'claude-opus-5':
      return {
        name: t('model.opus.name'),
        eyebrow: t('model.opus.eyebrow'),
        description: t('model.opus.description'),
      };
    case 'claude-haiku-4-5-20251001':
      return {
        name: t('model.haiku.name'),
        eyebrow: t('model.haiku.eyebrow'),
        description: t('model.haiku.description'),
      };
    case 'claude-fable-5-1':
      return {
        name: t('model.fable.name'),
        eyebrow: t('model.fable.eyebrow'),
        description: t('model.fable.description'),
      };
    case 'gpt-5.6':
      return {
        name: t('model.gpt56.name'),
        eyebrow: t('model.gpt56.eyebrow'),
        description: t('model.gpt56.description'),
      };
    case 'gpt-5.6-mini':
      return {
        name: t('model.gpt56mini.name'),
        eyebrow: t('model.gpt56mini.eyebrow'),
        description: t('model.gpt56mini.description'),
      };
    case 'gpt-5.6-nano':
      return {
        name: t('model.gpt56nano.name'),
        eyebrow: t('model.gpt56nano.eyebrow'),
        description: t('model.gpt56nano.description'),
      };
    case 'GLM-5.3':
      return {
        name: t('model.glm53.name'),
        eyebrow: t('model.glm53.eyebrow'),
        description: t('model.glm53.description'),
      };
    case 'GLM-5.3-Flash':
      return {
        name: t('model.glm53flash.name'),
        eyebrow: t('model.glm53flash.eyebrow'),
        description: t('model.glm53flash.description'),
      };
  }
}

type Props = {
  disabled?: boolean;
  placement?: 'composer' | 'settings';
  /** Model catalog of the selected Harness; defaults to every known model. */
  models?: readonly SupportedModel[];
  selected: SupportedModel;
  visible: boolean;
  onClose: () => void;
  onSelect: (model: SupportedModel) => void;
};

export function ModelPicker({
  disabled = false,
  placement = 'composer',
  models: modelsProp,
  selected,
  visible,
  onClose,
  onSelect,
}: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const models =
    modelsProp ?? (Object.keys(modelDetails) as SupportedModel[]);

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
                  accessibilityState={{ checked: isSelected, disabled }}
                  disabled={disabled}
                  key={model}
                  onPress={() => {
                    onSelect(model);
                    onClose();
                  }}
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
    optionDisabled: { opacity: 0.45 },
  });
