import { NativeModules } from 'react-native';

import type { CredentialSlot, HarnessId } from '../harness/types';
import {
  CompletionBridgeError,
  encodeCompleteV2Request,
  encodeCompleteV3Request,
  sanitizeCompletionError,
  validateCompleteV2Result,
  validateCompleteV3Result,
  validateLegacyCompleteV2Result,
} from '../completion/validation';
import type {
  CompleteRoundV2Request,
  CompleteRoundV2Result,
  CompleteRoundV3Request,
  CompleteRoundV3Result,
  CompleteV2Request,
  CompleteV2Result,
  CompletionMessage,
  HarnessModelId,
  DeepSeekModelId,
  DeepSeekThinkingMode,
} from '../completion/types';

export type {
  CompleteRoundV2Request,
  CompleteRoundV2Result,
  CompleteRoundV3Request,
  CompleteRoundV3Result,
  CompleteV2Request,
  CompleteV2Result,
  CompletionAttachmentReference,
  CompletionMessage,
  CompletionToolDefinitionV2,
  CompleteV2ToolCall,
  DeepSeekModelId,
  DeepSeekThinkingMode,
  HarnessModelId,
} from '../completion/types';

export type RuntimeProofChecks = {
  credential_in_keychain: boolean;
  credential_in_secure_store?: boolean;
  model_response_received: boolean;
  session_restored_after_restart: boolean;
  rish_applet_executed: boolean;
  // The workspace tools -- list_dir, read_file, write_file -- run without the
  // guest applet. A platform that has one and not the other says so here.
  workspace_tools_available?: boolean;
};

export type RuntimeProof = {
  schema_version: 2;
  product: 'rish';
  active_harness: string;
  mode: 'local_substrate';
  platform:
    | 'ios_simulator'
    | 'ios_device'
    | 'android_emulator'
    | 'android_device';
  bundle_id: string;
  runtime_id: string;
  launch_instance_id: string;
  process_id: number;
  generated_at: string;
  proof_run_id?: string;
  container_root: string;
  session_store: string;
  model_transport: 'url_session' | 'okhttp';
  rish_backend: 'portable_applet' | 'unavailable';
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
  agent_tool_trace?: {
    recorded_at: string;
    entry_count: number;
    entries: Array<{
      name: string;
      arguments_sha256: string;
      outcome: 'ok' | 'failed' | 'denied';
      recorded_at: string;
    }>;
  };
  model_transition_trace?: {
    recorded_at: string;
    entry_count: number;
    entries: Array<{
      conversation_id_sha256: string;
      from_model: DeepSeekModelId;
      to_model: DeepSeekModelId;
      source: ModelTransitionSource;
      request_epoch: number;
      request_state: 'idle' | 'sending';
      attachment_busy: boolean;
      draft_image_count: number;
      history_image_count: number;
      recorded_at: string;
    }>;
  };
  mac_dsh_port_3180_reachable: boolean | null;
  checks: RuntimeProofChecks;
};

export type BootstrapResult = {
  proof: RuntimeProof;
  rish: Record<string, unknown>;
};

export type CredentialStatus = {
  status: 'configured' | 'missing';
};

export type CredentialPromptLocale = 'zh-CN' | 'en-US';

export type CredentialPromptResult = {
  status: 'configured' | 'cancelled';
};

export type { CredentialSlot } from '../harness/types';

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
export type AgentTraceProofEntry = {
  name: string;
  arguments_sha256: string;
  outcome: 'ok' | 'failed' | 'denied';
};

export type ModelTransitionSource =
  | 'composer_picker'
  | 'settings_picker'
  | 'send_image_guard';

export type ModelTransitionProofEntry = {
  conversation_id: string;
  from_model: HarnessModelId;
  to_model: HarnessModelId;
  source: ModelTransitionSource;
  request_epoch: number;
  request_state: 'idle' | 'sending';
  attachment_busy: boolean;
  draft_image_count: number;
  history_image_count: number;
};

type NativeLocalRuntime = {
  bootstrap(): Promise<BootstrapResult>;
  bootstrapForHarness?(harnessId: HarnessId): Promise<BootstrapResult>;
  credentialStatus(): Promise<CredentialStatus>;
  presentCredentialPrompt(
    locale: CredentialPromptLocale,
  ): Promise<CredentialPromptResult>;
  clearCredential(): Promise<ClearCredentialResult>;
  credentialStatusForSlot?(slot: CredentialSlot): Promise<CredentialStatus>;
  presentCredentialPromptForSlot?(
    slot: CredentialSlot,
    locale: CredentialPromptLocale,
  ): Promise<CredentialPromptResult>;
  clearCredentialForSlot?(slot: CredentialSlot): Promise<ClearCredentialResult>;
  complete(
    model: DeepSeekModelId,
    history: CompletionMessage[],
    requestId: string,
    thinkingMode: DeepSeekThinkingMode,
  ): Promise<CompletionResult>;
  cancelCompletion(requestId: string): Promise<CancelCompletionResult>;
  persistSession(json: string): Promise<boolean>;
  loadSession(): Promise<string | null>;
  completeV2?(envelopeJSON: string): Promise<unknown>;
  completeV2Stream?(envelopeJSON: string): Promise<unknown>;
  recordAgentTrace?(
    entries: readonly AgentTraceProofEntry[],
  ): Promise<{ recorded: number }>;
  recordModelTransition?(
    entry: ModelTransitionProofEntry,
  ): Promise<{ recorded: number }>;
};

