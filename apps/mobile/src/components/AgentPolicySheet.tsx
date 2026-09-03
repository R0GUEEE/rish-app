import React, { useMemo } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import X from 'lucide-react-native/icons/x';

import type { AgentCapability, AgentConversationGrantV2 } from '../state';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

export type AgentPolicyAccess =
  | 'auto'
  | 'conversation_confirm'
  | 'confirm_once'
  | 'durable_deny';

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

const POLICY_TOOLS = [
  'list_dir',
  'read_file',
  'write_file',
  'git_status',
  'git_commit',
  'git_push',
] as const;

type PolicyTool = (typeof POLICY_TOOLS)[number];

/**
 * Effective per-tool access for one capability set, mirroring the native
 * capability-filter matrix: reads and git_status are automatic, writes and
 * git commits need conversation confirmation, git push is confirm-once, and
 * anything outside the granted capabilities is durably denied.
 */
export function agentToolAccess(
  capabilities: readonly AgentCapability[],
): Record<PolicyTool, AgentPolicyAccess> {
  const has = (capability: AgentCapability): boolean =>
    capabilities.includes(capability);
  return {
    list_dir: has('file_read') ? 'auto' : 'durable_deny',
    read_file: has('file_read') ? 'auto' : 'durable_deny',
    write_file: has('file_write') ? 'conversation_confirm' : 'durable_deny',
    git_status: has('git_status') ? 'auto' : 'durable_deny',
    git_commit: has('git_commit') ? 'conversation_confirm' : 'durable_deny',
    git_push: has('git_push') ? 'confirm_once' : 'durable_deny',
  };
}

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
  }
}

function accessKey(access: AgentPolicyAccess): string {
  switch (access) {
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
    default:
      return 'agent.tool.git_push';
  }
}

type Props = {
  visible: boolean;
  workspaceName: string | null;
  capabilities: readonly AgentCapability[];
  budget: AgentPolicyBudget;
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
  budget,
  grants,
  revokeBusy,
  revokeFailed,
  onClose,
  onRevoke,
}: Props) {
  const { colors, t } = useAppPresentation();
  const { height: windowHeight } = useWindowDimensions();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // The panel scrolls inside a bounded sheet; taller windows get more of it
  // without ever covering the whole screen.
  const scrollMaxHeight = Math.max(320, Math.min(windowHeight * 0.66, 720));
  if (!visible) return null;
  const access = agentToolAccess(capabilities);
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="agent-policy-modal"
      transparent
      visible
    >
      <View accessibilityViewIsModal style={styles.overlay}>
        <View pointerEvents="box-none" style={styles.anchor}>
          <View
            accessibilityLabel={t('agent.policy.title')}
            accessibilityRole="dialog"
            style={styles.card}
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
                onPress={onClose}
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
              style={[styles.scroll, { maxHeight: scrollMaxHeight }]}
            >
              <Text style={styles.sectionLabel}>{t('agent.policy.workspace')}</Text>
              <Text style={styles.workspaceName} testID="agent-policy-workspace">
                {workspaceName ?? t('agent.policy.noWorkspace')}
              </Text>
              <Text style={styles.sectionLabel}>{t('agent.policy.capabilities')}</Text>
              <View style={styles.chipRow} testID="agent-policy-capabilities">
                {capabilities.length === 0 && (
                  <Text style={styles.emptyText}>
                    {t('agent.policy.grantsEmpty')}
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
              <View testID="agent-policy-tools">
                {POLICY_TOOLS.map(tool => (
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
                      style={[
                        styles.accessBadge,
                        access[tool] === 'durable_deny' && styles.accessDenied,
                        access[tool] === 'auto' && styles.accessAuto,
                      ]}
                    >
                      {t(accessKey(access[tool]) as never)}
                    </Text>
                  </View>
                ))}
              </View>
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
                        {grant.tool_family === 'git_commit'
                          ? t('agent.policy.grant.git_commit')
                          : t('agent.policy.grant.file_write')}
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
    anchor: {
      flex: 1,
      justifyContent: 'flex-end',
      alignItems: 'stretch',
      paddingHorizontal: 18,
      paddingBottom: 72,
    },
    card: {
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
    scroll: { marginTop: 6 },
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
