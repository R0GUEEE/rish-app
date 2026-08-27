import { NativeModules } from 'react-native';

export type RuntimeProofChecks = {
  credential_in_keychain: boolean;
  model_response_received: boolean;
  session_restored_after_restart: boolean;
  rish_applet_executed: boolean;
};

export type RuntimeProof = {
  schema_version: 2;
  product: 'rish';
  active_harness: string;
  mode: 'local_substrate';
  platform: 'ios_simulator' | 'ios_device';
  bundle_id: string;
  runtime_id: string;
  launch_instance_id: string;
  process_id: number;
  generated_at: string;
  proof_run_id?: string;
  container_root: string;
  session_store: string;
  model_transport: 'url_session';
  rish_backend: 'portable_applet';
  rish_protocol_version: number;
  rish_probe: {
    protocol_version?: number;
    program?: string;
    exit_code?: number;
    path_kind?: string;
    path_name?: string;
    stdout?: string;
  };
  model_response?: {
    proof_run_id: string;
    launch_instance_id: string;
    received_at: string;
    http_status: number;
    model: string;
    requested_model?: DeepSeekModelId;
    request_id?: string;
    request_history_sha256?: string;
    request_message_count?: number;
    assistant_text_sha256?: string;
    reasoning_text_sha256?: string;
    thinking_mode?: DeepSeekThinkingMode;
    finish_reason: string;
    response_id: string;
  };
  session_persisted?: {
    proof_run_id: string;
    request_id?: string;
    request_history_sha256?: string;
    assistant_text_sha256?: string;
    reasoning_text_sha256?: string;
    writer_launch_instance_id: string;
    sha256: string;
    message_count: number;
    persisted_at: string;
  };
  session_restore?: {
    proof_run_id: string;
    request_id?: string;
    writer_launch_instance_id: string;
    restore_launch_instance_id: string;
    sha256: string;
    message_count: number;
    restored_at: string;
  };
  mac_dsh_port_3180_reachable: boolean;
  checks: RuntimeProofChecks;
};

export type BootstrapResult = {
  proof: RuntimeProof;
  rish: Record<string, unknown>;
};

export type DeepSeekModelId =
  | 'deepseek-v4-flash'
  | 'deepseek-v4-pro'
  | 'deepseek-v4-flash-vision-exp';
export type DeepSeekThinkingMode = 'off' | 'high' | 'max';

export type CompletionAttachmentReference = {
  schema_version: 1;
  id: string;
  kind: 'image' | 'text' | 'pdf';
  name: string;
  mime_type: string;
  size: number;
};

export type CompletionMessage = {
  role: 'user' | 'assistant';
  content: string;
  attachments?: CompletionAttachmentReference[];
};

export type CredentialStatus = {
  status: 'configured' | 'missing';
};

export type CredentialPromptLocale = 'zh-CN' | 'en-US';

export type CredentialPromptResult = {
  status: 'configured' | 'cancelled';
};

export type ClearCredentialResult = {
  status: 'cleared';
};

export type CancelCompletionResult = {
  status: 'cancelled' | 'idle' | 'stale';
};

