import type { HarnessId, HarnessModelId, ProviderId } from '../harness/types';

export type {
  DeepSeekModelId,
  ClaudeModelId,
  CodexModelId,
  HarnessModelId,
} from '../harness/types';

export type DeepSeekThinkingMode = 'off' | 'high' | 'max';

export type CompletionAttachmentReference = {
  readonly schema_version: 1;
  readonly id: string;
  readonly kind: 'image' | 'text' | 'pdf';
  readonly name: string;
  readonly mime_type: string;
  readonly size: number;
};

export type CompletionMessage = {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly attachments?: readonly CompletionAttachmentReference[];
};

/** Schema-1 flat tool shape retained for the existing AgentLoop v0 path. */
export type CompletionToolDefinitionV2 = {
  readonly name: string;
  readonly description?: string;
  readonly parameters?: Readonly<Record<string, unknown>>;
};

export type CompleteV2Request = {
  readonly model: HarnessModelId;
  readonly requestId: string;
  readonly thinkingMode: DeepSeekThinkingMode;
  readonly history: readonly CompletionMessage[];
  readonly tools?: readonly CompletionToolDefinitionV2[];
};

export type CompleteV2ToolCall = {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
};

export type CompleteV2Result = {
  readonly schema_version: 1;
  readonly text: string;
  readonly tool_calls: readonly CompleteV2ToolCall[];
  readonly finish_reason: string;
  readonly model: string;
  readonly request_id: string;
  readonly latency_ms: number;
  readonly reasoning: string;
  readonly thinking_mode: DeepSeekThinkingMode;
};

export type CompletionVisibleMessageV2 = {
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly attachments: readonly CompletionAttachmentReference[];
};

export type CompletionProviderToolV2 = {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Readonly<Record<string, unknown>>;
  };
};

export type CompletionTranscriptToolCallV2 = {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
};

export type CompletionTranscriptAssistantV2 = {
  readonly role: 'assistant';
  readonly content: string;
  readonly reasoning_content: string;
  readonly tool_calls: readonly CompletionTranscriptToolCallV2[];
};

export type CompletionTranscriptToolV2 = {
  readonly role: 'tool';
  readonly tool_call_id: string;
  readonly content: string;
};

export type CompletionRoundTranscriptMessageV2 =
  | CompletionTranscriptAssistantV2
  | CompletionTranscriptToolV2;

export type CompleteRoundV2Request = {
  readonly schemaVersion: 2;
  /** Harness that owns this round; the adapter routes the native provider by it. */
  readonly harnessId: HarnessId;
  readonly turnId: string;
  readonly attemptId: string;
  readonly roundId: string;
  readonly roundIndex: number;
  readonly model: HarnessModelId;
  readonly thinkingMode: DeepSeekThinkingMode;
  readonly visibleHistory: readonly CompletionVisibleMessageV2[];
  readonly roundTranscript: readonly CompletionRoundTranscriptMessageV2[];
  readonly tools: readonly CompletionProviderToolV2[];
  readonly projectContext: null;
};

export type CompletionProjectContextV3 = {
  readonly schemaVersion: 1;
  readonly snapshotId: string;
  readonly consentReceiptId: string;
  readonly conversationId: string;
  readonly projectId: string;
  readonly provider: ProviderId;
  readonly policy: 'chat-read-v1';
};

export type CompleteRoundV3Request = Omit<
  CompleteRoundV2Request,
  'schemaVersion' | 'projectContext'
> & {
  readonly schemaVersion: 3;
  readonly projectContext: CompletionProjectContextV3;
};

export type CompletionFinishReasonV2 =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter';

export type CompleteRoundV2Result = {
  readonly schema_version: 2;
  /**
   * Which built-in Harness produced this model response. Optional on the
   * wire so pre-adapter records hydrate as DSH; the validator normalizes
   * and always returns a value.
   */
  readonly harness_id: HarnessId;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly round_id: string;
  readonly round_index: number;
  readonly provider_request_id: string;
  readonly provider_response_id: string;
  readonly requested_model: HarnessModelId;
  readonly model: HarnessModelId;
  readonly thinking_mode: DeepSeekThinkingMode;
  readonly text: string;
  readonly reasoning: string;
  readonly tool_calls: readonly CompleteV2ToolCall[];
  readonly finish_reason: CompletionFinishReasonV2;
  readonly latency_ms: number;
  readonly visible_history_sha256: string;
  readonly model_input_sha256: string;
  readonly request_body_sha256: string;
  readonly project_context_receipt: null;
};

export type CompletionProjectContextReceiptV3 = {
  readonly schema_version: 1;
  readonly snapshot_id: string;
  readonly snapshot_sha256: string;
  readonly source_fingerprint: string;
  readonly context_bytes: number;
  readonly verified_at: string;
};

export type CompleteRoundV3Result = Omit<
  CompleteRoundV2Result,
  'schema_version' | 'project_context_receipt'
> & {
  readonly schema_version: 3;
  readonly project_context_receipt: CompletionProjectContextReceiptV3;
};
