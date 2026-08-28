import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import CircleAlert from 'lucide-react-native/icons/circle-alert';
import CircleEllipsis from 'lucide-react-native/icons/circle-ellipsis';
import LoaderCircle from 'lucide-react-native/icons/loader-circle';
import Menu from 'lucide-react-native/icons/menu';
import {
  Alert,
  AccessibilityInfo,
  findNodeHandle,
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
import { ConversationOptionsPicker } from '../components/ConversationOptionsPicker';
import { HarnessPicker } from '../components/HarnessPicker';
import type { StructuredBlock } from '../components/StructuredContent';
import { ModelPicker, type SupportedModel } from '../components/ModelPicker';
import { LocalWorkspaces } from '../native/LocalWorkspaces';
import { ProjectsSurface } from '../components/ProjectsSurface';
import {
  ProjectContextSheet,
  type ProjectContextSheetBusyAction,
  type ProjectContextSheetFilter,
  type ProjectContextSheetMode,
  type ProjectContextSheetRecoveryAction,
} from '../components/ProjectContextSheet';
import {
  ProjectContextStrip,
  type ProjectContextVerificationStatus,
} from '../components/ProjectContextStrip';
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
  selectProjectContextSnapshotReferences,
  selectOrderedConversations,
  type ChatState,
  type Conversation,
  type AttachmentDescriptor,
} from '../state';
import {
  LocalRuntime,
  type ModelTransitionSource,
  type RuntimeProof,
} from '../native/LocalRuntime';
import {
  createCompletionController,
  type CompletionControllerOutcome,
  type CompletionControllerState,
} from '../completion/CompletionController';
import {
  createSessionPersistenceCoordinator,
  type SessionDurabilityResult,
} from '../completion/SessionPersistence';
import { readRuntimeEvidence } from '../runtime/evidence';
import { LocalProjects, type LocalProject } from '../native/LocalProjects';
import { LocalProjectContext } from '../native/LocalProjectContext';
import { LocalAttachments } from '../native/LocalAttachments';
import { BUILTIN_HARNESSES, DSH_HARNESS, DshHarnessAdapter } from '../harness';
import { safeHydrateAppPreferences } from '../preferences';
import {
  createProjectContextController,
  isProjectContextSendable,
  type ProjectContextActionToken,
  type ProjectContextControllerOwner,
  type ProjectContextControllerState,
} from '../project-context';
import { useAppPresentation } from '../presentation/AppPresentation';
import { fonts, hitSlop, type ThemePalette } from '../theme';

type RequestState = 'idle' | 'sending';

type PendingContextOpen = {
  readonly conversationId: string;
  readonly projectId: string;
  readonly runtimeContextId: string | null;
  readonly modelId: Conversation['modelId'];
  readonly uiEpoch: number;
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function completionBusy(state: CompletionControllerState): boolean {
  return (
    state.phase === 'preparing' ||
    state.phase === 'persistence_pending' ||
    state.phase === 'resume_available' ||
    state.phase === 'starting' ||
    state.phase === 'sending' ||
    state.phase === 'cancelling' ||
    state.phase === 'finalizing' ||
    state.phase === 'commit_pending'
  );
}

function completionCancellable(state: CompletionControllerState): boolean {
  return (
    state.phase === 'preparing' ||
    state.phase === 'starting' ||
    state.phase === 'sending'
  );
}

function completionOwnsPresentation(
  state: CompletionControllerState,
  conversationId: string,
): boolean {
  return state.conversationId === conversationId && state.phase !== 'idle';
}

function completionBlocksContextMutation(
  state: CompletionControllerState,
  conversationId: string,
): boolean {
  return state.conversationId === conversationId && completionBusy(state);
}

function projectContextOwnsMutation(
  state: ProjectContextControllerState,
): boolean {
  return (
    state.phase === 'inspecting' ||
    state.phase === 'preparing' ||
    state.phase === 'review' ||
    state.phase === 'confirming' ||
    state.phase === 'disabling' ||
    state.phase === 'persistence_pending' ||
    state.phase === 'cleanup_pending' ||
    state.candidateManifest !== null
  );
}

function sameProjectContextOwner(
  owner: ProjectContextControllerOwner | null,
  conversation: Conversation | null,
): boolean {
  return (
    owner !== null &&
    conversation !== null &&
    conversation.projectId !== null &&
    owner.conversationId === conversation.id &&
    owner.projectId === conversation.projectId &&
    owner.runtimeContextId === conversation.runtimeContextId &&
    owner.modelId === conversation.modelId
  );
}

function sameProjectContextToken(
  left: ProjectContextActionToken | null,
  right: ProjectContextActionToken | null,
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.conversationId === right.conversationId &&
    left.projectId === right.projectId &&
    left.runtimeContextId === right.runtimeContextId &&
    left.modelId === right.modelId &&
    left.generation === right.generation &&
    left.preparationId === right.preparationId &&
    left.listGeneration === right.listGeneration
  );
}

function scheduleProjectContextSearch(
  delayMilliseconds: number,
  operation: () => void,
) {
  let active = true;
  const timer = setTimeout(() => {
    if (!active) return;
    active = false;
    operation();
  }, delayMilliseconds);
  return {
    cancel: () => {
      if (!active) return;
      active = false;
      clearTimeout(timer);
    },
  };
}

