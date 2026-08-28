export type DeepSeekModelId =
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash-vision-exp';

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
  readonly model: DeepSeekModelId;
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
  readonly turnId: string;
  readonly attemptId: string;
  readonly roundId: string;
  readonly roundIndex: number;
  readonly model: DeepSeekModelId;
  readonly thinkingMode: DeepSeekThinkingMode;
  readonly visibleHistory: readonly CompletionVisibleMessageV2[];
  readonly roundTranscript: readonly CompletionRoundTranscriptMessageV2[];
  readonly tools: readonly CompletionProviderToolV2[];
  readonly projectContext: null;
};

export type CompletionFinishReasonV2 =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter';

export type CompleteRoundV2Result = {
  readonly schema_version: 2;
  readonly turn_id: string;
  readonly attempt_id: string;
  readonly round_id: string;
  readonly round_index: number;
  readonly provider_request_id: string;
  readonly provider_response_id: string;
  readonly requested_model: DeepSeekModelId;
  readonly model: DeepSeekModelId;
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