const native: unknown = NativeModules.LocalRuntime;

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

function isStrictRoundRequest(
  request: CompleteV2Request | CompleteRoundV2Request | CompleteRoundV3Request,
): request is CompleteRoundV2Request | CompleteRoundV3Request {
  return 'schemaVersion' in request;
}

function classifyCompleteV2Request(
  request: CompleteV2Request | CompleteRoundV2Request | CompleteRoundV3Request,
):
  | { readonly kind: 'legacy'; readonly request: CompleteV2Request }
  | { readonly kind: 'schema2'; readonly request: CompleteRoundV2Request }
  | { readonly kind: 'schema3'; readonly request: CompleteRoundV3Request } {
  if (!isStrictRoundRequest(request)) return { kind: 'legacy', request };
  return request.schemaVersion === 3
    ? { kind: 'schema3', request }
    : { kind: 'schema2', request };
}

async function completeV2(
  request: CompleteV2Request,
  harnessId?: HarnessId,
): Promise<CompleteV2Result>;
async function completeV2(
  request: CompleteRoundV2Request,
  harnessId?: HarnessId,
): Promise<CompleteRoundV2Result>;
async function completeV2(
  request: CompleteRoundV3Request,
  harnessId?: HarnessId,
): Promise<CompleteRoundV3Result>;
async function completeV2(
  request: CompleteV2Request | CompleteRoundV2Request | CompleteRoundV3Request,
  harnessId: HarnessId = 'dsh',
): Promise<CompleteV2Result | CompleteRoundV2Result | CompleteRoundV3Result> {
  let classified:
    | { readonly kind: 'legacy'; readonly request: CompleteV2Request }
    | { readonly kind: 'schema2'; readonly request: CompleteRoundV2Request }
    | { readonly kind: 'schema3'; readonly request: CompleteRoundV3Request };
  try {
    classified = classifyCompleteV2Request(request);
  } catch {
    throw new CompletionBridgeError('E_COMPLETION_NATIVE');
  }
  if (classified.kind === 'legacy') {
    const legacyRequest = classified.request;
    try {
      const nativeModule = required();
      if (typeof nativeModule.completeV2 !== 'function') {
        throw new CompletionBridgeError('E_COMPLETION_NATIVE');
      }
      const envelope = JSON.stringify({
        schema_version: 1,
        model: legacyRequest.model,
        request_id: legacyRequest.requestId,
        thinking_mode: legacyRequest.thinkingMode,
        history: legacyRequest.history,
        tools: legacyRequest.tools ?? [],
      });
      const raw = await nativeModule.completeV2(envelope);
      return validateLegacyCompleteV2Result(raw);
    } catch (error) {
      throw sanitizeCompletionError(error);
    }
  }

  try {
    const nativeModule = required();
    if (typeof nativeModule.completeV2 !== 'function') {
      throw new CompletionBridgeError('E_COMPLETION_NATIVE');
    }
    if (classified.kind === 'schema3') {
      const envelope = encodeCompleteV3Request(classified.request, harnessId);
      const raw = await nativeModule.completeV2(envelope);
      return validateCompleteV3Result(raw, classified.request);
    }
    const envelope = encodeCompleteV2Request(classified.request, harnessId);
    const raw = await nativeModule.completeV2(envelope);
    return validateCompleteV2Result(raw, classified.request);
  } catch (error) {
    throw sanitizeCompletionError(error);
  }
}

