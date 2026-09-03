import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import type { ApprovalRequestSpec } from '../agent/AgentApprovals';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from '../agent/AgentApprovals';
import {
  AgentPolicySheet,
  AGENT_POLICY_DEFAULT_BUDGET,
} from '../components/AgentPolicySheet';
import { ApprovalComposer } from '../components/ApprovalComposer';
import { useAppPresentation } from '../presentation/AppPresentation';
import type { AgentConversationGrantV2 } from '../state';

/**
 * Launch-environment gated UI preview (DSH_UI_PREVIEW). It renders the
 * approval composer and the Agent policy panel with fixed display data so
 * simulator screenshots can be taken without a provider round. Nothing here
 * touches the store, native runtime, or persistence: every decision is
 * discarded, so the surface can never issue an approval or revoke a grant.
 */

export const UI_PREVIEW_KINDS = [
  'approval-single',
  'approval-batch',
  'policy-panel',
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
  const { colors } = useAppPresentation();
  const [decided, setDecided] = useState<string | null>(null);
  return (
    <View
      style={[styles.root, { backgroundColor: colors.background }]}
      testID="ui-preview-root"
    >
      <Text style={[styles.caption, { color: colors.muted }]} testID="ui-preview-caption">
        {decided ?? `preview:${kind}`}
      </Text>
      {kind === 'policy-panel' ? (
        <AgentPolicySheet
          budget={AGENT_POLICY_DEFAULT_BUDGET}
          capabilities={['file_read', 'file_write', 'git_status', 'git_commit', 'git_push']}
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
          requests={kind === 'approval-batch' ? [WRITE_REQUEST, COMMIT_REQUEST] : [WRITE_REQUEST]}
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

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'flex-start' },
  caption: { marginTop: 64, fontSize: 11 },
});
