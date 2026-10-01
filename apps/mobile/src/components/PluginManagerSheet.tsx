import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Puzzle from 'lucide-react-native/icons/puzzle';
import Trash2 from 'lucide-react-native/icons/trash-2';

import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';
import {
  pluginToolName,
  type Plugin,
  type PluginCapability,
  type PluginToolPosture,
} from '../plugins/plugins';
import { AppIcon } from './AppIcon';

type Props = {
  visible: boolean;
  plugins: readonly Plugin[];
  /**
   * Whether the Agent's native tool table can carry plugin tools yet.
   *
   * The sheet says which state it is in rather than presenting a switch whose
   * effect nobody can observe.
   */
  posture: PluginToolPosture;
  onClose: () => void;
  onToggle: (id: string, enabled: boolean) => void;
  onRemove: (id: string) => void;
};

// `as const`, not `Record<..., string>`: the translator is typed by its key
// union, so a widened string would not be accepted as one of them.
const CAPABILITY_LABELS = {
  file_read: 'plugins.capability.fileRead',
  file_write: 'plugins.capability.fileWrite',
  git_status: 'plugins.capability.gitStatus',
  git_commit: 'plugins.capability.gitCommit',
  git_push: 'plugins.capability.gitPush',
  guest_service: 'plugins.capability.guestService',
} as const satisfies Record<PluginCapability, string>;

export function PluginManagerSheet(props: Props) {
  const insets = useSafeAreaInsets();
  const { colors, t } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const postureText =
    props.posture === 'admitted'
      ? t('plugins.posture.admitted')
      : props.posture === 'awaiting_native'
        ? t('plugins.posture.awaiting')
        : t('plugins.posture.unknown');

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
        <Text style={styles.title}>{t('plugins.title')}</Text>
        <Text
          accessibilityLiveRegion="polite"
          style={styles.posture}
          testID="plugin-posture"
        >
          {postureText}
        </Text>
        {props.plugins.length === 0 ? (
          <Text style={styles.empty}>{t('plugins.empty')}</Text>
        ) : (
          <ScrollView
            contentContainerStyle={styles.list}
            style={styles.scroll}
          >
            {props.plugins.map(plugin => (
              <View
                key={plugin.id}
                style={styles.row}
                testID={`plugin-row-${plugin.id}`}
              >
                <View style={styles.rowHeader}>
                  <AppIcon color={colors.accent} icon={Puzzle} size={17} />
                  <View style={styles.rowCopy}>
                    <Text numberOfLines={1} style={styles.rowName}>
                      {plugin.name}
                    </Text>
                    <Text numberOfLines={1} style={styles.rowVersion}>
                      {plugin.id} · {plugin.version}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={t('plugins.toggleAccessibility', {
                      name: plugin.name,
                    })}
                    accessibilityState={{ checked: plugin.enabled }}
                    onValueChange={value => props.onToggle(plugin.id, value)}
                    testID={`plugin-toggle-${plugin.id}`}
                    value={plugin.enabled}
                  />
                </View>
                <Text style={styles.rowDescription}>{plugin.description}</Text>
                {plugin.tools.length === 0 ? (
                  <Text style={styles.noTools}>{t('plugins.noTools')}</Text>
                ) : (
                  plugin.tools.map(tool => (
                    <View key={tool.name} style={styles.toolRow}>
                      <Text numberOfLines={1} style={styles.toolName}>
                        {pluginToolName(plugin.id, tool.name)}
                      </Text>
                      <Text style={styles.toolCapability}>
                        {t(CAPABILITY_LABELS[tool.capability])}
                      </Text>
                      {tool.requiresApproval && (
                        <Text style={styles.toolApproval}>
                          {t('plugins.needsApproval')}
                        </Text>
                      )}
                    </View>
                  ))
                )}
                <Pressable
                  accessibilityLabel={t('plugins.remove', {
                    name: plugin.name,
                  })}
                  accessibilityRole="button"
                  hitSlop={hitSlop}
                  onPress={() => props.onRemove(plugin.id)}
                  style={({ pressed }) => [
                    styles.remove,
                    pressed && styles.pressed,
                  ]}
                  testID={`plugin-remove-${plugin.id}`}
                >
                  <AppIcon color={colors.danger} icon={Trash2} size={15} />
                  <Text style={styles.removeText}>
                    {t('plugins.removeLabel')}
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
    posture: {
      color: colors.muted,
      fontSize: 12,
      lineHeight: 17,
      marginTop: 10,
    },
    empty: {
      color: colors.textDim,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 18,
    },
    scroll: { marginTop: 14 },
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
    noTools: { color: colors.faint, fontSize: 11, marginTop: 9 },
    toolRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 7,
    },
    toolName: {
      flexShrink: 1,
      color: colors.textDim,
      fontFamily: fonts.mono,
      fontSize: 10,
    },
    toolCapability: { color: colors.muted, fontSize: 10 },
    toolApproval: { color: colors.warning, fontSize: 10, fontWeight: '700' },
    remove: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      minHeight: 40,
      borderRadius: 13,
      marginTop: 11,
      backgroundColor: colors.surfaceWarm,
    },
    removeText: { color: colors.danger, fontSize: 12, fontWeight: '700' },
    done: {
      height: 48,
      borderRadius: 15,
      backgroundColor: colors.text,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: 14,
    },
    doneText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    pressed: { opacity: 0.6, transform: [{ scale: 0.987 }] },
  });
