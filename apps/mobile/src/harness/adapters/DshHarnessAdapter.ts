import {
  LocalRuntime,
  type CompletionMessage,
  type CredentialPromptLocale,
  type DeepSeekModelId,
  type DeepSeekThinkingMode,
} from '../../native/LocalRuntime';
import { DSH_HARNESS } from '../builtins';

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
};
