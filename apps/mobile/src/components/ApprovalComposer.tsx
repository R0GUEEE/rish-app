import { ComposerViewport } from './ComposerViewport';
import React, { useMemo, useRef, useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import Check from 'lucide-react-native/icons/check';
import X from 'lucide-react-native/icons/x';

import type { ApprovalRequestSpec } from '../agent/AgentApprovals';
import {
  approvalMessageBudget,
  MAX_APPROVAL_MESSAGE_BYTES,
} from '../agent/approvalMessage';
import type { AgentApprovalPreviewV1 } from '../native/AgentRuntime';
import type { ApprovalScopeValue } from '../agent/SessionEvents';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, type ThemePalette } from '../theme';
import { AppIcon } from './AppIcon';

export type AgentApprovalDecisionInput =
  | { readonly status: 'approved'; readonly scope: ApprovalScopeValue }
  | { readonly status: 'denied'; readonly message?: string };

type Props = {
  requests: readonly ApprovalRequestSpec[];
  onDecide: (
    decisions: readonly {
      approvalId: string;
      decision: AgentApprovalDecisionInput;
    }[],
  ) => void;
};

type ItemDecision =
  | { readonly kind: 'approve'; readonly scope: ApprovalScopeValue }
  | { readonly kind: 'deny'; readonly message: string };

function toolSummaryKey(name: string): string {
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
    default:
      return 'agent.tool.unknown';
  }
}

type ComposerTranslator = (
  key: Parameters<ReturnType<typeof useAppPresentation>['t']>[0],
  params?: Record<string, string | number>,
) => string;

/**
 * DSH-style approval composer. One gated call renders the single-card flow;
 * a batch of gated calls renders one list with per-item decisions and a
 * single commit. All decisions are re-validated by the driver; a malformed
 * or expired settlement always fails closed into a denial.
 */
