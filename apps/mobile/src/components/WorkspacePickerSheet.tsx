import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import Check from 'lucide-react-native/icons/check';
import FolderInput from 'lucide-react-native/icons/folder-input';
import FolderOpen from 'lucide-react-native/icons/folder-open';
import Plus from 'lucide-react-native/icons/plus';

import { useAppPresentation } from '../presentation/AppPresentation';
import { LocalWorkspaces, type WorkspaceDescriptor } from '../native/LocalWorkspaces';
import { createCompletionRequestId } from '../native/LocalRuntime';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const OPEN_DURATION_MS = 190;
const CLOSE_DURATION_MS = 150;
// Deterministic snapshots in Jest: skip the entrance/exit animation.
const disableAnimations = process.env.NODE_ENV === 'test';

type Props = {
  visible: boolean;
  activeWorkspaceId: string | null;
  onClose: () => void;
  onSelect: (workspaceId: string) => void;
};

/**
 * Restrained bottom sheet that binds a conversation to a workspace. Only
 * opaque ids cross into JavaScript, so every row shows display metadata plus
 * the structured access state reported by native.
 */
export function WorkspacePickerSheet({
  visible,
  activeWorkspaceId,
  onClose,
  onSelect,
}: Props) {
  const { colors, t } = useAppPresentation();
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const progress = useRef(new Animated.Value(0)).current;
  const [presented, setPresented] = useState(visible);
  const presentedRef = useRef(visible);
  const [rows, setRows] = useState<readonly WorkspaceDescriptor[] | null>(
    null,
  );
  const [notice, setNotice] = useState<
    | { readonly kind: 'load' | 'action'; readonly error: string }
    | null
  >(null);
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState('');

  const reload = useCallback(async () => {
    try {
      const listing = await LocalWorkspaces.list();
      setRows(listing.workspaces);
      setNotice(null);
    } catch (error) {
      setRows([]);
      setNotice({
        kind: 'load',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    if (visible) {
      setRows(null);
      setDraftName('');
      setNotice(null);
      reload().catch(() => undefined);
    }
  }, [visible, reload]);

  useEffect(() => {
    if (visible) {
      if (presentedRef.current) return undefined;
      presentedRef.current = true;
      setPresented(true);
      if (disableAnimations) {
        progress.setValue(1);
        return undefined;
      }
      progress.setValue(0);
      const frame = requestAnimationFrame(() => {
        Animated.timing(progress, {
          duration: OPEN_DURATION_MS,
          easing: Easing.out(Easing.cubic),
          toValue: 1,
          useNativeDriver: true,
        }).start();
      });
      return () => cancelAnimationFrame(frame);
    }
    if (!presentedRef.current) return undefined;
    presentedRef.current = false;
    if (disableAnimations) {
      progress.setValue(0);
      setPresented(false);
      return undefined;
    }
    Animated.timing(progress, {
      duration: CLOSE_DURATION_MS,
      easing: Easing.in(Easing.cubic),
      toValue: 0,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished) setPresented(false);
    });
    return undefined;
  }, [visible, progress]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await action();
        setNotice(null);
        await reload();
      } catch (error) {
        setNotice({
          kind: 'action',
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setBusy(false);
      }
    },
    [busy, reload],
  );

  const createWorkspace = useCallback((): Promise<void> => {
    const name = draftName.trim();
    if (name.length === 0) return Promise.resolve();
    return runAction(async () => {
      await LocalWorkspaces.create({
        schema_version: 1,
        display_name: name,
        operation_id: createCompletionRequestId(),
      });
      setDraftName('');
    });
  }, [draftName, runAction]);

  return (
    <Modal
      animationType="none"
      hardwareAccelerated
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={presented}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <AnimatedPressable
          accessibilityLabel={t('workspaces.close')}
          accessibilityRole="button"
          onPress={onClose}
          style={[styles.backdrop, { opacity: progress }]}
          testID="workspace-picker-backdrop"
        />
        <Animated.View
          style={[
            styles.cardAnchor,
            {
              transform: [
                {
                  translateY: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [windowHeight, 0],
                  }),
                },
              ],
            },
          ]}
        >
      <View
        accessibilityLabel={t('workspaces.title')}
        accessibilityRole="dialog"
        style={[styles.sheet, { maxHeight: Math.round(windowHeight * 0.78) }]}
        testID="workspace-picker-sheet"
      >
        <Text style={styles.title}>{t('workspaces.title')}</Text>
          {notice !== null && (
            <Text accessibilityRole="alert" style={styles.notice}>
              {notice.kind === 'load'
                ? t('workspaces.loadFailed', { error: notice.error })
                : t('workspaces.actionFailed', { error: notice.error })}
            </Text>
          )}
          <ScrollView
            accessibilityLabel={t('workspaces.list')}
            style={styles.listScroll}
            contentContainerStyle={styles.listContent}
          >
            {rows === null ? (
              <View style={styles.loading}>
                <ActivityIndicator color={colors.accent} size="small" />
              </View>
            ) : rows.length === 0 ? (
              <Text style={styles.empty}>{t('workspaces.empty')}</Text>
            ) : (
              rows.map(row => {
                const isActive = row.workspace_id === activeWorkspaceId;
                return (
                  <View key={row.workspace_id} style={styles.rowShell}>
                    <Pressable
                      accessibilityLabel={t('workspaces.select', {
                        name: row.display_name,
                      })}
                      accessibilityRole="radio"
                      accessibilityState={{
                        checked: isActive,
                        disabled: row.status !== 'ok',
                      }}
                      disabled={busy || row.status !== 'ok'}
                      onPress={() => onSelect(row.workspace_id)}
                      style={({ pressed }) => [
                        styles.row,
                        row.status !== 'ok' && styles.disabledRow,
                        pressed && styles.pressed,
                      ]}
                    >
                      <View style={styles.check}>
                        {isActive && (
                          <AppIcon
                            color={colors.accent}
                            icon={Check}
                            size={18}
                          />
                        )}
                      </View>
                      <View style={styles.rowCopy}>
                        <Text numberOfLines={1} style={styles.rowTitle}>
                          {row.display_name}
                        </Text>
                        <Text style={styles.rowStatus}>
                          {row.origin === 'granted_folder'
                            ? `${t(`workspaces.status.${row.status}`)} · ${t(
                                'workspaces.onDevice',
                              )}`
                            : t(`workspaces.status.${row.status}`)}
                        </Text>
                      </View>
                      <Pressable
                        accessibilityLabel={t('workspaces.forget', {
                          name: row.display_name,
                        })}
                        accessibilityRole="button"
                          onPress={() =>
                            runAction(() =>
                            LocalWorkspaces.forget({
                              schema_version: 1,
                              workspace_id: row.workspace_id,
                              expected_binding_revision: row.binding_revision,
                            }),
                          )
                        }
                        style={({ pressed }) => [
                          styles.forgetButton,
                          pressed && styles.pressed,
                        ]}
                      >
                        <Text style={styles.forgetText}>
                          {t('common.forget')}
                        </Text>
                      </Pressable>
                    </Pressable>
                  </View>
                );
              })
            )}
          </ScrollView>
          <View style={styles.newRow}>
            <TextInput
              accessibilityLabel={t('workspaces.namePlaceholder')}
              onChangeText={setDraftName}
              onSubmitEditing={() => {
                createWorkspace().catch(() => undefined);
              }}
              placeholder={t('workspaces.namePlaceholder')}
              placeholderTextColor={colors.faint}
              style={styles.input}
              value={draftName}
            />
            <Pressable
              accessibilityLabel={t('workspaces.new')}
              accessibilityRole="button"
              disabled={draftName.trim().length === 0 || busy}
              onPress={() => {
                createWorkspace().catch(() => undefined);
              }}
              style={({ pressed }) => [
                styles.actionChip,
                draftName.trim().length === 0 && styles.actionDisabled,
                pressed && styles.pressed,
              ]}
            >
              {busy ? (
                <ActivityIndicator color={colors.text} size="small" />
              ) : (
                <>
                  <AppIcon color={colors.text} icon={Plus} size={16} />
                  <Text style={styles.actionText}>{t('workspaces.new')}</Text>
                </>
              )}
            </Pressable>
          </View>
          <View style={styles.footerRow}>
            <Pressable
              accessibilityLabel={t('workspaces.openFolder')}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                runAction(() =>
                  LocalWorkspaces.grantFolder({
                    schema_version: 1,
                    operation_id: createCompletionRequestId(),
                  }),
                ).catch(
                  () => undefined,
                );
              }}
              style={({ pressed }) => [
                styles.footerAction,
                pressed && styles.pressed,
              ]}
            >
              <AppIcon color={colors.accent} icon={FolderOpen} size={17} />
              <Text style={styles.footerActionText}>
                {t('workspaces.openFolder')}
              </Text>
            </Pressable>
            <Pressable
              accessibilityLabel={t('workspaces.importFolder')}
              accessibilityRole="button"
              disabled={busy}
              onPress={() => {
                runAction(() =>
                  LocalWorkspaces.importFolder({
                    schema_version: 1,
                    operation_id: createCompletionRequestId(),
                  }),
                ).catch(
                  () => undefined,
                );
              }}
              style={({ pressed }) => [
                styles.footerAction,
                pressed && styles.pressed,
              ]}
            >
              <AppIcon color={colors.accent} icon={FolderInput} size={17} />
              <Text style={styles.footerActionText}>
                {t('workspaces.importFolder')}
              </Text>
            </Pressable>
          </View>
        </View>
        </Animated.View>
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
      backgroundColor: colors.scrim,
    },
    cardAnchor: {
      position: 'absolute',
      right: 0,
      bottom: 0,
      left: 0,
    },
    sheet: {
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 16,
    },
    title: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '800',
      marginBottom: 6,
    },
    notice: {
      color: colors.danger,
      fontSize: 12,
      lineHeight: 16,
      marginBottom: 6,
    },
    listScroll: { flexGrow: 0 },
    listContent: { paddingVertical: 4 },
    loading: {
      minHeight: 72,
      alignItems: 'center',
      justifyContent: 'center',
    },
    empty: {
      color: colors.muted,
      fontSize: 13,
      textAlign: 'center',
      paddingVertical: 24,
    },
    rowShell: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.line,
    },
    row: {
      minHeight: 58,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 8,
      paddingRight: 2,
    },
    disabledRow: { opacity: 0.56 },
    rowCopy: { flex: 1 },
    rowTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
    rowStatus: {
      color: colors.muted,
      fontSize: 11,
      fontFamily: fonts.mono,
      marginTop: 2,
    },
    check: {
      width: 24,
      alignItems: 'flex-start',
      marginRight: 8,
    },
    forgetButton: {
      borderRadius: 13,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 10,
      paddingVertical: 6,
      marginLeft: 8,
    },
    forgetText: { color: colors.textDim, fontSize: 11, fontWeight: '700' },
    newRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      marginTop: 8,
    },
    input: {
      flex: 1,
      minHeight: 38,
      borderRadius: 19,
      backgroundColor: colors.surfaceRaised,
      color: colors.text,
      fontSize: 14,
      paddingHorizontal: 13,
    },
    actionChip: {
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.surfaceRaised,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingHorizontal: 12,
    },
    actionDisabled: { opacity: 0.5 },
    actionText: { color: colors.textDim, fontSize: 12, fontWeight: '700' },
    footerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 16,
      marginTop: 10,
    },
    footerAction: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      minHeight: 36,
    },
    footerActionText: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
    pressed: { opacity: 0.58 },
  });
