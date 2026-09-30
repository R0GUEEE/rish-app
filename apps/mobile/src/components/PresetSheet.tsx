import React, { useEffect, useMemo, useState } from 'react';
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
import Check from 'lucide-react-native/icons/check';
import Plus from 'lucide-react-native/icons/plus';
import Trash2 from 'lucide-react-native/icons/trash-2';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import {
  MAX_PRESET_NAME_LENGTH,
  isPresetName,
  type AgentPreset,
} from '../presets/presets';
import { AppIcon } from './AppIcon';

/** The settings a "save current" would capture. */
export type PresetCurrentSettings = {
  readonly modelId: string;
  readonly thinkingMode: AgentPreset['thinkingMode'];
  readonly toolPermission: AgentPreset['toolPermission'];
};

type Props = {
  visible: boolean;
  presets: readonly AgentPreset[];
  current: PresetCurrentSettings;
  onClose: () => void;
  onApply: (preset: AgentPreset) => void;
  onDelete: (id: string) => void;
  /** Saves the current settings under a new name. */
  onSaveCurrent: (name: string) => void;
};

/**
 * Managing saved round settings.
 *
 * Applying a preset is the primary action, so it is the whole row and the
 * destructive action is a separate small target beside it -- a delete that
 * shares the row's tap area is a delete people hit by accident. Saving the
 * current settings is offered here rather than only where the settings live,
 * because this is where a person notices the preset they want is missing.
 */
export function PresetSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [name, setName] = useState('');
  const [appliedId, setAppliedId] = useState<string | null>(null);

  // A sheet that keeps a half-typed name and a stale "applied" tick across
  // openings is a sheet that lies about what it just did.
  useEffect(() => {
    if (props.visible) return;
    setName('');
    setAppliedId(null);
  }, [props.visible]);

  const canSave = isPresetName(name);
  const apply = (preset: AgentPreset) => {
    props.onApply(preset);
    setAppliedId(preset.id);
  };

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
        <Text style={styles.eyebrow}>{t('presets.eyebrow')}</Text>
        <Text style={styles.title}>{t('presets.title')}</Text>

        <ScrollView
          style={styles.list}
          contentContainerStyle={styles.listContent}
          testID="preset-list"
        >
          {props.presets.length === 0 ? (
            <Text style={styles.empty}>{t('presets.empty')}</Text>
          ) : (
            props.presets.map(preset => (
              <View key={preset.id} style={styles.row}>
                <Pressable
                  accessibilityLabel={t('presets.apply', { name: preset.name })}
                  accessibilityRole="button"
                  onPress={() => apply(preset)}
                  style={({ pressed }) => [
                    styles.rowMain,
                    pressed && styles.pressed,
                  ]}
                  testID={`preset-apply-${preset.id}`}
                >
                  <View style={styles.rowText}>
                    <Text numberOfLines={1} style={styles.rowName}>
                      {preset.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.rowMeta}>
                      {`${preset.modelId} · ${preset.thinkingMode} · ${preset.toolPermission}`}
                    </Text>
                  </View>
                  {appliedId === preset.id && (
                    <AppIcon color={colors.accent} icon={Check} size={16} />
                  )}
                </Pressable>
                <Pressable
                  accessibilityLabel={t('presets.delete', { name: preset.name })}
                  accessibilityRole="button"
                  onPress={() => props.onDelete(preset.id)}
                  style={({ pressed }) => [
                    styles.rowDelete,
                    pressed && styles.pressed,
                  ]}
                  testID={`preset-delete-${preset.id}`}
                >
                  <AppIcon color={colors.danger} icon={Trash2} size={15} />
                </Pressable>
              </View>
            ))
          )}
        </ScrollView>

        <Text style={styles.saveLabel}>{t('presets.saveCurrent')}</Text>
        <View style={styles.saveRow}>
          <TextInput
            accessibilityLabel={t('presets.nameLabel')}
            maxLength={MAX_PRESET_NAME_LENGTH}
            onChangeText={setName}
            placeholder={t('presets.namePlaceholder')}
            placeholderTextColor={colors.faint}
            style={styles.input}
            testID="preset-name"
            value={name}
          />
          <Pressable
            accessibilityLabel={t('presets.save')}
            accessibilityRole="button"
            disabled={!canSave}
            onPress={() => {
              props.onSaveCurrent(name.trim());
              setName('');
            }}
            style={({ pressed }) => [
              styles.save,
              !canSave && styles.disabled,
              pressed && canSave && styles.pressed,
            ]}
            testID="preset-save"
          >
            <AppIcon color={colors.background} icon={Plus} size={16} />
            <Text style={styles.saveText}>{t('presets.save')}</Text>
          </Pressable>
        </View>
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
    list: { maxHeight: 280, marginTop: 14 },
    listContent: { gap: 8 },
    empty: { color: colors.muted, fontSize: 13, lineHeight: 19 },
    row: { flexDirection: 'row', alignItems: 'stretch', gap: 8 },
    rowMain: {
      flex: 1,
      minWidth: 0,
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
    rowDelete: {
      width: 48,
      minHeight: 52,
      borderRadius: 15,
      backgroundColor: colors.surfaceWarm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    saveLabel: {
      color: colors.accent,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 2,
      marginTop: 20,
    },
    saveRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
    input: {
      flex: 1,
      minWidth: 0,
      height: 49,
      borderRadius: 15,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontSize: 15,
      paddingHorizontal: 14,
    },
    save: {
      minWidth: 96,
      height: 49,
      borderRadius: 15,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingHorizontal: 16,
    },
    saveText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    disabled: { opacity: 0.3 },
    pressed: { opacity: 0.6 },
  });