export function ApprovalComposer({ requests, onDecide }: Props) {
  const { colors, t } = useAppPresentation();
  const { fontScale } = useWindowDimensions();
  const styles = useMemo(
    () => createStyles(colors, fontScale >= 1.5),
    [colors, fontScale],
  );
  const batch = requests.length > 1;
  const [decisions, setDecisions] = useState<Record<string, ItemDecision>>(
    () => {
      const initial: Record<string, ItemDecision> = {};
      requests.forEach(request => {
        initial[request.approvalId] = { kind: 'deny', message: '' };
      });
      return initial;
    },
  );

  const decisionsRef = useRef(decisions);
  decisionsRef.current = decisions;
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  const requestKey = JSON.stringify(
    requests.map(request => request.approvalId),
  );
  const invalidBatchItems = requests.flatMap((request, index) => {
    const decision = decisions[request.approvalId];
    return decision?.kind === 'deny' &&
      !approvalMessageBudget(decision.message).valid
      ? [index + 1]
      : [];
  });
  const invalidBatch = invalidBatchItems.length > 0;
  const setDecision = (approvalId: string, decision: ItemDecision) => {
    decisionsRef.current = { ...decisionsRef.current, [approvalId]: decision };
    setDecisions(decisionsRef.current);
  };

  const submitAll = () => {
    if (
      requestKey !==
      JSON.stringify(requestsRef.current.map(request => request.approvalId))
    )
      return;
    if (
      requests.some(request => {
        const decision = decisionsRef.current[request.approvalId];
        return (
          decision?.kind === 'deny' &&
          !approvalMessageBudget(decision.message).valid
        );
      })
    )
      return;
    onDecide(
      requests.map(request => {
        const decision = decisionsRef.current[request.approvalId];
        const approval: AgentApprovalDecisionInput =
          decision !== undefined && decision.kind === 'approve'
            ? { status: 'approved', scope: decision.scope }
            : {
                status: 'denied',
                ...(decision !== undefined && decision.message.trim().length > 0
                  ? { message: decision.message }
                  : {}),
              };
        return { approvalId: request.approvalId, decision: approval };
      }),
    );
  };

  const submitSingle = (
    request: ApprovalRequestSpec,
    decision: AgentApprovalDecisionInput,
  ) => {
    if (
      requestsRef.current.length !== 1 ||
      requestsRef.current[0]?.approvalId !== request.approvalId
    )
      return;
    if (
      decision.status === 'denied' &&
      decision.message !== undefined &&
      !approvalMessageBudget(decision.message).valid
    )
      return;
    onDecide([{ approvalId: request.approvalId, decision }]);
  };

  const closeAll = () => {
    if (
      requestKey !==
      JSON.stringify(requestsRef.current.map(request => request.approvalId))
    )
      return;
    onDecide(
      requests.map(request => ({
        approvalId: request.approvalId,
        decision: { status: 'denied' as const },
      })),
    );
  };

  const approvedCount = requests.filter(request => {
    const decision = decisions[request.approvalId];
    return decision !== undefined && decision.kind === 'approve';
  }).length;

  const batchFooter = batch ? (
    <View style={styles.batchFooter} testID="approval-batch-footer">
      {invalidBatch && (
        <Text accessibilityRole="alert" style={styles.messageError}>
          {t('agent.approvalBatchMessageInvalid', {
            calls: invalidBatchItems.join(','),
            limit: MAX_APPROVAL_MESSAGE_BYTES,
          })}
        </Text>
      )}
      <Text style={styles.batchSummary}>
        {t('agent.approvalBatchSummary', {
          approved: approvedCount,
          denied: requests.length - approvedCount,
        })}
      </Text>
      <View style={styles.batchFooterActions}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (
              requestKey !==
              JSON.stringify(requestsRef.current.map(request => request.approvalId))
            ) return;
            onDecide(
              requestsRef.current.map(request => ({
                approvalId: request.approvalId,
                decision: { status: 'approved' as const, scope: 'once' as const },
              })),
            );
          }}
          style={({ pressed }) => [
            styles.batchApproveAll,
            pressed && styles.pressed,
          ]}
          testID="approval-batch-approve-all-once"
        >
          <Text style={styles.batchApproveAllText}>
            {t('agent.approvalBatchApproveAll')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={submitAll}
          disabled={invalidBatch}
          accessibilityState={{ disabled: invalidBatch }}
          style={({ pressed }) => [
            styles.commitButton,
            invalidBatch && styles.disabled,
            pressed && styles.pressed,
          ]}
          testID="approval-batch-commit"
        >
          <Text style={styles.commitText}>
            {t('agent.approvalBatchCommit')}
          </Text>
        </Pressable>
      </View>
    </View>
  ) : undefined;

  return (
    <Modal
      animationType="fade"
      onRequestClose={closeAll}
      presentationStyle="overFullScreen"
      statusBarTranslucent
      testID="approval-composer-modal"
      transparent
      visible
    >
      <ComposerViewport footer={batchFooter} revealEndOnKeyboard={!batch}>
        <View
          accessibilityLabel={
            batch
              ? t('agent.approvalBatchTitle', { count: requests.length })
              : t('agent.approvalTitle')
          }
          role="dialog"
          style={styles.card}
          testID="approval-composer-card"
        >
          <Text style={styles.eyebrow}>
            {batch
              ? t('agent.approvalBatchEyebrow')
              : t('agent.approvalEyebrow')}
          </Text>
          <Text style={styles.title}>
            {batch
              ? t('agent.approvalBatchTitle', { count: requests.length })
              : t('agent.approvalTitle')}
          </Text>
          {batch ? (
            <View style={styles.batchList} testID="approval-batch-list">
              {requests.map((request, index) => (
                <BatchItem
                  key={request.approvalId}
                  colors={colors}
                  decision={decisions[request.approvalId]}
                  index={index}
                  request={request}
                  styles={styles}
                  t={t}
                  onDecision={decision =>
                    setDecision(request.approvalId, decision)
                  }
                />
              ))}
            </View>
          ) : (
            <SingleItem
              key={requests[0]?.approvalId}
              colors={colors}
              request={requests[0]}
              styles={styles}
              t={t}
              onSubmit={submitSingle}
            />
          )}
        </View>
      </ComposerViewport>
    </Modal>
  );
}

