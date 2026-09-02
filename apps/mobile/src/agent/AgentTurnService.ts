import type { AgentTraceRow } from './AgentLoop';
import type { AgentInteractionController } from './AgentInteractionController';
import type { SessionEventJournal } from './SessionEvents';
import type { WorkspaceRootRefV1 } from '../native/WorkspaceRoot';

/**
 * Disabled compatibility surface for the pre-durability agent driver.
 *
 * The durable completion controller is the only production agent authority.
 * Keeping this adapter inert prevents a stale caller from starting a second
 * provider/tool loop outside that authority.
 *
 * @deprecated Do not use for production agent execution.
 */

export const LEGACY_AGENT_TURN_DISABLED_CODE =
  'E_AGENT_TURN_DISABLED' as const;

export type AgentToolPermission =
  | 'read-only'
  | 'workspace-write'
  | 'read-write';

export type AgentModelCalls = (args: {
  model: string;
  thinkingMode: string;
  requestId: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: readonly unknown[];
}) => Promise<{
  text: string;
  finish_reason: string;
  tool_calls: ReadonlyArray<{
    id: string;
    name: string;
    arguments: string;
  }>;
}>;

export type AgentTurnServiceDeps = {
  journal: SessionEventJournal;
  interactions: AgentInteractionController;
  modelCalls: AgentModelCalls;
  getGitHttpsProxyUrl: () => string | null;
  createApprovalId: () => string;
  createQuestionId: () => string;
  approvalTimeoutMs?: number;
  questionTimeoutMs?: number;
};

export type AgentTurnStartInput = {
  root: WorkspaceRootRefV1;
  model: string;
  thinkingMode: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  tools?: readonly unknown[];
  requestId?: string;
  toolPermission?: AgentToolPermission;
  mode?: AgentToolPermission;
  access?: AgentToolPermission;
  readOnly?: boolean;
  operationId?: string;
  credentialReference?: string | null;
};

export type AgentTurnResult = {
  status: 'done' | 'cancelled' | 'failed';
  finalText: string | null;
  traces: readonly AgentTraceRow[];
  exhausted: boolean;
  failure?: { code: string };
};

export type AgentTurnService = {
  start(input: AgentTurnStartInput): Promise<AgentTurnResult>;
  /** Settles any interaction wait left by a retired caller. */
  cancel(): void;
  isRunning(): boolean;
};

const NO_TRACES: readonly AgentTraceRow[] = Object.freeze([]);
const DISABLED_RESULT: AgentTurnResult = Object.freeze({
  status: 'failed' as const,
  finalText: null,
  traces: NO_TRACES,
  exhausted: false,
  failure: Object.freeze({ code: LEGACY_AGENT_TURN_DISABLED_CODE }),
});

export function createAgentTurnService(
  deps: AgentTurnServiceDeps,
): AgentTurnService {
  return {
    isRunning: () => false,
    cancel: () => {
      deps.interactions.cancelPending();
    },
    start: async _input => DISABLED_RESULT,
  };
}
