import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
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
import {
  LocalWorkspaces,
  type WorkspaceDescriptor,
} from '../native/LocalWorkspaces';
import { createCompletionRequestId } from '../native/LocalRuntime';
import { fonts, type ThemePalette } from '../theme';
import {
  WorkspacePickerController,
  type WorkspaceForgetAuthorization,
  type WorkspacePickerSelection,
} from '../workspaces/WorkspacePickerController';
import { AppIcon } from './AppIcon';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

const OPEN_DURATION_MS = 190;
const CLOSE_DURATION_MS = 150;
// Deterministic snapshots in Jest: skip the entrance/exit animation.
const disableAnimations = process.env.NODE_ENV === 'test';

export type WorkspacePickerSheetProps = {
  visible: boolean;
  activeWorkspaceId: string | null;
  onClose: () => void;
  onSelect: (workspaceId: string) => void;
  /**
   * Native-issued clearance from the session coordinator. The picker never
   * creates either ID and refuses to call native forget without both.
   */
  forgetAuthorization?:
    | WorkspaceForgetAuthorization
    | ((
        workspace: WorkspaceDescriptor,
      ) => WorkspaceForgetAuthorization | null | undefined);
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
  forgetAuthorization,
}: WorkspacePickerSheetProps) {
  const { colors, t } = useAppPresentation();
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const progress = useRef(new Animated.Value(0)).current;
  const [presented, setPresented] = useState(visible);
  const presentedRef = useRef(visible);
  const [rows, setRows] = useState<readonly WorkspaceDescriptor[] | null>(null);
  const [notice, setNotice] = useState<{
    readonly kind: 'load' | 'action';
    readonly error: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [pendingSelection, setPendingSelection] =
    useState<WorkspacePickerSelection | null>(null);
  const mountedRef = useRef(true);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const ownerWorkspaceRef = useRef(activeWorkspaceId);
  const ownerGenerationRef = useRef(0);
  if (ownerWorkspaceRef.current !== activeWorkspaceId) {
    ownerWorkspaceRef.current = activeWorkspaceId;
    ownerGenerationRef.current += 1;
  }
  const surfaceGenerationRef = useRef(0);
  const busyRef = useRef(false);
  const selectionOwnerGenerationRef = useRef(ownerGenerationRef.current);
  const controllerRef = useRef<WorkspacePickerController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new WorkspacePickerController({
      native: LocalWorkspaces,
      createOperationId: createCompletionRequestId,
      onSelectionChanged: selection => {
        if (!mountedRef.current) return;
        if (
          selection !== null &&
          selectionOwnerGenerationRef.current !== ownerGenerationRef.current
        ) {
          return;
        }
        setPendingSelection(selection);
      },
    });
  }
  const controller = controllerRef.current;

  const reload = useCallback(
    async (
      expectedGeneration = surfaceGenerationRef.current,
      expectedOwnerGeneration = ownerGenerationRef.current,
    ) => {
      try {
        const listing = await LocalWorkspaces.list();
        if (
          !mountedRef.current ||
          !visibleRef.current ||
          surfaceGenerationRef.current !== expectedGeneration ||
          ownerGenerationRef.current !== expectedOwnerGeneration
        ) {
          return;
        }
        setRows(listing.workspaces);
        setNotice(null);
      } catch (error) {
        if (
          !mountedRef.current ||
          !visibleRef.current ||
          surfaceGenerationRef.current !== expectedGeneration ||
          ownerGenerationRef.current !== expectedOwnerGeneration
        ) {
          return;
        }
        setRows([]);
        setNotice({
          kind: 'load',
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controller.dispose();
    };
  }, [controller]);

  useEffect(() => {
    surfaceGenerationRef.current += 1;
    controller.invalidate();
    setPendingSelection(null);
    if (visible) {
      setRows(null);
      setDraftName('');
      setNotice(null);
      const expectedGeneration = surfaceGenerationRef.current;
      reload(expectedGeneration).catch(() => undefined);
    }
  }, [activeWorkspaceId, controller, reload, visible]);

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
    async (action: () => Promise<boolean>) => {
      if (busyRef.current) return;
      const expectedGeneration = surfaceGenerationRef.current;
      const expectedOwnerGeneration = ownerGenerationRef.current;
      busyRef.current = true;
      setBusy(true);
      try {
        const shouldReload = await action();
        if (
          !mountedRef.current ||
          !visibleRef.current ||
          surfaceGenerationRef.current !== expectedGeneration ||
          ownerGenerationRef.current !== expectedOwnerGeneration
        ) {
          return;
        }
        setNotice(null);
        if (shouldReload) await reload(expectedGeneration);
      } catch (error) {
        if (
          mountedRef.current &&
          visibleRef.current &&
          surfaceGenerationRef.current === expectedGeneration &&
          ownerGenerationRef.current === expectedOwnerGeneration
        ) {
          setNotice({
            kind: 'action',
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [reload],
  );

  const createWorkspace = useCallback((): Promise<void> => {
    const name = draftName.trim();
    if (name.length === 0) return Promise.resolve();
    const expectedGeneration = surfaceGenerationRef.current;
    const expectedOwnerGeneration = ownerGenerationRef.current;
    return runAction(async () => {
      await LocalWorkspaces.create({
        schema_version: 1,
        display_name: name,
        operation_id: createCompletionRequestId(),
      });
      if (
        mountedRef.current &&
        visibleRef.current &&
        surfaceGenerationRef.current === expectedGeneration &&
        ownerGenerationRef.current === expectedOwnerGeneration
      ) {
        setDraftName('');
      }
      return true;
    });
  }, [draftName, runAction]);

  const closeSurface = useCallback(() => {
    surfaceGenerationRef.current += 1;
    controller.invalidate();
    if (mountedRef.current) setPendingSelection(null);
    onClose();
  }, [controller, onClose]);

  const isCurrentAction = useCallback(
    (expectedGeneration: number, expectedOwnerGeneration: number) =>
      mountedRef.current &&
      visibleRef.current &&
      surfaceGenerationRef.current === expectedGeneration &&
      ownerGenerationRef.current === expectedOwnerGeneration,
    [],
  );

  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      if (!mountedRef.current || !visibleRef.current) return;
      // A direct row selection is an owner transition too. Invalidate native
      // picker/import/regrant callbacks before handing control to Home.
      surfaceGenerationRef.current += 1;
      controller.invalidate();
      onSelect(workspaceId);
    },
    [controller, onSelect],
  );

  const presentFolderPicker = useCallback(
    (mode: 'grant_or_import' | 'import_only') => {
      const expectedGeneration = surfaceGenerationRef.current;
      const expectedOwnerGeneration = ownerGenerationRef.current;
      selectionOwnerGenerationRef.current = expectedOwnerGeneration;
      return runAction(async () => {
        const result = await controller.presentFolderPicker(mode);
        if (
          result.status === 'selected' &&
          isCurrentAction(expectedGeneration, expectedOwnerGeneration)
        ) {
          selectWorkspace(result.workspace.workspace_id);
          return true;
        }
        return false;
      });
    },
    [controller, isCurrentAction, runAction, selectWorkspace],
  );

  const confirmSelection = useCallback(() => {
    const expectedGeneration = surfaceGenerationRef.current;
    const expectedOwnerGeneration = ownerGenerationRef.current;
    return runAction(async () => {
      const result = await controller.confirmSelection();
      if (
        (result.status === 'imported' ||
          result.status === 'regranted' ||
          result.status === 'different_root') &&
        isCurrentAction(expectedGeneration, expectedOwnerGeneration)
      ) {
        selectWorkspace(result.workspace.workspace_id);
        return true;
      }
      return false;
    });
  }, [controller, isCurrentAction, runAction, selectWorkspace]);

  const cancelSelection = useCallback(
    () =>
      runAction(async () => {
        await controller.cancelSelection();
        return false;
      }),
    [controller, runAction],
  );

  const presentRegrantPicker = useCallback(
    (workspace: WorkspaceDescriptor) => {
      const expectedOwnerGeneration = ownerGenerationRef.current;
      selectionOwnerGenerationRef.current = expectedOwnerGeneration;
      return runAction(async () => {
        await controller.presentRegrantPicker(workspace);
        return false;
      });
    },
    [controller, runAction],
  );

  const resolveForgetAuthorization = useCallback(
    (workspace: WorkspaceDescriptor): WorkspaceForgetAuthorization | null => {
      const authorization =
        typeof forgetAuthorization === 'function'
          ? forgetAuthorization(workspace)
          : forgetAuthorization;
      return authorization ?? null;
    },
    [forgetAuthorization],
  );

  const forgetWorkspace = useCallback(
    (workspace: WorkspaceDescriptor) =>
      runAction(async () => {
        const result = await controller.forgetWorkspace(
          workspace,
          resolveForgetAuthorization(workspace),
        );
        if (result.status === 'not_authorized') {
          throw new Error('Workspace clearance is unavailable.');
        }
        return result.status === 'forgotten';
      }),
    [controller, resolveForgetAuthorization, runAction],
  );

  return (
    <Modal
      animationType="none"
      hardwareAccelerated
      onRequestClose={closeSurface}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      transparent
      visible={presented}
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <AnimatedPressable
          accessibilityLabel={t('workspaces.close')}
          accessibilityRole="button"
          onPress={closeSurface}
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
            style={[
              styles.sheet,
              { maxHeight: Math.round(windowHeight * 0.78) },
            ]}
            testID="workspace-picker-sheet"
          >
            <Text style={styles.title}>{t('workspaces.title')}</Text>
            {pendingSelection !== null && (
              <View
                accessibilityLabel={pendingSelection.display_name}
                style={styles.selectionPrompt}
                testID="workspace-picker-selection-prompt"
              >
                <Text style={styles.selectionPromptText}>
                  {pendingSelection.kind === 'import'
                    ? t('workspaces.importFolder')
                    : t('workspaces.openFolder')}{' '}
                  {pendingSelection.display_name}
                </Text>
                <View style={styles.selectionPromptActions}>
                  <Pressable
                    accessibilityLabel={`Confirm ${pendingSelection.display_name}`}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => {
                      confirmSelection().catch(() => undefined);
                    }}
                    style={({ pressed }) => [
                      styles.actionChip,
                      pressed && styles.pressed,
                    ]}
                    testID="workspace-picker-confirm-selection"
                  >
                    <Text style={styles.actionText}>
                      {pendingSelection.kind === 'import'
                        ? t('workspaces.importFolder')
                        : t('workspaces.openFolder')}
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityLabel={`Cancel ${pendingSelection.display_name}`}
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={() => {
                      cancelSelection().catch(() => undefined);
                    }}
                    style={({ pressed }) => [
                      styles.footerAction,
                      pressed && styles.pressed,
                    ]}
                    testID="workspace-picker-cancel-selection"
                  >
                    <Text style={styles.footerActionText}>
                      {t('workspaces.close')}
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
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
              testID="workspace-picker-list"
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
                      <View style={styles.row}>
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
                          onPress={() => selectWorkspace(row.workspace_id)}
                          style={({ pressed }) => [
                            styles.rowSelect,
                            row.status !== 'ok' && styles.disabledRow,
                            pressed && styles.pressed,
                          ]}
                          testID={`workspace-picker-row-${row.workspace_id}`}
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
                                ? `${t(
                                    `workspaces.status.${row.status}`,
                                  )} · ${t('workspaces.onDevice')}`
                                : t(`workspaces.status.${row.status}`)}
                            </Text>
                          </View>
                        </Pressable>
                        <View style={styles.rowActions}>
                          {row.origin === 'granted_folder' &&
                            row.status !== 'ok' && (
                              <Pressable
                                accessibilityLabel={`Regrant ${row.display_name}`}
                                accessibilityRole="button"
                                disabled={busy}
                                onPress={() => {
                                  presentRegrantPicker(row).catch(
                                    () => undefined,
                                  );
                                }}
                                style={({ pressed }) => [
                                  styles.forgetButton,
                                  pressed && styles.pressed,
                                ]}
                                testID={`workspace-picker-regrant-${row.workspace_id}`}
                              >
                                <Text style={styles.forgetText}>Regrant</Text>
                              </Pressable>
                            )}
                          <Pressable
                            accessibilityLabel={t('workspaces.forget', {
                              name: row.display_name,
                            })}
                            accessibilityRole="button"
                            disabled={busy}
                            onPress={() => {
                              forgetWorkspace(row).catch(() => undefined);
                            }}
                            style={({ pressed }) => [
                              styles.forgetButton,
                              pressed && styles.pressed,
                            ]}
                          >
                            <Text style={styles.forgetText}>
                              {t('common.forget')}
                            </Text>
                          </Pressable>
                        </View>
                      </View>
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
                testID="workspace-picker-name-input"
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
                testID="workspace-picker-new"
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
                disabled={busy || pendingSelection !== null}
                onPress={() => {
                  presentFolderPicker('grant_or_import').catch(() => undefined);
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
                disabled={busy || pendingSelection !== null}
                onPress={() => {
                  presentFolderPicker('import_only').catch(() => undefined);
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
    rowSelect: {
      flex: 1,
      minHeight: 42,
      flexDirection: 'row',
      alignItems: 'center',
    },
    rowActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginLeft: 8,
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
    selectionPrompt: {
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 8,
    },
    selectionPromptText: {
      color: colors.text,
      fontSize: 12,
      fontWeight: '700',
      marginBottom: 8,
    },
    selectionPromptActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
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