function PreviewBlock({
  preview,
  styles,
  t,
}: {
  preview: AgentApprovalPreviewV1;
  styles: ReturnType<typeof createStyles>;
  t: ComposerTranslator;
}) {
  if (preview.kind === 'write_file') {
    return (
      <View testID="approval-preview">
        <Text style={styles.previewLabel}>{t('agent.approvalPathLabel')}</Text>
        <Text
          numberOfLines={2}
          style={styles.previewPath}
          testID="approval-preview-path"
        >
          {preview.paths[0] ?? ''}
        </Text>
        <Text style={styles.previewMeta} testID="approval-preview-bytes">
          {preview.prior === null || preview.prior.kind === 'absent'
            ? t('agent.approvalPriorAbsent')
            : t('agent.approvalPriorKnown', {
                bytes: preview.prior.bytes === null ? 0 : preview.prior.bytes,
              })}
          {` · ${t('agent.approvalBytes', {
            bytes: preview.content_bytes ?? 0,
          })}`}
        </Text>
        <Text style={styles.previewLabel}>{t('agent.approvalDiffTitle')}</Text>
        <DiffPreview preview={preview} styles={styles} t={t} />
      </View>
    );
  }
  return (
    <View testID="approval-preview">
      <Text style={styles.previewLabel}>{t('agent.approvalPathLabel')}</Text>
      <Text
        numberOfLines={2}
        style={styles.previewPath}
        testID="approval-preview-path"
      >
        {preview.paths.length === 0 && preview.kind === 'list_dir'
          ? t('agent.approvalPathRoot')
          : preview.paths.join(', ') || '—'}
      </Text>
    </View>
  );
}

function DiffPreview({
  preview,
  styles,
  t,
}: {
  preview: AgentApprovalPreviewV1;
  styles: ReturnType<typeof createStyles>;
  t: ComposerTranslator;
}) {
  if (preview.diff_preview === null) {
    if (
      preview.kind === 'write_file' &&
      preview.prior !== null &&
      preview.prior.kind === 'absent'
    ) {
      return (
        <Text style={styles.diffEmpty} testID="approval-diff-new-file">
          {t('agent.approvalDiffNewFile')}
        </Text>
      );
    }
    return (
      <Text style={styles.diffEmpty} testID="approval-diff-binary">
        {t('agent.approvalDiffBinary')}
      </Text>
    );
  }
  if (preview.diff_preview.length === 0) {
    return (
      <Text style={styles.diffEmpty} testID="approval-diff-empty">
        {t('agent.approvalDiffEmpty')}
      </Text>
    );
  }
  return (
    <View testID="approval-diff">
      <ScrollView
        bounces={false}
        horizontal
        nestedScrollEnabled
        style={styles.diffBox}
      >
        <Text style={styles.diffText}>{preview.diff_preview}</Text>
      </ScrollView>
      {preview.diff_truncated && (
        <Text style={styles.diffTruncated}>
          {t('agent.approvalDiffTruncated')}
        </Text>
      )}
    </View>
  );
}