export type CompletionResult = {
  text: string;
  model: string;
  request_id: string;
  latency_ms: number;
  reasoning: string;
  thinking_mode: DeepSeekThinkingMode;
};
export type CompletionToolDefinitionV2 = {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type CompleteV2Request = {
  model: DeepSeekModelId;
  requestId: string;
  thinkingMode: DeepSeekThinkingMode;
  history: readonly CompletionMessage[];
  tools?: readonly CompletionToolDefinitionV2[];
};

export type CompleteV2ToolCall = {
  id: string;
  name: string;
  arguments: string;
};

export type CompleteV2Result = {
  schema_version: 1;
  text: string;
  tool_calls: readonly CompleteV2ToolCall[];
  finish_reason: string;
  model: string;
  request_id: string;
  latency_ms: number;
  reasoning: string;
  thinking_mode: DeepSeekThinkingMode;
};

type NativeLocalRuntime = {
  bootstrap(): Promise<BootstrapResult>;
  credentialStatus(): Promise<CredentialStatus>;
  presentCredentialPrompt(
    locale: CredentialPromptLocale,
  ): Promise<CredentialPromptResult>;
  clearCredential(): Promise<ClearCredentialResult>;
  complete(
    model: DeepSeekModelId,
    history: CompletionMessage[],
    requestId: string,
    thinkingMode: DeepSeekThinkingMode,
  ): Promise<CompletionResult>;
  cancelCompletion(requestId: string): Promise<CancelCompletionResult>;
  persistSession(json: string): Promise<boolean>;
  loadSession(): Promise<string | null>;
  completeV2?(envelopeJSON: string): Promise<Record<string, unknown>>;
};

const native = NativeModules.LocalRuntime as unknown;

function hasNativeCapabilities(value: unknown): value is NativeLocalRuntime {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<Record<keyof NativeLocalRuntime, unknown>>;
  return (
    typeof candidate.bootstrap === 'function' &&
    typeof candidate.credentialStatus === 'function' &&
    typeof candidate.presentCredentialPrompt === 'function' &&
    typeof candidate.clearCredential === 'function' &&
    typeof candidate.complete === 'function' &&
    typeof candidate.cancelCompletion === 'function' &&
    typeof candidate.persistSession === 'function' &&
    typeof candidate.loadSession === 'function'
  );
}

function required(): NativeLocalRuntime {
  if (!hasNativeCapabilities(native)) {
    throw new Error('LocalRuntime native module is not linked');
  }
  return native;
}

function safeCredentialPromptLocale(
  locale: CredentialPromptLocale,
): CredentialPromptLocale {
  return locale === 'zh-CN' || locale === 'en-US' ? locale : 'en-US';
}

export function createCompletionRequestId(): string {
  const bytes = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256),
  );
  bytes[6] = ((bytes[6] ?? 0) % 16) + 64;
  bytes[8] = ((bytes[8] ?? 0) % 64) + 128;
  const hex = bytes.map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const LocalRuntime = {
  isAvailable: () => hasNativeCapabilities(native),
  createCompletionRequestId,
  bootstrap: () => required().bootstrap(),
  credentialStatus: () => required().credentialStatus(),
  presentCredentialPrompt: (locale: CredentialPromptLocale) =>
    required().presentCredentialPrompt(safeCredentialPromptLocale(locale)),
  clearCredential: () => required().clearCredential(),
  complete: (
    model: DeepSeekModelId,
    history: CompletionMessage[],
    requestId = createCompletionRequestId(),
    thinkingMode: DeepSeekThinkingMode = 'off',
  ) => required().complete(model, history, requestId, thinkingMode),
  cancelCompletion: (requestId: string) =>
    required().cancelCompletion(requestId),
  isCompletionV2Available: () => {
    const module = NativeModules.LocalRuntime as
      | Partial<NativeLocalRuntime>
      | undefined;
    return typeof module?.completeV2 === 'function';
  },
  completeV2: async (
    request: CompleteV2Request,
  ): Promise<CompleteV2Result> => {
    const nativeModule = required() as NativeLocalRuntime & {
      completeV2?: (envelopeJSON: string) => Promise<Record<string, unknown>>;
    };
    if (typeof nativeModule.completeV2 !== 'function') {
      throw new Error('completionV2 native method is not linked');
    }
    const envelope = JSON.stringify({
      schema_version: 1,
      model: request.model,
      request_id: request.requestId,
      thinking_mode: request.thinkingMode,
      history: request.history,
      tools: request.tools ?? [],
    });
    const raw = await nativeModule.completeV2(envelope);
    return raw as unknown as CompleteV2Result;
  },
  persistSession: (json: string) => required().persistSession(json),
  loadSession: () => required().loadSession(),
};
