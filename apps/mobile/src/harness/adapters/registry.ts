import type {
  CompleteRoundV2Request,
  CompleteRoundV2Result,
  CompleteRoundV3Request,
  CompleteRoundV3Result,
} from '../../completion/types';
import type {
  ClearCredentialResult,
  CredentialPromptLocale,
  CredentialPromptResult,
  CredentialStatus,
} from '../../native/LocalRuntime';
import type { HarnessId } from '../types';
import { ClaudeCodeHarnessAdapter } from './ClaudeCodeHarnessAdapter';
import { CodexHarnessAdapter } from './CodexHarnessAdapter';
import { DshHarnessAdapter } from './DshHarnessAdapter';
import { GlmHarnessAdapter } from './GlmHarnessAdapter';

/**
 * The shared surface every builtin native-adapter Harness exposes. The
 * generic Rish runtime (sessions, workspaces, agent loop, approvals, ledger,
 * proof) is outside this seam; an adapter only owns its credential slot and
 * provider round transport.
 */
export type HarnessAdapter = {
  isAvailable(): boolean;
  credentialStatus(): Promise<CredentialStatus>;
  presentCredentialPrompt(
    locale: CredentialPromptLocale,
  ): Promise<CredentialPromptResult>;
  clearCredential(): Promise<ClearCredentialResult>;
  completeRoundV2(
    request: CompleteRoundV2Request,
  ): Promise<CompleteRoundV2Result>;
  completeRoundV3(
    request: CompleteRoundV3Request,
  ): Promise<CompleteRoundV3Result>;
  cancelRoundV2(roundId: string): Promise<unknown>;
  cancelRoundV3(roundId: string): Promise<unknown>;
};

export const BUILTIN_HARNESS_ADAPTERS: Record<HarnessId, HarnessAdapter> = {
  dsh: DshHarnessAdapter,
  'claude-code': ClaudeCodeHarnessAdapter,
  codex: CodexHarnessAdapter,
  glm: GlmHarnessAdapter,
};

export function getHarnessAdapter(harnessId: HarnessId): HarnessAdapter {
  return BUILTIN_HARNESS_ADAPTERS[harnessId];
}