function BatchItem({
  colors,
  decision,
  index,
  onDecision,
  request,
  styles,
  t,
}: {
  colors: ThemePalette;
  decision: ItemDecision | undefined;
  index: number;
  onDecision: (decision: ItemDecision) => void;
  request: ApprovalRequestSpec;
  styles: ReturnType<typeof createStyles>;
  t: ComposerTranslator;
}) {
  const [denyMessage, setDenyMessage] = useState('');
  const denyMessageRef = useRef('');
  const current = decision ?? { kind: 'deny', message: '' };
  const approve = (value: ApprovalScopeValue) =>
    onDecision({ kind: 'approve', scope: value });
  const deny = () =>
    onDecision({ kind: 'deny', message: denyMessageRef.current });
  return (
    <View style={styles.batchItem} testID={`approval-batch-item-${index}`}>
      <Text style={styles.itemIndex}>
        {t('agent.approvalBatchItem', { index: index + 1 })}
      </Text>
      <Text style={styles.toolName}>{request.toolName}</Text>
      <Text style={styles.toolSummary}>
        {t(toolSummaryKey(request.toolName) as never)}
      </Text>
      {request.preview !== null && (
        <PreviewBlock preview={request.preview} styles={styles} t={t} />
      )}
      <View style={styles.itemActions}>
        {request.scopes.map(value => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{
              selected: current.kind === 'approve' && current.scope === value,
            }}
            key={value}
            onPress={() => approve(value)}
            style={({ pressed }) => [
              styles.itemApprove,
              current.kind === 'approve' &&
                current.scope === value &&
                styles.itemApproveSelected,
              pressed && styles.pressed,
            ]}
            testID={`approval-item-${index}-${value}`}
          >
            <AppIcon
              color={
                current.kind === 'approve' && current.scope === value
                  ? colors.background
                  : colors.accent
              }
              icon={Check}
              size={13}
            />
            <Text
              style={[
                styles.itemApproveText,
                current.kind === 'approve' &&
                  current.scope === value &&
                  styles.itemApproveTextSelected,
              ]}
            >
              {value === 'once'
                ? t('agent.approvalScope.once')
                : t('agent.approvalScope.conversation')}
            </Text>
          </Pressable>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: current.kind === 'deny' }}
          onPress={deny}
          style={({ pressed }) => [
            styles.itemDeny,
            current.kind === 'deny' && styles.itemDenySelected,
            pressed && styles.pressed,
          ]}
          testID={`approval-item-${index}-deny`}
        >
          <AppIcon
            color={current.kind === 'deny' ? colors.background : colors.danger}
            icon={X}
            size={13}
          />
          <Text
            style={[
              styles.itemDenyText,
              current.kind === 'deny' && styles.itemDenyTextSelected,
            ]}
          >
            {t('agent.approvalDeny')}
          </Text>
        </Pressable>
      </View>
      {current.kind === 'deny' && (
        <View style={styles.denyMessageRow}>
          <TextInput
            accessibilityLabel={t('agent.approvalDenyWithMessage')}
            multiline
            onChangeText={value => {
              denyMessageRef.current = value;
              setDenyMessage(value);
              onDecision({ kind: 'deny', message: value });
            }}
            placeholder={t('agent.approvalDenyMessagePlaceholder')}
            placeholderTextColor={colors.muted}
            style={styles.denyInput}
            testID={`approval-item-${index}-deny-message`}
            value={denyMessage}
          />
          <Text style={styles.denyHint}>
            {t('agent.approvalDenyMessageHint')}
          </Text>
          <MessageBudget message={denyMessage} styles={styles} t={t} />
        </View>
      )}
    </View>
  );
}

