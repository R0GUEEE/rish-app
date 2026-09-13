import type { ChatStore, CreateConversationOptions } from './store';
import type { Conversation } from './types';

/** One launch-only selection, after hydration/recovery and before navigation opens. */
export function createColdStartConversationSelection() {
  let applied = false;
  return (store: ChatStore, options: CreateConversationOptions): boolean => {
    if (applied) return false;
    applied = true;
    const state = store.getState();
    // Recovery owns navigation until its persisted transition is resolved.
    if (state.projectContextDestructiveTransition !== null) return false;
    const reusable = (conversation: Conversation) =>
      conversation.messages.length === 0 &&
      conversation.turns.length === 0 &&
      conversation.attempts.length === 0 &&
      conversation.projectId === null &&
      conversation.workspaceId === null &&
      conversation.workspaceBinding == null &&
      conversation.runtimeContextId === null &&
      conversation.projectContext === null &&
      conversation.titleSource === 'auto' &&
      (conversation.agentGrants?.length ?? 0) === 0 &&
      (conversation.agent_grants?.length ?? 0) === 0 &&
      conversation.modelId === options.modelId &&
      conversation.thinkingMode === options.thinkingMode;
    const selected = state.selectedConversationId === null
      ? undefined : state.conversations[state.selectedConversationId];
    if (selected !== undefined && reusable(selected)) return false;
    const blank = Object.values(state.conversations).find(reusable);
    if (blank !== undefined) store.selectConversation(blank.id);
    else store.createConversation(options);
    return store.getState() !== state;
  };
}
