import React, { useCallback, useEffect, useMemo } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import X from 'lucide-react-native/icons/x';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { AgentCapability, AgentConversationGrantV2 } from '../state';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';
import {
  AGENT_POLICY_TOOLS,
  type AgentPolicyAccess,
  type AgentPolicyViewStatus,
  type PolicyTool,
} from './agent-policy-projection';

export type { AgentPolicyAccess } from './agent-policy-projection';

export type AgentPolicyBudget = {
  readonly max_single_write_bytes: number;
  readonly max_batch_write_bytes: number;
  readonly max_attempt_write_bytes: number;
};

export const AGENT_POLICY_DEFAULT_BUDGET: AgentPolicyBudget = {
  max_single_write_bytes: 32768,
  max_batch_write_bytes: 524288,
  max_attempt_write_bytes: 4194304,
};

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function capabilityLabel(capability: AgentCapability): string {
  switch (capability) {
    case 'file_read':
      return 'agent.policy.capability.file_read';
    case 'file_write':
      return 'agent.policy.capability.file_write';
    case 'git_status':
      return 'agent.policy.capability.git_status';
    case 'git_commit':
      return 'agent.policy.capability.git_commit';
    case 'git_push':
      return 'agent.policy.capability.git_push';
    case 'guest_service':
      return 'agent.policy.capability.guest_service';
  }
}

function accessKey(access: AgentPolicyAccess): string {
  switch (access) {
    case 'unverified':
      return 'agent.policy.access.unverified';
    case 'checking':
      return 'agent.policy.access.checking';
    case 'conversation_allowed':
      return 'agent.policy.access.conversation_allowed';
    case 'not_enabled':
      return 'agent.policy.access.not_enabled';
    case 'unavailable':
      return 'agent.policy.access.unavailable';
    case 'auto':
      return 'agent.policy.access.auto';
    case 'conversation_confirm':
      return 'agent.policy.access.conversation_confirm';
    case 'confirm_once':
      return 'agent.policy.access.confirm_once';
    default:
      return 'agent.policy.access.durable_deny';
  }
}

function accessBodyKey(access: AgentPolicyAccess): string {
  switch (access) {
    case 'unverified':
      return 'agent.policy.unverifiedBody';
    case 'checking':
      return 'agent.policy.loading';
    case 'conversation_allowed':
      return 'agent.policy.access.conversation_allowedBody';
    case 'not_enabled':
      return 'agent.policy.gitNotEnabledBody';
    case 'unavailable':
      return 'agent.policy.access.durable_denyBody';
    case 'auto':
      return 'agent.policy.access.autoBody';
    case 'conversation_confirm':
      return 'agent.policy.access.conversation_confirmBody';
    case 'confirm_once':
      return 'agent.policy.access.confirm_onceBody';
    default:
      return 'agent.policy.access.durable_denyBody';
  }
}

function toolKey(name: PolicyTool): string {
  switch (name) {
    case 'list_dir':
      return 'agent.tool.list_dir';
    case 'read_file':
      return 'agent.tool.read_file';
    case 'write_file':
      return 'agent.tool.write_file';
    case 'git_status':
      return 'agent.tool.git_status';
    case 'git_commit':
      return 'agent.tool.git_commit';
    case 'git_push':
      return 'agent.tool.git_push';
    case 'start_guest_cgi':
      return 'agent.tool.start_guest_cgi';
    case 'stop_guest_cgi':
      return 'agent.tool.stop_guest_cgi';
    case 'list_runtime_environments':
      return 'agent.tool.list_runtime_environments';
    case 'install_runtime_environment':
      return 'agent.tool.install_runtime_environment';
    case 'run_program':
      return 'agent.tool.run_program';
    case 'start_runtime_service':
      return 'agent.tool.start_runtime_service';
    case 'stop_runtime_service':
      return 'agent.tool.stop_runtime_service';
  }
}

type Props = {
  visible: boolean;
  workspaceName: string | null;
  capabilities: readonly AgentCapability[];
  toolAccess: Readonly<Record<PolicyTool, AgentPolicyAccess>>;
  policyStatus: AgentPolicyViewStatus;
  onRetryPolicy: () => void;
  gitActivationAvailable?: boolean;
  gitActivationBusy?: boolean;
  gitActivationBlocked?: boolean;
  gitActivationError?: string | null;
  onEnableWorkspaceGit?: () => void;
  gitProjectRequired?: boolean;
  budget: AgentPolicyBudget | null;
  grants: readonly AgentConversationGrantV2[];
  revokeBusy: boolean;
  revokeFailed: string | null;
  onClose: () => void;
  onRevoke: (grantId: string) => void;
};