function SingleItem({
  colors,
  onSubmit,
  request,
  styles,
  t,
}: {
  colors: ThemePalette;
  onSubmit: (
    request: ApprovalRequestSpec,
    decision: AgentApprovalDecisionInput,
  ) => void;
  request: ApprovalRequestSpec;
  styles: ReturnType<typeof createStyles>;
  t: ComposerTranslator;
}) {
  const [scope, setScope] = useState<ApprovalScopeValue>(
    request.scopes[0] ?? 'once',
  );
  const [denyMessage, setDenyMessage] = useState('');
  const denyMessageRef = useRef('');
  return (
    <>
      <Text style={styles.toolName}>{request.toolName}</Text>
      <Text style={styles.toolSummary}>
        {t(toolSummaryKey(request.toolName) as never)}
      </Text>
      {request.preview !== null && (
        <PreviewBlock preview={request.preview} styles={styles} t={t} />
      )}
      <Text style={styles.scopeLabel}>{t('agent.approvalScopeLabel')}</Text>
      <View
        accessibilityLabel={t('agent.approvalScopeLabel')}
        accessibilityRole="radiogroup"
        testID="approval-scope-group"
      >
        {request.scopes.map(scopeValue => {
          const isSelected = scopeValue === scope;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: isSelected }}
              key={scopeValue}
              onPress={() => setScope(scopeValue)}
              style={({ pressed }) => [
                styles.scopeOption,
                isSelected && styles.scopeSelected,
                pressed && styles.pressed,
              ]}
              testID={
                scopeValue === 'once'
                  ? 'approval-scope-once'
                  : 'approval-scope-conversation'
              }
            >
              <View style={styles.check}>
                {isSelected && (
                  <AppIcon color={colors.accent} icon={Check} size={16} />
                )}
              </View>
              <View style={styles.scopeCopy}>
                <Text style={styles.scopeTitle}>
                  {scopeValue === 'once'
                    ? t('agent.approvalScope.once')
                    : t('agent.approvalScope.conversation')}
                </Text>
                <Text style={styles.scopeBody}>
                  {scopeValue === 'once'
                    ? t('agent.approvalScope.onceBody')
                    : t('agent.approvalScope.conversationBody')}
                </Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {denyMessage.trim().length > 0 && (
        <Text style={styles.denyHint}>
          {t('agent.approvalDenyMessageHint')}
        </Text>
      )}
      <MessageBudget message={denyMessage} styles={styles} t={t} />
      <TextInput
        accessibilityLabel={t('agent.approvalDenyWithMessage')}
        multiline
        onChangeText={value => {
          denyMessageRef.current = value;
          setDenyMessage(value);
        }}
        placeholder={t('agent.approvalDenyMessagePlaceholder')}
        placeholderTextColor={colors.muted}
        style={styles.denyInput}
        testID="approval-deny-message"
        value={denyMessage}
      />
      <View style={styles.buttonRow}>
        <Pressable
          accessibilityRole="button"
          disabled={!approvalMessageBudget(denyMessage).valid}
          accessibilityState={{
            disabled: !approvalMessageBudget(denyMessage).valid,
          }}
          onPress={() => {
            const message = denyMessageRef.current;
            if (!approvalMessageBudget(message).valid) return;
            onSubmit(request, {
              status: 'denied',
              ...(message.trim().length > 0 ? { message } : {}),
            });
          }}
          style={({ pressed }) => [
            styles.denyButton,
            !approvalMessageBudget(denyMessage).valid && styles.disabled,
            pressed && styles.pressed,
          ]}
          testID="approval-deny"
        >
          <Text style={styles.denyText}>
            {denyMessage.trim().length > 0
              ? t('agent.approvalDenyWithMessage')
              : t('agent.approvalDeny')}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onSubmit(request, { status: 'approved', scope })}
          style={({ pressed }) => [
            styles.allowButton,
            pressed && styles.pressed,
          ]}
          testID="approval-allow"
        >
          <Text style={styles.allowText}>{t('agent.approvalAllow')}</Text>
        </Pressable>
      </View>
    </>
  );
}

function MessageBudget({
  message,
  styles,
  t,
}: {
  message: string;
  styles: ReturnType<typeof createStyles>;
  t: ComposerTranslator;
}) {
  const budget = approvalMessageBudget(message);
  if (message.length === 0) return null;
  return (
    <View>
      {budget.bytes !== null && (
        <Text style={styles.denyHint}>
          {t('agent.approvalMessageBudget', {
            used: budget.bytes,
            limit: MAX_APPROVAL_MESSAGE_BYTES,
          })}
        </Text>
      )}
      {!budget.valid && (
        <Text accessibilityRole="alert" style={styles.messageError}>
          {t(
            budget.bytes === null
              ? 'agent.approvalMessageInvalid'
              : 'agent.approvalMessageTooLong',
            { limit: MAX_APPROVAL_MESSAGE_BYTES },
          )}
        </Text>
      )}
    </View>
  );
}

