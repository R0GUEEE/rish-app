import type { AgentConversationGrantV2, PersistedAgentAttemptJournalV3, PersistedAgentCallJournalV3 } from '../state/types';
import { agentToolGrantFamily } from './tool-registry';

type GrantCall = Pick<PersistedAgentCallJournalV3, 'name' | 'access' | 'approval_decision' | 'approval_token' | 'approval_reference' | 'idempotency_key' | 'native_row_revision'>;
type GrantJournal = Pick<PersistedAgentAttemptJournalV3, 'root' | 'policy' | 'tool_registry_version' | 'frozen_grant_ids'>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA = /^[0-9a-f]{64}$/u;

/** Structural classification only. Authority additionally requires both proofs below. */
export function isConversationGrantBoundCall(call: GrantCall): boolean {
  return call.access === 'conversation_confirm' && call.approval_decision === 'allow_conversation' &&
    call.approval_token === null && typeof call.approval_reference === 'string' && UUID.test(call.approval_reference) &&
    typeof call.idempotency_key === 'string' && SHA.test(call.idempotency_key) &&
    Number.isSafeInteger(call.native_row_revision) && call.native_row_revision !== null && call.native_row_revision >= 1 &&
    agentToolGrantFamily(call.name) !== null;
}
export function hasFrozenConversationGrant(call: GrantCall, journal: GrantJournal): boolean {
  if (call.approval_token !== null || call.approval_decision !== 'allow_conversation') return true;
  const family = agentToolGrantFamily(call.name);
  return isConversationGrantBoundCall(call) && family !== null && journal.root.capabilities.includes(family) &&
    journal.frozen_grant_ids.includes(call.approval_reference!);
}
/** Candidate freeze list; callers must verify each reference against live grants. */
export function conversationGrantIdsForBatch(journal: GrantJournal, calls: readonly GrantCall[]): string[] {
  const ids = [...journal.frozen_grant_ids];
  for (const call of calls) if (isConversationGrantBoundCall(call) && !ids.includes(call.approval_reference!)) ids.push(call.approval_reference!);
  return ids;
}
/** Used at Store commit and session hydration, where the current live grants exist. */
export function hasLiveConversationGrant(call: GrantCall, journal: GrantJournal,
  conversationId: string, grants: readonly AgentConversationGrantV2[]): boolean {
  if (call.approval_token !== null || call.approval_decision !== 'allow_conversation') return true;
  if (!hasFrozenConversationGrant(call, journal)) return false;
  const grant = grants.find(candidate => candidate.grant_id === call.approval_reference);
  return grant !== undefined && grant.schema_version === 2 && grant.conversation_id === conversationId &&
    grant.workspace_id === journal.root.workspace_id && grant.project_id === journal.root.project_id &&
    grant.binding_revision === journal.root.workspace_binding_revision &&
    grant.root_fingerprint_sha256 === journal.root.root_fingerprint_sha256 &&
    grant.registry_version === journal.tool_registry_version && grant.policy_version === journal.policy.policy_version &&
    grant.tool_family === agentToolGrantFamily(call.name);
}
