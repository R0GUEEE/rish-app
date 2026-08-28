import {
  LocalRuntime,
  type CompleteRoundV2Request,
  type CompletionToolDefinitionV2,
  type CompletionMessage,
  type CredentialPromptLocale,
  type DeepSeekModelId,
  type DeepSeekThinkingMode,
} from '../../native/LocalRuntime';
import { sanitizeCompletionError } from '../../completion/validation';
import { DSH_HARNESS } from '../builtins';

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

export const DshHarnessAdapter = {
  manifest: DSH_HARNESS,
  isAvailable: () => LocalRuntime.isAvailable(),
  credentialStatus: () => LocalRuntime.credentialStatus(),
  presentCredentialPrompt: (locale: CredentialPromptLocale) =>
    LocalRuntime.presentCredentialPrompt(locale),
  clearCredential: () => LocalRuntime.clearCredential(),
  complete: (
    model: DeepSeekModelId,
    history: CompletionMessage[],
    requestId: string,
    thinkingMode: DeepSeekThinkingMode,
  ) => LocalRuntime.complete(model, history, requestId, thinkingMode),
  cancel: (requestId: string) => LocalRuntime.cancelCompletion(requestId),
  completeV2: (
    model: DeepSeekModelId,
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
    }),
  completeRoundV2: (request: CompleteRoundV2Request) =>
    LocalRuntime.completeV2(request),
  cancelRoundV2: async (roundId: string) => {
    try {
      return await LocalRuntime.cancelCompletion(roundId);
    } catch (error) {
      throw sanitizeCompletionError(error);
    }
  },
};
