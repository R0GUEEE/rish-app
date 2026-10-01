import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Save from 'lucide-react-native/icons/save';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import {
  MAX_SKILL_DESCRIPTION_LENGTH,
  MAX_SKILL_ID_LENGTH,
  MAX_SKILL_INSTRUCTIONS_LENGTH,
  MAX_SKILL_NAME_LENGTH,
  MAX_SKILL_VERSION_LENGTH,
  createSkill,
  type Skill,
} from '../skills';
import { AppIcon } from './AppIcon';

type Props = {
  visible: boolean;
  /** The skill being corrected, or null when this is a new one. */
  editing: Skill | null;
  onClose: () => void;
  onSave: (skill: Skill) => void;
};

const EMPTY = {
  id: '',
  name: '',
  version: '1.0.0',
  description: '',
  instructions: '',
};

/**
 * Writes a skill by hand.
 *
 * The same rules the library enforces run here as a person types, so a skill
 * that could not be kept is never offered as saveable: the id has to be one the
 * library accepts, the fields have their bounds, and the instructions have to
 * be something the transcript can carry.
 */
export function SkillEditorSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [fields, setFields] = useState(EMPTY);

  useEffect(() => {
    if (!props.visible) return;
    setFields(
      props.editing === null
        ? EMPTY
        : {
            id: props.editing.id,
            name: props.editing.name,
            version: props.editing.version,
            description: props.editing.description,
            instructions: props.editing.instructions,
          },
    );
  }, [props.visible, props.editing]);

  const candidate = useMemo(() => createSkill(fields), [fields]);
  const reason =
    candidate === null
      ? t('skills.editor.invalid')
      : null;

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
        <Text style={styles.eyebrow}>{t('skills.eyebrow')}</Text>
        <Text style={styles.title}>
          {props.editing === null
            ? t('skills.editor.addTitle')
            : t('skills.editor.editTitle')}
        </Text>
        <Text style={styles.hint}>{t('skills.editor.hint')}</Text>
        <Field
          label={t('skills.editor.id')}
          maxLength={MAX_SKILL_ID_LENGTH}
          onChangeText={value => setFields(current => ({ ...current, id: value }))}
          placeholder="release_notes"
          testID="skill-editor-id"
          value={fields.id}
        />
        <Field
          label={t('skills.editor.name')}
          maxLength={MAX_SKILL_NAME_LENGTH}
          onChangeText={value =>
            setFields(current => ({ ...current, name: value }))
          }
          placeholder="Release notes"
          testID="skill-editor-name"
          value={fields.name}
        />
        <Field
          label={t('skills.editor.version')}
          maxLength={MAX_SKILL_VERSION_LENGTH}
          onChangeText={value =>
            setFields(current => ({ ...current, version: value }))
          }
          placeholder="1.0.0"
          testID="skill-editor-version"
          value={fields.version}
        />
        <Field
          label={t('skills.editor.description')}
          maxLength={MAX_SKILL_DESCRIPTION_LENGTH}
          onChangeText={value =>
            setFields(current => ({ ...current, description: value }))
          }
          placeholder={t('skills.editor.descriptionPlaceholder')}
          testID="skill-editor-description"
          value={fields.description}
        />
        <Field
          label={t('skills.editor.instructions')}
          maxLength={MAX_SKILL_INSTRUCTIONS_LENGTH}
          multiline
          onChangeText={value =>
            setFields(current => ({ ...current, instructions: value }))
          }
          placeholder={t('skills.editor.instructionsPlaceholder')}
          testID="skill-editor-instructions"
          value={fields.instructions}
        />
        {reason !== null && (
          <Text style={styles.reason} testID="skill-editor-reason">
            {reason}
          </Text>
        )}
        <Pressable
          accessibilityLabel={t('skills.editor.save')}
          accessibilityRole="button"
          accessibilityState={{ disabled: candidate === null }}
          disabled={candidate === null}
          onPress={() => {
            if (candidate === null) return;
            props.onSave(candidate);
          }}
          style={({ pressed }) => [
            styles.save,
            candidate === null && styles.disabled,
            pressed && candidate !== null && styles.pressed,
          ]}
          testID="skill-editor-save"
        >
          <AppIcon color={colors.background} icon={Save} size={17} />
          <Text style={styles.saveText}>{t('skills.editor.save')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  maxLength,
  multiline = false,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
  testID: string;
}) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="none"
        maxLength={maxLength}
        multiline={multiline}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        style={[styles.input, multiline && styles.multiline]}
        testID={testID}
        value={value}
      />
    </View>
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
      marginTop: 8,
    },
    field: { marginTop: 12 },
    fieldLabel: {
      color: colors.faint,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.4,
      marginBottom: 6,
    },
    input: {
      minHeight: 44,
      borderRadius: 14,
      backgroundColor: colors.background,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontSize: 14,
      paddingHorizontal: 13,
      paddingVertical: 10,
    },
    multiline: { minHeight: 96, textAlignVertical: 'top' },
    reason: { color: colors.warning, fontSize: 11, marginTop: 10 },
    save: {
      height: 48,
      borderRadius: 15,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 14,
    },
    saveText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    disabled: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
  });
