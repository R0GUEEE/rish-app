import React, { useEffect, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Plus from 'lucide-react-native/icons/plus';
import Save from 'lucide-react-native/icons/save';
import Trash2 from 'lucide-react-native/icons/trash-2';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';
import {
  MAX_PLUGIN_DESCRIPTION_LENGTH,
  MAX_PLUGIN_ID_LENGTH,
  MAX_PLUGIN_NAME_LENGTH,
  MAX_PLUGIN_TOOLS,
  MAX_PLUGIN_TOOL_DESCRIPTION_LENGTH,
  MAX_PLUGIN_TOOL_NAME_LENGTH,
  MAX_PLUGIN_VERSION_LENGTH,
  PLUGIN_CAPABILITIES,
  createPlugin,
  type Plugin,
  type PluginCapability,
} from '../plugins/plugins';
import { AppIcon } from './AppIcon';
import { CAPABILITY_LABELS } from './pluginLabels';

type Props = {
  visible: boolean;
  /** The plugin being corrected, or null when this is a new one. */
  editing: Plugin | null;
  onClose: () => void;
  onSave: (plugin: Plugin) => void;
};

type ToolDraft = {
  readonly name: string;
  readonly description: string;
  readonly capability: PluginCapability;
  readonly requiresApproval: boolean;
};

const NEW_TOOL: ToolDraft = {
  name: '',
  description: '',
  capability: 'file_read',
  requiresApproval: true,
};

const EMPTY = {
  id: '',
  name: '',
  version: '1.0.0',
  description: '',
};

/**
 * Writes a plugin declaration by hand.
 *
 * The library's rules run as a person types, so a declaration that could not
 * be kept is never offered as saveable: bounded fields, a namespaced tool name
 * that fits the provider's budget, no shadowing of a tool the app already
 * offers, and only capabilities the Agent core actually checks.
 */
export function PluginEditorSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [fields, setFields] = useState(EMPTY);
  const [tools, setTools] = useState<readonly ToolDraft[]>([]);

  useEffect(() => {
    if (!props.visible) return;
    if (props.editing === null) {
      setFields(EMPTY);
      setTools([]);
      return;
    }
    setFields({
      id: props.editing.id,
      name: props.editing.name,
      version: props.editing.version,
      description: props.editing.description,
    });
    setTools(
      props.editing.tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        capability: tool.capability,
        requiresApproval: tool.requiresApproval,
      })),
    );
  }, [props.visible, props.editing]);

  const candidate = useMemo(
    () => createPlugin({ ...fields, enabled: props.editing?.enabled ?? true, tools }),
    [fields, props.editing, tools],
  );

  const updateTool = (index: number, patch: Partial<ToolDraft>) =>
    setTools(current =>
      current.map((tool, at) => (at === index ? { ...tool, ...patch } : tool)),
    );

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
        <Text style={styles.eyebrow}>{t('plugins.eyebrow')}</Text>
        <Text style={styles.title}>
          {props.editing === null
            ? t('plugins.editor.addTitle')
            : t('plugins.editor.editTitle')}
        </Text>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
          <Text style={styles.hint}>{t('plugins.editor.hint')}</Text>
          <Field
            label={t('plugins.editor.id')}
            maxLength={MAX_PLUGIN_ID_LENGTH}
            onChangeText={value =>
              setFields(current => ({ ...current, id: value }))
            }
            placeholder="web_reader"
            testID="plugin-editor-id"
            value={fields.id}
          />
          <Field
            label={t('plugins.editor.name')}
            maxLength={MAX_PLUGIN_NAME_LENGTH}
            onChangeText={value =>
              setFields(current => ({ ...current, name: value }))
            }
            placeholder="Web reader"
            testID="plugin-editor-name"
            value={fields.name}
          />
          <Field
            label={t('plugins.editor.version')}
            maxLength={MAX_PLUGIN_VERSION_LENGTH}
            onChangeText={value =>
              setFields(current => ({ ...current, version: value }))
            }
            placeholder="1.0.0"
            testID="plugin-editor-version"
            value={fields.version}
          />
          <Field
            label={t('plugins.editor.description')}
            maxLength={MAX_PLUGIN_DESCRIPTION_LENGTH}
            onChangeText={value =>
              setFields(current => ({ ...current, description: value }))
            }
            placeholder={t('plugins.editor.descriptionPlaceholder')}
            testID="plugin-editor-description"
            value={fields.description}
          />
          <Text style={styles.sectionLabel}>{t('plugins.editor.tools')}</Text>
          {tools.map((tool, index) => (
            <View key={index} style={styles.tool} testID={`plugin-editor-tool-${index}`}>
              <Field
                label={t('plugins.editor.toolName')}
                maxLength={MAX_PLUGIN_TOOL_NAME_LENGTH}
                onChangeText={value => updateTool(index, { name: value })}
                placeholder="fetch_page"
                testID={`plugin-editor-tool-name-${index}`}
                value={tool.name}
              />
              <Field
                label={t('plugins.editor.toolDescription')}
                maxLength={MAX_PLUGIN_TOOL_DESCRIPTION_LENGTH}
                onChangeText={value => updateTool(index, { description: value })}
                placeholder={t('plugins.editor.toolDescriptionPlaceholder')}
                testID={`plugin-editor-tool-description-${index}`}
                value={tool.description}
              />
              <Text style={styles.fieldLabel}>
                {t('plugins.editor.capability')}
              </Text>
              <View style={styles.chips}>
                {PLUGIN_CAPABILITIES.map(capability => {
                  const chosen = tool.capability === capability;
                  return (
                    <Pressable
                      key={capability}
                      accessibilityLabel={t(CAPABILITY_LABELS[capability])}
                      accessibilityRole="button"
                      accessibilityState={{ selected: chosen }}
                      onPress={() => updateTool(index, { capability })}
                      style={({ pressed }) => [
                        styles.chip,
                        chosen && styles.chipChosen,
                        pressed && styles.pressed,
                      ]}
                      testID={`plugin-editor-capability-${capability}-${index}`}
                    >
                      <Text
                        style={[styles.chipText, chosen && styles.chipTextChosen]}
                      >
                        {t(CAPABILITY_LABELS[capability])}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.approvalRow}>
                <Text style={styles.fieldLabel}>
                  {t('plugins.editor.requiresApproval')}
                </Text>
                <Switch
                  accessibilityLabel={t('plugins.editor.requiresApproval')}
                  onValueChange={value =>
                    updateTool(index, { requiresApproval: value })
                  }
                  testID={`plugin-editor-tool-approval-${index}`}
                  value={tool.requiresApproval}
                />
              </View>
              <Pressable
                accessibilityLabel={t('plugins.editor.removeTool')}
                accessibilityRole="button"
                hitSlop={hitSlop}
                onPress={() =>
                  setTools(current => current.filter((_, at) => at !== index))
                }
                style={({ pressed }) => [
                  styles.removeTool,
                  pressed && styles.pressed,
                ]}
                testID={`plugin-editor-remove-tool-${index}`}
              >
                <AppIcon color={colors.danger} icon={Trash2} size={14} />
                <Text style={styles.removeToolText}>
                  {t('plugins.editor.removeTool')}
                </Text>
              </Pressable>
            </View>
          ))}
          <Pressable
            accessibilityLabel={t('plugins.editor.addTool')}
            accessibilityRole="button"
            accessibilityState={{ disabled: tools.length >= MAX_PLUGIN_TOOLS }}
            disabled={tools.length >= MAX_PLUGIN_TOOLS}
            onPress={() => setTools(current => [...current, NEW_TOOL])}
            style={({ pressed }) => [
              styles.addTool,
              tools.length >= MAX_PLUGIN_TOOLS && styles.disabled,
              pressed && tools.length < MAX_PLUGIN_TOOLS && styles.pressed,
            ]}
            testID="plugin-editor-add-tool"
          >
            <AppIcon color={colors.text} icon={Plus} size={15} />
            <Text style={styles.addToolText}>{t('plugins.editor.addTool')}</Text>
          </Pressable>
          {candidate === null && (
            <Text style={styles.reason} testID="plugin-editor-reason">
              {t('plugins.editor.invalid')}
            </Text>
          )}
        </ScrollView>
        <Pressable
          accessibilityLabel={t('plugins.editor.save')}
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
          testID="plugin-editor-save"
        >
          <AppIcon color={colors.background} icon={Save} size={17} />
          <Text style={styles.saveText}>{t('plugins.editor.save')}</Text>
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
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  maxLength: number;
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
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.faint}
        style={styles.input}
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
      maxHeight: '88%',
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
    // A sheet sized by maxHeight needs its scroller bounded too, or the list
    // collapses to nothing and the sheet looks empty.
    scroll: { maxHeight: 420, marginTop: 10 },
    scrollContent: { gap: 2, paddingBottom: 6 },
    hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
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
    sectionLabel: {
      color: colors.accent,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.8,
      marginTop: 18,
    },
    tool: {
      borderRadius: 15,
      backgroundColor: colors.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 12,
      marginTop: 10,
    },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      borderRadius: 11,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.background,
      paddingHorizontal: 9,
      paddingVertical: 5,
    },
    chipChosen: { backgroundColor: colors.text, borderColor: colors.text },
    chipText: { color: colors.textDim, fontSize: 10 },
    chipTextChosen: { color: colors.background, fontWeight: '700' },
    approvalRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 12,
    },
    removeTool: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      minHeight: 38,
      borderRadius: 12,
      marginTop: 10,
      backgroundColor: colors.surfaceWarm,
    },
    removeToolText: { color: colors.danger, fontSize: 11, fontWeight: '700' },
    addTool: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      minHeight: 44,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.line,
      backgroundColor: colors.surfaceRaised,
      marginTop: 12,
    },
    addToolText: { color: colors.text, fontSize: 13, fontWeight: '700' },
    reason: { color: colors.warning, fontSize: 11, marginTop: 10 },
    save: {
      height: 48,
      borderRadius: 15,
      backgroundColor: colors.text,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 12,
    },
    saveText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    disabled: { opacity: 0.35 },
    pressed: { opacity: 0.7 },
  });