const createStyles = (colors: ThemePalette, largeText = false) =>
  StyleSheet.create({
    disabled: { opacity: 0.4 },
    messageError: {
      color: colors.danger,
      fontSize: 11,
      lineHeight: 16,
      marginTop: 4,
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
    eyebrow: {
      color: colors.muted,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1.2,
      marginBottom: 4,
    },
    title: { color: colors.text, fontSize: 17, fontWeight: '800' },
    toolName: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '700',
      marginTop: 6,
    },
    toolSummary: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 2,
    },
    previewLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: '700',
      marginTop: 8,
      marginBottom: 2,
    },
    previewPath: {
      color: colors.text,
      fontSize: 12,
      fontFamily: fonts.mono,
      lineHeight: 16,
    },
    previewMeta: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 2,
    },
    diffBox: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: 10,
      padding: 8,
      marginTop: 2,
    },
    diffText: {
      color: colors.text,
      fontSize: 10,
      fontFamily: fonts.mono,
      lineHeight: 14,
    },
    diffEmpty: {
      color: colors.muted,
      fontSize: 11,
      fontStyle: 'italic',
      marginTop: 2,
    },
    diffTruncated: {
      color: colors.warning ?? colors.accent,
      fontSize: 10,
      marginTop: 2,
    },
    batchList: { marginTop: 8 },
    batchFooter: {
      backgroundColor: colors.surface,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.line,
      paddingHorizontal: 18,
      paddingTop: 10,
    },
    batchFooterActions: {
      flexDirection: largeText ? 'column' : 'row',
      gap: 8,
    },
    batchItem: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      borderRadius: 12,
      padding: 10,
      marginBottom: 8,
    },
    itemIndex: {
      color: colors.muted,
      fontSize: 9,
      fontWeight: '800',
      letterSpacing: 1,
    },
    itemActions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
      marginTop: 8,
    },
    itemApprove: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    itemApproveSelected: { backgroundColor: colors.accent },
    itemApproveText: { color: colors.accent, fontSize: 11, fontWeight: '700' },
    itemApproveTextSelected: { color: colors.background },
    itemDeny: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      paddingHorizontal: 8,
      paddingVertical: 6,
    },
    itemDenySelected: { backgroundColor: colors.danger },
    itemDenyText: { color: colors.danger, fontSize: 11, fontWeight: '700' },
    itemDenyTextSelected: { color: colors.background },
    denyMessageRow: { marginTop: 6 },
    denyInput: {
      backgroundColor: colors.surfaceRaised,
      borderRadius: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      color: colors.text,
      fontSize: 12,
      lineHeight: 16,
      minHeight: 38,
      maxHeight: 84,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    denyHint: {
      color: colors.muted,
      fontSize: 10,
      lineHeight: 13,
      marginTop: 4,
    },
    batchSummary: {
      color: colors.muted,
      fontSize: 11,
      textAlign: 'center',
      marginTop: 6,
    },
    commitButton: {
      flex: largeText ? 0 : 1,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    commitText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    batchApproveAll: {
      flex: largeText ? 0 : 1,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
      backgroundColor: colors.surface,
    },
    batchApproveAllText: {
      color: colors.accent,
      fontSize: 13,
      fontWeight: '700',
      textAlign: 'center',
    },
    scopeLabel: {
      color: colors.muted,
      fontSize: 10,
      fontWeight: '700',
      marginTop: 12,
      marginBottom: 4,
    },
    scopeOption: {
      minHeight: 52,
      paddingHorizontal: 10,
      paddingVertical: 8,
      borderRadius: 12,
      flexDirection: 'row',
      alignItems: 'center',
      marginBottom: 6,
    },
    scopeSelected: { backgroundColor: colors.surfaceRaised },
    check: {
      width: 20,
      alignItems: 'flex-start',
      marginRight: 8,
    },
    scopeCopy: { flex: 1 },
    scopeTitle: { color: colors.text, fontSize: 13, fontWeight: '700' },
    scopeBody: {
      color: colors.muted,
      fontSize: 11,
      lineHeight: 15,
      marginTop: 1,
    },
    buttonRow: {
      flexDirection: largeText ? 'column' : 'row',
      gap: 10,
      marginTop: 10,
    },
    denyButton: {
      flex: largeText ? 0 : 1,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surfaceRaised,
    },
    denyText: { color: colors.danger, fontSize: 14, fontWeight: '700' },
    allowButton: {
      flex: largeText ? 0 : 1.6,
      minHeight: 46,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.accent,
    },
    allowText: { color: colors.background, fontSize: 14, fontWeight: '700' },
    pressed: { opacity: 0.58 },
  });
