import { ChatComposer } from '../components/ChatComposer';
import { EmptyChat } from '../components/EmptyChat';
import { HarnessPicker } from '../components/HarnessPicker';
import { BUILTIN_HARNESSES } from '../harness/builtins';
import { QuestionComposer } from '../components/QuestionComposer';
import { RecoveryNotice } from '../components/RecoveryNotice';
import { completionRecoveryLabel } from '../components/recoveryMessage';
import {
  createPreferencesStore,
  createDefaultPreferences,
} from '../preferences';
import React, { useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { MessageList, type DisplayMessage } from '../components/MessageList';
import type { ApprovalRequestSpec } from '../agent/AgentApprovals';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from '../agent/AgentApprovals';
import {
  AgentPolicySheet,
  AGENT_POLICY_DEFAULT_BUDGET,
} from '../components/AgentPolicySheet';
import { ApprovalComposer } from '../components/ApprovalComposer';
import {
  AppPresentationProvider,
  useAppPresentation,
} from '../presentation/AppPresentation';
import type { AgentConversationGrantV2 } from '../state';

/**
 * Launch-environment gated UI preview (DSH_UI_PREVIEW). It renders the
 * approval composer, message list and Agent policy panel with fixed display data so
 * simulator screenshots can be taken without a provider round. Nothing here
 * touches the store, native runtime, or persistence: every decision is
 * discarded, so the surface can never issue an approval or revoke a grant.
 */

export const UI_PREVIEW_KINDS = [
  'approval-single',
  'approval-batch',
  'policy-panel',
  'message-list',
  'recovery-zh',
  'recovery-en',
  'approval-long-zh',
  'question-options-zh',
  'question-text-zh',
  'composer-zh',
  'copy-zh',
  'copy-en',
] as const;

export type UIPreviewKind = (typeof UI_PREVIEW_KINDS)[number];

export function parseUIPreviewKind(value: unknown): UIPreviewKind | null {
  return typeof value === 'string' &&
    (UI_PREVIEW_KINDS as readonly string[]).includes(value)
    ? (value as UIPreviewKind)
    : null;
}

const WRITE_REQUEST: ApprovalRequestSpec = {
  approvalId: 'preview-write',
  toolCallId: 'preview-write-call',
  toolName: 'write_file',
  argumentsJson: '{"arguments_sha256":"preview"}',
  preview: {
    schema_version: 1,
    kind: 'write_file',
    paths: ['notes/todo.md'],
    content_bytes: 148,
    prior: { schema_version: 1, kind: 'known', bytes: 96 },
    diff_preview:
      '@@ -1,3 +1,4 @@\n # Todo\n-- [ ] write the release notes\n+- [x] write the release notes\n+- [ ] tag v0.3.0\n - [ ] ship',
    diff_truncated: false,
  },
  scopes: ['once', 'conversation'],
  expiresAtMs: Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS,
};

const COMMIT_REQUEST: ApprovalRequestSpec = {
  approvalId: 'preview-commit',
  toolCallId: 'preview-commit-call',
  toolName: 'git_commit',
  argumentsJson: '{"arguments_sha256":"preview"}',
  preview: {
    schema_version: 1,
    kind: 'git_commit',
    paths: [],
    content_bytes: null,
    prior: null,
    diff_preview: null,
    diff_truncated: false,
  },
  scopes: ['once', 'conversation'],
  expiresAtMs: Date.now() + DEFAULT_APPROVAL_TIMEOUT_MS,
};

const PREVIEW_GRANTS: readonly AgentConversationGrantV2[] = [
  {
    schema_version: 2,
    grant_id: 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1',
    conversation_id: 'b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2',
    workspace_id: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3',
    project_id: null,
    binding_revision: 1,
    root_fingerprint_sha256: 'd'.repeat(64),
    tool_family: 'file_write',
    registry_version: 1,
    policy_version: 'agent-v1',
    issued_for: {
      schema_version: 1,
      task_id: 'e4e4e4e4-e4e4-4e4e-8e4e-e4e4e4e4e4e4',
      attempt_id: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5',
    },
    created_at: '2026-09-03T12:00:00.000Z',
  },
];

export function UIPreview({ kind }: { kind: UIPreviewKind }) {
  const [store] = useState(() =>
    createPreferencesStore({
      initialPreferences: {
        ...createDefaultPreferences(),
        locale: kind.endsWith('-zh') ? 'zh-CN' : 'en-US',
      },
    }),
  );
  return (
    <AppPresentationProvider store={store}>
      <UIPreviewContent kind={kind} />
    </AppPresentationProvider>
  );
}

function UIPreviewContent({ kind }: { kind: UIPreviewKind }) {
  const { colors } = useAppPresentation();
  const [decided, setDecided] = useState<string | null>(null);
  return (
    <View
      style={[styles.root, { backgroundColor: colors.background }]}
      testID="ui-preview-root"
    >
      <Text
        style={[styles.caption, { color: colors.muted }]}
        testID="ui-preview-caption"
      >
        {decided ?? `preview:${kind}`}
      </Text>
      {decided !== null ? null : kind === 'composer-zh' ? (
        <ComposerPreview />
      ) : kind === 'copy-zh' || kind === 'copy-en' ? (
        <CopyPreview />
      ) : kind === 'question-options-zh' || kind === 'question-text-zh' ? (
        <QuestionComposer
          question={{
            questionId: 'preview-question',
            text: '请检查这次操作的范围并选择下一步。'.repeat(5),
            inputMode: kind === 'question-options-zh' ? 'options' : 'free_text',
            options:
              kind === 'question-options-zh'
                ? Array.from({ length: 8 }, (_, i) => ({
                    id: `option-${i + 1}`,
                    label: `选项${
                      i + 1
                    }：只处理当前工作区中确认过的文件，并保留未保存的修改。`,
                  }))
                : [],
            required: false,
          }}
          onAnswer={(_, answer) => setDecided(`answered:${answer}`)}
          onCancel={() => setDecided('cancelled')}
        />
      ) : kind === 'recovery-zh' || kind === 'recovery-en' ? (
        <RecoveryPreview locale={kind === 'recovery-zh' ? 'zh-CN' : 'en-US'} />
      ) : kind === 'message-list' ? (
        <MessageListPreview />
      ) : kind === 'policy-panel' ? (
        <AgentPolicySheet
          budget={AGENT_POLICY_DEFAULT_BUDGET}
          capabilities={[
            'file_read',
            'file_write',
            'git_status',
            'git_commit',
            'git_push',
          ]}
          grants={PREVIEW_GRANTS}
          revokeBusy={false}
          revokeFailed={null}
          visible
          workspaceName="Release notes"
          onClose={() => setDecided('closed')}
          onRevoke={grantId => setDecided(`revoke:${grantId}`)}
        />
      ) : (
        <ApprovalComposer
          requests={
            kind === 'approval-batch'
              ? [WRITE_REQUEST, COMMIT_REQUEST]
              : kind === 'approval-long-zh'
              ? [
                  {
                    ...WRITE_REQUEST,
                    preview: {
                      ...WRITE_REQUEST.preview!,
                      paths: [
                        'docs/项目说明与验收记录/需要认真复核的长文件名.md',
                      ],
                      diff_preview: '+ 请复核文件内容与操作范围。\n'.repeat(30),
                      diff_truncated: true,
                    },
                  },
                ]
              : [WRITE_REQUEST]
          }
          onDecide={decisions =>
            setDecided(
              decisions
                .map(entry => `${entry.approvalId}:${entry.decision.status}`)
                .join(','),
            )
          }
        />
      )}
    </View>
  );
}

function ComposerPreview() {
  const [draft, setDraft] = useState('验收草稿');
  const [sending, setSending] = useState(false);
  const [action, setAction] = useState('');
  const { colors } = useAppPresentation();
  return (
    <View
      style={{
        flex: 1,
        alignSelf: 'stretch',
        justifyContent: 'flex-end',
        padding: 12,
      }}
    >
      <Text style={{ color: colors.text }}>{action}</Text>
      <ChatComposer
        configured
        draft={draft}
        attachments={[]}
        attachmentBusy={false}
        previewingAttachmentId={null}
        model="claude-haiku-4-5-20251001"
        providerName="Anthropic"
        harnessName="Claude Code"
        optionsVisible={false}
        thinkingMode="high"
        workspaceName="用于验证长项目名称的工作区"
        ownershipKey="preview"
        locked={false}
        sending={sending}
        onAddAttachment={() => setAction('attachment')}
        onCancel={() => {
          setSending(false);
          setAction('cancel');
        }}
        onChange={setDraft}
        onConfigure={() => setAction('configure')}
        onOptionsPress={() => setAction('options')}
        onPreviewAttachment={() => {}}
        onRemoveAttachment={() => {}}
        onSend={() => {
          setDraft('');
          setSending(true);
          setAction('sent');
        }}
        onWorkspacePress={() => setAction('workspace')}
      />
    </View>
  );
}
function CopyPreview() {
  const [visible, setVisible] = useState(false);
  const { colors } = useAppPresentation();
  return (
    <View style={{ flex: 1, alignSelf: 'stretch' }}>
      <EmptyChat onSuggestion={() => {}} />
      <Pressable accessibilityRole="button" onPress={() => setVisible(true)}>
        <Text style={{ color: colors.accent, padding: 12 }}>
          Show harness list
        </Text>
      </Pressable>
      <HarnessPicker
        manifests={BUILTIN_HARNESSES.list()}
        selectedId="glm"
        visible={visible}
        onClose={() => setVisible(false)}
        onSelect={() => {}}
      />
    </View>
  );
}

function RecoveryPreview({ locale }: { locale: 'zh-CN' | 'en-US' }) {
  const [store] = useState(() =>
    createPreferencesStore({
      initialPreferences: { ...createDefaultPreferences(), locale },
    }),
  );
  return (
    <AppPresentationProvider store={store}>
      <RecoveryPreviewContent />
    </AppPresentationProvider>
  );
}

function RecoveryPreviewContent() {
  const { t, colors } = useAppPresentation();
  const [kind, setKind] = useState(0);
  const failures = [
    'E_WORKSPACE_PERSISTENCE',
    'E_WORKSPACE_REVOKED',
    'E_SESSION_PROTECTION',
  ];
  const error =
    failures[kind] + ': ' + 'Diagnostic line. '.repeat(80) + 'END OF DETAILS';
  return (
    <View style={{ alignSelf: 'stretch', padding: 20, gap: 16 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Next example"
        onPress={() => setKind(value => (value + 1) % failures.length)}
      >
        <Text style={{ color: colors.accent }}>Next example</Text>
      </Pressable>
      <RecoveryNotice error={error} />
      <Text style={{ color: colors.text }}>
        {kind === 0
          ? completionRecoveryLabel('persistence_pending', t)
          : kind === 1
          ? t('workspaces.regrant')
          : t('recovery.retrySave')}
      </Text>
    </View>
  );
}

function MessageListPreview() {
  const list = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const [revision, setRevision] = useState(0);
  const [toolDone, setToolDone] = useState(false);
  const messages: DisplayMessage[] = [
    ...Array.from(
      { length: 20 },
      (_, index): DisplayMessage => ({
        id: `history-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `History ${
          index + 1
        }. This saved paragraph stays in place while new output arrives.\nA second line makes the reading position easy to verify.`,
      }),
    ),
    {
      id: 'live',
      role: 'assistant',
      text: '',
      blocks: [
        {
          id: 'stream',
          type: 'text',
          text: `Latest response — revision ${revision}.\n${'New streamed text. '.repeat(
            revision * 8 + 1,
          )}`,
        },
        {
          id: 'tool',
          type: 'tool-call',
          name: 'read_file',
          arguments: '{"path":"notes.txt"}',
          status: toolDone ? 'success' : 'running',
        },
      ],
    },
  ];
  return (
    <View style={{ flex: 1, alignSelf: 'stretch' }}>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-around',
          padding: 12,
        }}
      >
        <Pressable
          accessibilityRole="button"
          onPress={() => list.current?.scrollTo({ y: 0, animated: false })}
        >
          <Text>Read history</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setRevision(value => value + 1)}
        >
          <Text>Append stream</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => setToolDone(value => !value)}
        >
          <Text>Update tool</Text>
        </Pressable>
      </View>
      <MessageList ref={list} messages={messages} autoExpandTools />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'flex-start' },
  caption: { marginTop: 64, fontSize: 11 },
});