/**
 * Read-only effective-policy panel for the bound workspace: capabilities,
 * per-tool access modes, the attempt write budgets, and the active
 * conversation grants with a persisted-checkpoint revoke action. Nothing
 * here is authority — native revalidates every capability and grant before
 * any effect.
 */
export function AgentPolicySheet({
  visible,
  workspaceName,
  capabilities,
  toolAccess,
  policyStatus,
  onRetryPolicy,
  gitActivationAvailable = false,
  gitActivationBusy = false,
  gitActivationBlocked = false,
  gitActivationError = null,
  onEnableWorkspaceGit,
  gitProjectRequired = false,
  budget,
  grants,
  revokeBusy,
  revokeFailed,
  onClose,
  onRevoke,
}: Props) {
  const { colors, t } = useAppPresentation();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const topInset = Math.max(insets.top, 12);
  const bottomInset = Math.max(insets.bottom, 12);
  // Bound the whole card, including its fixed header, and allow it to shrink
  // further while a previous screen's keyboard is being dismissed.
  const cardMaxHeight = Math.min(680, Math.max(0, windowHeight - topInset - bottomInset) * 0.82);
  useEffect(() => {
    if (visible) Keyboard.dismiss();
  }, [visible]);
  const close = useCallback(() => {
    Keyboard.dismiss();
    onClose();
  }, [onClose]);
  if (!visible) return null;
  const access = toolAccess;
  const canEnableGit = gitActivationAvailable && !gitActivationBlocked && policyStatus === 'ready' && capabilities.includes('file_write');
  return (
    <Modal
      animationType="fade"
      onRequestClose={close}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="agent-policy-modal"
      transparent
      visible
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <Pressable
          accessibilityLabel={t('agent.policy.close')}
          accessibilityRole="button"
          onPress={close}
          style={styles.backdrop}
          testID="agent-policy-backdrop"
        />
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          pointerEvents="box-none"
          style={styles.keyboardAvoider}
        >
        <View
          pointerEvents="box-none"
          style={[
            styles.anchor,
            {
              paddingTop: topInset,
              paddingBottom: bottomInset,
              paddingLeft: Math.max(insets.left, 18),
              paddingRight: Math.max(insets.right, 18),
            },
          ]}
          testID="agent-policy-viewport"
        >
          <View
            accessibilityLabel={t('agent.policy.title')}
            role="dialog"
            style={[styles.card, { maxHeight: cardMaxHeight }]}
            testID="agent-policy-card"
          >
            <View style={styles.headerRow}>
              <View style={styles.headerCopy}>
                <Text style={styles.eyebrow}>{t('agent.policy.eyebrow')}</Text>
                <Text style={styles.title}>{t('agent.policy.title')}</Text>
              </View>
              <Pressable
                accessibilityLabel={t('agent.policy.close')}
                accessibilityRole="button"
                hitSlop={8}
                onPress={close}
                style={({ pressed }) => [
                  styles.closeButton,
                  pressed && styles.pressed,
                ]}
                testID="agent-policy-close"
              >
                <AppIcon color={colors.muted} icon={X} size={18} />
              </Pressable>
            </View>
            <ScrollView
              bounces={false}
              keyboardShouldPersistTaps="handled"
              style={styles.scroll}
              testID="agent-policy-scroll"
            >
              <Text style={styles.sectionLabel}>{t('agent.policy.workspace')}</Text>
              <Text style={styles.workspaceName} testID="agent-policy-workspace">
                {workspaceName ?? t('agent.policy.noWorkspace')}
              </Text>
              {policyStatus === 'ready' && (
                <Pressable accessibilityRole="button" onPress={onRetryPolicy}
                  disabled={gitActivationBusy} testID="agent-policy-retry" style={styles.policyButton}>
                  <Text style={styles.policyButtonText}>{t('agent.policy.refresh')}</Text>
                </Pressable>
              )}
              {policyStatus !== 'ready' && (
                <View testID="agent-policy-status">
                  <Text style={styles.toolBody}>
                    {t(policyStatus === 'unbound' ? 'agent.policy.selectWorkspace'
                      : policyStatus === 'loading' ? 'agent.policy.loading'
                      : policyStatus === 'unavailable' ? 'agent.policy.nativeUnavailable'
                      : 'agent.policy.checkFailed')}
                  </Text>
                  {policyStatus !== 'unbound' && (
                    <Pressable accessibilityRole="button" onPress={onRetryPolicy}
                      disabled={policyStatus === 'loading'} testID="agent-policy-retry"
                      style={styles.policyButton}>
                      <Text style={styles.policyButtonText}>{t('agent.policy.refresh')}</Text>
                    </Pressable>
                  )}
                </View>
              )}
              <Text style={styles.sectionLabel}>{t('agent.policy.capabilities')}</Text>
              <View style={styles.chipRow} testID="agent-policy-capabilities">
                {capabilities.length === 0 && (
                  <Text style={styles.emptyText}>
                    {t(policyStatus === 'ready' ? 'agent.policy.noCapabilities' : 'agent.policy.unverifiedBody')}
                  </Text>
                )}
                {capabilities.map(capability => (
                  <View key={capability} style={styles.chip}>
                    <Text style={styles.chipText}>
                      {t(capabilityLabel(capability) as never)}
                    </Text>
                  </View>
                ))}
              </View>
              <Text style={styles.sectionLabel}>{t('agent.policy.toolAccess')}</Text>
              {gitProjectRequired && (
                <View style={styles.gitSetup} testID="agent-policy-git-project-required">
                  <Text style={styles.toolBody}>{t(gitActivationAvailable ? 'agent.policy.gitProjectRequired' : 'agent.policy.gitUnsupported')}</Text>
                  {gitActivationAvailable && onEnableWorkspaceGit !== undefined && (
                    <Pressable accessibilityRole="button" onPress={onEnableWorkspaceGit}
                      disabled={!canEnableGit || gitActivationBusy}
                      accessibilityState={{ disabled: !canEnableGit || gitActivationBusy, busy: gitActivationBusy }}
                      style={styles.policyButton} testID="agent-policy-enable-git">
                      <Text style={styles.policyButtonText}>
                        {t(gitActivationBusy ? 'agent.policy.gitEnabling' : 'agent.policy.gitEnable')}
                      </Text>
                    </Pressable>
                  )}
                  {gitActivationAvailable && gitActivationBlocked && !gitActivationBusy && (
                    <Text style={styles.toolBody}>{t('agent.policy.gitWaiting')}</Text>
                  )}
                  {gitActivationError !== null && (
                    <Text style={styles.errorText} testID="agent-policy-git-error">
                      {t('agent.policy.gitEnableFailed')}
                    </Text>
                  )}
                </View>
              )}
              <View testID="agent-policy-tools">
                {AGENT_POLICY_TOOLS.map(tool => (
                  <View key={tool} style={styles.toolRow}>
                    <View style={styles.toolCopy}>
                      <Text style={styles.toolName}>
                        {t(toolKey(tool) as never)}
                      </Text>
                      <Text style={styles.toolBody}>
                        {t(accessBodyKey(access[tool]) as never)}
                      </Text>
                    </View>
                    <Text
                      testID={`agent-policy-access-${tool}`}
                      style={[
                        styles.accessBadge,
                        access[tool] === 'durable_deny' && styles.accessDenied,
                        (access[tool] === 'auto' || access[tool] === 'conversation_allowed') && styles.accessAuto,
                        ['unverified', 'checking', 'unavailable', 'not_enabled'].includes(access[tool]) && styles.accessUnverified,
                      ]}
                    >
                      {t(accessKey(access[tool]) as never)}
                    </Text>
                  </View>
                ))}
              </View>
              {budget !== null && <>
              <Text style={styles.sectionLabel}>{t('agent.policy.writeBudget')}</Text>
              <View style={styles.budgetRow} testID="agent-policy-budget">
                <BudgetCell
                  label={t('agent.policy.writeBudget.single')}
                  value={formatBytes(budget.max_single_write_bytes)}
                  styles={styles}
                />
                <BudgetCell
                  label={t('agent.policy.writeBudget.batch')}
                  value={formatBytes(budget.max_batch_write_bytes)}
                  styles={styles}
                />
                <BudgetCell
                  label={t('agent.policy.writeBudget.attempt')}
                  value={formatBytes(budget.max_attempt_write_bytes)}
                  styles={styles}
                />
              </View>
              </>}
              <Text style={styles.sectionLabel}>{t('agent.policy.grants')}</Text>
              <View testID="agent-policy-grants">
                {grants.length === 0 && (
                  <Text style={styles.emptyText}>
                    {t('agent.policy.grantsEmpty')}
                  </Text>
                )}
                {grants.map(grant => (
                  <View key={grant.grant_id} style={styles.grantRow}>
                    <View style={styles.toolCopy}>
                      <Text style={styles.toolName}>
                        {t(grant.tool_family === 'git_commit' ? 'agent.policy.grant.git_commit'
                          : grant.tool_family === 'git_push' ? 'agent.policy.grant.git_push'
                          : grant.tool_family === 'guest_service' ? 'agent.policy.grant.guest_service'
                          : 'agent.policy.grant.file_write')}
                      </Text>
                      <Text style={styles.toolBody}>
                        {t('agent.policy.grantScoped')}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ busy: revokeBusy, disabled: revokeBusy }}
                      disabled={revokeBusy}
                      onPress={() => onRevoke(grant.grant_id)}
                      style={({ pressed }) => [
                        styles.revokeButton,
                        pressed && styles.pressed,
                      ]}
                      testID={`agent-policy-revoke-${grant.grant_id}`}
                    >
                      <Text style={styles.revokeText}>
                        {revokeBusy
                          ? t('agent.policy.revokeBusy')
                          : t('agent.policy.revoke')}
                      </Text>
                    </Pressable>
                  </View>
                ))}
              </View>
              {revokeFailed !== null && (
                <Text style={styles.errorText} testID="agent-policy-revoke-error">
                  {t('agent.policy.revokeFailed')}
                </Text>
              )}
            </ScrollView>
          </View>
        </View>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function BudgetCell({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof createStyles>;
}) {
  return (
    <View style={styles.budgetCell}>
      <Text style={styles.budgetLabel}>{label}</Text>
      <Text style={styles.budgetValue}>{value}</Text>
    </View>
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
    keyboardAvoider: { flex: 1 },
    anchor: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
    },
    card: {
      width: '100%',
      maxWidth: 640,
      flexShrink: 1,
      backgroundColor: colors.surface,
      borderRadius: 22,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      padding: 16,
      shadowColor: '#000000',
      shadowOffset: { width: 0, height: 12 },
      shadowOpacity: 0.24,
      shadowRadius: 30,
      elevation: 16,
    },
    headerRow: {
      flexShrink: 0,
      flexDirection: 'row',
      alignItems: 'flex-start',
      justifyContent: 'space-between',
    },
    headerCopy: { flex: 1 },
    eyebrow: {
      color: colors.muted,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.2,
      marginBottom: 4,
    },
    title: { color: colors.text, fontSize: 17, fontWeight: '800' },
    closeButton: {
      width: 30,
      height: 30,
      borderRadius: 15,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    scroll: { flexGrow: 0, flexShrink: 1, marginTop: 6 },
    sectionLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: '700',
      letterSpacing: 0.4,
      marginTop: 14,
      marginBottom: 4,
    },
    workspaceName: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '700',
    },
    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    chip: {
      borderRadius: 10,
      backgroundColor: colors.surfaceRaised,
      paddingHorizontal: 8,
      paddingVertical: 5,
    },
    chipText: { color: colors.text, fontSize: 11, fontWeight: '600' },
    emptyText: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 15,
      marginBottom: 4,
    },
    toolRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 5,
    },
    toolCopy: { flex: 1, paddingRight: 10 },
    toolName: { color: colors.text, fontSize: 12, fontWeight: '700' },
    toolBody: {
      color: colors.muted,
      fontSize: 10,
      lineHeight: 13,
      marginTop: 1,
    },
    accessBadge: {
      fontSize: 10,
      fontWeight: '700',
      color: colors.accent,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
      borderRadius: 8,
      paddingHorizontal: 6,
      paddingVertical: 3,
    },
    accessAuto: { color: colors.background, backgroundColor: colors.accent },
    accessDenied: {
      color: colors.danger,
      borderColor: colors.danger,
    },
    accessUnverified: {
      color: colors.muted,
      borderColor: colors.line,
    },
    policyButtonText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
    policyButton: {
      alignSelf: 'flex-start', paddingHorizontal: 10, paddingVertical: 8,
      borderRadius: 10, borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent, marginTop: 8,
    },
    gitSetup: { marginBottom: 10 },
    budgetRow: { flexDirection: 'row', gap: 8 },
    budgetCell: {
      flex: 1,
      backgroundColor: colors.surfaceRaised,
      borderRadius: 10,
      paddingHorizontal: 8,
      paddingVertical: 8,
    },
    budgetLabel: { color: colors.muted, fontSize: 9, fontWeight: '700' },
    budgetValue: {
      color: colors.text,
      fontSize: 12,
      fontWeight: '700',
      marginTop: 2,
    },
    grantRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingVertical: 5,
    },
    revokeButton: {
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    revokeText: { color: colors.danger, fontSize: 11, fontWeight: '700' },
    errorText: {
      color: colors.danger,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 8,
    },
    pressed: { opacity: 0.58 },
  });
