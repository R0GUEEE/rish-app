import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleEllipsis from 'lucide-react-native/icons/circle-ellipsis';
import FolderCode from 'lucide-react-native/icons/folder-code';
import LoaderCircle from 'lucide-react-native/icons/loader-circle';
import Menu from 'lucide-react-native/icons/menu';
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import {
  ChatComposer,
  type AttachmentSource,
} from '../components/ChatComposer';
import { ChatDrawer, type ConversationSummary } from '../components/ChatDrawer';
import { BrandMark } from '../components/BrandMark';
import { AppIcon } from '../components/AppIcon';
import { AccountSheet } from '../components/AccountSheet';
import { ConversationActionSheet } from '../components/ConversationActionSheet';
import { EmptyChat } from '../components/EmptyChat';
import { MessageList, type DisplayMessage } from '../components/MessageList';
import { MirrorSettingsSheet } from '../components/MirrorSettingsSheet';
import { runAgentTurn } from '../agent/runAgentTurn';
import { executeAgentTool } from '../agent/AgentTools';
import type { AgentTraceRow } from '../agent/AgentLoop';
import { ConversationOptionsPicker } from '../components/ConversationOptionsPicker';
import { HarnessPicker } from '../components/HarnessPicker';
import type { StructuredBlock } from '../components/StructuredContent';
import { ModelPicker, type SupportedModel } from '../components/ModelPicker';
import { LocalWorkspaces } from '../native/LocalWorkspaces';
import { ProjectsSurface } from '../components/ProjectsSurface';
import {
  RuntimeEvidenceSheet,
  type RuntimeVerificationStatus,
} from '../components/RuntimeEvidenceSheet';
import { SettingsSheet } from '../components/SettingsSheet';
import { WorkspaceDrawer } from '../components/WorkspaceDrawer';
import { WorkspacePickerSheet } from '../components/WorkspacePickerSheet';
import {
  createChatStore,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_TOTAL_ATTACHMENT_SIZE,
  safeHydrateChatState,
  selectActiveConversation,
  selectConversationById,
  selectOrderedConversations,
  type ChatState,
  type ChatMessage,
  type Conversation,
  type AttachmentDescriptor,
} from '../state';
import {
  LocalRuntime,
  type CompletionMessage,
  type DeepSeekThinkingMode,
  type RuntimeProof,
} from '../native/LocalRuntime';
import { readRuntimeEvidence } from '../runtime/evidence';
import { LocalProjects, type LocalProject } from '../native/LocalProjects';
import { LocalAttachments } from '../native/LocalAttachments';
import { BUILTIN_HARNESSES, DSH_HARNESS, DshHarnessAdapter } from '../harness';
import { safeHydrateAppPreferences } from '../preferences';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';

type RequestState = 'idle' | 'sending';
type RetryContext = {
  conversationId: string;
  history: CompletionMessage[];
  model: SupportedModel;
  thinkingMode: DeepSeekThinkingMode;
};

type LegacyMessage = {
  id?: unknown;
  role?: unknown;
  text?: unknown;
};

const ATTACHMENT_PICKER_TIMEOUT_MS = 120_000;

function waitForAttachmentPicker<T>(
  operation: Promise<T>,
  timeoutMessage: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(new Error(timeoutMessage));
    }, ATTACHMENT_PICKER_TIMEOUT_MS);
    operation.then(
      value => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      },
      error => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function completionMessage(message: ChatMessage): CompletionMessage {
  return {
    role: message.role,
    content: message.text,
    ...(message.attachments === undefined || message.attachments.length === 0
      ? {}
      : {
          attachments: message.attachments.map(attachment => ({
            schema_version: attachment.schema_version,
            id: attachment.id,
            kind: attachment.kind,
            name: attachment.name,
            mime_type: attachment.mime_type,
            size: attachment.size,
          })),
        }),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error))
    return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

function summaryFor(conversation: Conversation): ConversationSummary {
  const last = conversation.messages.at(-1);
  return {
    id: conversation.id,
    title: conversation.title,
    preview:
      last?.text ||
      last?.attachments?.map(attachment => attachment.name).join(', ') ||
      '',
    updatedAt: Date.parse(conversation.updatedAt),
  };
}

function displayMessages(
  conversation: Conversation | null,
  previews: Readonly<Record<string, string>>,
): DisplayMessage[] {
  return (conversation?.messages ?? []).map(message => {
    const blocks: StructuredBlock[] | undefined =
      message.role === 'assistant' && message.metadata?.reasoning !== undefined
        ? [
            {
              id: `${message.id}-reasoning`,
              type: 'reasoning',
              text: message.metadata.reasoning,
            },
            { id: `${message.id}-text`, type: 'text', text: message.text },
          ]
        : undefined;
    return {
      id: message.id,
      role: message.role,
      text: message.text,
      ...(message.attachments === undefined || message.attachments.length === 0
        ? {}
        : {
            attachments: message.attachments.map(attachment => ({
              ...attachment,
              ...(attachment.thumbnail_data_url !== undefined
                ? {}
                : previews[attachment.id] === undefined
                ? {}
                : { thumbnail_data_url: previews[attachment.id] }),
            })),
          }),
      ...(blocks === undefined ? {} : { blocks }),
      ...(message.metadata === undefined
        ? {}
        : {
            meta: [
              message.metadata.modelId,
              message.metadata.latencyMs === undefined
                ? undefined
                : `${message.metadata.latencyMs} ms`,
            ]
              .filter(Boolean)
              .join(' · '),
          }),
    };
  });
}

function legacyMessages(input: string): LegacyMessage[] | null {
  try {
    const decoded = JSON.parse(input) as unknown;
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      Array.isArray(decoded)
    )
      return null;
    const record = decoded as Record<string, unknown>;
    return record.schema_version === 1 && Array.isArray(record.messages)
      ? (record.messages as LegacyMessage[])
      : null;
  } catch {
    return null;
  }
}

/**
 * Fixed completionV2 tool set for agent v0, bound to the conversation's
 * project repository through the executor bridge.
 */
const AGENT_TOOLS_V0 = [
  {
    name: 'list_dir',
    description: 'List files in the project directory.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative directory' },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read a bounded text file from the project.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the project.',
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
    description: 'Report branch, HEAD and cleanliness.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_commit',
    description: 'Stage all changes and commit with a message.',
    parameters: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'git_push',
    description: 'Push committed work to origin. Needs explicit approval.',
    parameters: { type: 'object', properties: {} },
  },
] as const;