export const LocalRuntime = {
  isAvailable: () => hasNativeCapabilities(native),
  createCompletionRequestId,
  bootstrap: () => required().bootstrap(),
  bootstrapForHarness: async (
    harnessId: HarnessId,
  ): Promise<BootstrapResult> => {
    const module = NativeModules.LocalRuntime as
      | (Partial<NativeLocalRuntime> & {
          bootstrapForHarness?: (id: HarnessId) => Promise<BootstrapResult>;
        })
      | undefined;
    if (typeof module?.bootstrapForHarness === 'function') {
      return module.bootstrapForHarness(harnessId);
    }
    if (harnessId === 'dsh') return required().bootstrap();
    throw new Error('harness-aware runtime bootstrap is unavailable');
  },
  credentialStatus: () => required().credentialStatus(),
  presentCredentialPrompt: (locale: CredentialPromptLocale) =>
    required().presentCredentialPrompt(safeCredentialPromptLocale(locale)),
  clearCredential: () => required().clearCredential(),
  credentialStatusForSlot: (slot: CredentialSlot) => {
    const module = required() as NativeLocalRuntime & {
      credentialStatusForSlot?: (
        slot: CredentialSlot,
      ) => Promise<CredentialStatus>;
    };
    if (typeof module.credentialStatusForSlot !== 'function') {
      return required().credentialStatus();
    }
    return module.credentialStatusForSlot(slot);
  },
  presentCredentialPromptForSlot: (
    slot: CredentialSlot,
    locale: CredentialPromptLocale,
  ) => {
    const module = required() as NativeLocalRuntime & {
      presentCredentialPromptForSlot?: (
        slot: CredentialSlot,
        locale: CredentialPromptLocale,
      ) => Promise<CredentialPromptResult>;
    };
    if (typeof module.presentCredentialPromptForSlot !== 'function') {
      return required().presentCredentialPrompt(
        safeCredentialPromptLocale(locale),
      );
    }
    return module.presentCredentialPromptForSlot(
      slot,
      safeCredentialPromptLocale(locale),
    );
  },
  clearCredentialForSlot: (slot: CredentialSlot) => {
    const module = required() as NativeLocalRuntime & {
      clearCredentialForSlot?: (
        slot: CredentialSlot,
      ) => Promise<ClearCredentialResult>;
    };
    if (typeof module.clearCredentialForSlot !== 'function') {
      return required().clearCredential();
    }
    return module.clearCredentialForSlot(slot);
  },
  isCredentialSlotAvailable: () => {
    const module = NativeModules.LocalRuntime as
      | Partial<NativeLocalRuntime>
      | undefined;
    return typeof module?.credentialStatusForSlot === 'function';
  },
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
  completeV2,
  isRecordAgentTraceAvailable: () => {
    const module = NativeModules.LocalRuntime as
      | Partial<NativeLocalRuntime>
      | undefined;
    return typeof module?.recordAgentTrace === 'function';
  },
  isStreamingAvailable: () => {
    const module = NativeModules.LocalRuntime as
      | Partial<NativeLocalRuntime>
      | undefined;
    return typeof module?.completeV2Stream === 'function';
  },
  completeV2Stream: async (
    request: CompleteV2Request,
    harnessId: HarnessId = 'dsh',
  ): Promise<CompleteV2Result> => {
    const nativeModule = required() as NativeLocalRuntime & {
      completeV2Stream?: (
        envelopeJSON: string,
      ) => Promise<Record<string, unknown>>;
    };
    if (typeof nativeModule.completeV2Stream !== 'function') {
      throw new Error('completeV2Stream native method is not linked');
    }
    const envelope = JSON.stringify({
      schema_version: 1,
      harness_id: harnessId,
      model: request.model,
      request_id: request.requestId,
      thinking_mode: request.thinkingMode,
      history: request.history,
      tools: request.tools ?? [],
    });
    const raw = await nativeModule.completeV2Stream(envelope);
    return raw as unknown as CompleteV2Result;
  },
  addStreamingListener: (
    listener: (event: {
      request_id: string;
      delta: {
        type: 'delta' | 'done';
        content?: string;
        reasoning?: string;
        finish_reason?: string;
      };
    }) => void,
  ) => {
    const { NativeEventEmitter } =
      require('react-native') as typeof import('react-native');
    const emitter = new NativeEventEmitter(NativeModules.LocalRuntime);
    const subscription = emitter.addListener(
      'completionStream',
      listener as (payload: unknown) => void,
    );
    return { remove: () => subscription.remove() };
  },
  recordAgentTrace: async (
    entries: readonly AgentTraceProofEntry[],
  ): Promise<{ recorded: number }> => {
    const nativeModule = required() as NativeLocalRuntime & {
      recordAgentTrace?: (
        entries: readonly AgentTraceProofEntry[],
      ) => Promise<{ recorded: number }>;
    };
    if (typeof nativeModule.recordAgentTrace !== 'function') {
      throw new Error('recordAgentTrace native method is not linked');
    }
    return nativeModule.recordAgentTrace([...entries]);
  },
  isRecordModelTransitionAvailable: () => {
    const module = NativeModules.LocalRuntime as
      | Partial<NativeLocalRuntime>
      | undefined;
    return typeof module?.recordModelTransition === 'function';
  },
  recordModelTransition: async (
    entry: ModelTransitionProofEntry,
  ): Promise<{ recorded: number }> => {
    const nativeModule = required() as NativeLocalRuntime & {
      recordModelTransition?: (
        value: ModelTransitionProofEntry,
      ) => Promise<{ recorded: number }>;
    };
    if (typeof nativeModule.recordModelTransition !== 'function') {
      throw new Error('recordModelTransition native method is not linked');
    }
    return nativeModule.recordModelTransition(entry);
  },
  persistSession: (json: string) => required().persistSession(json),
  loadSession: () => required().loadSession(),
};
