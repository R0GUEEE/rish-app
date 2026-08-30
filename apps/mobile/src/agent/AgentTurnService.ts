import type { AgentTurnResult, RunAgentTurnDeps } from './runAgentTurn';
import { runAgentTurn } from './runAgentTurn';
import { executeAgentTool } from './AgentTools';
import type { SessionEventJournal } from './SessionEvents';
import type { AgentInteractionController } from './AgentInteractionController';

/**
 * Production binding of the agent turn: real native tool execution, real
 * model transport (injected), the user-decision broker, and the shared
 * session-event journal. The service is the single place where the
 * runAgentTurn driver meets the durable trajectory, so every approval and
 * question row from a real turn lands in the same persisted log the
 * completion controller writes.
 */

/** Canonical agent tool registry (the six bounded applets + ask_user). */
export const AGENT_TOOL_DEFINITIONS: readonly Record<string, unknown>[] = [
  {
    name: 'list_dir',
    description: 'List entries in a project repo directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: [],
    },
  },
  {
    name: 'read_file',
    description: 'Read a text file from the project repo.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or replace a text file in the project repo.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'git_status',
    description: 'Show the working-tree status of the bound project.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and commit them in the bound project.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description: 'Push the bound project to its configured remote.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a structured question. Options mode offers up to 8 choices; free_text mode accepts a short typed answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        input_mode: { type: 'string', enum: ['options', 'free_text'] },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['id', 'label'],
          },
        },
        required: { type: 'boolean' },
      },
      required: ['question', 'input_mode'],
    },
  },
];

export type AgentTurnServiceDeps = {
  journal: SessionEventJournal;
  interactions: AgentInteractionController;
  modelCalls: RunAgentTurnDeps['modelCalls'];
  createApprovalId: () => string;
  createQuestionId: () => string;
  approvalTimeoutMs?: number;
  questionTimeoutMs?: number;
};

export type AgentTurnStartInput = {
  projectId: string;
  model: string;
  thinkingMode: string;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  tools?: readonly unknown[];
  requestId?: string;
};

export type AgentTurnService = {
  start(input: AgentTurnStartInput): Promise<AgentTurnResult>;
  /** Settles any open approval/question wait and stops the turn loop. */
  cancel(): void;
  isRunning(): boolean;
};

export function createAgentTurnService(
  deps: AgentTurnServiceDeps,
): AgentTurnService {
  let cancelled = false;
  let running = false;
  return {
    isRunning: () => running,
    cancel: () => {
      cancelled = true;
      deps.interactions.cancelPending();
    },
    start: async input => {
      if (running) {
        return {
          status: 'failed' as const,
          finalText: null,
          traces: [],
          exhausted: false,
          failure: { code: 'E_AGENT_TURN_BUSY' },
        };
      }
      cancelled = false;
      running = true;
      try {
        return await runAgentTurn({
          projectId: input.projectId,
          model: input.model,
          thinkingMode: input.thinkingMode,
          history: input.history,
          tools: input.tools ?? AGENT_TOOL_DEFINITIONS,
          ...(input.requestId !== undefined
            ? { requestId: input.requestId }
            : {}),
          ...(deps.approvalTimeoutMs !== undefined
            ? { approvalTimeoutMs: deps.approvalTimeoutMs }
            : {}),
          ...(deps.questionTimeoutMs !== undefined
            ? { questionTimeoutMs: deps.questionTimeoutMs }
            : {}),
          deps: {
            modelCalls: deps.modelCalls,
            executeTool: (context, name, argumentsJson) =>
              executeAgentTool(context, name, argumentsJson),
            requestApproval: spec => deps.interactions.requestApproval(spec),
            askQuestion: spec => deps.interactions.askQuestion(spec),
            createApprovalId: deps.createApprovalId,
            createQuestionId: deps.createQuestionId,
            emitSessionEvent: event => {
              deps.journal.append(event);
            },
            shouldCancel: () => cancelled,
          },
        });
      } finally {
        running = false;
      }
    },
  };
}