function agentTraceLine(traces: readonly AgentTraceRow[]): string {
  if (traces.length === 0) return '';
  const parts = traces.map(row => {
    if (row.blocked === 'denied_by_user') return `${row.name} blocked`;
    if (row.ok === false) return `${row.name} failed`;
    if (row.ok === true) return row.name;
    return `${row.name}…`;
  });
  return `[agent] ${parts.join(' · ')}`;
}

export function HomeScreen() {
  const insets = useSafeAreaInsets();
  const {
    colors,
    locale,
    preferences,
    store: preferencesStore,
    t,
  } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const shell = useMemo(readRuntimeEvidence, []);
  const store = useMemo(() => createChatStore(), []);
  const [chatState, setChatState] = useState<ChatState>(() => store.getState());
  const [draft, setDraft] = useState('');
  const [draftAttachments, setDraftAttachments] = useState<
    readonly AttachmentDescriptor[]
  >([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [attachmentPreviews, setAttachmentPreviews] = useState<
    Readonly<Record<string, string>>
  >({});
  const [previewingAttachmentId, setPreviewingAttachmentId] = useState<
    string | null
  >(null);
  const [drawerVisible, setDrawerVisible] = useState(false);
  const [accountVisible, setAccountVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const [composerOptionsVisible, setComposerOptionsVisible] = useState(false);
  const [workspaceSheetVisible, setWorkspaceSheetVisible] = useState(false);
  const [workspaceNames, setWorkspaceNames] = useState<
    Readonly<Record<string, string>>
  >({});
  const [workspaceRefreshToken, setWorkspaceRefreshToken] = useState(0);
  const [modelVisible, setModelVisible] = useState(false);
  const [mirrorsVisible, setMirrorsVisible] = useState(false);
  const [harnessesVisible, setHarnessesVisible] = useState(false);
  const [evidenceVisible, setEvidenceVisible] = useState(false);
  const [workspaceVisible, setWorkspaceVisible] = useState(false);
  const [projectsVisible, setProjectsVisible] = useState(false);
  const [projectFilesScope, setProjectFilesScope] =
    useState<LocalProject | null>(null);
  const [projectRefreshToken, setProjectRefreshToken] = useState(0);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(
    null,
  );
  const [actionConversationId, setActionConversationId] = useState<
    string | null
  >(null);
  const [credentialConfigured, setCredentialConfigured] = useState(false);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [runtimeChecking, setRuntimeChecking] = useState(true);
  const [requestState, setRequestState] = useState<RequestState>('idle');
  const [proof, setProof] = useState<RuntimeProof | null>(null);
  const [runtimeFailure, setRuntimeFailure] = useState<string | null>(null);
  const [requestFailure, setRequestFailure] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [retryContext, setRetryContext] = useState<RetryContext | null>(null);
  const [agentTraces, setAgentTraces] = useState<readonly AgentTraceRow[]>([]);
  const [agentApproval, setAgentApproval] = useState<{
    callId: string;
    name: string;
    arguments: string;
  } | null>(null);
  const agentApprovalResolver = useRef<((approved: boolean) => void) | null>(
    null,
  );
  const requestEpoch = useRef(0);
  const activeRequestId = useRef<string | null>(null);
  const activeAttachmentPreviewId = useRef<string | null>(null);
  const afterDrawerDismiss = useRef<(() => void) | null>(null);
  const afterActionDismiss = useRef<(() => void) | null>(null);
  const started = useRef(false);
  const nativeAvailable = useMemo(() => DshHarnessAdapter.isAvailable(), []);
  const activeHarness =
    BUILTIN_HARNESSES.get(preferences.selectedHarnessId) ?? DSH_HARNESS;

  useEffect(() => store.subscribe(setChatState), [store]);

  useEffect(() => {
    if (attachmentNotice === null) return;
    const timer = setTimeout(() => setAttachmentNotice(null), 2800);
    return () => clearTimeout(timer);
  }, [attachmentNotice]);

  const referencedAttachmentIds = useCallback(
    (state: ChatState): string[] =>
      Array.from(
        new Set(
          Object.values(state.conversations).flatMap(conversation =>
            conversation.messages.flatMap(message =>
              (message.attachments ?? []).map(attachment => attachment.id),
            ),
          ),
        ),
      ),
    [],
  );

  const synchronizeAttachmentStore = useCallback(
    async (state: ChatState) => {
      if (!LocalAttachments.isAvailable()) return;
      const referencedIds = referencedAttachmentIds(state);
      try {
        await LocalAttachments.prune(referencedIds);
      } catch (error) {
        setRequestFailure(
          t('messages.attachment.failed', { error: errorText(error) }),
        );
      }
      const images = Array.from(
        new Map(
          Object.values(state.conversations)
            .flatMap(conversation =>
              conversation.messages.flatMap(message =>
                (message.attachments ?? []).filter(
                  attachment => attachment.kind === 'image',
                ),
              ),
            )
            .map(attachment => [attachment.id, attachment] as const),
        ).values(),
      );
      const previews = await Promise.all(
        images.map(async attachment => {
          if (attachment.thumbnail_data_url !== undefined) {
            return [attachment.id, attachment.thumbnail_data_url] as const;
          }
          try {
            const preview = await LocalAttachments.preview(attachment.id);
            return preview.thumbnail_data_url === null
              ? null
              : ([preview.id, preview.thumbnail_data_url] as const);
          } catch {
            return null;
          }
        }),
      );
      setAttachmentPreviews(
        Object.fromEntries(
          previews.filter(
            (entry): entry is readonly [string, string] => entry !== null,
          ),
        ),
      );
    },
    [referencedAttachmentIds, t],
  );

  const persist = useCallback(async (): Promise<boolean> => {
    if (!nativeAvailable) {
      setStorageWarning(t('home.persistenceUnavailable'));
      return false;
    }
    try {
      const snapshot = JSON.parse(store.serialize()) as Record<string, unknown>;
      snapshot.preferences = JSON.parse(
        preferencesStore.serialize(),
      ) as unknown;
      await LocalRuntime.persistSession(JSON.stringify(snapshot));
      setStorageWarning(null);
      return true;
    } catch (error) {
      setStorageWarning(t('home.saveFailed', { error: errorText(error) }));
      return false;
    }
  }, [nativeAvailable, preferencesStore, store, t]);

  const ensureConversation = useCallback((): string => {
    const selected = store.getState().selectedConversationId;
    if (selected !== null) return selected;
    return store.createConversation({
      modelId: preferencesStore.getState().defaultModel,
      thinkingMode: preferencesStore.getState().thinkingMode,
    });
  }, [preferencesStore, store]);

  const hydrateStoredState = useCallback(
    (stored: string | null) => {
      if (stored === null) {
        ensureConversation();
        return;
      }
      try {
        const decoded = JSON.parse(stored) as unknown;
        if (
          typeof decoded === 'object' &&
          decoded !== null &&
          !Array.isArray(decoded)
        ) {
          const savedPreferences = (decoded as Record<string, unknown>)
            .preferences;
          if (savedPreferences !== undefined) {
            const result = safeHydrateAppPreferences(savedPreferences);
            if (result.ok) preferencesStore.hydrate(savedPreferences);
          }
        }
      } catch {
        // Chat hydration below owns the fail-closed error shown to the user.
      }
      const hydrated = safeHydrateChatState(stored);
      if (hydrated.ok) {
        store.hydrate(stored);
        if (store.getState().selectedConversationId === null)
          ensureConversation();
        return;
      }

      const legacy = legacyMessages(stored);
      if (legacy !== null) {
        const conversationId = store.createConversation();
        legacy.forEach(message => {
          if (message.role !== 'user' && message.role !== 'assistant') return;
          if (
            typeof message.text !== 'string' ||
            message.text.trim().length === 0
          )
            return;
          if (message.role === 'user')
            store.appendUserMessage(conversationId, message.text);
          else store.appendAssistantMessage(conversationId, message.text);
        });
        setStorageWarning(t('home.legacySessionUpgraded'));
        return;
      }

      ensureConversation();
      setStorageWarning(
        t('home.storedChatsRejected', { error: hydrated.error.message }),
      );
    },
    [ensureConversation, preferencesStore, store, t],
  );

  const bootstrap = useCallback(async () => {
    setRuntimeChecking(true);
    setRuntimeFailure(null);
    if (!nativeAvailable) {
      ensureConversation();
      setChatState(store.getState());
      setRuntimeFailure(t('home.localAdapterUnavailable'));
      setRuntimeChecking(false);
      return;
    }
    try {
      const credential = await DshHarnessAdapter.credentialStatus();
      const configured = credential.status === 'configured';
      setCredentialConfigured(configured);
      let initialProof: RuntimeProof | null = null;
      if (configured) initialProof = (await LocalRuntime.bootstrap()).proof;
      const stored = await LocalRuntime.loadSession();
      hydrateStoredState(stored);
      setChatState(store.getState());
      await synchronizeAttachmentStore(store.getState());
      if (configured && stored !== null)
        initialProof = (await LocalRuntime.bootstrap()).proof;
      setProof(initialProof);
    } catch (error) {
      setRuntimeFailure(errorText(error));
      if (store.getState().selectedConversationId === null)
        ensureConversation();
      setChatState(store.getState());
    } finally {
      setRuntimeChecking(false);
    }
  }, [
    ensureConversation,
    hydrateStoredState,
    nativeAvailable,
    store,
    synchronizeAttachmentStore,
    t,
  ]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    bootstrap().catch(() => undefined);
  }, [bootstrap]);

  const activeConversation = selectActiveConversation(chatState);
  const activeProjectId = activeConversation?.projectId ?? null;
  useEffect(() => {
    let cancelled = false;
    if (activeProjectId === null || !LocalProjects.isAvailable()) {
      setActiveProjectName(null);
      return () => {
        cancelled = true;
      };
    }
    LocalProjects.list()
      .then(listing => {
        if (cancelled) return;
        setActiveProjectName(
          listing.projects.find(project => project.id === activeProjectId)
            ?.name ?? null,
        );
      })
      .catch(() => {
        if (!cancelled) setActiveProjectName(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectId]);
  const activeMessages = useMemo(
    () => displayMessages(activeConversation, attachmentPreviews),
    [activeConversation, attachmentPreviews],
  );
  const conversationSummaries = useMemo(
    () => selectOrderedConversations(chatState).map(summaryFor),
    [chatState],
  );
  const activeModel = (activeConversation?.modelId ??
    preferences.defaultModel) as SupportedModel;
  const activeThinkingMode =
    activeConversation?.thinkingMode ?? preferences.thinkingMode;
  const activeWorkspaceId = activeConversation?.workspaceId ?? null;
  const runtimeLocal =
    proof !== null &&
    proof.checks.credential_in_keychain &&
    proof.checks.rish_applet_executed &&
    !proof.mac_dsh_port_3180_reachable;
  const runtimeLabel = runtimeChecking
    ? t('runtime.status.verifying')
    : !nativeAvailable
    ? t('home.localAdapterUnavailable')
    : !credentialConfigured
    ? t('settings.credential.notConfigured')
    : proof?.mac_dsh_port_3180_reachable
    ? t('runtime.status.proxyDetected')
    : runtimeLocal
    ? t('runtime.status.verified')
    : t('runtime.status.incomplete');
  const runtimeStatus: RuntimeVerificationStatus = runtimeChecking
    ? 'checking'
    : runtimeFailure !== null ||
      !nativeAvailable ||
      proof?.mac_dsh_port_3180_reachable
    ? 'failed'
    : runtimeLocal
    ? 'verified'
    : 'incomplete';

  const refreshProof = useCallback(async () => {
    if (!credentialConfigured) return;
    try {
      setProof((await LocalRuntime.bootstrap()).proof);
      setRuntimeFailure(null);
    } catch (error) {
      setRuntimeFailure(errorText(error));
    }
  }, [credentialConfigured]);

  const discardDraftAttachments = useCallback(() => {
    const ids = draftAttachments.map(attachment => attachment.id);
    setDraftAttachments([]);
    if (ids.length > 0 && LocalAttachments.isAvailable()) {
      LocalAttachments.discard(ids).catch(error =>
        setRequestFailure(
          t('messages.attachment.failed', { error: errorText(error) }),
        ),
      );
    }
  }, [draftAttachments, t]);

  const addAttachment = useCallback(
    async (source: AttachmentSource) => {
      if (!LocalAttachments.isAvailable() || attachmentBusy) {
        setRequestFailure(t('messages.attachment.unsupported'));
        return;
      }
      setAttachmentBusy(true);
      setRequestFailure(null);
      try {
        const result = await waitForAttachmentPicker(
          LocalAttachments.present(source),
          t('messages.attachment.timeout'),
        );
        if (result.status === 'cancelled' || result.attachments.length === 0)
          return;
        const ids = new Set(draftAttachments.map(attachment => attachment.id));
        let totalSize = draftAttachments.reduce(
          (sum, attachment) => sum + attachment.size,
          0,
        );
        const accepted: AttachmentDescriptor[] = [];
        const overflow: AttachmentDescriptor[] = [];
        result.attachments.forEach(attachment => {
          if (ids.has(attachment.id)) return;
          ids.add(attachment.id);
          if (
            draftAttachments.length + accepted.length >=
              MAX_ATTACHMENTS_PER_MESSAGE ||
            totalSize + attachment.size > MAX_TOTAL_ATTACHMENT_SIZE
          ) {
            overflow.push(attachment);
            return;
          }
          totalSize += attachment.size;
          accepted.push(attachment);
        });
        setDraftAttachments([...draftAttachments, ...accepted]);
        if (overflow.length > 0) {
          LocalAttachments.discard(
            overflow.map(attachment => attachment.id),
          ).catch(() => undefined);
          setRequestFailure(t('messages.attachment.limit'));
        }
        if (accepted.some(attachment => attachment.kind === 'image')) {
          const conversationId = ensureConversation();
          store.setModel(conversationId, 'deepseek-v4-flash-vision-exp');
          setAttachmentNotice(t('messages.attachment.visionEnabled'));
          await persist();
        }
      } catch (error) {
        setRequestFailure(
          t('messages.attachment.failed', { error: errorText(error) }),
        );
      } finally {
        setAttachmentBusy(false);
      }
    },
    [attachmentBusy, draftAttachments, ensureConversation, persist, store, t],
  );

  const removeDraftAttachment = useCallback(
    (id: string) => {
      setDraftAttachments(current =>
        current.filter(attachment => attachment.id !== id),
      );
      if (LocalAttachments.isAvailable()) {
        LocalAttachments.discard([id]).catch(error =>
          setRequestFailure(
            t('messages.attachment.failed', { error: errorText(error) }),
          ),
        );
      }
    },
    [t],
  );

  const presentAttachmentPreview = useCallback(
    async (id: string) => {
      if (activeAttachmentPreviewId.current !== null) return;
      if (!LocalAttachments.isAvailable()) {
        setRequestFailure(t('messages.attachment.previewUnavailable'));
        return;
      }
      activeAttachmentPreviewId.current = id;
      setPreviewingAttachmentId(id);
      setRequestFailure(null);
      try {
        await LocalAttachments.presentPreview(id);
      } catch (error) {
        setRequestFailure(
          t('messages.attachment.previewFailed', { error: errorText(error) }),
        );
      } finally {
        if (activeAttachmentPreviewId.current === id) {
          activeAttachmentPreviewId.current = null;
          setPreviewingAttachmentId(null);
        }
      }
    },
    [t],
  );

  const finishCompletion = useCallback(
    async (context: RetryContext, epoch: number) => {
      const requestId = LocalRuntime.createCompletionRequestId();
      activeRequestId.current = requestId;
      try {
        const result = await DshHarnessAdapter.complete(
          context.model,
          context.history,
          requestId,
          context.thinkingMode,
        );
        if (requestEpoch.current !== epoch) return;
        store.appendAssistantMessage(context.conversationId, result.text, {
          metadata: {
            modelId: context.model,
            latencyMs: result.latency_ms,
            finishReason: 'stop',
            ...(result.reasoning.length === 0
              ? {}
              : { reasoning: result.reasoning }),
          },
        });
        setRetryContext(null);
        setRequestFailure(null);
        await persist();
        await refreshProof();
      } catch (error) {
        if (requestEpoch.current !== epoch || errorCode(error) === 'cancelled')
          return;
        setRetryContext(context);
        setRequestFailure(errorText(error));
      } finally {
        if (activeRequestId.current === requestId)
          activeRequestId.current = null;
        if (requestEpoch.current === epoch) setRequestState('idle');
      }
    },
    [persist, refreshProof, store],
  );

  const runAgentCompletion = useCallback(
    async (context: RetryContext, projectId: string, epoch: number) => {
      const requestId = LocalRuntime.createCompletionRequestId();
      activeRequestId.current = requestId;
      const startedAt = Date.now();
      setAgentTraces([]);
      setAgentApproval(null);
      try {
        const result = await runAgentTurn({
          projectId,
          model: context.model,
          thinkingMode: context.thinkingMode,
          history: context.history,
          tools: AGENT_TOOLS_V0,
          requestId,
          deps: {
            modelCalls: async req => {
              return await DshHarnessAdapter.completeV2(
                req.model as Parameters<
                  typeof DshHarnessAdapter.completeV2
                >[0],
                [...req.history],
                req.requestId,
                req.thinkingMode as Parameters<
                  typeof DshHarnessAdapter.completeV2
                >[3],
                [...req.tools],
              );
            },
            executeTool: (toolContext, name, argumentsJson) =>
              executeAgentTool(
                { projectId: toolContext.projectId },
                name,
                argumentsJson,
              ),
            requestApproval: call =>
              new Promise<boolean>(resolve => {
                setAgentApproval({
                  callId: call.callId,
                  name: call.name,
                  arguments: call.arguments,
                });
                agentApprovalResolver.current = resolve;
              }),
            onTrace: rows => setAgentTraces(rows),
            recordTrace: entries => {
              LocalRuntime.recordAgentTrace(entries).catch(() => undefined);
            },
          },
        });
        if (requestEpoch.current !== epoch) return;
        if (result.status === 'failed') {
          setRequestFailure(result.failure?.code ?? 'E_AGENT_FAILED');
          return;
        }
        if (result.status === 'cancelled') {
          setRequestFailure(t('home.responseStopped'));
          return;
        }
        const traceLine = agentTraceLine(result.traces);
        const finalBody =
          (traceLine.length > 0 ? traceLine + '\n\n' : '') +
          (result.finalText ??
            t('messages.agent.noAnswer'));
        store.appendAssistantMessage(context.conversationId, finalBody, {
          metadata: {
            modelId: context.model,
            latencyMs: Date.now() - startedAt,
            finishReason: 'stop',
          },
        });
        setRetryContext(null);
        setRequestFailure(null);
        await persist();
        await refreshProof();
      } catch (error) {
        if (requestEpoch.current !== epoch) return;
        setRequestFailure(errorText(error));
      } finally {
        if (activeRequestId.current === requestId) activeRequestId.current = null;
        if (requestEpoch.current === epoch) setRequestState('idle');
        setAgentApproval(null);
      }
    },
    [persist, refreshProof, store, t],
  );


  const send = useCallback(async () => {
    const prompt = draft.trim();
    const outgoingAttachments = draftAttachments;
    if (
      !credentialConfigured ||
      (prompt.length === 0 && outgoingAttachments.length === 0) ||
      requestState === 'sending'
    )
      return;
    const conversationId = ensureConversation();
    const beforeAppend = selectConversationById(
      store.getState(),
      conversationId,
    );
    const historyNeedsVision =
      beforeAppend?.messages.some(message =>
        message.attachments?.some(attachment => attachment.kind === 'image'),
      ) === true ||
      outgoingAttachments.some(attachment => attachment.kind === 'image');
    if (
      historyNeedsVision &&
      beforeAppend?.modelId !== 'deepseek-v4-flash-vision-exp'
    ) {
      store.setModel(conversationId, 'deepseek-v4-flash-vision-exp');
      setAttachmentNotice(t('messages.attachment.visionEnabled'));
    }
    store.appendUserMessage(conversationId, prompt, {
      attachments: outgoingAttachments,
    });
    setDraft('');
    setDraftAttachments([]);
    setAttachmentNotice(null);
    setRequestFailure(null);
    setRetryContext(null);
    await persist();
    const conversation = selectConversationById(
      store.getState(),
      conversationId,
    );
    if (conversation === null) return;
    const context: RetryContext = {
      conversationId,
      model: conversation.modelId,
      thinkingMode: conversation.thinkingMode,
      history: conversation.messages.map(completionMessage),
    };
    const epoch = ++requestEpoch.current;
    setRequestState('sending');
    if (
      typeof conversation.projectId === 'string' &&
      LocalRuntime.isCompletionV2Available()
    ) {
      await runAgentCompletion(context, conversation.projectId, epoch);
      return;
    }
    await finishCompletion(context, epoch);
  }, [
    credentialConfigured,
    draft,
    draftAttachments,
    ensureConversation,
    finishCompletion,
    persist,
    requestState,
    runAgentCompletion,
    store,
    t,
  ]);

  const retry = useCallback(async () => {
    if (retryContext === null || requestState === 'sending') return;
    const epoch = ++requestEpoch.current;
    setRequestFailure(null);
    setRequestState('sending');
    await finishCompletion(retryContext, epoch);
  }, [finishCompletion, requestState, retryContext]);


  const cancel = useCallback(() => {
    const requestId = activeRequestId.current;
    activeRequestId.current = null;
    requestEpoch.current += 1;
    setRequestState('idle');
    setRetryContext(null);
    setRequestFailure(t('home.responseStopped'));
    if (requestId !== null)
      DshHarnessAdapter.cancel(requestId).catch(() => undefined);
  }, [t]);

  const createConversation = useCallback(() => {
    if (requestState === 'sending') cancel();
    discardDraftAttachments();
    store.createConversation({
      modelId: preferencesStore.getState().defaultModel,
      thinkingMode: preferencesStore.getState().thinkingMode,
    });
    setDraft('');
    setAttachmentNotice(null);
    setRequestFailure(null);
    setRetryContext(null);
    setDrawerVisible(false);
    persist().catch(() => undefined);
  }, [
    cancel,
    discardDraftAttachments,
    persist,
    preferencesStore,
    requestState,
    store,
  ]);

  const selectConversation = useCallback(
    (id: string) => {
      if (requestState === 'sending') cancel();
      discardDraftAttachments();
      store.selectConversation(id);
      setDraft('');
      setAttachmentNotice(null);
      setRequestFailure(null);
      setRetryContext(null);
      setDrawerVisible(false);
      persist().catch(() => undefined);
    },
    [cancel, discardDraftAttachments, persist, requestState, store],
  );

  const renameConversation = useCallback(
    (title: string) => {
      if (actionConversationId === null) return;
      store.renameConversation(actionConversationId, title);
      persist().catch(() => undefined);
    },
    [actionConversationId, persist, store],
  );

  const confirmDeleteConversation = useCallback(
    (deleting: string) => {
      Alert.alert(t('home.deleteChatTitle'), t('home.deleteChatBody'), [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () => {
            const deletingConversation = selectConversationById(
              store.getState(),
              deleting,
            );
            const candidateAttachmentIds = Array.from(
              new Set(
                (deletingConversation?.messages ?? []).flatMap(message =>
                  (message.attachments ?? []).map(attachment => attachment.id),
                ),
              ),
            );
            discardDraftAttachments();
            store.deleteConversation(deleting);
            if (store.getState().selectedConversationId === null) {
              store.createConversation({
                modelId: preferencesStore.getState().defaultModel,
                thinkingMode: preferencesStore.getState().thinkingMode,
              });
            }
            const remainingIds = new Set(
              referencedAttachmentIds(store.getState()),
            );
            const orphanedIds = candidateAttachmentIds.filter(
              id => !remainingIds.has(id),
            );
            persist()
              .then(saved => {
                if (
                  saved &&
                  orphanedIds.length > 0 &&
                  LocalAttachments.isAvailable()
                ) {
                  return LocalAttachments.discard(orphanedIds).then(
                    () => undefined,
                  );
                }
                return undefined;
              })
              .catch(() => undefined);
          },
        },
      ]);
    },
    [
      discardDraftAttachments,
      persist,
      preferencesStore,
      referencedAttachmentIds,
      store,
      t,
    ],
  );

  const requestDeleteConversation = useCallback(() => {
    if (actionConversationId === null) return;
    const deleting = actionConversationId;
    afterActionDismiss.current = () => confirmDeleteConversation(deleting);
    setActionConversationId(null);
  }, [actionConversationId, confirmDeleteConversation]);

  const selectModel = useCallback(
    (model: SupportedModel) => {
      const conversationId = ensureConversation();
      store.setModel(conversationId, model);
      setAttachmentNotice(null);
      persist().catch(() => undefined);
    },
    [ensureConversation, persist, store],
  );

  const selectThinkingMode = useCallback(
    (thinkingMode: DeepSeekThinkingMode) => {
      const conversationId = ensureConversation();
      store.setThinkingMode(conversationId, thinkingMode);
      persist().catch(() => undefined);
    },
    [ensureConversation, persist, store],
  );

  useEffect(() => {
    if (!LocalWorkspaces.isAvailable()) return;
    let cancelled = false;
    LocalWorkspaces.list()
      .then(listing => {
        if (cancelled) return;
        setWorkspaceNames(
          Object.fromEntries(
            listing.workspaces.map(workspace => [
              workspace.workspace_id,
              workspace.display_name,
            ]),
          ),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [workspaceRefreshToken]);

  const handleWorkspaceSelect = useCallback(
    (workspaceId: string) => {
      const conversationId = ensureConversation();
      store.bindConversationToWorkspace(conversationId, workspaceId);
      persist().catch(() => undefined);
      setWorkspaceSheetVisible(false);
      setWorkspaceRefreshToken(token => token + 1);
    },
    [ensureConversation, persist, store],
  );

  const chatInProject = useCallback(
    (project: LocalProject) => {
      const current = selectActiveConversation(store.getState());
      if (current?.projectId !== project.id) {
        if (current === null || current.messages.length > 0) {
          discardDraftAttachments();
          setDraft('');
          setAttachmentNotice(null);
          store.createConversation({
            modelId: preferencesStore.getState().defaultModel,
            thinkingMode: preferencesStore.getState().thinkingMode,
            projectId: project.id,
          });
        } else {
          store.bindConversationToProject(current.id, project.id);
        }
      }
      setActiveProjectName(project.name);
      setProjectsVisible(false);
      persist().catch(() => undefined);
    },
    [discardDraftAttachments, persist, preferencesStore, store],
  );

  const unbindProjectFromConversation = useCallback(() => {
    const conversationId = store.getState().selectedConversationId;
    if (conversationId === null) return;
    store.unbindConversationFromProject(conversationId);
    setActiveProjectName(null);
    persist().catch(() => undefined);
  }, [persist, store]);

  const selectHarness = useCallback(
    (harnessId: string) => {
      if (!BUILTIN_HARNESSES.has(harnessId)) return;
      preferencesStore.setSelectedHarness(harnessId);
      setHarnessesVisible(false);
      persist().catch(() => undefined);
    },
    [persist, preferencesStore],
  );

  const configureCredential = useCallback(async () => {
    if (!nativeAvailable) {
      setRuntimeFailure(t('home.secureStorageUnavailable'));
      return;
    }
    setCredentialBusy(true);
    try {
      const result = await DshHarnessAdapter.presentCredentialPrompt(locale);
      if (result.status === 'configured') {
        setCredentialConfigured(true);
        setProof((await LocalRuntime.bootstrap()).proof);
        setRuntimeFailure(null);
      }
    } catch (error) {
      setRuntimeFailure(errorText(error));
    } finally {
      setCredentialBusy(false);
    }
  }, [locale, nativeAvailable, t]);

  const clearCredential = useCallback(() => {
    Alert.alert(t('home.clearKeyTitle'), t('home.clearKeyBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.clear'),
        style: 'destructive',
        onPress: () => {
          setCredentialBusy(true);
          DshHarnessAdapter.clearCredential()
            .then(() => {
              setCredentialConfigured(false);
              setProof(null);
              setSettingsVisible(false);
            })
            .catch(error => setRuntimeFailure(errorText(error)))
            .finally(() => setCredentialBusy(false));
        },
      },
    ]);
  }, [t]);

  const openAfterDrawerDismiss = useCallback((open: () => void) => {
    afterDrawerDismiss.current = open;
    setDrawerVisible(false);
  }, []);

  const handleDrawerDismiss = useCallback(() => {
    const open = afterDrawerDismiss.current;
    afterDrawerDismiss.current = null;
    open?.();
  }, []);

  const handleActionDismiss = useCallback(() => {
    const open = afterActionDismiss.current;
    afterActionDismiss.current = null;
    open?.();
  }, []);

  const openRuntimeFromDrawer = useCallback(() => {
    openAfterDrawerDismiss(() => setEvidenceVisible(true));
  }, [openAfterDrawerDismiss]);

  const openConversationActions = useCallback(
    (id: string) => {
      openAfterDrawerDismiss(() => setActionConversationId(id));
    },
    [openAfterDrawerDismiss],
  );

  const actionConversation =
    actionConversationId === null
      ? null
      : selectConversationById(chatState, actionConversationId);
  const navigationSurfaceVisible =
    drawerVisible ||
    settingsVisible ||
    accountVisible ||
    mirrorsVisible ||
    projectsVisible ||
    workspaceVisible;
  const workspaceProjectScope = useMemo(
    () =>
      projectFilesScope === null
        ? undefined
        : {
            rootPath: projectFilesScope.workspace_path,
            label: projectFilesScope.name,
          },
    [projectFilesScope],
  );

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={styles.root}
    >
      <View
        accessibilityElementsHidden={navigationSurfaceVisible}
        importantForAccessibility={
          navigationSurfaceVisible ? 'no-hide-descendants' : 'auto'
        }
        style={[styles.screen, { paddingTop: insets.top }]}
      >
        <View style={styles.topBar}>
          <RoundButton
            accessibilityLabel={t('home.openNavigation')}
            onPress={() => setDrawerVisible(true)}
          >
            <AppIcon color={colors.text} icon={Menu} size={20} />
          </RoundButton>
          <View style={styles.titleWrap}>
            <BrandMark compact size={30} />
            {activeConversation !== null &&
              activeConversation.messages.length > 0 && (
                <Text numberOfLines={1} style={styles.chatTitle}>
                  {activeConversation.title}
                </Text>
              )}
            {activeProjectName !== null && (
              <View
                accessible
                accessibilityLabel={t('messages.projectContext', {
                  project: activeProjectName,
                })}
                style={styles.projectContext}
              >
                <AppIcon color={colors.accent} icon={FolderCode} size={11} />
                <Text numberOfLines={1} style={styles.projectContextText}>
                  {activeProjectName}
                </Text>
              </View>
            )}
          </View>
          {runtimeStatus === 'verified' ? (
            <View style={styles.topBarSpacer} />
          ) : (
            <RoundButton
              accessibilityLabel={t('home.showRuntimeEvidence')}
              onPress={() => setEvidenceVisible(true)}
            >
              <View style={styles.runtimeGlyph}>
                <View
                  style={[
                    styles.runtimeDot,
                    runtimeStatus === 'failed' && styles.runtimeDotFailed,
                  ]}
                />
                <AppIcon
                  color={
                    runtimeStatus === 'failed' ? colors.danger : colors.warning
                  }
                  icon={
                    runtimeStatus === 'failed'
                      ? CircleAlert
                      : runtimeStatus === 'checking'
                      ? LoaderCircle
                      : CircleEllipsis
                  }
                  size={18}
                />
              </View>
            </RoundButton>
          )}
        </View>

        {activeMessages.length === 0 ? (
          <EmptyChat onSuggestion={setDraft} />
        ) : (
          <MessageList
            autoExpandTools={preferences.autoExpandTools}
            messages={activeMessages}
            onPreviewAttachment={id => {
              presentAttachmentPreview(id).catch(() => undefined);
            }}
            previewingAttachmentId={previewingAttachmentId}
            showReasoning={preferences.showReasoning}
          />
        )}

        <View
          style={[
            styles.bottomArea,
            { paddingBottom: Math.max(insets.bottom, 11) },
          ]}
        >
          {(requestFailure !== null || storageWarning !== null) && (
            <View style={styles.notice}>
              <Text numberOfLines={3} style={styles.noticeText}>
                {requestFailure ?? storageWarning}
              </Text>
              {retryContext !== null && requestFailure !== null && (
                <Pressable
                  accessibilityLabel={t('messages.retryResponse')}
                  accessibilityRole="button"
                  hitSlop={hitSlop}
                  onPress={() => retry().catch(() => undefined)}
                  style={({ pressed }) => [
                    styles.retry,
                    pressed && styles.pressed,
                  ]}
                >
                  <Text style={styles.retryText}>{t('messages.retry')}</Text>
                </Pressable>
              )}
            </View>
          )}
          {attachmentNotice !== null && requestFailure === null && (
            <View
              accessibilityLiveRegion="polite"
              accessibilityRole="status"
              style={styles.attachmentNotice}
            >
              <Text numberOfLines={2} style={styles.attachmentNoticeText}>
                {attachmentNotice}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityLabel={runtimeLabel}
            accessibilityRole="button"
            accessibilityState={{ busy: runtimeStatus === 'checking' }}
            hitSlop={hitSlop}
            onPress={() => setEvidenceVisible(true)}
            style={({ pressed }) => [
              styles.proofChip,
              pressed && styles.pressed,
            ]}
          >
            <View
              style={[
                styles.proofDot,
                runtimeStatus === 'verified' && styles.proofDotReady,
                runtimeStatus === 'failed' && styles.proofDotFailed,
              ]}
            />
            <Text style={styles.proofText}>
              {runtimeLabel.toLocaleUpperCase()}
            </Text>
          </Pressable>
          {(agentApproval !== null || agentTraces.length > 0) && (
            <View accessibilityRole="status" style={styles.agentPanel}>
              {agentApproval !== null && (
                <>
                  <Text style={styles.agentPanelText}>
                    {t('messages.agent.allowTitle', {
                      name: agentApproval.name,
                    })}
                  </Text>
                  <View style={styles.agentButtonsRow}>
                    <Pressable
                      accessibilityLabel={t('agent.allow')}
                      accessibilityRole="button"
                      onPress={() => {
                        const resolve = agentApprovalResolver.current;
                        setAgentApproval(null);
                        agentApprovalResolver.current = null;
                        resolve?.(true);
                      }}
                      style={({ pressed }) => [
                        styles.agentAllow,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.agentButtonText}>
                        {t('agent.allow')}
                      </Text>
                    </Pressable>
                    <Pressable
                      accessibilityLabel={t('agent.deny')}
                      accessibilityRole="button"
                      onPress={() => {
                        const resolve = agentApprovalResolver.current;
                        setAgentApproval(null);
                        agentApprovalResolver.current = null;
                        resolve?.(false);
                      }}
                      style={({ pressed }) => [
                        styles.agentDeny,
                        pressed && styles.pressed,
                      ]}
                    >
                      <Text style={styles.agentButtonTextDim}>
                        {t('agent.deny')}
                      </Text>
                    </Pressable>
                  </View>
                </>
              )}
              {agentApproval === null && agentTraces.length > 0 && (
                <Text numberOfLines={2} style={styles.agentTrace}>
                  {`AGENT  ${agentTraces
                    .map(
                      row =>
                        `${row.name}${
                          row.blocked === 'denied_by_user'
                            ? ' x'
                            : row.ok === false
                              ? ' !'
                              : row.ok === true
                                ? ' ok'
                                : ' ...'
                        }`,
                    )
                    .join('   ')}`}
                </Text>
              )}
            </View>
          )}
          <ChatComposer
            attachmentBusy={attachmentBusy}
            attachments={draftAttachments}
            configured={credentialConfigured}
            draft={draft}
            harnessName={activeHarness.name}
            model={activeModel}
            optionsVisible={composerOptionsVisible}
            previewingAttachmentId={previewingAttachmentId}
            projectName={activeProjectName}
            thinkingMode={activeThinkingMode}
            workspaceName={
              activeWorkspaceId === null
                ? null
                : workspaceNames[activeWorkspaceId] ?? null
            }
            workspacePickerVisible={workspaceSheetVisible}
            sending={requestState === 'sending'}
            onAddAttachment={source => {
              addAttachment(source).catch(() => undefined);
            }}
            onCancel={cancel}
            onChange={setDraft}
            onConfigure={() => setSettingsVisible(true)}
            onOptionsPress={() => {
              setComposerOptionsVisible(true);
            }}
            onWorkspacePress={() => {
              setWorkspaceSheetVisible(true);
            }}
            onPreviewAttachment={id => {
              presentAttachmentPreview(id).catch(() => undefined);
            }}
            onRemoveAttachment={removeDraftAttachment}
            onSend={() => send().catch(() => undefined)}
          />
        </View>
      </View>

      <ChatDrawer
        activeId={chatState.selectedConversationId}
        conversations={conversationSummaries}
        covered={settingsVisible || accountVisible || mirrorsVisible}
        runtimeLabel={runtimeLabel}
        runtimeStatus={runtimeStatus}
        visible={drawerVisible}
        onClose={() => setDrawerVisible(false)}
        onDismiss={handleDrawerDismiss}
        onNewChat={createConversation}
        onOpenAccount={() => setAccountVisible(true)}
        onOpenConversationMenu={openConversationActions}
        onOpenFiles={() =>
          openAfterDrawerDismiss(() => {
            setProjectFilesScope(null);
            setWorkspaceVisible(true);
          })
        }
        onOpenProjects={() =>
          openAfterDrawerDismiss(() => setProjectsVisible(true))
        }
        onOpenHarnesses={() =>
          openAfterDrawerDismiss(() => setHarnessesVisible(true))
        }
        onOpenRuntime={openRuntimeFromDrawer}
        onOpenSettings={() => setSettingsVisible(true)}
        onSelect={selectConversation}
      />
      <ConversationActionSheet
        title={actionConversation?.title ?? ''}
        visible={actionConversation !== null}
        onClose={() => setActionConversationId(null)}
        onDelete={requestDeleteConversation}
        onDismiss={handleActionDismiss}
        onRename={renameConversation}
      />
      <SettingsSheet
        busy={credentialBusy}
        covered={mirrorsVisible || modelVisible}
        credentialConfigured={credentialConfigured}
        model={activeModel}
        runtimeAvailable={nativeAvailable}
        runtimeLabel={runtimeLabel}
        runtimeStatus={runtimeStatus}
        visible={settingsVisible}
        onClearCredential={clearCredential}
        onClose={() => setSettingsVisible(false)}
        onDismiss={() => undefined}
        onConfigureCredential={() =>
          configureCredential().catch(() => undefined)
        }
        onOpenModelPicker={() => {
          setModelVisible(true);
        }}
        onOpenMirrors={() => setMirrorsVisible(true)}
        onOpenRuntime={() => setEvidenceVisible(true)}
        onPreferencesChanged={() => {
          persist().catch(() => undefined);
        }}
      />
      <AccountSheet
        visible={accountVisible}
        onClose={() => setAccountVisible(false)}
      />
      <ModelPicker
        placement="settings"
        selected={activeModel}
        visible={modelVisible}
        onClose={() => setModelVisible(false)}
        onSelect={selectModel}
      />
      <ConversationOptionsPicker
        model={activeModel}
        thinkingMode={activeThinkingMode}
        visible={composerOptionsVisible}
        onClose={() => setComposerOptionsVisible(false)}
        onSelectModel={selectModel}
        onSelectThinkingMode={selectThinkingMode}
      />
      <WorkspacePickerSheet
        activeWorkspaceId={activeWorkspaceId}
        visible={workspaceSheetVisible}
        onClose={() => {
          setWorkspaceSheetVisible(false);
          setWorkspaceRefreshToken(token => token + 1);
        }}
        onSelect={handleWorkspaceSelect}
      />
      <MirrorSettingsSheet
        visible={mirrorsVisible}
        onClose={() => setMirrorsVisible(false)}
        onDismiss={() => undefined}
        onPreferencesChanged={() => {
          persist().catch(() => undefined);
        }}
      />
      <HarnessPicker
        manifests={BUILTIN_HARNESSES.list()}
        selectedId={activeHarness.id}
        visible={harnessesVisible}
        onClose={() => setHarnessesVisible(false)}
        onSelect={selectHarness}
      />
      <RuntimeEvidenceSheet
        failure={runtimeFailure}
        proof={proof}
        runtimeLabel={runtimeLabel}
        runtimeStatus={runtimeStatus}
        shell={shell}
        visible={evidenceVisible}
        onClose={() => setEvidenceVisible(false)}
        onRetry={() => bootstrap().catch(() => undefined)}
      />
      <ProjectsSurface
        boundProjectId={activeConversation?.projectId ?? null}
        covered={workspaceVisible}
        refreshToken={projectRefreshToken}
        visible={projectsVisible}
        onChatInProject={chatInProject}
        onClose={() => setProjectsVisible(false)}
        onOpenFiles={project => {
          setProjectFilesScope(project);
          setWorkspaceVisible(true);
        }}
        onUnbindFromChat={unbindProjectFromConversation}
      />
      <WorkspaceDrawer
        confirmDestructive={preferences.confirmDestructiveFileActions}
        projectScope={workspaceProjectScope}
        readOnly={preferences.toolPermission === 'read-only'}
        visible={workspaceVisible}
        onClose={() => {
          setWorkspaceVisible(false);
          if (projectFilesScope !== null)
            setProjectRefreshToken(previous => previous + 1);
        }}
      />
    </KeyboardAvoidingView>
  );
}

function RoundButton({
  accessibilityLabel,
  children,
  onPress,
}: React.PropsWithChildren<{
  accessibilityLabel: string;
  onPress: () => void;
}>) {
  const { colors } = useAppPresentation();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      hitSlop={hitSlop}
      onPress={onPress}
      style={({ pressed }) => [styles.roundButton, pressed && styles.pressed]}
    >
      {children}
    </Pressable>
  );
}

const createStyles = (colors: ThemePalette) =>
  StyleSheet.create({
    agentPanel: {
      marginTop: 6,
      borderRadius: 14,
      backgroundColor: colors.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
      paddingHorizontal: 12,
      paddingVertical: 8,
      gap: 6,
    },
    agentPanelText: { color: colors.text, fontSize: 12, fontWeight: '600' },
    agentButtonsRow: { flexDirection: 'row', gap: 8 },
    agentAllow: {
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 6,
      backgroundColor: colors.accent,
    },
    agentDeny: {
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 6,
      backgroundColor: colors.surfaceRaised,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    agentButtonText: {
      color: colors.background,
      fontSize: 12,
      fontWeight: '700',
    },
    agentButtonTextDim: {
      color: colors.textDim,
      fontSize: 12,
      fontWeight: '700',
    },
    agentTrace: {
      color: colors.muted,
      fontSize: 10,
      fontFamily: fonts.mono,
    },
    root: { flex: 1, backgroundColor: colors.background },
    screen: { flex: 1, backgroundColor: colors.background },
    topBar: {
      height: 66,
      paddingHorizontal: 16,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    titleWrap: { alignItems: 'center', maxWidth: '58%' },
    topBarSpacer: { width: 42, height: 42 },
    chatTitle: {
      color: colors.muted,
      fontFamily: fonts.body,
      fontSize: 9,
      marginTop: 3,
      maxWidth: 210,
    },
    projectContext: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 3,
      marginTop: 2,
      maxWidth: 150,
    },
    projectContextText: {
      color: colors.accent,
      fontFamily: fonts.mono,
      fontSize: 8,
      flexShrink: 1,
    },
    roundButton: {
      width: 42,
      height: 42,
      borderRadius: 21,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.line,
    },
    pressed: { opacity: 0.6, transform: [{ scale: 0.98 }] },
    runtimeGlyph: { alignItems: 'center', justifyContent: 'center' },
    runtimeDot: {
      position: 'absolute',
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.warning,
      right: -4,
      top: -3,
    },
    runtimeDotReady: { backgroundColor: colors.success },
    runtimeDotFailed: { backgroundColor: colors.danger },
    bottomArea: { paddingHorizontal: 13, gap: 5 },
    proofChip: {
      alignSelf: 'center',
      minHeight: 28,
      paddingHorizontal: 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
    },
    proofDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.warning,
    },
    proofDotReady: { backgroundColor: colors.success },
    proofDotFailed: { backgroundColor: colors.danger },
    proofText: {
      color: colors.muted,
      fontFamily: fonts.mono,
      fontSize: 8,
      fontWeight: '700',
      letterSpacing: 1.1,
    },
    notice: {
      minHeight: 42,
      borderRadius: 13,
      backgroundColor: colors.surfaceWarm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.danger,
      paddingHorizontal: 12,
      paddingVertical: 9,
      flexDirection: 'row',
      alignItems: 'center',
    },
    noticeText: { flex: 1, color: colors.danger, fontSize: 11, lineHeight: 15 },
    attachmentNotice: {
      minHeight: 34,
      borderRadius: 12,
      backgroundColor: colors.surfaceWarm,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.accent,
      paddingHorizontal: 11,
      paddingVertical: 8,
      justifyContent: 'center',
    },
    attachmentNoticeText: {
      color: colors.textDim,
      fontSize: 10,
      lineHeight: 14,
    },
    retry: {
      height: 28,
      borderRadius: 14,
      backgroundColor: colors.text,
      paddingHorizontal: 11,
      alignItems: 'center',
      justifyContent: 'center',
      marginLeft: 9,
    },
    retryText: { color: colors.background, fontSize: 10, fontWeight: '800' },
  });
