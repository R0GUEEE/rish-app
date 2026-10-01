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
import FileText from 'lucide-react-native/icons/file-text';
import Pencil from 'lucide-react-native/icons/pencil';
import Plus from 'lucide-react-native/icons/plus';
import ShoppingBag from 'lucide-react-native/icons/shopping-bag';
import Trash2 from 'lucide-react-native/icons/trash-2';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';
import type { Skill } from '../skills';
import { AppIcon } from './AppIcon';

type Props = {
  visible: boolean;
  skills: readonly Skill[];
  onClose: () => void;
  /**
   * Puts the skill in the message box.
   *
   * A skill is text the person sends, so this fills the composer rather than
   * sending anything: what the Agent is told stays what the transcript shows.
   */
  onUse: (skill: Skill) => void;
  onRemove: (id: string) => void;
  onOpenMarketplace: () => void;
  /** Writes a new skill by hand. */
  onAddSkill: () => void;
  onEditSkill: (skill: Skill) => void;
};

export function SkillManagerSheet(props: Props) {
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
        <Text style={styles.eyebrow}>{t('skills.eyebrow')}</Text>
        <Text style={styles.title}>{t('skills.title')}</Text>
        <Text style={styles.subtitle}>{t('skills.subtitle')}</Text>
        <Pressable
          accessibilityLabel={t('skills.editor.add')}
          accessibilityRole="button"
          onPress={props.onAddSkill}
          style={({ pressed }) => [styles.secondary, pressed && styles.pressed]}
          testID="skills-add-by-hand"
        >
          <AppIcon color={colors.text} icon={Plus} size={16} />
          <Text style={styles.secondaryText}>{t('skills.editor.add')}</Text>
        </Pressable>
        <Pressable
          accessibilityLabel={t('skills.openMarketplace')}
          accessibilityRole="button"
          onPress={props.onOpenMarketplace}
          style={({ pressed }) => [
            styles.marketplace,
            pressed && styles.pressed,
          ]}
          testID="skills-open-marketplace"
        >
          <AppIcon color={colors.text} icon={ShoppingBag} size={16} />
          <Text style={styles.marketplaceText}>
            {t('skills.openMarketplace')}
          </Text>
        </Pressable>
        {props.skills.length === 0 ? (
          <Text style={styles.empty} testID="skills-empty">
            {t('skills.empty')}
          </Text>
        ) : (
          <ScrollView contentContainerStyle={styles.list} style={styles.scroll}>
            {props.skills.map(skill => (
              <View
                key={skill.id}
                style={styles.row}
                testID={`skill-row-${skill.id}`}
              >
                <View style={styles.rowHeader}>
                  <AppIcon color={colors.accent} icon={FileText} size={16} />
                  <View style={styles.rowCopy}>
                    <Text numberOfLines={1} style={styles.rowName}>
                      {skill.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.rowVersion}>
                      {skill.id} · {skill.version}
                    </Text>
                  </View>
                </View>
                <Text style={styles.rowDescription}>{skill.description}</Text>
                <Pressable
                  accessibilityLabel={t('skills.use', { name: skill.name })}
                  accessibilityRole="button"
                  onPress={() => props.onUse(skill)}
                  style={({ pressed }) => [
                    styles.use,
                    pressed && styles.pressed,
                  ]}
                  testID={`skill-use-${skill.id}`}
                >
                  <Text style={styles.useText}>{t('skills.useLabel')}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={t('skills.editor.edit')}
                  accessibilityRole="button"
                  onPress={() => props.onEditSkill(skill)}
                  style={({ pressed }) => [
                    styles.edit,
                    pressed && styles.pressed,
                  ]}
                  testID={`skill-edit-${skill.id}`}
                >
                  <AppIcon color={colors.textDim} icon={Pencil} size={14} />
                  <Text style={styles.editText}>{t('skills.editor.edit')}</Text>
                </Pressable>
                <Pressable
                  accessibilityLabel={t('skills.remove', { name: skill.name })}
                  accessibilityRole="button"
                  hitSlop={hitSlop}
                  onPress={() => props.onRemove(skill.id)}
                  style={({ pressed }) => [
                    styles.remove,
                    pressed && styles.pressed,
                  ]}
                  testID={`skill-remove-${skill.id}`}
                >
                  <AppIcon color={colors.danger} icon={Trash2} size={15} />
                  <Text style={styles.removeText}>
                    {t('skills.removeLabel')}
                  </Text>
                </Pressable>
              </View>
            ))}
          </ScrollView>
        )}
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
    subtitle: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 10,
    },
    marketplace: {
      height: 44,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      borderWidth: 1,
      borderColor: colors.line,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 14,
    },
    marketplaceText: { color: colors.text, fontSize: 13, fontWeight: '700' },
    secondary: {
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
    secondaryText: { color: colors.text, fontSize: 13, fontWeight: '700' },
    edit: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minHeight: 38,
      borderRadius: 12,
      marginTop: 10,
      backgroundColor: colors.surface,
      borderWidth: 1,
      borderColor: colors.line,
    },
    editText: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    empty: {
      color: colors.textDim,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 18,
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
    rowHeader: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    rowCopy: { flex: 1, minWidth: 0 },
    rowName: { color: colors.text, fontSize: 14, fontWeight: '700' },
    rowVersion: {
      color: colors.faint,
      fontFamily: fonts.mono,
      fontSize: 9,
      marginTop: 3,
    },
    rowDescription: {
      color: colors.textDim,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 9,
    },
    use: {
      minHeight: 42,
      borderRadius: 13,
      backgroundColor: colors.text,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 11,
    },
    useText: { color: colors.background, fontSize: 12, fontWeight: '700' },
    remove: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      minHeight: 40,
      borderRadius: 13,
      marginTop: 8,
      backgroundColor: colors.surfaceWarm,
    },
    removeText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
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
