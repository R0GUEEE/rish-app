import {
  LocalRuntime,
  type CompleteRoundV2Request,
  type CompleteRoundV3Request,
  type CompletionMessage,
  type CompletionToolDefinitionV2,
  type CredentialPromptLocale,
  type DeepSeekThinkingMode,
  type HarnessModelId,
} from '../../native/LocalRuntime';
import { sanitizeCompletionError } from '../../completion/validation';
import { CLAUDE_CODE_HARNESS } from '../builtins';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function legacyToolDefinition(value: unknown): CompletionToolDefinitionV2 {
  if (!isRecord(value) || typeof value.name !== 'string') {
    throw new Error('E_COMPLETION_TOOLS');
  }
  if (value.description !== undefined && typeof value.description !== 'string') {
    throw new Error('E_COMPLETION_TOOLS');
  }
  if (value.parameters !== undefined && !isRecord(value.parameters)) {
    throw new Error('E_COMPLETION_TOOLS');
  }
  return {
    name: value.name,
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
    ...(isRecord(value.parameters) ? { parameters: value.parameters } : {}),
  };
}

/**
 * Claude Code Harness adapter. Owns the Anthropic credential slot and the
 * provider model catalog; the generic Rish runtime still owns sessions,
 * workspaces, the agent loop, approvals, the ledger, and proof. Tool
 * semantics (write_file / read_file / list_dir / git_commit) come from the
 * same tool registry as DSH, so approvals and replay protection are shared.
 */
export const ClaudeCodeHarnessAdapter = {
  manifest: CLAUDE_CODE_HARNESS,
  isAvailable: () => LocalRuntime.isAvailable(),
  credentialStatus: () =>
    LocalRuntime.credentialStatusForSlot('ANTHROPIC_API_KEY'),
  presentCredentialPrompt: (locale: CredentialPromptLocale) =>
    LocalRuntime.presentCredentialPromptForSlot('ANTHROPIC_API_KEY', locale),
  clearCredential: () =>
    LocalRuntime.clearCredentialForSlot('ANTHROPIC_API_KEY'),
  complete: (
    model: HarnessModelId,
    history: CompletionMessage[],
    requestId: string,
    thinkingMode: DeepSeekThinkingMode,
  ) => LocalRuntime.completeV2({
    model,
    requestId,
    thinkingMode,
    history,
    tools: [],
  }, 'claude-code'),
  cancel: (requestId: string) => LocalRuntime.cancelCompletion(requestId),
  completeV2: (
    model: HarnessModelId,
    history: readonly CompletionMessage[],
    requestId: string,
    thinkingMode: DeepSeekThinkingMode,
    tools: readonly unknown[],
  ) =>
    LocalRuntime.completeV2({
      model,
      requestId,
      thinkingMode,
      history,
      tools: tools.map(legacyToolDefinition),
    }, 'claude-code'),
  completeRoundV2: (request: CompleteRoundV2Request) =>
    LocalRuntime.completeV2(request, request.harnessId),
  completeRoundV3: (request: CompleteRoundV3Request) =>
    LocalRuntime.completeV2(request, request.harnessId),
  cancelRoundV2: async (roundId: string) => {
    try {
      return await LocalRuntime.cancelCompletion(roundId);
    } catch (error) {
      throw sanitizeCompletionError(error);
    }
  },
  cancelRoundV3: async (roundId: string) => {
    try {
      return await LocalRuntime.cancelCompletion(roundId);
    } catch (error) {
      throw sanitizeCompletionError(error);
    }
  },
};