function completionOwnershipKey(
  state: CompletionControllerState,
  conversationId: string | null,
  uiEpoch: number,
): string {
  return JSON.stringify([
    uiEpoch,
    conversationId,
    state.epoch,
    state.phase,
    state.conversationId,
    state.turnId,
    state.attemptId,
    state.roundId,
  ]);
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
    messageCount: conversation.messages.length,
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
  const draftAttachmentsRef = useRef<readonly AttachmentDescriptor[]>([]);
  draftAttachmentsRef.current = draftAttachments;
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
  const [contextSheetVisible, setContextSheetVisible] = useState(false);
  const contextSheetVisibleRef = useRef(false);
  contextSheetVisibleRef.current = contextSheetVisible;
  const navigationSurfaceVisibleRef = useRef(false);
  const [contextSheetFilter, setContextSheetFilter] =
    useState<ProjectContextSheetFilter>('all');
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
  const [proof, setProof] = useState<RuntimeProof | null>(null);
  const [runtimeFailure, setRuntimeFailure] = useState<string | null>(null);
  const [requestFailure, setRequestFailure] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const attachmentOperationGeneration = useRef(0);
  const activeAttachmentOperation = useRef<{
    generation: number;
    conversationId: string;
    stale: boolean;
  } | null>(null);
  const activeAttachmentPreviewId = useRef<string | null>(null);
  const afterDrawerDismiss = useRef<(() => void) | null>(null);
  const afterActionDismiss = useRef<(() => void) | null>(null);
  const pendingContextOpenAfterProjectsDismiss =
    useRef<PendingContextOpen | null>(null);
  const pendingContextAttachAfterOpen = useRef<PendingContextOpen | null>(null);
  const projectChatTransitionInFlight = useRef(false);
  const projectContextUiEpoch = useRef(0);
  const projectContextStripRef =
    useRef<React.ElementRef<typeof View> | null>(null);
  const projectContextStripTarget = useRef<number | null>(null);
  const completionUiEpoch = useRef(0);
  const retryActionInFlight = useRef(false);
  const started = useRef(false);
  const nativeAvailable = useMemo(() => DshHarnessAdapter.isAvailable(), []);
  const activeHarness =
    BUILTIN_HARNESSES.get(preferences.selectedHarnessId) ?? DSH_HARNESS;

  useEffect(() => store.subscribe(setChatState), [store]);

  useEffect(() => {
    const operation = activeAttachmentOperation.current;
    if (
      operation !== null &&
      chatState.selectedConversationId !== operation.conversationId
    ) {
      operation.stale = true;
    }
  }, [chatState.selectedConversationId]);

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

  const sessionPersistence = useMemo(
    () =>
      createSessionPersistenceCoordinator({
        persistSession: json => LocalRuntime.persistSession(json),
        loadSession: () => LocalRuntime.loadSession(),
      }),
    [],
  );

  const persistCurrent = useCallback(
    async (): Promise<SessionDurabilityResult> => {
      if (!nativeAvailable) {
        setStorageWarning(t('home.persistenceUnavailable'));
        return { status: 'unknown' };
      }
      try {
        const snapshot = JSON.parse(
          store.serialize(),
        ) as Record<string, unknown>;
        snapshot.preferences = JSON.parse(
          preferencesStore.serialize(),
        ) as unknown;
        const result = await sessionPersistence.write(
          JSON.stringify(snapshot),
        );
        if (result.status === 'committed') {
          setStorageWarning(null);
        } else {
          setStorageWarning(
            t('home.saveFailed', { error: result.status }),
          );
        }
        return result;
      } catch (error) {
        setStorageWarning(t('home.saveFailed', { error: errorText(error) }));
        return { status: 'unknown' };
      }
    },
    [
      nativeAvailable,
      preferencesStore,
      sessionPersistence,
      store,
      t,
    ],
  );

  const persist = useCallback(async (): Promise<boolean> => {
    return (await persistCurrent()).status === 'committed';
  }, [persistCurrent]);

  const persistCurrentRef = useRef(persistCurrent);
  persistCurrentRef.current = persistCurrent;
  const completionController = useMemo(
    () =>
      createCompletionController({
        chat: store,
        persistCurrent: () => persistCurrentRef.current(),
        completeRoundV2: request =>
          DshHarnessAdapter.completeRoundV2(request),
        completeRoundV3: request =>
          DshHarnessAdapter.completeRoundV3(request),
        cancelRoundV2: roundId =>
          DshHarnessAdapter.cancelRoundV2(roundId),
        cancelRoundV3: roundId =>
          DshHarnessAdapter.cancelRoundV3(roundId),
        createRoundId: () => LocalRuntime.createCompletionRequestId(),
      }),
    [store],
  );
  const [completionState, setCompletionState] =
    useState<CompletionControllerState>(() =>
      completionController.getState(),
    );
  useEffect(
    () => completionController.subscribe(setCompletionState),
    [completionController],
  );
  const projectContextNativeAvailable = useMemo(
    () => LocalProjectContext.isAvailable(),
    [],
  );
  const projectContextController = useMemo(
    () =>
      createProjectContextController({
        chat: store,
        native: LocalProjectContext,
        persistCurrent: () => persistCurrentRef.current(),
        createPreparationId: () => LocalRuntime.createCompletionRequestId(),
        completionMutationBlocked: conversationId =>
          completionBlocksContextMutation(
            completionController.getState(),
            conversationId,
          ),
        snapshotReferences: (conversationId, snapshotId) =>
          selectProjectContextSnapshotReferences(
            store.getState(),
            conversationId,
            snapshotId,
          ),
        scheduleSearch: scheduleProjectContextSearch,
        maximumPendingPersistence: 1,
      }),
    [completionController, store],
  );
  const [projectContextControllerState, setProjectContextControllerState] =
    useState<ProjectContextControllerState>(() =>
      projectContextController.getState(),
    );
  useEffect(
    () => projectContextController.subscribe(setProjectContextControllerState),
    [projectContextController],
  );
  const requestState: RequestState = completionBusy(completionState)
    ? 'sending'
    : 'idle';
  const attachmentOwnershipKey = completionOwnershipKey(
    completionState,
    chatState.selectedConversationId,
    completionUiEpoch.current,
  );
  const completionRetryVisible =
    completionState.phase === 'retryable' ||
    completionState.phase === 'resume_available' ||
    completionState.phase === 'persistence_pending' ||
    completionState.phase === 'commit_pending';
  const durabilityFailure =
    completionState.phase === 'persistence_pending' ||
    completionState.phase === 'commit_pending'
      ? completionState.failureCode ?? 'E_ATTEMPT_PERSISTENCE'
      : null;
  const visibleRequestFailure =
    durabilityFailure ??
    requestFailure ??
    (completionRetryVisible
      ? completionState.failureCode ??
        (completionState.phase === 'resume_available'
          ? 'E_ATTEMPT_INTERRUPTED'
          : t('home.responseStopped'))
      : null);

  const applyCompletionOutcome = useCallback(
    (result: CompletionControllerOutcome, expectedEpoch: number) => {
      if (expectedEpoch !== completionUiEpoch.current) return;
      if (
        result.conversationId !== null &&
        store.getState().selectedConversationId !== result.conversationId
      ) {
        return;
      }
      if (result.status === 'completed') {
        setRequestFailure(null);
      } else if (result.status === 'cancelled') {
        setRequestFailure(t('home.responseStopped'));
      } else {
        setRequestFailure(result.code ?? 'E_COMPLETION_NATIVE');
      }
    },
    [store, t],
  );

  const ensureConversation = useCallback((): string => {
    const selected = store.getState().selectedConversationId;
    if (selected !== null) return selected;
    return store.createConversation({
      modelId: preferencesStore.getState().defaultModel,
      thinkingMode: preferencesStore.getState().thinkingMode,
    });
  }, [preferencesStore, store]);

  const reconcileSelectedConversation = useCallback(
    (conversationId: string) => {
      completionController.reconcileHydrated(conversationId);
      if (!projectContextNativeAvailable) return;
      if (
        completionOwnsPresentation(
          completionController.getState(),
          conversationId,
        ) ||
        selectProjectContextSnapshotReferences(
          store.getState(),
          conversationId,
        ).length > 0
      ) {
        return;
      }
      projectContextController
        .reconcileHydrated(conversationId)
        .catch(() => undefined);
    },
    [
      completionController,
      projectContextController,
      projectContextNativeAvailable,
      store,
    ],
  );

  const hydrateStoredState = useCallback(
    (stored: string | null) => {
      if (stored === null) {
        const conversationId = ensureConversation();
        reconcileSelectedConversation(conversationId);
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
        const selected = store.getState().selectedConversationId;
        if (selected !== null) reconcileSelectedConversation(selected);
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
    [ensureConversation, preferencesStore, reconcileSelectedConversation, store, t],
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
  const projectContextOwnerAligned = sameProjectContextOwner(
    projectContextControllerState.owner,
    activeConversation,
  );
  const projectContextVerificationStatus: ProjectContextVerificationStatus =
    !projectContextNativeAvailable ||
    activeConversation?.projectContext?.status === 'unavailable'
      ? 'unavailable'
      : !projectContextOwnerAligned
        ? 'checking'
        : projectContextControllerState.phase === 'persistence_pending' ||
          projectContextControllerState.phase === 'cleanup_pending'
        ? 'recovery'
        : projectContextControllerState.failureCode !== null ||
            projectContextControllerState.phase === 'blocked'
          ? 'error'
          : projectContextControllerState.phase === 'inspecting' ||
              projectContextControllerState.phase === 'preparing' ||
              projectContextControllerState.phase === 'confirming' ||
              projectContextControllerState.phase === 'disabling'
            ? 'checking'
            : 'verified';
  const projectContextCandidateManifest =
    projectContextOwnerAligned
      ? projectContextControllerState.candidateManifest
      : null;
  const projectContextManifest =
    projectContextCandidateManifest ??
    activeConversation?.projectContext?.snapshot ??
    null;
  const projectContextConfirmationRequired =
    projectContextControllerState.phase === 'review' &&
    projectContextCandidateManifest !== null;
  const projectContextSheetMode: ProjectContextSheetMode =
    projectContextManifest === null ? 'candidates' : 'disclosure';
  const projectContextBusyAction: ProjectContextSheetBusyAction =
    !projectContextOwnerAligned
      ? null
      : projectContextControllerState.phase === 'preparing'
      ? 'prepare'
      : projectContextControllerState.phase === 'confirming'
        ? 'confirm'
        : projectContextControllerState.phase === 'inspecting'
          ? 'refresh'
          : projectContextControllerState.phase === 'disabling'
            ? 'disable'
            : null;
  const projectContextRecoveryAction: ProjectContextSheetRecoveryAction =
    !projectContextOwnerAligned
      ? null
      : projectContextControllerState.phase === 'persistence_pending'
      ? 'persistence'
      : projectContextControllerState.phase === 'cleanup_pending'
        ? 'cleanup'
        : null;
  const projectContextActionToken = projectContextOwnerAligned
    ? projectContextController.getActionToken()
    : null;
  const completionBlocksActiveProjectMutation =
    activeConversation !== null &&
    completionBlocksContextMutation(completionState, activeConversation.id);
  const projectContextHasSnapshotReferences =
    activeConversation !== null &&
    selectProjectContextSnapshotReferences(
      chatState,
      activeConversation.id,
    ).length > 0;
  const projectContextActionsDisabled =
    projectContextActionToken === null ||
    completionBlocksActiveProjectMutation ||
    projectContextHasSnapshotReferences;
  const projectContextLocksComposer =
    activeConversation?.projectId !== null &&
    activeConversation?.projectId !== undefined &&
    projectContextOwnerAligned &&
    projectContextOwnsMutation(projectContextControllerState);
  const projectContextRenderEpoch = projectContextUiEpoch.current;
  const projectContextActionKey = JSON.stringify([
    projectContextRenderEpoch,
    contextSheetVisible,
    activeConversation?.id ?? null,
    projectContextActionToken?.generation ?? null,
    projectContextActionToken?.listGeneration ?? null,
    projectContextActionToken?.preparationId ?? null,
    projectContextActionToken?.projectId ?? null,
    projectContextActionToken?.runtimeContextId ?? null,
    projectContextActionToken?.modelId ?? null,
  ]);
  useEffect(() => {
    if (!projectContextNativeAvailable || activeConversation === null) return;
    if (
      activeConversation.projectId === null ||
      activeConversation.projectContext === null ||
      completionOwnsPresentation(completionState, activeConversation.id) ||
      selectProjectContextSnapshotReferences(
        store.getState(),
        activeConversation.id,
      ).length > 0
    ) {
      return;
    }
    const controllerState = projectContextController.getState();
    if (sameProjectContextOwner(controllerState.owner, activeConversation)) {
      return;
    }
    if (projectContextOwnsMutation(controllerState)) {
      return;
    }
    projectContextController
      .reconcileHydrated(activeConversation.id)
      .catch(() => undefined);
  }, [
    activeConversation,
    completionState,
    projectContextController,
    projectContextControllerState,
    projectContextNativeAvailable,
    store,
  ]);
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
    if (!nativeAvailable) return;
    try {
      const credential = await DshHarnessAdapter.credentialStatus();
      const configured = credential.status === 'configured';
      setCredentialConfigured(configured);
      if (!configured) {
        setProof(null);
        setRuntimeFailure(null);
        return;
      }
      setProof((await LocalRuntime.bootstrap()).proof);
      setRuntimeFailure(null);
    } catch (error) {
      setRuntimeFailure(errorText(error));
    }
  }, [nativeAvailable]);

  const changeConversationModel = useCallback(
    (
      conversationId: string,
      model: SupportedModel,
      source: ModelTransitionSource,
    ): boolean => {
      const controllerState = completionController.getState();
      if (
        completionBusy(controllerState) ||
        activeAttachmentOperation.current !== null
      ) {
        return false;
      }
      const conversation = selectConversationById(
        store.getState(),
        conversationId,
      );
      if (conversation === null || conversation.modelId === model) return false;
      const historyImageCount = conversation.messages.reduce(
        (count, message) =>
          count +
          (message.attachments?.filter(
            attachment => attachment.kind === 'image',
          ).length ?? 0),
        0,
      );
      const draftImageCount = draftAttachments.filter(
        attachment => attachment.kind === 'image',
      ).length;
      const fromModel = conversation.modelId;
      store.setModel(conversationId, model);
      LocalRuntime.recordModelTransition({
        conversation_id: conversationId,
        from_model: fromModel,
        to_model: model,
        source,
        request_epoch: controllerState.epoch,
        request_state: completionBusy(controllerState)
          ? 'sending'
          : 'idle',
        attachment_busy: activeAttachmentOperation.current !== null,
        draft_image_count: draftImageCount,
        history_image_count: historyImageCount,
      }).catch(() => undefined);
      return true;
    },
    [completionController, draftAttachments, store],
  );

  const discardDraftAttachments = useCallback(() => {
    const referencedIds = new Set(referencedAttachmentIds(store.getState()));
    const ids = draftAttachments
      .map(attachment => attachment.id)
      .filter(id => !referencedIds.has(id));
    draftAttachmentsRef.current = [];
    setDraftAttachments([]);
    if (ids.length > 0 && LocalAttachments.isAvailable()) {
      LocalAttachments.discard(ids).catch(error =>
        setRequestFailure(
          t('messages.attachment.failed', { error: errorText(error) }),
        ),
      );
    }
  }, [draftAttachments, referencedAttachmentIds, store, t]);

  const markAttachmentOperationStale = useCallback(() => {
    if (activeAttachmentOperation.current !== null) {
      activeAttachmentOperation.current.stale = true;
    }
  }, []);

  const addAttachment = useCallback(
    async (source: AttachmentSource, expectedOwnershipKey: string) => {
      const liveOwnershipKey = completionOwnershipKey(
        completionController.getState(),
        store.getState().selectedConversationId,
        completionUiEpoch.current,
      );
      if (
        expectedOwnershipKey !== liveOwnershipKey ||
        completionBusy(completionController.getState())
      ) {
        return;
      }
      if (
        !LocalAttachments.isAvailable() ||
        activeAttachmentOperation.current !== null
      ) {
        setRequestFailure(t('messages.attachment.unsupported'));
        return;
      }
      const conversationId = ensureConversation();
      const generation = ++attachmentOperationGeneration.current;
      activeAttachmentOperation.current = {
        generation,
        conversationId,
        stale: false,
      };
      const discardUnreferenced = (attachments: readonly AttachmentDescriptor[]) => {
        const liveDraftAttachments = draftAttachmentsRef.current;
        const protectedIds = new Set([
          ...referencedAttachmentIds(store.getState()),
          ...liveDraftAttachments.map(attachment => attachment.id),
        ]);
        const ids = attachments
          .map(attachment => attachment.id)
          .filter(id => !protectedIds.has(id));
        return ids.length === 0
          ? Promise.resolve()
          : LocalAttachments.discard(ids).then(() => undefined);
      };
      setAttachmentBusy(true);
      setRequestFailure(null);
      try {
        const nativeOperation = LocalAttachments.present(source);
        // A native picker may finish after our timeout. If this operation is
        // no longer current, reclaim every returned opaque attachment instead
        // of leaking it into native storage.
        nativeOperation
          .then(result => {
            if (
              activeAttachmentOperation.current?.generation !== generation &&
              result.attachments.length > 0
            ) {
              discardUnreferenced(result.attachments).catch(() => undefined);
            }
          })
          .catch(() => undefined);
        const result = await waitForAttachmentPicker(
          nativeOperation,
          t('messages.attachment.timeout'),
        );
        if (result.status === 'cancelled' || result.attachments.length === 0)
          return;
        const selectedConversationId = store.getState().selectedConversationId;
        const operation = activeAttachmentOperation.current;
        if (
          operation?.generation !== generation ||
          operation.conversationId !== conversationId ||
          operation.stale ||
          selectedConversationId !== conversationId ||
          expectedOwnershipKey !==
            completionOwnershipKey(
              completionController.getState(),
              selectedConversationId,
              completionUiEpoch.current,
            ) ||
          completionBusy(completionController.getState()) ||
          selectConversationById(store.getState(), conversationId) === null
        ) {
          await discardUnreferenced(result.attachments).catch(() => undefined);
          return;
        }
        const liveDraftAttachments = draftAttachmentsRef.current;
        const ids = new Set(
          liveDraftAttachments.map(attachment => attachment.id),
        );
        let totalSize = liveDraftAttachments.reduce(
          (sum, attachment) => sum + attachment.size,
          0,
        );
        const accepted: AttachmentDescriptor[] = [];
        const overflow: AttachmentDescriptor[] = [];
        result.attachments.forEach(attachment => {
          if (ids.has(attachment.id)) return;
          ids.add(attachment.id);
          if (
            liveDraftAttachments.length + accepted.length >=
              MAX_ATTACHMENTS_PER_MESSAGE ||
            totalSize + attachment.size > MAX_TOTAL_ATTACHMENT_SIZE
          ) {
            overflow.push(attachment);
            return;
          }
          totalSize += attachment.size;
          accepted.push(attachment);
        });
        const nextAttachments = [...liveDraftAttachments, ...accepted];
        draftAttachmentsRef.current = nextAttachments;
        setDraftAttachments(nextAttachments);
        if (overflow.length > 0) {
          LocalAttachments.discard(
            overflow.map(attachment => attachment.id),
          ).catch(() => undefined);
          setRequestFailure(t('messages.attachment.limit'));
        }
      } catch (error) {
        const operation = activeAttachmentOperation.current;
        if (
          operation?.generation === generation &&
          !operation.stale &&
          store.getState().selectedConversationId === conversationId &&
          expectedOwnershipKey ===
            completionOwnershipKey(
              completionController.getState(),
              conversationId,
              completionUiEpoch.current,
            ) &&
          !completionBusy(completionController.getState())
        ) {
          setRequestFailure(
            t('messages.attachment.failed', { error: errorText(error) }),
          );
        }
      } finally {
        if (activeAttachmentOperation.current?.generation === generation) {
          activeAttachmentOperation.current = null;
          setAttachmentBusy(false);
        }
      }
    },
    [
      completionController,
      ensureConversation,
      referencedAttachmentIds,
      store,
      t,
    ],
  );

  const removeDraftAttachment = useCallback(
    (id: string, expectedOwnershipKey: string) => {
      const liveOwnershipKey = completionOwnershipKey(
        completionController.getState(),
        store.getState().selectedConversationId,
        completionUiEpoch.current,
      );
      if (
        expectedOwnershipKey !== liveOwnershipKey ||
        completionBusy(completionController.getState()) ||
        activeAttachmentOperation.current !== null ||
        activeAttachmentPreviewId.current !== null ||
        !draftAttachmentsRef.current.some(attachment => attachment.id === id)
      ) {
        return;
      }
      const nextAttachments = draftAttachmentsRef.current.filter(
        attachment => attachment.id !== id,
      );
      draftAttachmentsRef.current = nextAttachments;
      setDraftAttachments(nextAttachments);
      const referenced = referencedAttachmentIds(store.getState()).includes(id);
      if (!referenced && LocalAttachments.isAvailable()) {
        LocalAttachments.discard([id]).catch(error =>
          setRequestFailure(
            t('messages.attachment.failed', { error: errorText(error) }),
          ),
        );
      }
    },
    [completionController, referencedAttachmentIds, store, t],
  );

  const presentAttachmentPreview = useCallback(
    async (id: string, expectedOwnershipKey: string) => {
      const liveOwnershipKey = completionOwnershipKey(
        completionController.getState(),
        store.getState().selectedConversationId,
        completionUiEpoch.current,
      );
      if (
        activeAttachmentPreviewId.current !== null ||
        activeAttachmentOperation.current !== null ||
        completionBusy(completionController.getState()) ||
        expectedOwnershipKey !== liveOwnershipKey
      )
        return;
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
        if (
          activeAttachmentPreviewId.current === id &&
          expectedOwnershipKey ===
            completionOwnershipKey(
              completionController.getState(),
              store.getState().selectedConversationId,
              completionUiEpoch.current,
            ) &&
          !completionBusy(completionController.getState())
        ) {
          setRequestFailure(
            t('messages.attachment.previewFailed', { error: errorText(error) }),
          );
        }
      } finally {
        if (activeAttachmentPreviewId.current === id) {
          activeAttachmentPreviewId.current = null;
          setPreviewingAttachmentId(null);
        }
      }
    },
    [completionController, store, t],
  );

  const send = useCallback(async () => {
    const prompt = draft.trim();
    const outgoingAttachments = draftAttachments;
    if (
      !credentialConfigured ||
      (prompt.length === 0 && outgoingAttachments.length === 0) ||
      completionBusy(completionController.getState()) ||
      activeAttachmentOperation.current !== null ||
      activeAttachmentPreviewId.current !== null
    )
      return;
    const conversationId = ensureConversation();
    const beforeAppend = selectConversationById(
      store.getState(),
      conversationId,
    );
    if (
      beforeAppend?.projectId !== null &&
      beforeAppend?.projectId !== undefined &&
      (beforeAppend.projectContext === null ||
        !isProjectContextSendable(beforeAppend.projectContext) ||
        !projectContextNativeAvailable ||
        !sameProjectContextOwner(
          projectContextController.getState().owner,
          beforeAppend,
        ) ||
        projectContextController.getState().phase !== 'idle' ||
        projectContextController.getState().candidateManifest !== null)
    ) {
      return;
    }
    const historyNeedsVision =
      beforeAppend?.messages.some(message =>
        message.attachments?.some(attachment => attachment.kind === 'image'),
      ) === true ||
      outgoingAttachments.some(attachment => attachment.kind === 'image');
    let visionModelChanged = false;
    if (
      historyNeedsVision &&
      beforeAppend?.modelId !== 'deepseek-v4-flash-vision-exp'
    ) {
      visionModelChanged = changeConversationModel(
        conversationId,
        'deepseek-v4-flash-vision-exp',
        'send_image_guard',
      );
      if (visionModelChanged) {
        setAttachmentNotice(t('messages.attachment.visionEnabled'));
      }
    }
    if (visionModelChanged && beforeAppend?.projectId !== null) {
      if (await persist()) reconcileSelectedConversation(conversationId);
      return;
    }
    const attachmentIds = outgoingAttachments.map(attachment => attachment.id);
    setAttachmentNotice(null);
    setRequestFailure(null);
    const outcomeEpoch = ++completionUiEpoch.current;
    const result = await completionController.send(
      {
        conversationId,
        text: prompt,
        attachments: outgoingAttachments,
      },
      {
        onPreparedDurable: () => {
          setDraft(current => (current.trim() === prompt ? '' : current));
          setDraftAttachments(current => {
            const next =
              current.length === attachmentIds.length &&
              current.every((attachment, index) =>
                attachment.id === attachmentIds[index],
              )
                ? []
                : current;
            draftAttachmentsRef.current = next;
            return next;
          });
        },
        onCommitted: () => {
          refreshProof().catch(() => undefined);
        },
      },
    );
    applyCompletionOutcome(result, outcomeEpoch);
  }, [
    applyCompletionOutcome,
    changeConversationModel,
    completionController,
    credentialConfigured,
    draft,
    draftAttachments,
    ensureConversation,
    projectContextController,
    projectContextNativeAvailable,
    persist,
    reconcileSelectedConversation,
    refreshProof,
    store,
    t,
  ]);

  const retry = useCallback(async (expected: CompletionControllerState) => {
    if (
      retryActionInFlight.current ||
      activeAttachmentOperation.current !== null ||
      activeAttachmentPreviewId.current !== null
    )
      return;
    const current = completionController.getState();
    if (
      current.epoch !== expected.epoch ||
      current.phase !== expected.phase ||
      current.conversationId !== expected.conversationId ||
      current.attemptId !== expected.attemptId ||
      current.roundId !== expected.roundId
    ) {
      return;
    }
    const actionable =
      current.phase === 'persistence_pending' ||
      current.phase === 'commit_pending' ||
      ((current.phase === 'resume_available' ||
        current.phase === 'retryable') &&
        current.conversationId !== null &&
        current.attemptId !== null);
    if (!actionable) return;
    retryActionInFlight.current = true;
    const outcomeEpoch = ++completionUiEpoch.current;
    let result: CompletionControllerOutcome | null = null;
    try {
      if (current.phase === 'persistence_pending') {
        result = await completionController.retryPersistence();
      } else if (current.phase === 'commit_pending') {
        result = await completionController.retryCommit();
      } else if (
        current.phase === 'resume_available' &&
        current.conversationId !== null &&
        current.attemptId !== null
      ) {
        result = await completionController.resume(
          current.conversationId,
          current.attemptId,
          { onCommitted: () => refreshProof().catch(() => undefined) },
        );
      } else if (
        current.phase === 'retryable' &&
        current.conversationId !== null &&
        current.attemptId !== null
      ) {
        result = await completionController.retry(
          current.conversationId,
          current.attemptId,
          { onCommitted: () => refreshProof().catch(() => undefined) },
        );
      }
      if (result !== null) applyCompletionOutcome(result, outcomeEpoch);
    } finally {
      retryActionInFlight.current = false;
    }
  }, [applyCompletionOutcome, completionController, refreshProof]);

  const cancel = useCallback(async (expected: CompletionControllerState) => {
    const owned = completionController.getState();
    if (
      !completionCancellable(owned) ||
      owned.epoch !== expected.epoch ||
      owned.conversationId !== expected.conversationId ||
      owned.attemptId !== expected.attemptId ||
      owned.roundId !== expected.roundId
    ) {
      return;
    }
    const outcomeEpoch = ++completionUiEpoch.current;
    await completionController.cancel();
    if (outcomeEpoch !== completionUiEpoch.current) return;
    const current = completionController.getState();
    if (
      current.phase === 'persistence_pending' ||
      current.phase === 'blocked'
    ) {
      setRequestFailure(current.failureCode ?? 'E_ATTEMPT_PERSISTENCE');
    } else {
      setRequestFailure(t('home.responseStopped'));
    }
  }, [completionController, t]);

  const createConversation = useCallback(async () => {
    const currentId = store.getState().selectedConversationId;
    if (
      currentId !== null &&
      !(await projectContextController.beforeConversationChange(currentId))
    ) {
      return;
    }
    if (
      currentId !== null &&
      !(await completionController.beforeConversationChange(currentId))
    ) {
      return;
    }
    completionUiEpoch.current += 1;
    markAttachmentOperationStale();
    discardDraftAttachments();
    store.createConversation({
      modelId: preferencesStore.getState().defaultModel,
      thinkingMode: preferencesStore.getState().thinkingMode,
    });
    setDraft('');
    setAttachmentNotice(null);
    setRequestFailure(null);
    setDrawerVisible(false);
    reconcileSelectedConversation(store.getState().selectedConversationId!);
    await persist();
  }, [
    completionController,
    discardDraftAttachments,
    markAttachmentOperationStale,
    persist,
    preferencesStore,
    projectContextController,
    reconcileSelectedConversation,
    store,
  ]);

  const selectConversation = useCallback(
    async (id: string) => {
      const currentId = store.getState().selectedConversationId;
      if (
        currentId !== null &&
        !(await projectContextController.beforeConversationChange(currentId))
      ) {
        return;
      }
      if (
        currentId !== null &&
        !(await completionController.beforeConversationChange(currentId))
      ) {
        return;
      }
      completionUiEpoch.current += 1;
      markAttachmentOperationStale();
      discardDraftAttachments();
      store.selectConversation(id);
      setDraft('');
      setAttachmentNotice(null);
      setRequestFailure(null);
      setDrawerVisible(false);
      reconcileSelectedConversation(id);
      await persist();
    },
    [
      completionController,
      discardDraftAttachments,
      markAttachmentOperationStale,
      persist,
      projectContextController,
      reconcileSelectedConversation,
      store,
    ],
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
          onPress: () =>
            (async () => {
              if (
                !(await projectContextController.beforeConversationDelete(
                  deleting,
                ))
              ) {
                return;
              }
              if (
                !(await completionController.beforeConversationDelete(deleting))
              ) {
                return;
              }
              completionUiEpoch.current += 1;
              setRequestFailure(null);
              const deletingConversation = selectConversationById(
                store.getState(),
                deleting,
              );
              const candidateAttachmentIds = Array.from(
                new Set(
                  (deletingConversation?.messages ?? []).flatMap(message =>
                    (message.attachments ?? []).map(
                      attachment => attachment.id,
                    ),
                  ),
                ),
              );
              if (store.getState().selectedConversationId === deleting) {
                markAttachmentOperationStale();
                discardDraftAttachments();
                setDraft('');
              }
              store.deleteConversation(deleting);
              if (store.getState().selectedConversationId === null) {
                store.createConversation({
                  modelId: preferencesStore.getState().defaultModel,
                  thinkingMode: preferencesStore.getState().thinkingMode,
                });
              }
              const selectedAfterDelete =
                store.getState().selectedConversationId;
              if (selectedAfterDelete !== null) {
                reconcileSelectedConversation(selectedAfterDelete);
              }
              const remainingIds = new Set(
                referencedAttachmentIds(store.getState()),
              );
              const orphanedIds = candidateAttachmentIds.filter(
                id => !remainingIds.has(id),
              );
              const saved = await persist();
              if (
                saved &&
                orphanedIds.length > 0 &&
                LocalAttachments.isAvailable()
              ) {
                await LocalAttachments.discard(orphanedIds);
              }
            })().catch(() => undefined),
        },
      ]);
    },
    [
      completionController,
      discardDraftAttachments,
      markAttachmentOperationStale,
      persist,
      preferencesStore,
      projectContextController,
      reconcileSelectedConversation,
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
    (model: SupportedModel, source: ModelTransitionSource) => {
      if (
        completionBusy(completionController.getState()) ||
        projectContextOwnsMutation(projectContextController.getState()) ||
        activeAttachmentOperation.current !== null
      ) {
        return;
      }
      const conversationId = ensureConversation();
      if (!changeConversationModel(conversationId, model, source)) return;
      setAttachmentNotice(null);
      persist()
        .then(saved => {
          if (saved) reconcileSelectedConversation(conversationId);
        })
        .catch(() => undefined);
    },
    [
      changeConversationModel,
      completionController,
      ensureConversation,
      persist,
      projectContextController,
      reconcileSelectedConversation,
    ],
  );

  const selectComposerModel = useCallback(
    (model: SupportedModel) => selectModel(model, 'composer_picker'),
    [selectModel],
  );

  const selectSettingsModel = useCallback(
    (model: SupportedModel) => selectModel(model, 'settings_picker'),
    [selectModel],
  );

  const selectThinkingMode = useCallback(
    (thinkingMode: Conversation['thinkingMode']) => {
      if (
        completionBusy(completionController.getState()) ||
        projectContextOwnsMutation(projectContextController.getState()) ||
        activeAttachmentOperation.current !== null
      ) {
        return;
      }
      const conversationId = ensureConversation();
      store.setThinkingMode(conversationId, thinkingMode);
      persist().catch(() => undefined);
    },
    [
      completionController,
      ensureConversation,
      persist,
      projectContextController,
      store,
    ],
  );

  const openComposerOptions = useCallback(() => {
    if (
      completionBusy(completionController.getState()) ||
      projectContextOwnsMutation(projectContextController.getState()) ||
      activeAttachmentOperation.current !== null
    ) {
      return;
    }
    setComposerOptionsVisible(true);
  }, [completionController, projectContextController]);

  const openSettings = useCallback(() => {
    if (projectContextOwnsMutation(projectContextController.getState())) return;
    setSettingsVisible(true);
  }, [projectContextController]);

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
    async (project: LocalProject) => {
      if (projectChatTransitionInFlight.current) return;
      projectChatTransitionInFlight.current = true;
      let waitForDismiss = false;
      try {
        const current = selectActiveConversation(store.getState());
        const expectedSelectedId = current?.id ?? null;
        if (
          current !== null &&
          !(await projectContextController.beforeConversationChange(current.id))
        ) {
          return;
        }
        if (store.getState().selectedConversationId !== expectedSelectedId) return;
        if (
          current !== null &&
          !(await completionController.beforeConversationChange(current.id))
        ) {
          return;
        }
        if (store.getState().selectedConversationId !== expectedSelectedId) return;
        completionUiEpoch.current += 1;
        setRequestFailure(null);
        if (current?.projectId !== project.id) {
          if (current === null || current.messages.length > 0) {
            markAttachmentOperationStale();
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
        const selected = store.getState().selectedConversationId;
        if (selected === null || !(await persist())) return;
        const selectedConversation = selectConversationById(
          store.getState(),
          selected,
        );
        if (
          selectedConversation === null ||
          selectedConversation.projectId !== project.id
        ) {
          return;
        }
        const uiEpoch = ++projectContextUiEpoch.current;
        pendingContextOpenAfterProjectsDismiss.current = {
          conversationId: selected,
          projectId: project.id,
          runtimeContextId: selectedConversation.runtimeContextId,
          modelId: selectedConversation.modelId,
          uiEpoch,
        };
        waitForDismiss = true;
        setProjectsVisible(false);
      } finally {
        if (!waitForDismiss) projectChatTransitionInFlight.current = false;
      }
    },
    [
      completionController,
      discardDraftAttachments,
      markAttachmentOperationStale,
      persist,
      preferencesStore,
      projectContextController,
      store,
    ],
  );

  const handleProjectsDismiss = useCallback(() => {
    const pending = pendingContextOpenAfterProjectsDismiss.current;
    pendingContextOpenAfterProjectsDismiss.current = null;
    if (pending === null) return;
    projectChatTransitionInFlight.current = false;
    const selected = selectActiveConversation(store.getState());
    if (
      selected === null ||
      selected.id !== pending.conversationId ||
      selected.projectId !== pending.projectId ||
      selected.runtimeContextId !== pending.runtimeContextId ||
      selected.modelId !== pending.modelId ||
      projectContextUiEpoch.current !== pending.uiEpoch
    ) {
      return;
    }
    setContextSheetFilter('all');
    contextSheetVisibleRef.current = true;
    setContextSheetVisible(true);
    if (
      completionOwnsPresentation(
        completionController.getState(),
        selected.id,
      ) ||
      selectProjectContextSnapshotReferences(store.getState(), selected.id)
        .length > 0 ||
      !projectContextNativeAvailable
    ) {
      return;
    }
    pendingContextAttachAfterOpen.current = pending;
  }, [
    completionController,
    projectContextNativeAvailable,
    store,
  ]);

  useEffect(() => {
    if (!contextSheetVisible) return;
    const pending = pendingContextAttachAfterOpen.current;
    pendingContextAttachAfterOpen.current = null;
    if (pending === null) return;
    (async () => {
      await projectContextController.attachConversation(pending.conversationId);
      const current = selectActiveConversation(store.getState());
      if (
        !contextSheetVisibleRef.current ||
        current === null ||
        current.id !== pending.conversationId ||
        current.projectId !== pending.projectId ||
        current.runtimeContextId !== pending.runtimeContextId ||
        current.modelId !== pending.modelId ||
        projectContextUiEpoch.current !== pending.uiEpoch
      ) {
        return;
      }
      const token = projectContextController.getActionToken();
      if (token !== null && current.projectContext?.snapshot === null) {
        projectContextController.search(token, '').catch(() => undefined);
      }
    })().catch(() => undefined);
  }, [contextSheetVisible, projectContextController, store]);

  const openProjectContextFromStrip = useCallback(() => {
    if (
      contextSheetVisibleRef.current ||
      navigationSurfaceVisibleRef.current
    ) {
      return;
    }
    const selected = selectActiveConversation(store.getState());
    if (
      selected === null ||
      selected.projectId === null ||
      selected.projectContext === null
    ) {
      return;
    }
    const uiEpoch = ++projectContextUiEpoch.current;
    setContextSheetFilter('all');
    contextSheetVisibleRef.current = true;
    setContextSheetVisible(true);
    if (
      completionOwnsPresentation(
        completionController.getState(),
        selected.id,
      ) ||
      selectProjectContextSnapshotReferences(store.getState(), selected.id)
        .length > 0 ||
      !projectContextNativeAvailable
    ) {
      return;
    }
    const controllerState = projectContextController.getState();
    if (sameProjectContextOwner(controllerState.owner, selected)) return;
    projectContextController
      .attachConversation(selected.id)
      .then(() => {
        if (
          projectContextUiEpoch.current !== uiEpoch ||
          store.getState().selectedConversationId !== selected.id
        ) {
          return;
        }
        const current = selectConversationById(store.getState(), selected.id);
        const token = projectContextController.getActionToken();
        if (
          current?.projectContext?.snapshot === null &&
          token !== null
        ) {
          projectContextController.search(token, '').catch(() => undefined);
        }
      })
      .catch(() => undefined);
  }, [
    completionController,
    projectContextController,
    projectContextNativeAvailable,
    store,
  ]);

  const projectContextActionIsLive = (
    expected: ProjectContextActionToken | null,
  ): expected is ProjectContextActionToken => {
    if (
      !contextSheetVisibleRef.current ||
      projectContextUiEpoch.current !== projectContextRenderEpoch ||
      expected === null
    ) {
      return false;
    }
    const selected = selectActiveConversation(store.getState());
    if (
      selected === null ||
      selected.id !== expected.conversationId ||
      selected.projectId !== expected.projectId ||
      completionBlocksContextMutation(
        completionController.getState(),
        selected.id,
      ) ||
      selectProjectContextSnapshotReferences(store.getState(), selected.id)
        .length > 0
    ) {
      return false;
    }
    return sameProjectContextToken(
      expected,
      projectContextController.getActionToken(),
    );
  };

  const closeProjectContextSheet = () => {
    contextSheetVisibleRef.current = false;
    projectContextUiEpoch.current += 1;
    setContextSheetVisible(false);
  };

  const completeProjectContextAction = (
    expected: ProjectContextActionToken,
    closeOnSuccess: boolean,
    operation: () => Promise<{ readonly status: string }>,
  ) => {
    if (!projectContextActionIsLive(expected)) return;
    const capturedEpoch = projectContextRenderEpoch;
    operation()
      .then(outcome => {
        const selected = selectConversationById(
          store.getState(),
          expected.conversationId,
        );
        if (
          closeOnSuccess &&
          outcome.status === 'completed' &&
          contextSheetVisibleRef.current &&
          projectContextUiEpoch.current === capturedEpoch &&
          store.getState().selectedConversationId === expected.conversationId &&
          selected?.projectId === expected.projectId &&
          selected.runtimeContextId === expected.runtimeContextId &&
          selected.modelId === expected.modelId
        ) {
          closeProjectContextSheet();
        }
      })
      .catch(() => undefined);
  };

  const handleProjectContextDismiss = () => {
    const target =
      findNodeHandle(projectContextStripRef.current) ??
      projectContextStripTarget.current;
    if (typeof target === 'number') {
      AccessibilityInfo.setAccessibilityFocus(target);
    }
  };

  const unbindProjectFromConversation = useCallback(async () => {
    const conversationId = store.getState().selectedConversationId;
    if (conversationId === null) return;
    if (
      !(await completionController.beforeConversationChange(conversationId))
    ) {
      return;
    }
    completionUiEpoch.current += 1;
    setRequestFailure(null);
    store.unbindConversationFromProject(conversationId);
    setActiveProjectName(null);
    completionController.reconcileHydrated(conversationId);
    await persist();
  }, [completionController, persist, store]);

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
    workspaceVisible ||
    contextSheetVisible;
  navigationSurfaceVisibleRef.current = navigationSurfaceVisible;
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
              presentAttachmentPreview(id, attachmentOwnershipKey).catch(
                () => undefined,
              );
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
          {(visibleRequestFailure !== null || storageWarning !== null) && (
            <View style={styles.notice}>
              <Text numberOfLines={3} style={styles.noticeText}>
                {visibleRequestFailure ?? storageWarning}
              </Text>
              {completionRetryVisible && visibleRequestFailure !== null && (
                <Pressable
                  accessibilityLabel={t('messages.retryResponse')}
                  accessibilityRole="button"
                  accessibilityState={{
                    disabled:
                      attachmentBusy || previewingAttachmentId !== null,
                  }}
                  disabled={attachmentBusy || previewingAttachmentId !== null}
                  hitSlop={hitSlop}
                  onPress={() =>
                    retry(completionState).catch(() => undefined)
                  }
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
          {attachmentNotice !== null && visibleRequestFailure === null && (
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
          {activeConversation?.projectContext !== null &&
            activeConversation?.projectContext !== undefined &&
            activeConversation.projectId !== null && (
              <View
                collapsable={false}
                onLayout={event => {
                  if (typeof event.target === 'number') {
                    projectContextStripTarget.current = event.target;
                  }
                }}
                testID="project-context-strip-focus-target"
              >
                <ProjectContextStrip
                  ref={projectContextStripRef}
                  projectName={
                    activeProjectName ??
                    activeConversation.projectContext.snapshot?.project_name ??
                    activeConversation.projectId
                  }
                  state={activeConversation.projectContext}
                  verificationStatus={projectContextVerificationStatus}
                  onPress={openProjectContextFromStrip}
                />
              </View>
            )}
          <ChatComposer
            attachmentBusy={attachmentBusy}
            attachments={draftAttachments}
            configured={credentialConfigured}
            draft={draft}
            harnessName={activeHarness.name}
            model={activeModel}
            locked={
              requestState === 'sending' ||
              previewingAttachmentId !== null ||
              projectContextLocksComposer
            }
            ownershipKey={attachmentOwnershipKey}
            optionsVisible={composerOptionsVisible}
            previewingAttachmentId={previewingAttachmentId}
            thinkingMode={activeThinkingMode}
            workspaceName={
              activeWorkspaceId === null
                ? null
                : workspaceNames[activeWorkspaceId] ?? null
            }
            workspacePickerVisible={workspaceSheetVisible}
            sending={completionCancellable(completionState)}
            onAddAttachment={(source, ownershipKey) => {
              addAttachment(source, ownershipKey).catch(() => undefined);
            }}
            onCancel={() => cancel(completionState)}
            onChange={setDraft}
            onConfigure={openSettings}
            onOptionsPress={openComposerOptions}
            onWorkspacePress={() => {
              setWorkspaceSheetVisible(true);
            }}
            onPreviewAttachment={(id, ownershipKey) => {
              presentAttachmentPreview(id, ownershipKey).catch(
                () => undefined,
              );
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
        onOpenSettings={openSettings}
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
          if (projectContextOwnsMutation(projectContextController.getState())) {
            return;
          }
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
        disabled={
          requestState === 'sending' ||
          attachmentBusy ||
          projectContextLocksComposer
        }
        placement="settings"
        selected={activeModel}
        visible={modelVisible}
        onClose={() => setModelVisible(false)}
        onSelect={selectSettingsModel}
      />
      <ConversationOptionsPicker
        disabled={
          requestState === 'sending' ||
          attachmentBusy ||
          projectContextLocksComposer
        }
        model={activeModel}
        thinkingMode={activeThinkingMode}
        visible={composerOptionsVisible}
        onClose={() => setComposerOptionsVisible(false)}
        onSelectModel={selectComposerModel}
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
        onRetry={() => refreshProof().catch(() => undefined)}
      />
      <ProjectsSurface
        boundProjectId={activeConversation?.projectId ?? null}
        covered={workspaceVisible}
        refreshToken={projectRefreshToken}
        visible={projectsVisible}
        onChatInProject={chatInProject}
        onClose={() => {
          if (!projectChatTransitionInFlight.current) {
            setProjectsVisible(false);
          }
        }}
        onDismiss={handleProjectsDismiss}
        onOpenFiles={project => {
          setProjectFilesScope(project);
          setWorkspaceVisible(true);
        }}
        onUnbindFromChat={unbindProjectFromConversation}
      />
      <ProjectContextSheet
        actionKey={projectContextActionKey}
        busyAction={projectContextBusyAction}
        candidates={
          projectContextOwnerAligned
            ? projectContextControllerState.list.candidates
            : []
        }
        checking={projectContextVerificationStatus === 'checking'}
        confirmationRequired={projectContextConfirmationRequired}
        disabled={projectContextActionsDisabled}
        errorCode={
          projectContextOwnerAligned
            ? projectContextControllerState.failureCode
            : null
        }
        filter={contextSheetFilter}
        hasActiveContext={
          !projectContextConfirmationRequired &&
          activeConversation?.projectContext?.snapshot !== null &&
          activeConversation?.projectContext?.snapshot !== undefined
        }
        loading={
          projectContextOwnerAligned && projectContextControllerState.list.loading
        }
        loadingMore={
          projectContextOwnerAligned &&
          projectContextControllerState.list.loadingMore
        }
        manifest={projectContextManifest}
        mode={projectContextSheetMode}
        nextCursor={
          projectContextOwnerAligned
            ? projectContextControllerState.list.nextCursor
            : null
        }
        projectName={
          activeProjectName ??
          activeConversation?.projectContext?.snapshot?.project_name ??
          activeConversation?.projectId ??
          ''
        }
        query={
          projectContextOwnerAligned
            ? projectContextControllerState.list.query
            : ''
        }
        recoveryAction={projectContextRecoveryAction}
        selectedCandidates={
          projectContextOwnerAligned
            ? projectContextControllerState.selectedCandidates
            : []
        }
        selectedPaths={
          projectContextOwnerAligned
            ? projectContextControllerState.selectedPaths
            : []
        }
        unavailable={
          !projectContextNativeAvailable ||
          activeConversation?.projectContext?.status === 'unavailable'
        }
        visible={contextSheetVisible}
        onCancelCandidate={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          completeProjectContextAction(
            token,
            true,
            () => projectContextController.cancel(token),
          );
        }}
        onCancelRecovery={closeProjectContextSheet}
        onClose={closeProjectContextSheet}
        onConfirm={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          completeProjectContextAction(
            token,
            true,
            () => projectContextController.confirm(token),
          );
        }}
        onDisable={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          completeProjectContextAction(
            token,
            true,
            () => projectContextController.disable(token),
          );
        }}
        onDismiss={handleProjectContextDismiss}
        onFilterChange={filter => {
          if (!projectContextActionIsLive(projectContextActionToken)) return;
          setContextSheetFilter(filter);
        }}
        onLoadMore={() => {
          const token = projectContextActionToken;
          if (!projectContextActionIsLive(token)) return;
          projectContextController.loadMore(token).catch(() => undefined);
        }}
        onPrepare={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          completeProjectContextAction(
            token,
            false,
            () => projectContextController.prepare(token),
          );
        }}
        onQueryChange={query => {
          const token = projectContextActionToken;
          if (!projectContextActionIsLive(token)) return;
          projectContextController.search(token, query).catch(() => undefined);
        }}
        onRefreshAndSend={() => undefined}
        onRefreshCandidates={() => {
          const token = projectContextActionToken;
          if (!projectContextActionIsLive(token)) return;
          projectContextController
            .search(token, projectContextControllerState.list.query)
            .catch(() => undefined);
        }}
        onRefreshContext={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          completeProjectContextAction(
            token,
            false,
            () => projectContextController.inspect(token),
          );
        }}
        onRetryCleanup={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          completeProjectContextAction(
            token,
            false,
            () => projectContextController.retryCleanup(token),
          );
        }}
        onRetryPersistence={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          completeProjectContextAction(
            token,
            false,
            () => projectContextController.retryPersistence(token),
          );
        }}
        onSendWithoutContext={() => undefined}
        onTogglePath={path => {
          const token = projectContextActionToken;
          if (!projectContextActionIsLive(token)) return;
          const selected = projectContextController.getState().selectedPaths;
          const next = selected.includes(path)
            ? selected.filter(candidate => candidate !== path)
            : [...selected, path];
          projectContextController.setSelectedPaths(token, next);
        }}
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
