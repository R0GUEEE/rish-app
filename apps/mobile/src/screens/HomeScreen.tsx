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
  type SnapshotFreeProjectMutationTransaction,
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
  createProjectContextLifecycleController,
  isProjectContextSendable,
  type ProjectContextActionToken,
  type ProjectContextControllerOwner,
  type ProjectContextControllerState,
  type ProjectContextDestructiveBeginToken,
  type ProjectContextDestructiveOutcome,
  type ProjectContextDestructiveToken,
  type ProjectContextLifecycleControllerState,
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

type PendingProjectSend = {
  readonly conversationId: string;
  readonly uiEpoch: number;
  readonly text: string;
  readonly attachments: readonly AttachmentDescriptor[];
  readonly attachmentIds: readonly string[];
};

type PendingProjectSendStage = 'recovery' | 'context_flow';
type PendingContextDismissAction = {
  readonly kind: 'verified' | 'without_context';
  readonly pendingEpoch: number;
};

type ProjectContextLifecycleIntent = {
  readonly nonce: number;
  readonly action: 'unbind' | 'delete' | 'rebind';
  readonly conversationId: string;
  readonly selectedConversationId: string | null;
  readonly targetProjectId: string | null;
  readonly beginToken: ProjectContextDestructiveBeginToken;
};

type ConversationDeleteRequest = {
  readonly actionEpoch: number;
  readonly completionEpoch: number;
  readonly selectedConversationId: string | null;
  readonly conversation: Conversation;
};

type DirectProjectMutationOutbox = {
  readonly action: 'unbind' | 'delete' | 'rebind';
  readonly conversationId: string;
  readonly targetProjectId: string | null;
  readonly targetProjectName: string | null;
  readonly expectedConversation: Conversation;
  readonly selectedConversationId: string | null;
  readonly transaction: SnapshotFreeProjectMutationTransaction | null;
  readonly sourceProjectsEpoch: number | null;
};

type DirectProjectMutationView = Pick<
  DirectProjectMutationOutbox,
  'action' | 'conversationId' | 'targetProjectId' | 'targetProjectName'
>;

function sameDeleteOwner(
  current: Conversation | null,
  expected: Conversation,
): boolean {
  return (
    current !== null &&
    current.id === expected.id &&
    current.projectId === expected.projectId &&
    current.workspaceId === expected.workspaceId &&
    current.runtimeContextId === expected.runtimeContextId &&
    current.projectContext === expected.projectContext &&
    current.title === expected.title &&
    current.titleSource === expected.titleSource &&
    current.modelId === expected.modelId &&
    current.thinkingMode === expected.thinkingMode &&
    current.messages === expected.messages &&
    current.turns === expected.turns &&
    current.createdAt === expected.createdAt
  );
}

function copyPendingAttachment(
  attachment: AttachmentDescriptor,
): AttachmentDescriptor {
  return Object.freeze({
    schema_version: attachment.schema_version,
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mime_type: attachment.mime_type,
    size: attachment.size,
  });
}

function sameOrderedAttachmentIds(
  attachments: readonly AttachmentDescriptor[],
  expectedIds: readonly string[],
): boolean {
  return (
    attachments.length === expectedIds.length &&
    attachments.every(
      (attachment, index) => attachment.id === expectedIds[index],
    )
  );
}

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
    state.candidateManifest !== null ||
    state.list.loading ||
    state.list.loadingMore
  );
}

function projectContextOperationInFlight(
  state: ProjectContextControllerState,
): boolean {
  return (
    state.phase === 'inspecting' ||
    state.phase === 'preparing' ||
    state.phase === 'confirming' ||
    state.phase === 'disabling' ||
    state.phase === 'persistence_pending' ||
    state.phase === 'cleanup_pending' ||
    state.list.loading ||
    state.list.loadingMore
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

function sameConversationOwner(
  expected: Conversation | null,
  current: Conversation | null,
): boolean {
  return (
    expected === null
      ? current === null
      : current !== null &&
        current.id === expected.id &&
        current.projectId === expected.projectId &&
        current.runtimeContextId === expected.runtimeContextId &&
        current.modelId === expected.modelId &&
        current.projectContext === expected.projectContext
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

function sameDestructiveBeginToken(
  left: ProjectContextDestructiveBeginToken,
  right: ProjectContextDestructiveBeginToken,
): boolean {
  return (
    left.expectedRootEpoch === right.expectedRootEpoch &&
    left.action === right.action &&
    left.conversationId === right.conversationId &&
    left.sourceProjectId === right.sourceProjectId &&
    left.sourceRuntimeContextId === right.sourceRuntimeContextId &&
    left.sourceModelId === right.sourceModelId &&
    left.snapshotId === right.snapshotId &&
    left.snapshotSha256 === right.snapshotSha256 &&
    left.consentReceiptId === right.consentReceiptId &&
    left.expectedUpdatedAt === right.expectedUpdatedAt &&
    left.targetProjectId === right.targetProjectId
  );
}

function sameDestructiveToken(
  left: ProjectContextDestructiveToken,
  right: ProjectContextDestructiveToken | null,
): boolean {
  return (
    right !== null &&
    left.generation === right.generation &&
    left.lifecycleId === right.lifecycleId &&
    left.epoch === right.epoch &&
    left.action === right.action &&
    left.conversationId === right.conversationId &&
    left.sourceProjectId === right.sourceProjectId &&
    left.sourceRuntimeContextId === right.sourceRuntimeContextId &&
    left.sourceModelId === right.sourceModelId &&
    left.snapshotId === right.snapshotId &&
    left.snapshotSha256 === right.snapshotSha256 &&
    left.consentReceiptId === right.consentReceiptId &&
    left.targetProjectId === right.targetProjectId &&
    left.phase === right.phase
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
  const draftRef = useRef('');
  draftRef.current = draft;
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
  const drawerVisibleRef = useRef(false);
  drawerVisibleRef.current = drawerVisible;
  const drawerSurfaceEpoch = useRef(0);
  const [accountVisible, setAccountVisible] = useState(false);
  const [settingsVisible, setSettingsVisible] = useState(false);
  const settingsVisibleRef = useRef(false);
  settingsVisibleRef.current = settingsVisible;
  const settingsSurfaceEpoch = useRef(0);
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
  const projectsVisibleRef = useRef(false);
  projectsVisibleRef.current = projectsVisible;
  const projectsSurfaceEpoch = useRef(0);
  const [contextSheetVisible, setContextSheetVisible] = useState(false);
  const contextSheetVisibleRef = useRef(false);
  contextSheetVisibleRef.current = contextSheetVisible;
  const navigationSurfaceVisibleRef = useRef(false);
  const lifecycleBootstrapReadyRef = useRef(false);
  const [lifecycleBootstrapReady, setLifecycleBootstrapReady] =
    useState(false);
  const lifecycleIntentNonce = useRef(0);
  const lifecycleActionInFlight = useRef(false);
  const [lifecycleIntent, setLifecycleIntent] =
    useState<ProjectContextLifecycleIntent | null>(null);
  const lifecycleIntentRef = useRef<ProjectContextLifecycleIntent | null>(
    null,
  );
  lifecycleIntentRef.current = lifecycleIntent;
  const [lifecycleSheetTargetId, setLifecycleSheetTargetId] = useState<
    string | null
  >(null);
  const [directProjectMutationView, setDirectProjectMutationView] =
    useState<DirectProjectMutationView | null>(null);
  const directProjectMutationOutboxRef =
    useRef<DirectProjectMutationOutbox | null>(null);
  const directProjectMutationPersistenceInFlight = useRef(false);
  const [contextSheetFilter, setContextSheetFilter] =
    useState<ProjectContextSheetFilter>('all');
  const [pendingProjectSend, setPendingProjectSend] =
    useState<PendingProjectSend | null>(null);
  const [pendingProjectSendStage, setPendingProjectSendStage] =
    useState<PendingProjectSendStage | null>(null);
  const pendingProjectSendRef = useRef<PendingProjectSend | null>(null);
  const pendingProjectSendEpoch = useRef(0);
  const pendingContextDismissAction =
    useRef<PendingContextDismissAction | null>(null);
  const pendingProjectSendActionInFlight = useRef(false);
  const [projectFilesScope, setProjectFilesScope] =
    useState<LocalProject | null>(null);
  const [projectRefreshToken, setProjectRefreshToken] = useState(0);
  const [activeProjectName, setActiveProjectName] = useState<string | null>(
    null,
  );
  const [actionConversationId, setActionConversationId] = useState<
    string | null
  >(null);
  const conversationActionEpoch = useRef(0);
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
  const pendingLifecycleOpenAfterProjectsDismiss =
    useRef<ProjectContextLifecycleIntent | null>(null);
  const pendingExistingLifecycleAfterProjectsDismiss =
    useRef<ProjectContextDestructiveToken | null>(null);
  const pendingDirectOpenAfterProjectsDismiss =
    useRef<DirectProjectMutationView | null>(null);
  const pendingLifecycleOpenAfterDrawerDismiss = useRef<{
    readonly intent: ProjectContextLifecycleIntent | null;
    readonly token: ProjectContextDestructiveToken | null;
    readonly direct: DirectProjectMutationView | null;
  } | null>(null);
  const projectChatTransitionInFlight = useRef(false);
  const navigationMutationInFlight = useRef(false);
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

  const invalidatePendingProjectSend = useCallback(() => {
    pendingProjectSendEpoch.current += 1;
    pendingProjectSendRef.current = null;
    pendingContextDismissAction.current = null;
    pendingProjectSendActionInFlight.current = false;
    setPendingProjectSend(null);
    setPendingProjectSendStage(null);
  }, []);

  const capturePendingProjectSend = useCallback(
    (
      conversationId: string,
      text: string,
      attachments: readonly AttachmentDescriptor[],
    ): PendingProjectSend => {
      const uiEpoch = ++pendingProjectSendEpoch.current;
      pendingContextDismissAction.current = null;
      pendingProjectSendActionInFlight.current = false;
      const attachmentCopies = Object.freeze(
        attachments.map(copyPendingAttachment),
      );
      const attachmentIds = Object.freeze(
        attachmentCopies.map(attachment => attachment.id),
      );
      const pending = Object.freeze({
        conversationId,
        uiEpoch,
        text,
        attachments: attachmentCopies,
        attachmentIds,
      });
      pendingProjectSendRef.current = pending;
      setPendingProjectSend(pending);
      setPendingProjectSendStage('recovery');
      return pending;
    },
    [],
  );

  const pendingProjectSendIsLive = useCallback(
    (pending: PendingProjectSend): boolean => {
      return (
        pendingProjectSendRef.current === pending &&
        pendingProjectSendEpoch.current === pending.uiEpoch &&
        store.getState().selectedConversationId === pending.conversationId &&
        draftRef.current === pending.text &&
        sameOrderedAttachmentIds(
          draftAttachmentsRef.current,
          pending.attachmentIds,
        )
      );
    },
    [store],
  );

  const changeDraft = useCallback(
    (value: string) => {
      invalidatePendingProjectSend();
      draftRef.current = value;
      setDraft(value);
    },
    [invalidatePendingProjectSend],
  );

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
  const sessionEventLogRef = useRef<
    ReadonlyArray<{
      event_id: string;
      attempt_id: string;
      seq: number;
      kind: string;
      created_at: string;
      text: string;
    }>
  >([]);

  const completionController = useMemo(
    () =>
      createCompletionController({
        chat: store,
        persistCurrent: () => persistCurrentRef.current(),
        onSessionEvent: event => {
          // Durable trajectory capture: appended to the in-memory log which
          // hydrates the replay surface; persistence rides the existing
          // session store on the next persist pass.
          sessionEventLogRef.current = [
            ...sessionEventLogRef.current,
            event,
          ];
        },
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
  const projectContextLifecycleController = useMemo(
    () =>
      createProjectContextLifecycleController({
        chat: store,
        native: LocalProjectContext,
        persistCurrent: () => persistCurrentRef.current(),
        createLifecycleId: () => LocalRuntime.createCompletionRequestId(),
        completionMutationBlocked: () =>
          completionBusy(completionController.getState()),
        projectContextMutationBlocked: () =>
          projectContextOwnsMutation(projectContextController.getState()),
        snapshotReferences: (conversationId, snapshotId) =>
          selectProjectContextSnapshotReferences(
            store.getState(),
            conversationId,
            snapshotId,
          ),
        maximumPendingLifecycle: 1,
      }),
    [completionController, projectContextController, store],
  );
  const [projectContextLifecycleState, setProjectContextLifecycleState] =
    useState<ProjectContextLifecycleControllerState>(() =>
      projectContextLifecycleController.getState(),
    );
  useEffect(
    () =>
      projectContextLifecycleController.subscribe(
        setProjectContextLifecycleState,
      ),
    [projectContextLifecycleController],
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
      if (
        directProjectMutationOutboxRef.current !== null ||
        store.getState().projectContextDestructiveTransition !== null
      ) {
        return;
      }
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
      lifecycleBootstrapReadyRef.current = true;
      setLifecycleBootstrapReady(true);
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
      const restoredTransition =
        store.getState().projectContextDestructiveTransition;
      if (restoredTransition !== null) {
        const outcome =
          await projectContextLifecycleController.reconcileDestructiveTransition();
        if (outcome.status !== 'completed') {
          drawerSurfaceEpoch.current += 1;
          drawerVisibleRef.current = false;
          setDrawerVisible(false);
          conversationActionEpoch.current += 1;
          setActionConversationId(null);
          settingsSurfaceEpoch.current += 1;
          settingsVisibleRef.current = false;
          setSettingsVisible(false);
          setAccountVisible(false);
          setMirrorsVisible(false);
          setModelVisible(false);
          setComposerOptionsVisible(false);
          setWorkspaceSheetVisible(false);
          setHarnessesVisible(false);
          setEvidenceVisible(false);
          projectsSurfaceEpoch.current += 1;
          projectsVisibleRef.current = false;
          setProjectsVisible(false);
          setWorkspaceVisible(false);
          afterDrawerDismiss.current = null;
          afterActionDismiss.current = null;
          lifecycleIntentRef.current = null;
          setLifecycleIntent(null);
          setLifecycleSheetTargetId(restoredTransition.conversationId);
          projectContextUiEpoch.current += 1;
          contextSheetVisibleRef.current = true;
          setContextSheetVisible(true);
        }
      }
      lifecycleBootstrapReadyRef.current = true;
      setLifecycleBootstrapReady(true);
      if (
        store.getState().projectContextDestructiveTransition === null &&
        store.getState().selectedConversationId === null
      ) {
        ensureConversation();
      }
      const selectedAfterLifecycle = store.getState().selectedConversationId;
      if (
        store.getState().projectContextDestructiveTransition === null &&
        selectedAfterLifecycle !== null
      ) {
        reconcileSelectedConversation(selectedAfterLifecycle);
      }
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
      if (!lifecycleBootstrapReadyRef.current) {
        lifecycleBootstrapReadyRef.current = true;
        setLifecycleBootstrapReady(true);
      }
      setRuntimeChecking(false);
    }
  }, [
    ensureConversation,
    hydrateStoredState,
    nativeAvailable,
    projectContextLifecycleController,
    reconcileSelectedConversation,
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
  const lifecycleToken = projectContextLifecycleState.token;
  const projectContextVerificationStatus: ProjectContextVerificationStatus =
    (directProjectMutationView?.conversationId ??
      lifecycleIntent?.conversationId ??
      lifecycleToken?.conversationId) ===
      activeConversation?.id
      ? 'recovery'
      : !projectContextNativeAvailable ||
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
  const lifecycleTargetId =
    directProjectMutationView?.conversationId ??
    lifecycleIntent?.conversationId ??
    lifecycleToken?.conversationId ??
    lifecycleSheetTargetId;
  const lifecycleTargetConversation =
    lifecycleTargetId === null
      ? null
      : selectConversationById(chatState, lifecycleTargetId);
  const lifecycleSheetActive =
    lifecycleTargetId !== null &&
    (directProjectMutationView !== null ||
      lifecycleIntent !== null ||
      lifecycleToken !== null);
  const lifecycleAction =
    directProjectMutationView?.action ??
    lifecycleIntent?.action ??
    lifecycleToken?.action ??
    null;
  const lifecyclePresentation =
    lifecycleSheetActive && lifecycleAction !== null
      ? directProjectMutationView !== null
        ? {
            kind: 'direct_persistence' as const,
            action: directProjectMutationView.action,
            targetProjectLabel:
              directProjectMutationView.action === 'rebind'
                ? directProjectMutationView.targetProjectName ??
                  t('context.sheet.lifecycle.localProject')
                : null,
          }
        : {
          kind: lifecycleIntent !== null ? ('confirmation' as const) : ('transition' as const),
          action: lifecycleAction,
          controllerState: projectContextLifecycleState,
          targetProjectLabel:
            lifecycleAction === 'rebind'
              ? t('context.sheet.lifecycle.localProject')
              : null,
          }
      : null;
  const projectContextConfirmationRequired =
    projectContextControllerState.phase === 'review' &&
    projectContextCandidateManifest !== null;
  const projectContextSheetMode: ProjectContextSheetMode =
    lifecycleSheetActive
      ? 'lifecycle'
      : pendingProjectSend !== null && pendingProjectSendStage === 'recovery'
      ? 'recovery'
      : pendingProjectSend !== null &&
          pendingProjectSendStage === 'context_flow' &&
          projectContextCandidateManifest === null
        ? 'candidates'
      : projectContextManifest === null
        ? 'candidates'
        : 'disclosure';
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
    directProjectMutationView !== null ||
    projectContextLifecycleState.token !== null ||
    lifecycleIntent !== null ||
    (activeConversation?.projectId !== null &&
      activeConversation?.projectId !== undefined &&
      projectContextOwnerAligned &&
      projectContextOwnsMutation(projectContextControllerState));
  const projectContextRecoveryGloballyDisabled =
    (activeConversation !== null &&
      completionOwnsPresentation(completionState, activeConversation.id)) ||
    (projectContextOwnerAligned &&
      projectContextOwnsMutation(projectContextControllerState));
  const projectContextRecoveryRefreshDisabled =
    projectContextRecoveryGloballyDisabled ||
    !projectContextNativeAvailable ||
    projectContextActionToken === null ||
    projectContextHasSnapshotReferences;
  const projectContextRenderEpoch = projectContextUiEpoch.current;
  const projectsRenderEpoch = projectsSurfaceEpoch.current;
  const drawerRenderEpoch = drawerSurfaceEpoch.current;
  const settingsRenderEpoch = settingsSurfaceEpoch.current;
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
    pendingProjectSend?.uiEpoch ?? null,
    pendingProjectSendStage,
    lifecycleIntent?.nonce ?? null,
    projectContextLifecycleState.generation,
    lifecycleToken?.lifecycleId ?? null,
    lifecycleToken?.epoch ?? null,
    lifecycleToken?.phase ?? null,
    directProjectMutationView?.action ?? null,
    directProjectMutationView?.conversationId ?? null,
  ]);
  useEffect(() => {
    if (
      !lifecycleBootstrapReady ||
      directProjectMutationView !== null ||
      lifecycleIntent !== null ||
      store.getState().projectContextDestructiveTransition !== null ||
      directProjectMutationOutboxRef.current !== null ||
      !projectContextNativeAvailable ||
      activeConversation === null
    )
      return;
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
    directProjectMutationView,
    lifecycleIntent,
    lifecycleBootstrapReady,
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
    invalidatePendingProjectSend();
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
  }, [
    draftAttachments,
    invalidatePendingProjectSend,
    referencedAttachmentIds,
    store,
    t,
  ]);

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
        if (accepted.length > 0) invalidatePendingProjectSend();
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
      invalidatePendingProjectSend,
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
      invalidatePendingProjectSend();
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
    [
      completionController,
      invalidatePendingProjectSend,
      referencedAttachmentIds,
      store,
      t,
    ],
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

  const openPendingProjectRecovery = useCallback(
    (
      conversationId: string,
      text: string,
      attachments: readonly AttachmentDescriptor[],
    ) => {
      capturePendingProjectSend(conversationId, text, attachments);
      projectContextUiEpoch.current += 1;
      setContextSheetFilter('all');
      contextSheetVisibleRef.current = true;
      setContextSheetVisible(true);
    },
    [capturePendingProjectSend],
  );

  const performCompletionSend = useCallback(
    async (
      conversationId: string,
      text: string,
      attachments: readonly AttachmentDescriptor[],
      sendWithoutProjectContext = false,
    ) => {
      const attachmentIds = attachments.map(attachment => attachment.id);
      setAttachmentNotice(null);
      setRequestFailure(null);
      const outcomeEpoch = ++completionUiEpoch.current;
      const result = await completionController.send(
        {
          conversationId,
          text,
          attachments,
          ...(sendWithoutProjectContext ? { sendWithoutProjectContext: true } : {}),
        },
        {
          onPreparedDurable: () => {
            setDraft(current => {
              const next = current === text ? '' : current;
              draftRef.current = next;
              return next;
            });
            setDraftAttachments(current => {
              const next = sameOrderedAttachmentIds(current, attachmentIds)
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
    },
    [applyCompletionOutcome, completionController, refreshProof],
  );

  const send = useCallback(async () => {
    const prompt = draft;
    const outgoingAttachments = draftAttachments;
    const selectedConversation = selectActiveConversation(store.getState());
    const contextControllerState = projectContextController.getState();
    if (
      !credentialConfigured ||
      (prompt.trim().length === 0 && outgoingAttachments.length === 0) ||
      completionBusy(completionController.getState()) ||
      store.getState().projectContextDestructiveTransition !== null ||
      directProjectMutationOutboxRef.current !== null ||
      lifecycleIntentRef.current !== null ||
      contextSheetVisibleRef.current ||
      pendingProjectSendActionInFlight.current ||
      (selectedConversation !== null &&
        sameProjectContextOwner(
          contextControllerState.owner,
          selectedConversation,
        ) &&
        projectContextOwnsMutation(contextControllerState)) ||
      activeAttachmentOperation.current !== null ||
      activeAttachmentPreviewId.current !== null
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
      openPendingProjectRecovery(
        conversationId,
        prompt,
        outgoingAttachments,
      );
      return;
    }
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
      openPendingProjectRecovery(
        conversationId,
        prompt,
        outgoingAttachments,
      );
      return;
    }
    invalidatePendingProjectSend();
    await performCompletionSend(
      conversationId,
      prompt,
      outgoingAttachments,
    );
  }, [
    changeConversationModel,
    completionController,
    credentialConfigured,
    draft,
    draftAttachments,
    ensureConversation,
    invalidatePendingProjectSend,
    openPendingProjectRecovery,
    performCompletionSend,
    projectContextController,
    projectContextNativeAvailable,
    persist,
    reconcileSelectedConversation,
    store,
    t,
  ]);

  const retry = useCallback(async (expected: CompletionControllerState) => {
    if (
      retryActionInFlight.current ||
      directProjectMutationOutboxRef.current !== null ||
      lifecycleIntentRef.current !== null ||
      store.getState().projectContextDestructiveTransition !== null ||
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
  }, [applyCompletionOutcome, completionController, refreshProof, store]);

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

  const captureLifecycleIntent = useCallback(
    (
      conversationId: string,
      action: ProjectContextLifecycleIntent['action'],
      targetProjectId: string | null = null,
    ): ProjectContextLifecycleIntent | null => {
      const captured =
        projectContextLifecycleController.captureDestructiveBeginToken(
          conversationId,
          action,
          targetProjectId,
        );
      if (!captured.ok) {
        setRequestFailure(captured.code);
        return null;
      }
      return Object.freeze({
        nonce: ++lifecycleIntentNonce.current,
        action,
        conversationId,
        selectedConversationId: store.getState().selectedConversationId,
        targetProjectId,
        beginToken: captured.token,
      });
    },
    [projectContextLifecycleController, store],
  );

  const lifecycleIntentIsLive = useCallback(
    (expected: ProjectContextLifecycleIntent): boolean => {
      if (
        lifecycleIntentRef.current !== expected ||
        store.getState().selectedConversationId !==
          expected.selectedConversationId
      ) {
        return false;
      }
      const fresh =
        projectContextLifecycleController.captureDestructiveBeginToken(
          expected.conversationId,
          expected.action,
          expected.targetProjectId,
        );
      return fresh.ok && sameDestructiveBeginToken(fresh.token, expected.beginToken);
    },
    [projectContextLifecycleController, store],
  );

  const openLifecycleSheet = useCallback(
    (intent: ProjectContextLifecycleIntent) => {
      lifecycleIntentRef.current = intent;
      setLifecycleIntent(intent);
      setLifecycleSheetTargetId(intent.conversationId);
      projectContextUiEpoch.current += 1;
      contextSheetVisibleRef.current = true;
      setContextSheetVisible(true);
    },
    [],
  );

  const openBlockedProjectContext = useCallback((conversationId: string) => {
    lifecycleIntentRef.current = null;
    setLifecycleIntent(null);
    setLifecycleSheetTargetId(null);
    projectContextUiEpoch.current += 1;
    contextSheetVisibleRef.current = true;
    setContextSheetVisible(true);
    if (
      projectContextController.getState().owner?.conversationId !==
      conversationId
    ) {
      projectContextController
        .attachConversation(conversationId)
        .catch(() => undefined);
    }
  }, [projectContextController]);

  const finishLifecycleOutcome = useCallback(
    async (
      result: ProjectContextDestructiveOutcome,
      action: ProjectContextLifecycleIntent['action'],
      targetConversationId: string,
      selectedAtStart: string | null,
    ) => {
      lifecycleActionInFlight.current = false;
      if (result.status !== 'completed') {
        if (store.getState().projectContextDestructiveTransition !== null) {
          lifecycleIntentRef.current = null;
          setLifecycleIntent(null);
        }
        setRequestFailure(
          result.status === 'blocked' ||
            result.status === 'cleanup_pending' ||
            result.status === 'persistence_pending'
            ? result.code
            : null,
        );
        return;
      }

      lifecycleIntentRef.current = null;
      setLifecycleIntent(null);
      setLifecycleSheetTargetId(null);
      contextSheetVisibleRef.current = false;
      projectContextUiEpoch.current += 1;
      setContextSheetVisible(false);
      setRequestFailure(null);
      completionUiEpoch.current += 1;

      if (action === 'delete') {
        if (selectedAtStart === targetConversationId) {
          markAttachmentOperationStale();
          discardDraftAttachments();
          draftRef.current = '';
          setDraft('');
        }
        if (store.getState().selectedConversationId === null) {
          store.createConversation({
            modelId: preferencesStore.getState().defaultModel,
            thinkingMode: preferencesStore.getState().thinkingMode,
          });
        }
        await synchronizeAttachmentStore(store.getState());
      } else if (
        action === 'unbind' &&
        store.getState().selectedConversationId === targetConversationId
      ) {
        setActiveProjectName(null);
      }

      const selected = store.getState().selectedConversationId;
      if (selected !== null) reconcileSelectedConversation(selected);
    },
    [
      discardDraftAttachments,
      markAttachmentOperationStale,
      preferencesStore,
      reconcileSelectedConversation,
      store,
      synchronizeAttachmentStore,
    ],
  );

  const confirmLifecycleIntent = useCallback(async (
    expected: ProjectContextLifecycleIntent | null,
    expectedSurfaceEpoch: number,
  ) => {
    if (
      expected === null ||
      projectContextUiEpoch.current !== expectedSurfaceEpoch ||
      lifecycleActionInFlight.current ||
      !contextSheetVisibleRef.current ||
      !lifecycleIntentIsLive(expected)
    ) {
      return;
    }
    lifecycleActionInFlight.current = true;
    if (
      !(await projectContextController.beforeConversationChange(
        expected.conversationId,
      )) ||
      !lifecycleIntentIsLive(expected) ||
      completionBusy(completionController.getState())
    ) {
      lifecycleActionInFlight.current = false;
      return;
    }
    const fresh =
      projectContextLifecycleController.captureDestructiveBeginToken(
        expected.conversationId,
        expected.action,
        expected.targetProjectId,
      );
    if (
      !fresh.ok ||
      !sameDestructiveBeginToken(fresh.token, expected.beginToken) ||
      !lifecycleIntentIsLive(expected)
    ) {
      lifecycleActionInFlight.current = false;
      return;
    }
    const result =
      await projectContextLifecycleController.beginDestructiveTransition(
        fresh.token,
      );
    await finishLifecycleOutcome(
      result,
      expected.action,
      expected.conversationId,
      expected.selectedConversationId,
    );
  }, [
    completionController,
    finishLifecycleOutcome,
    lifecycleIntentIsLive,
    projectContextController,
    projectContextLifecycleController,
  ]);

  const retryLifecyclePersistence = useCallback(
    async (
      expected: ProjectContextDestructiveToken,
      expectedSurfaceEpoch: number,
    ) => {
      if (
        projectContextUiEpoch.current !== expectedSurfaceEpoch ||
        lifecycleActionInFlight.current ||
        !contextSheetVisibleRef.current ||
        !sameDestructiveToken(
          expected,
          projectContextLifecycleController.getDestructiveToken(),
        )
      ) {
        return;
      }
      lifecycleActionInFlight.current = true;
      const result =
        await projectContextLifecycleController.retryDestructivePersistence(
          expected,
        );
      await finishLifecycleOutcome(
        result,
        expected.action,
        expected.conversationId,
        store.getState().selectedConversationId,
      );
    }, [finishLifecycleOutcome, projectContextLifecycleController, store],
  );

  const retryLifecycleCleanup = useCallback(
    async (
      expected: ProjectContextDestructiveToken,
      expectedSurfaceEpoch: number,
    ) => {
      if (
        projectContextUiEpoch.current !== expectedSurfaceEpoch ||
        lifecycleActionInFlight.current ||
        !contextSheetVisibleRef.current ||
        !sameDestructiveToken(
          expected,
          projectContextLifecycleController.getDestructiveToken(),
        )
      ) {
        return;
      }
      lifecycleActionInFlight.current = true;
      const result =
        await projectContextLifecycleController.retryDestructiveCleanup(
          expected,
        );
      await finishLifecycleOutcome(
        result,
        expected.action,
        expected.conversationId,
        store.getState().selectedConversationId,
      );
    }, [finishLifecycleOutcome, projectContextLifecycleController, store],
  );

  const showDirectProjectMutationRecovery = useCallback(
    (outbox: DirectProjectMutationOutbox) => {
      const view: DirectProjectMutationView = {
        action: outbox.action,
        conversationId: outbox.conversationId,
        targetProjectId: outbox.targetProjectId,
        targetProjectName: outbox.targetProjectName,
      };
      directProjectMutationOutboxRef.current = outbox;
      setDirectProjectMutationView(view);
      setLifecycleSheetTargetId(outbox.conversationId);
      projectContextUiEpoch.current += 1;
      if (
        outbox.sourceProjectsEpoch !== null &&
        projectsSurfaceEpoch.current !== outbox.sourceProjectsEpoch
      ) {
        setRequestFailure('E_CONTEXT_PERSISTENCE');
        return;
      }
      if (
        outbox.sourceProjectsEpoch !== null &&
        projectsVisibleRef.current
      ) {
        pendingDirectOpenAfterProjectsDismiss.current = view;
        projectsVisibleRef.current = false;
        setProjectsVisible(false);
      } else {
        contextSheetVisibleRef.current = true;
        setContextSheetVisible(true);
      }
      setRequestFailure('E_CONTEXT_PERSISTENCE');
    },
    [],
  );

  const completeDirectProjectMutation = useCallback(
    async (outbox: DirectProjectMutationOutbox) => {
      directProjectMutationOutboxRef.current = null;
      setDirectProjectMutationView(null);
      setLifecycleSheetTargetId(null);
      contextSheetVisibleRef.current = false;
      projectContextUiEpoch.current += 1;
      setContextSheetVisible(false);
      setRequestFailure(null);
      if (outbox.action === 'delete') {
        if (outbox.selectedConversationId === outbox.conversationId) {
          markAttachmentOperationStale();
          discardDraftAttachments();
          draftRef.current = '';
          setDraft('');
        }
        if (store.getState().selectedConversationId === null) {
          store.createConversation({
            modelId: preferencesStore.getState().defaultModel,
            thinkingMode: preferencesStore.getState().thinkingMode,
          });
        }
        await synchronizeAttachmentStore(store.getState());
      } else if (
        store.getState().selectedConversationId === outbox.conversationId
      ) {
        setActiveProjectName(
          outbox.action === 'rebind' ? outbox.targetProjectName : null,
        );
      }
      const selected = store.getState().selectedConversationId;
      if (selected !== null) reconcileSelectedConversation(selected);
    },
    [
      discardDraftAttachments,
      markAttachmentOperationStale,
      preferencesStore,
      reconcileSelectedConversation,
      store,
      synchronizeAttachmentStore,
    ],
  );

  const settleDirectProjectMutation = useCallback(
    async (
      outbox: DirectProjectMutationOutbox,
      transaction: SnapshotFreeProjectMutationTransaction,
      durability: SessionDurabilityResult,
    ) => {
      if (directProjectMutationOutboxRef.current !== outbox) return;
      if (durability.status === 'committed') {
        if (!transaction.commit()) {
          showDirectProjectMutationRecovery({
            ...outbox,
            transaction: null,
          });
          return;
        }
        await completeDirectProjectMutation(outbox);
        return;
      }
      if (durability.status === 'not_committed') {
        if (!transaction.rollback()) {
          showDirectProjectMutationRecovery({
            ...outbox,
            transaction: null,
          });
          return;
        }
        showDirectProjectMutationRecovery({
          ...outbox,
          transaction: null,
        });
        return;
      }
      showDirectProjectMutationRecovery({ ...outbox, transaction });
    }, [completeDirectProjectMutation, showDirectProjectMutationRecovery],
  );

  const applyDirectProjectMutation = useCallback(
    async (
      action: DirectProjectMutationOutbox['action'],
      conversation: Conversation,
      targetProjectId: string | null,
      targetProjectName: string | null = null,
    ): Promise<boolean> => {
      if (directProjectMutationOutboxRef.current !== null) return false;
      const selectedConversationId = store.getState().selectedConversationId;
      const sourceProjectsEpoch = projectsVisibleRef.current
        ? projectsSurfaceEpoch.current
        : null;
      const transaction = store.applySnapshotFreeProjectMutation({
        action,
        conversationId: conversation.id,
        targetProjectId,
        expectedConversation: conversation,
      });
      if (transaction === null) return false;
      const outbox: DirectProjectMutationOutbox = {
        action,
        conversationId: conversation.id,
        targetProjectId,
        targetProjectName,
        expectedConversation: conversation,
        selectedConversationId,
        transaction,
        sourceProjectsEpoch,
      };
      directProjectMutationOutboxRef.current = outbox;
      setDirectProjectMutationView({
        action,
        conversationId: conversation.id,
        targetProjectId,
        targetProjectName,
      });
      directProjectMutationPersistenceInFlight.current = true;
      try {
        await settleDirectProjectMutation(
          outbox,
          transaction,
          await persistCurrentRef.current(),
        );
      } finally {
        directProjectMutationPersistenceInFlight.current = false;
      }
      return true;
    }, [settleDirectProjectMutation, store],
  );

  const retryDirectProjectMutationPersistence = useCallback(async (
    expected: DirectProjectMutationView | null,
    expectedSurfaceEpoch: number,
  ) => {
    const outbox = directProjectMutationOutboxRef.current;
    if (
      expected === null ||
      projectContextUiEpoch.current !== expectedSurfaceEpoch ||
      outbox === null ||
      outbox.action !== expected.action ||
      outbox.conversationId !== expected.conversationId ||
      outbox.targetProjectId !== expected.targetProjectId ||
      lifecycleActionInFlight.current ||
      !contextSheetVisibleRef.current
    ) {
      return;
    }
    lifecycleActionInFlight.current = true;
    try {
      const transaction =
        outbox.transaction ??
        store.applySnapshotFreeProjectMutation({
          action: outbox.action,
          conversationId: outbox.conversationId,
          targetProjectId: outbox.targetProjectId,
          expectedConversation: outbox.expectedConversation,
        });
      if (transaction === null) return;
      const next = { ...outbox, transaction, sourceProjectsEpoch: null };
      directProjectMutationOutboxRef.current = next;
      directProjectMutationPersistenceInFlight.current = true;
      try {
        await settleDirectProjectMutation(
          next,
          transaction,
          await persistCurrentRef.current(),
        );
      } finally {
        directProjectMutationPersistenceInFlight.current = false;
      }
    } finally {
      lifecycleActionInFlight.current = false;
    }
  }, [settleDirectProjectMutation, store]);

  const destructiveAuthorityActive = useCallback(
    (allowSettledRecovery = false) => {
      const destructiveToken =
        projectContextLifecycleController.getDestructiveToken();
      const durableLifecycleActive =
        store.getState().projectContextDestructiveTransition !== null ||
        destructiveToken !== null;
      return (
      (directProjectMutationOutboxRef.current !== null &&
        (!allowSettledRecovery ||
          directProjectMutationPersistenceInFlight.current)) ||
      lifecycleIntentRef.current !== null ||
        (durableLifecycleActive &&
          (!allowSettledRecovery ||
            lifecycleActionInFlight.current ||
            destructiveToken === null))
      );
    },
    [projectContextLifecycleController, store],
  );

  const rootSurfaceAdmissionAllowed = useCallback(
    (allowSettledDirectRecovery = false) =>
      lifecycleBootstrapReadyRef.current &&
      !navigationSurfaceVisibleRef.current &&
      !contextSheetVisibleRef.current &&
      !destructiveAuthorityActive(allowSettledDirectRecovery) &&
      !projectContextOperationInFlight(projectContextController.getState()),
    [destructiveAuthorityActive, projectContextController],
  );

  const drawerSourceIsLive = useCallback(
    (expectedEpoch: number) =>
      lifecycleBootstrapReadyRef.current &&
      drawerVisibleRef.current &&
      drawerSurfaceEpoch.current === expectedEpoch &&
      !contextSheetVisibleRef.current &&
      !destructiveAuthorityActive() &&
      !projectContextOperationInFlight(projectContextController.getState()),
    [destructiveAuthorityActive, projectContextController],
  );

  const settingsSourceIsLive = useCallback(
    (expectedEpoch: number) =>
      lifecycleBootstrapReadyRef.current &&
      settingsVisibleRef.current &&
      settingsSurfaceEpoch.current === expectedEpoch &&
      !contextSheetVisibleRef.current &&
      !destructiveAuthorityActive() &&
      !projectContextOperationInFlight(projectContextController.getState()),
    [destructiveAuthorityActive, projectContextController],
  );

  const closeDrawerSurface = useCallback(() => {
    drawerSurfaceEpoch.current += 1;
    drawerVisibleRef.current = false;
    setDrawerVisible(false);
  }, []);

  const createConversation = useCallback(async (
    expectedDrawerEpoch: number,
  ) => {
    if (
      navigationMutationInFlight.current ||
      !drawerSourceIsLive(expectedDrawerEpoch)
    )
      return;
    navigationMutationInFlight.current = true;
    try {
      const currentId = store.getState().selectedConversationId;
      const currentConversation =
        currentId === null
          ? null
          : selectConversationById(store.getState(), currentId);
      if (directProjectMutationOutboxRef.current !== null) {
        const direct = directProjectMutationView;
        if (direct !== null) {
          pendingLifecycleOpenAfterDrawerDismiss.current = {
            intent: null,
            token: null,
            direct,
          };
          closeDrawerSurface();
        }
        return;
      }
      if (
        currentId !== null &&
        !projectContextLifecycleController.beforeConversationChange(currentId)
      ) {
        const token = projectContextLifecycleController.getDestructiveToken();
        if (token !== null) {
          pendingLifecycleOpenAfterDrawerDismiss.current = {
            intent: null,
            token,
            direct: null,
          };
          closeDrawerSurface();
        }
        return;
      }
      if (
        currentId !== null &&
        !(await projectContextController.beforeConversationChange(currentId))
      ) {
        afterDrawerDismiss.current = () =>
          openBlockedProjectContext(currentId);
        closeDrawerSurface();
        return;
      }
      if (
        !drawerSourceIsLive(expectedDrawerEpoch) ||
        store.getState().selectedConversationId !== currentId ||
        !sameConversationOwner(
          currentConversation,
          currentId === null
            ? null
            : selectConversationById(store.getState(), currentId),
        )
      )
        return;
      if (
        currentId !== null &&
        !(await completionController.beforeConversationChange(currentId))
      ) {
        return;
      }
      if (
        !drawerSourceIsLive(expectedDrawerEpoch) ||
        store.getState().selectedConversationId !== currentId ||
        !sameConversationOwner(
          currentConversation,
          currentId === null
            ? null
            : selectConversationById(store.getState(), currentId),
        )
      )
        return;
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
      closeDrawerSurface();
      reconcileSelectedConversation(store.getState().selectedConversationId!);
      await persist();
    } finally {
      navigationMutationInFlight.current = false;
    }
  }, [
    completionController,
    closeDrawerSurface,
    discardDraftAttachments,
    directProjectMutationView,
    drawerSourceIsLive,
    markAttachmentOperationStale,
    openBlockedProjectContext,
    persist,
    preferencesStore,
    projectContextController,
    projectContextLifecycleController,
    reconcileSelectedConversation,
    store,
  ]);

  const selectConversation = useCallback(
    async (id: string, expectedDrawerEpoch: number) => {
      if (
        navigationMutationInFlight.current ||
        !drawerSourceIsLive(expectedDrawerEpoch)
      )
        return;
      navigationMutationInFlight.current = true;
      try {
        const currentId = store.getState().selectedConversationId;
        const currentConversation =
          currentId === null
            ? null
            : selectConversationById(store.getState(), currentId);
        const targetConversation = selectConversationById(store.getState(), id);
        if (targetConversation === null) return;
        if (directProjectMutationOutboxRef.current !== null) {
          const direct = directProjectMutationView;
          if (direct !== null) {
            pendingLifecycleOpenAfterDrawerDismiss.current = {
              intent: null,
              token: null,
              direct,
            };
            closeDrawerSurface();
          }
          return;
        }
        if (
          currentId !== null &&
          !projectContextLifecycleController.beforeConversationChange(currentId)
        ) {
          const token = projectContextLifecycleController.getDestructiveToken();
          if (token !== null) {
            pendingLifecycleOpenAfterDrawerDismiss.current = {
              intent: null,
              token,
              direct: null,
            };
            closeDrawerSurface();
          }
          return;
        }
        if (
          currentId !== null &&
          !(await projectContextController.beforeConversationChange(currentId))
        ) {
          afterDrawerDismiss.current = () =>
            openBlockedProjectContext(currentId);
          closeDrawerSurface();
          return;
        }
        if (
          !drawerSourceIsLive(expectedDrawerEpoch) ||
          store.getState().selectedConversationId !== currentId ||
          !sameConversationOwner(
            currentConversation,
            currentId === null
              ? null
              : selectConversationById(store.getState(), currentId),
          ) ||
          !sameConversationOwner(
            targetConversation,
            selectConversationById(store.getState(), id),
          )
        )
          return;
        if (
          currentId !== null &&
          !(await completionController.beforeConversationChange(currentId))
        ) {
          return;
        }
        if (
          !drawerSourceIsLive(expectedDrawerEpoch) ||
          store.getState().selectedConversationId !== currentId ||
          !sameConversationOwner(
            currentConversation,
            currentId === null
              ? null
              : selectConversationById(store.getState(), currentId),
          ) ||
          !sameConversationOwner(
            targetConversation,
            selectConversationById(store.getState(), id),
          )
        )
          return;
        completionUiEpoch.current += 1;
        markAttachmentOperationStale();
        discardDraftAttachments();
        store.selectConversation(id);
        setDraft('');
        setAttachmentNotice(null);
        setRequestFailure(null);
        closeDrawerSurface();
        reconcileSelectedConversation(id);
        await persist();
      } finally {
        navigationMutationInFlight.current = false;
      }
    },
    [
      completionController,
      closeDrawerSurface,
      discardDraftAttachments,
      directProjectMutationView,
      drawerSourceIsLive,
      markAttachmentOperationStale,
      openBlockedProjectContext,
      persist,
      projectContextController,
      projectContextLifecycleController,
      reconcileSelectedConversation,
      store,
    ],
  );

  const renameConversation = useCallback(
    (title: string) => {
      if (
        actionConversationId === null ||
        directProjectMutationOutboxRef.current !== null ||
        lifecycleIntentRef.current !== null ||
        store.getState().projectContextDestructiveTransition !== null
      )
        return;
      store.renameConversation(actionConversationId, title);
      persist().catch(() => undefined);
    },
    [actionConversationId, persist, store],
  );

  const confirmDeleteConversation = useCallback(
    (request: ConversationDeleteRequest) => {
      const requestIsLive = () =>
        conversationActionEpoch.current === request.actionEpoch &&
        completionUiEpoch.current === request.completionEpoch &&
        store.getState().selectedConversationId ===
          request.selectedConversationId &&
        selectConversationById(
          store.getState(),
          request.conversation.id,
        ) === request.conversation &&
        !contextSheetVisibleRef.current &&
        lifecycleIntentRef.current === null &&
        directProjectMutationOutboxRef.current === null &&
        store.getState().projectContextDestructiveTransition === null;
      if (!requestIsLive()) return;
      Alert.alert(t('home.deleteChatTitle'), t('home.deleteChatBody'), [
        {
          text: t('common.cancel'),
          style: 'cancel',
          onPress: () => {
            if (conversationActionEpoch.current === request.actionEpoch) {
              conversationActionEpoch.current += 1;
            }
          },
        },
        {
          text: t('common.delete'),
          style: 'destructive',
          onPress: () =>
            (async () => {
              if (navigationMutationInFlight.current || !requestIsLive()) return;
              const operationActionEpoch = ++conversationActionEpoch.current;
              const operationIsLive = () =>
                conversationActionEpoch.current === operationActionEpoch &&
                completionUiEpoch.current === request.completionEpoch &&
                store.getState().selectedConversationId ===
                  request.selectedConversationId &&
                sameDeleteOwner(
                  selectConversationById(
                    store.getState(),
                    request.conversation.id,
                  ),
                  request.conversation,
                ) &&
                !contextSheetVisibleRef.current &&
                lifecycleIntentRef.current === null &&
                directProjectMutationOutboxRef.current === null &&
                store.getState().projectContextDestructiveTransition === null;
              navigationMutationInFlight.current = true;
              try {
                if (
                  !operationIsLive() ||
                  !projectContextLifecycleController.beforeConversationDelete(
                    request.conversation.id,
                  )
                ) {
                  return;
                }
                if (
                  request.conversation.projectContext?.snapshot !== null &&
                  request.conversation.projectContext?.snapshot !== undefined
                ) {
                  const intent = captureLifecycleIntent(
                    request.conversation.id,
                    'delete',
                  );
                  if (
                    intent === null ||
                    !operationIsLive() ||
                    !(await projectContextController.beforeConversationChange(
                      request.conversation.id,
                    )) ||
                    !operationIsLive()
                  ) {
                    return;
                  }
                  const fresh =
                    projectContextLifecycleController.captureDestructiveBeginToken(
                      request.conversation.id,
                      'delete',
                      null,
                    );
                  if (
                    !fresh.ok ||
                    !sameDestructiveBeginToken(
                      fresh.token,
                      intent.beginToken,
                    ) ||
                    !operationIsLive()
                  ) {
                    return;
                  }
                  openLifecycleSheet(intent);
                  return;
                }
                if (
                  !(await projectContextController.beforeConversationDelete(
                    request.conversation.id,
                  )) ||
                  !operationIsLive()
                ) {
                  return;
                }
                const completionAllowed =
                  await completionController.beforeConversationDelete(
                    request.conversation.id,
                  );
                if (!completionAllowed || !operationIsLive()) {
                  return;
                }
                const beforeMutation = selectConversationById(
                  store.getState(),
                  request.conversation.id,
                );
                if (beforeMutation === null) return;
                completionUiEpoch.current += 1;
                setRequestFailure(null);
                await applyDirectProjectMutation(
                  'delete',
                  beforeMutation,
                  null,
                );
              } finally {
                navigationMutationInFlight.current = false;
              }
            })().catch(() => undefined),
        },
      ]);
    },
    [
      completionController,
      applyDirectProjectMutation,
      captureLifecycleIntent,
      openLifecycleSheet,
      projectContextController,
      projectContextLifecycleController,
      store,
      t,
    ],
  );

  const requestDeleteConversation = useCallback(() => {
    if (
      actionConversationId === null ||
      contextSheetVisibleRef.current ||
      lifecycleIntentRef.current !== null ||
      directProjectMutationOutboxRef.current !== null ||
      store.getState().projectContextDestructiveTransition !== null
    )
      return;
    const deleting = selectConversationById(
      store.getState(),
      actionConversationId,
    );
    if (deleting === null) return;
    const request: ConversationDeleteRequest = Object.freeze({
      actionEpoch: conversationActionEpoch.current,
      completionEpoch: completionUiEpoch.current,
      selectedConversationId: store.getState().selectedConversationId,
      conversation: deleting,
    });
    afterActionDismiss.current = () => confirmDeleteConversation(request);
    setActionConversationId(null);
  }, [actionConversationId, confirmDeleteConversation, store]);

  const destructiveSurfaceBlocked = useCallback(
    () =>
      contextSheetVisibleRef.current ||
      store.getState().projectContextDestructiveTransition !== null ||
      directProjectMutationOutboxRef.current !== null ||
      lifecycleIntentRef.current !== null,
    [store],
  );

  const selectModel = useCallback(
    (model: SupportedModel, source: ModelTransitionSource) => {
      if (
        completionBusy(completionController.getState()) ||
        store.getState().projectContextDestructiveTransition !== null ||
        directProjectMutationOutboxRef.current !== null ||
        lifecycleIntentRef.current !== null ||
        projectContextOwnsMutation(projectContextController.getState()) ||
        activeAttachmentOperation.current !== null
      ) {
        return;
      }
      const conversationId = ensureConversation();
      invalidatePendingProjectSend();
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
      invalidatePendingProjectSend,
      store,
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

  const presentSettingsSurface = useCallback(() => {
    settingsSurfaceEpoch.current += 1;
    settingsVisibleRef.current = true;
    setSettingsVisible(true);
  }, []);

  const closeSettingsSurface = useCallback(() => {
    settingsSurfaceEpoch.current += 1;
    settingsVisibleRef.current = false;
    setSettingsVisible(false);
  }, []);

  const selectThinkingMode = useCallback(
    (thinkingMode: Conversation['thinkingMode']) => {
      if (
        completionBusy(completionController.getState()) ||
        store.getState().projectContextDestructiveTransition !== null ||
        directProjectMutationOutboxRef.current !== null ||
        lifecycleIntentRef.current !== null ||
        projectContextOwnsMutation(projectContextController.getState()) ||
        activeAttachmentOperation.current !== null
      ) {
        return;
      }
      const conversationId = ensureConversation();
      invalidatePendingProjectSend();
      store.setThinkingMode(conversationId, thinkingMode);
      persist().catch(() => undefined);
    },
    [
      completionController,
      ensureConversation,
      persist,
      projectContextController,
      invalidatePendingProjectSend,
      store,
    ],
  );

  const openComposerOptions = useCallback(() => {
    if (
      !rootSurfaceAdmissionAllowed() ||
      completionBusy(completionController.getState()) ||
      activeAttachmentOperation.current !== null
    ) {
      return;
    }
    setComposerOptionsVisible(true);
  }, [completionController, rootSurfaceAdmissionAllowed]);

  const openSettings = useCallback(() => {
    if (!rootSurfaceAdmissionAllowed()) return;
    presentSettingsSurface();
  }, [presentSettingsSurface, rootSurfaceAdmissionAllowed]);

  const openSettingsFromDrawer = useCallback((expectedEpoch: number) => {
    if (!drawerSourceIsLive(expectedEpoch)) return;
    presentSettingsSurface();
  }, [drawerSourceIsLive, presentSettingsSurface]);

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
      if (destructiveSurfaceBlocked()) return;
      invalidatePendingProjectSend();
      const conversationId = ensureConversation();
      store.bindConversationToWorkspace(conversationId, workspaceId);
      persist().catch(() => undefined);
      setWorkspaceSheetVisible(false);
      setWorkspaceRefreshToken(token => token + 1);
    },
    [
      destructiveSurfaceBlocked,
      ensureConversation,
      invalidatePendingProjectSend,
      persist,
      store,
    ],
  );

  const chatInProject = useCallback(
    async (project: LocalProject) => {
      if (
        projectChatTransitionInFlight.current ||
        !projectsVisibleRef.current ||
        contextSheetVisibleRef.current ||
        lifecycleIntentRef.current !== null ||
        directProjectMutationOutboxRef.current !== null ||
        store.getState().projectContextDestructiveTransition !== null
      )
        return;
      projectChatTransitionInFlight.current = true;
      let waitForDismiss = false;
      try {
        const sourceSurfaceEpoch = projectsSurfaceEpoch.current;
        const current = selectActiveConversation(store.getState());
        const expectedSelectedId = current?.id ?? null;
        if (directProjectMutationOutboxRef.current !== null) {
          if (directProjectMutationView !== null) {
            pendingDirectOpenAfterProjectsDismiss.current =
              directProjectMutationView;
            waitForDismiss = true;
            setProjectsVisible(false);
          }
          return;
        }
        if (
          current !== null &&
          !projectContextLifecycleController.beforeConversationChange(
            current.id,
          )
        ) {
          const token = projectContextLifecycleController.getDestructiveToken();
          if (token !== null) {
            pendingExistingLifecycleAfterProjectsDismiss.current = token;
            waitForDismiss = true;
            setProjectsVisible(false);
          }
          return;
        }
        if (
          current !== null &&
          !(await projectContextController.beforeConversationChange(current.id))
        ) {
          return;
        }
        const afterContextGuard =
          expectedSelectedId === null
            ? null
            : selectConversationById(store.getState(), expectedSelectedId);
        if (
          projectsSurfaceEpoch.current !== sourceSurfaceEpoch ||
          store.getState().selectedConversationId !== expectedSelectedId ||
          (current !== null &&
            (afterContextGuard === null ||
              afterContextGuard.projectId !== current.projectId ||
              afterContextGuard.runtimeContextId !== current.runtimeContextId ||
              afterContextGuard.modelId !== current.modelId ||
              afterContextGuard.projectContext !== current.projectContext))
        )
          return;
        if (
          current !== null &&
          !(await completionController.beforeConversationChange(current.id))
        ) {
          return;
        }
        const afterCompletionGuard =
          expectedSelectedId === null
            ? null
            : selectConversationById(store.getState(), expectedSelectedId);
        if (
          projectsSurfaceEpoch.current !== sourceSurfaceEpoch ||
          store.getState().selectedConversationId !== expectedSelectedId ||
          (current !== null &&
            (afterCompletionGuard === null ||
              afterCompletionGuard.projectId !== current.projectId ||
              afterCompletionGuard.runtimeContextId !==
                current.runtimeContextId ||
              afterCompletionGuard.modelId !== current.modelId ||
              afterCompletionGuard.projectContext !== current.projectContext))
        )
          return;
        completionUiEpoch.current += 1;
        setRequestFailure(null);
        let mutationPersisted = false;
        if (current?.projectId !== project.id) {
          invalidatePendingProjectSend();
          if (
            current === null ||
            current.messages.length > 0 ||
            current.projectContext?.snapshot !== null &&
              current.projectContext?.snapshot !== undefined
          ) {
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
            if (
              !(await applyDirectProjectMutation(
                'rebind',
                current,
                project.id,
                project.name,
              )) ||
              directProjectMutationOutboxRef.current !== null
            ) {
              return;
            }
            mutationPersisted = true;
          }
        }
        setActiveProjectName(project.name);
        const selected = store.getState().selectedConversationId;
        if (
          projectsSurfaceEpoch.current !== sourceSurfaceEpoch ||
          selected === null ||
          (!mutationPersisted && !(await persist()))
        )
          return;
        const selectedConversation = selectConversationById(
          store.getState(),
          selected,
        );
        if (
          projectsSurfaceEpoch.current !== sourceSurfaceEpoch ||
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
        projectsVisibleRef.current = false;
        setProjectsVisible(false);
      } finally {
        if (!waitForDismiss) projectChatTransitionInFlight.current = false;
      }
    },
    [
      completionController,
      applyDirectProjectMutation,
      discardDraftAttachments,
      directProjectMutationView,
      invalidatePendingProjectSend,
      markAttachmentOperationStale,
      persist,
      preferencesStore,
      projectContextController,
      projectContextLifecycleController,
      store,
    ],
  );

  const handleProjectsDismiss = useCallback(() => {
    const direct = pendingDirectOpenAfterProjectsDismiss.current;
    pendingDirectOpenAfterProjectsDismiss.current = null;
    if (direct !== null) {
      projectChatTransitionInFlight.current = false;
      const live = directProjectMutationOutboxRef.current;
      if (
        live !== null &&
        live.action === direct.action &&
        live.conversationId === direct.conversationId &&
        live.targetProjectId === direct.targetProjectId
      ) {
        setLifecycleSheetTargetId(direct.conversationId);
        projectContextUiEpoch.current += 1;
        contextSheetVisibleRef.current = true;
        setContextSheetVisible(true);
      }
      return;
    }
    const existingLifecycle =
      pendingExistingLifecycleAfterProjectsDismiss.current;
    pendingExistingLifecycleAfterProjectsDismiss.current = null;
    if (existingLifecycle !== null) {
      projectChatTransitionInFlight.current = false;
      if (
        sameDestructiveToken(
          existingLifecycle,
          projectContextLifecycleController.getDestructiveToken(),
        )
      ) {
        setLifecycleSheetTargetId(existingLifecycle.conversationId);
        projectContextUiEpoch.current += 1;
        contextSheetVisibleRef.current = true;
        setContextSheetVisible(true);
      }
      return;
    }
    const lifecycle = pendingLifecycleOpenAfterProjectsDismiss.current;
    pendingLifecycleOpenAfterProjectsDismiss.current = null;
    if (lifecycle !== null) {
      projectChatTransitionInFlight.current = false;
      if (lifecycleIntentIsLive(lifecycle)) openLifecycleSheet(lifecycle);
      return;
    }
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
    lifecycleIntentIsLive,
    openLifecycleSheet,
    projectContextNativeAvailable,
    projectContextLifecycleController,
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
    const pendingLifecycle = lifecycleIntentRef.current;
    const durableLifecycle =
      store.getState().projectContextDestructiveTransition;
    if (
      pendingLifecycle?.conversationId === selected.id ||
      durableLifecycle?.conversationId === selected.id
    ) {
      setLifecycleSheetTargetId(selected.id);
      projectContextUiEpoch.current += 1;
      contextSheetVisibleRef.current = true;
      setContextSheetVisible(true);
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
    if (
      lifecycleIntentRef.current !== null &&
      store.getState().projectContextDestructiveTransition === null
    ) {
      lifecycleIntentNonce.current += 1;
      lifecycleIntentRef.current = null;
      setLifecycleIntent(null);
      setLifecycleSheetTargetId(null);
      lifecycleActionInFlight.current = false;
      setRequestFailure(null);
    }
    contextSheetVisibleRef.current = false;
    projectContextUiEpoch.current += 1;
    setContextSheetVisible(false);
  };

  const pendingProjectSurfaceIsLive = (
    expected: PendingProjectSend | null,
  ): expected is PendingProjectSend =>
    expected !== null &&
    contextSheetVisibleRef.current &&
    projectContextUiEpoch.current === projectContextRenderEpoch &&
    pendingProjectSendIsLive(expected);

  const pendingProjectActionIsBlocked = (
    expected: PendingProjectSend,
  ): boolean => {
    const conversation = selectConversationById(
      store.getState(),
      expected.conversationId,
    );
    if (conversation === null || conversation.projectId === null) return true;
    const completion = completionController.getState();
    if (completionOwnsPresentation(completion, conversation.id)) return true;
    const context = projectContextController.getState();
    return (
      sameProjectContextOwner(context.owner, conversation) &&
      projectContextOwnsMutation(context)
    );
  };

  const verifiedPendingProjectContextIsLive = (
    expected: PendingProjectSend,
  ): boolean => {
    if (!pendingProjectSendIsLive(expected)) return false;
    const conversation = selectConversationById(
      store.getState(),
      expected.conversationId,
    );
    const controllerState = projectContextController.getState();
    return (
      conversation !== null &&
      conversation.projectId !== null &&
      conversation.projectContext !== null &&
      isProjectContextSendable(conversation.projectContext) &&
      sameProjectContextOwner(controllerState.owner, conversation) &&
      controllerState.phase === 'idle' &&
      controllerState.candidateManifest === null &&
      !completionOwnsPresentation(
        completionController.getState(),
        conversation.id,
      )
    );
  };

  const queuePendingProjectSendAfterDismiss = (
    expected: PendingProjectSend | null,
    kind: PendingContextDismissAction['kind'],
  ) => {
    if (
      pendingProjectSendActionInFlight.current ||
      !pendingProjectSurfaceIsLive(expected) ||
      (kind === 'verified'
        ? !verifiedPendingProjectContextIsLive(expected)
        : pendingProjectActionIsBlocked(expected))
    ) {
      return;
    }
    pendingProjectSendActionInFlight.current = true;
    pendingContextDismissAction.current = {
      kind,
      pendingEpoch: expected.uiEpoch,
    };
    closeProjectContextSheet();
  };

  const refreshPendingProjectContext = (
    expectedPending: PendingProjectSend | null,
    expectedToken: ProjectContextActionToken | null,
  ) => {
    if (
      pendingProjectSendActionInFlight.current ||
      !pendingProjectSurfaceIsLive(expectedPending) ||
      expectedToken === null ||
      !projectContextNativeAvailable ||
      !projectContextActionIsLive(expectedToken) ||
      pendingProjectActionIsBlocked(expectedPending)
    ) {
      return;
    }
    pendingProjectSendActionInFlight.current = true;
    setPendingProjectSendStage('context_flow');
    projectContextController
      .search(expectedToken, '')
      .catch(() => undefined)
      .finally(() => {
        if (pendingProjectSendRef.current === expectedPending) {
          pendingProjectSendActionInFlight.current = false;
        }
      });
  };

  const completePendingProjectContextAction = (
    expectedPending: PendingProjectSend | null,
    expectedToken: ProjectContextActionToken | null,
    sendWhenCompleted: boolean,
    operation: () => Promise<{ readonly status: string }>,
  ) => {
    if (
      pendingProjectSendActionInFlight.current ||
      !pendingProjectSurfaceIsLive(expectedPending) ||
      !projectContextActionIsLive(expectedToken)
    ) {
      return;
    }
    const surfaceEpoch = projectContextRenderEpoch;
    pendingProjectSendActionInFlight.current = true;
    operation()
      .then(outcome => {
        if (pendingProjectSendRef.current !== expectedPending) return;
        pendingProjectSendActionInFlight.current = false;
        if (
          sendWhenCompleted &&
          outcome.status === 'completed' &&
          contextSheetVisibleRef.current &&
          projectContextUiEpoch.current === surfaceEpoch
        ) {
          queuePendingProjectSendAfterDismiss(expectedPending, 'verified');
        }
      })
      .catch(() => {
        if (pendingProjectSendRef.current === expectedPending) {
          pendingProjectSendActionInFlight.current = false;
        }
      });
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
    const action = pendingContextDismissAction.current;
    pendingContextDismissAction.current = null;
    if (action === null) return;
    const pending = pendingProjectSendRef.current;
    if (
      pending === null ||
      pending.uiEpoch !== action.pendingEpoch ||
      !pendingProjectSendIsLive(pending) ||
      (action.kind === 'verified' &&
        !verifiedPendingProjectContextIsLive(pending)) ||
      (action.kind === 'without_context' &&
        pendingProjectActionIsBlocked(pending))
    ) {
      pendingProjectSendActionInFlight.current = false;
      return;
    }
    const text = pending.text;
    const attachments = pending.attachments;
    const conversationId = pending.conversationId;
    invalidatePendingProjectSend();
    performCompletionSend(
      conversationId,
      text,
      attachments,
      action.kind === 'without_context',
    ).catch(() => undefined);
  };

  const unbindProjectFromConversation = useCallback(async (
    sourceSurfaceEpoch: number,
  ) => {
    if (
      !projectsVisibleRef.current ||
      projectsSurfaceEpoch.current !== sourceSurfaceEpoch ||
      destructiveSurfaceBlocked()
    ) {
      return;
    }
    const conversationId = store.getState().selectedConversationId;
    if (conversationId === null) return;
    const conversation = selectConversationById(store.getState(), conversationId);
    if (conversation === null || conversation.projectId === null) return;
    const sourceIsLive = () => {
      if (
        !projectsVisibleRef.current ||
        projectsSurfaceEpoch.current !== sourceSurfaceEpoch ||
        destructiveSurfaceBlocked() ||
        store.getState().selectedConversationId !== conversationId
      ) {
        return false;
      }
      const current = selectConversationById(store.getState(), conversationId);
      return (
        current !== null &&
        current.projectId === conversation.projectId &&
        current.runtimeContextId === conversation.runtimeContextId &&
        current.modelId === conversation.modelId &&
        current.projectContext === conversation.projectContext
      );
    };
    if (!sourceIsLive()) return;
    if (conversation.projectContext?.snapshot !== null &&
        conversation.projectContext?.snapshot !== undefined) {
      const intent = captureLifecycleIntent(conversationId, 'unbind');
      if (!sourceIsLive()) return;
      if (intent === null) {
        const uiEpoch = ++projectContextUiEpoch.current;
        pendingContextOpenAfterProjectsDismiss.current = {
          conversationId,
          projectId: conversation.projectId,
          runtimeContextId: conversation.runtimeContextId,
          modelId: conversation.modelId,
          uiEpoch,
        };
        projectsSurfaceEpoch.current += 1;
        projectsVisibleRef.current = false;
        setProjectsVisible(false);
        return;
      }
      lifecycleIntentRef.current = intent;
      setLifecycleIntent(intent);
      setLifecycleSheetTargetId(conversationId);
      pendingLifecycleOpenAfterProjectsDismiss.current = intent;
      projectsSurfaceEpoch.current += 1;
      projectsVisibleRef.current = false;
      setProjectsVisible(false);
      return;
    }
    if (
      !(await projectContextController.beforeConversationChange(conversationId)) ||
      !sourceIsLive()
    ) {
      return;
    }
    if (
      !(await completionController.beforeConversationChange(conversationId)) ||
      !sourceIsLive()
    ) {
      return;
    }
    completionUiEpoch.current += 1;
    invalidatePendingProjectSend();
    setRequestFailure(null);
    const beforeMutation = selectConversationById(
      store.getState(),
      conversationId,
    );
    if (beforeMutation === null) return;
    await applyDirectProjectMutation('unbind', beforeMutation, null);
  }, [
    applyDirectProjectMutation,
    captureLifecycleIntent,
    completionController,
    destructiveSurfaceBlocked,
    invalidatePendingProjectSend,
    projectContextController,
    store,
  ]);

  const selectHarness = useCallback(
    (harnessId: string) => {
      if (!BUILTIN_HARNESSES.has(harnessId)) return;
      invalidatePendingProjectSend();
      preferencesStore.setSelectedHarness(harnessId);
      setHarnessesVisible(false);
      persist().catch(() => undefined);
    },
    [invalidatePendingProjectSend, persist, preferencesStore],
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
              closeSettingsSurface();
            })
            .catch(error => setRuntimeFailure(errorText(error)))
            .finally(() => setCredentialBusy(false));
        },
      },
    ]);
  }, [closeSettingsSurface, t]);

  const openAfterDrawerDismiss = useCallback((
    expectedEpoch: number,
    open: () => void,
  ) => {
    if (!drawerSourceIsLive(expectedEpoch)) return;
    afterDrawerDismiss.current = open;
    closeDrawerSurface();
  }, [closeDrawerSurface, drawerSourceIsLive]);

  const openPendingLifecycleFromDrawer = useCallback(
    (
      expectedIntent: ProjectContextLifecycleIntent | null,
      expectedToken: ProjectContextDestructiveToken | null,
      expectedDirect: DirectProjectMutationView | null,
      expectedDrawerEpoch: number,
    ) => {
      if (
        !lifecycleBootstrapReadyRef.current ||
        !drawerVisibleRef.current ||
        drawerSurfaceEpoch.current !== expectedDrawerEpoch
      )
        return;
      if (
        expectedDirect !== null
          ? directProjectMutationOutboxRef.current === null ||
            directProjectMutationOutboxRef.current.action !==
              expectedDirect.action ||
            directProjectMutationOutboxRef.current.conversationId !==
              expectedDirect.conversationId ||
            directProjectMutationOutboxRef.current.targetProjectId !==
              expectedDirect.targetProjectId
          : expectedIntent !== null
          ? !lifecycleIntentIsLive(expectedIntent)
          : expectedToken === null ||
            !sameDestructiveToken(
              expectedToken,
              projectContextLifecycleController.getDestructiveToken(),
            )
      ) {
        return;
      }
      pendingLifecycleOpenAfterDrawerDismiss.current = {
        intent: expectedIntent,
        token: expectedToken,
        direct: expectedDirect,
      };
      closeDrawerSurface();
    },
    [
      closeDrawerSurface,
      lifecycleIntentIsLive,
      projectContextLifecycleController,
    ],
  );

  const handleDrawerDismiss = useCallback(() => {
    const lifecycle = pendingLifecycleOpenAfterDrawerDismiss.current;
    pendingLifecycleOpenAfterDrawerDismiss.current = null;
    if (lifecycle !== null) {
      const targetId =
        lifecycle.direct?.conversationId ??
        lifecycle.intent?.conversationId ??
        lifecycle.token?.conversationId;
      const live =
        lifecycle.direct !== null
          ? directProjectMutationOutboxRef.current !== null &&
            directProjectMutationOutboxRef.current.action ===
              lifecycle.direct.action &&
            directProjectMutationOutboxRef.current.conversationId ===
              lifecycle.direct.conversationId &&
            directProjectMutationOutboxRef.current.targetProjectId ===
              lifecycle.direct.targetProjectId
          : lifecycle.intent !== null
          ? lifecycleIntentIsLive(lifecycle.intent)
          : lifecycle.token !== null &&
            sameDestructiveToken(
              lifecycle.token,
              projectContextLifecycleController.getDestructiveToken(),
            );
      if (live && targetId !== undefined) {
        setLifecycleSheetTargetId(targetId);
        projectContextUiEpoch.current += 1;
        contextSheetVisibleRef.current = true;
        setContextSheetVisible(true);
      }
      return;
    }
    const open = afterDrawerDismiss.current;
    afterDrawerDismiss.current = null;
    if (
      !lifecycleBootstrapReadyRef.current ||
      contextSheetVisibleRef.current ||
      lifecycleIntentRef.current !== null ||
      directProjectMutationOutboxRef.current !== null ||
      store.getState().projectContextDestructiveTransition !== null
    ) {
      return;
    }
    open?.();
  }, [lifecycleIntentIsLive, projectContextLifecycleController, store]);

  const handleActionDismiss = useCallback(() => {
    const open = afterActionDismiss.current;
    afterActionDismiss.current = null;
    if (
      !lifecycleBootstrapReadyRef.current ||
      contextSheetVisibleRef.current ||
      lifecycleIntentRef.current !== null ||
      directProjectMutationOutboxRef.current !== null ||
      store.getState().projectContextDestructiveTransition !== null
    ) {
      return;
    }
    open?.();
  }, [store]);

  const openRuntimeFromDrawer = useCallback((expectedEpoch: number) => {
    openAfterDrawerDismiss(expectedEpoch, () => setEvidenceVisible(true));
  }, [openAfterDrawerDismiss]);

  const openConversationActions = useCallback(
    (id: string, expectedEpoch: number) => {
      openAfterDrawerDismiss(expectedEpoch, () => {
        conversationActionEpoch.current += 1;
        setActionConversationId(id);
      });
    },
    [openAfterDrawerDismiss],
  );

  const actionConversation =
    actionConversationId === null
      ? null
      : selectConversationById(chatState, actionConversationId);
  const navigationSurfaceVisible =
    drawerVisible ||
    actionConversation !== null ||
    settingsVisible ||
    accountVisible ||
    mirrorsVisible ||
    modelVisible ||
    composerOptionsVisible ||
    workspaceSheetVisible ||
    harnessesVisible ||
    evidenceVisible ||
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
            onPress={() => {
              if (!rootSurfaceAdmissionAllowed(true)) return;
              drawerSurfaceEpoch.current += 1;
              drawerVisibleRef.current = true;
              setDrawerVisible(true);
            }}
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
              onPress={() => {
                if (!rootSurfaceAdmissionAllowed()) return;
                setEvidenceVisible(true);
              }}
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
          <EmptyChat onSuggestion={changeDraft} />
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
            onPress={() => {
              if (!rootSurfaceAdmissionAllowed()) return;
              setEvidenceVisible(true);
            }}
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
            onChange={changeDraft}
            onConfigure={openSettings}
            onOptionsPress={openComposerOptions}
            onWorkspacePress={() => {
              if (
                !rootSurfaceAdmissionAllowed() ||
                completionBusy(completionController.getState())
              ) {
                return;
              }
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
        pendingProjectCleanup={
          lifecycleSheetActive &&
          (lifecycleTargetId !== chatState.selectedConversationId ||
            (directProjectMutationView !== null &&
              activeConversation?.projectId === null))
        }
        runtimeLabel={runtimeLabel}
        runtimeStatus={runtimeStatus}
        visible={drawerVisible}
        onClose={closeDrawerSurface}
        onDismiss={handleDrawerDismiss}
        onNewChat={() => createConversation(drawerRenderEpoch)}
        onOpenAccount={() => {
          if (!drawerSourceIsLive(drawerRenderEpoch)) return;
          setAccountVisible(true);
        }}
        onOpenConversationMenu={id =>
          openConversationActions(id, drawerRenderEpoch)
        }
        onOpenFiles={() =>
          openAfterDrawerDismiss(drawerRenderEpoch, () => {
            setProjectFilesScope(null);
            setWorkspaceVisible(true);
          })
        }
        onOpenProjects={() =>
          openAfterDrawerDismiss(drawerRenderEpoch, () => {
            projectsSurfaceEpoch.current += 1;
            projectsVisibleRef.current = true;
            setProjectsVisible(true);
          })
        }
        onOpenPendingProjectCleanup={() =>
          openPendingLifecycleFromDrawer(
            lifecycleIntent,
            lifecycleToken,
            directProjectMutationView,
            drawerRenderEpoch,
          )
        }
        onOpenHarnesses={() =>
          openAfterDrawerDismiss(drawerRenderEpoch, () =>
            setHarnessesVisible(true),
          )
        }
        onOpenRuntime={() => openRuntimeFromDrawer(drawerRenderEpoch)}
        onOpenSettings={() => openSettingsFromDrawer(drawerRenderEpoch)}
        onSelect={id => selectConversation(id, drawerRenderEpoch)}
      />
      <ConversationActionSheet
        title={actionConversation?.title ?? ''}
        visible={actionConversation !== null}
        onClose={() => {
          conversationActionEpoch.current += 1;
          setActionConversationId(null);
        }}
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
        onClearCredential={() => {
          if (!settingsSourceIsLive(settingsRenderEpoch)) return;
          clearCredential();
        }}
        onClose={closeSettingsSurface}
        onDismiss={() => undefined}
        onConfigureCredential={() => {
          if (!settingsSourceIsLive(settingsRenderEpoch)) return;
          configureCredential().catch(() => undefined);
        }}
        onOpenModelPicker={() => {
          if (!settingsSourceIsLive(settingsRenderEpoch)) return;
          setModelVisible(true);
        }}
        onOpenMirrors={() => {
          if (!settingsSourceIsLive(settingsRenderEpoch)) return;
          setMirrorsVisible(true);
        }}
        onOpenRuntime={() => {
          if (!settingsSourceIsLive(settingsRenderEpoch)) return;
          setEvidenceVisible(true);
        }}
        onPreferencesChanged={() => {
          if (!settingsSourceIsLive(settingsRenderEpoch)) return;
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
          projectsSurfaceEpoch.current += 1;
          projectContextUiEpoch.current += 1;
          projectsVisibleRef.current = false;
          pendingContextOpenAfterProjectsDismiss.current = null;
          pendingContextAttachAfterOpen.current = null;
          pendingExistingLifecycleAfterProjectsDismiss.current = null;
          pendingLifecycleOpenAfterProjectsDismiss.current = null;
          pendingDirectOpenAfterProjectsDismiss.current = null;
          setProjectsVisible(false);
        }}
        onDismiss={handleProjectsDismiss}
        onOpenFiles={project => {
          if (!projectsVisibleRef.current || destructiveSurfaceBlocked()) return;
          setProjectFilesScope(project);
          setWorkspaceVisible(true);
        }}
        onUnbindFromChat={() =>
          unbindProjectFromConversation(projectsRenderEpoch)
        }
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
        disabled={
          projectContextSheetMode === 'lifecycle'
            ? lifecycleActionInFlight.current
            : projectContextSheetMode === 'recovery'
            ? projectContextRecoveryGloballyDisabled
            : projectContextActionsDisabled
        }
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
        lifecycle={lifecyclePresentation}
        manifest={projectContextManifest}
        mode={projectContextSheetMode}
        nextCursor={
          projectContextOwnerAligned
            ? projectContextControllerState.list.nextCursor
            : null
        }
        projectName={
          lifecycleSheetActive
            ? lifecycleTargetConversation?.projectContext?.snapshot
                ?.project_name ??
              t('context.sheet.lifecycle.localProject')
            : activeProjectName ??
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
        recoveryRefreshDisabled={projectContextRecoveryRefreshDisabled}
        recoverySendWithoutDisabled={projectContextRecoveryGloballyDisabled}
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
        onCancelRecovery={() => {
          const expected = pendingProjectSend;
          if (
            !pendingProjectSurfaceIsLive(expected) ||
            pendingProjectActionIsBlocked(expected)
          ) {
            return;
          }
          invalidatePendingProjectSend();
          closeProjectContextSheet();
        }}
        onClose={() => {
          if (projectContextUiEpoch.current !== projectContextRenderEpoch) return;
          closeProjectContextSheet();
        }}
        onConfirm={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          if (
            pendingProjectSend !== null &&
            pendingProjectSendStage === 'context_flow'
          ) {
            completePendingProjectContextAction(
              pendingProjectSend,
              token,
              true,
              () => projectContextController.confirm(token),
            );
            return;
          }
          completeProjectContextAction(
            token,
            true,
            () => projectContextController.confirm(token),
          );
        }}
        onConfirmLifecycle={() => {
          confirmLifecycleIntent(
            lifecycleIntent,
            projectContextRenderEpoch,
          ).catch(() => undefined);
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
          if (
            pendingProjectSend !== null &&
            pendingProjectSendStage === 'context_flow'
          ) {
            completePendingProjectContextAction(
              pendingProjectSend,
              token,
              false,
              () => projectContextController.prepare(token),
            );
            return;
          }
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
        onRefreshAndSend={() =>
          refreshPendingProjectContext(
            pendingProjectSend,
            projectContextActionToken,
          )
        }
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
        onRetryLifecycleCleanup={token => {
          retryLifecycleCleanup(token, projectContextRenderEpoch).catch(
            () => undefined,
          );
        }}
        onRetryLifecyclePersistence={token => {
          retryLifecyclePersistence(token, projectContextRenderEpoch).catch(
            () => undefined,
          );
        }}
        onRetryDirectPersistence={() => {
          retryDirectProjectMutationPersistence(
            directProjectMutationView,
            projectContextRenderEpoch,
          ).catch(() => undefined);
        }}
        onRetryPersistence={() => {
          const token = projectContextActionToken;
          if (token === null) return;
          if (
            pendingProjectSend !== null &&
            pendingProjectSendStage === 'context_flow'
          ) {
            completePendingProjectContextAction(
              pendingProjectSend,
              token,
              projectContextControllerState.pendingPersistence?.kind ===
                'confirmed_consent',
              () => projectContextController.retryPersistence(token),
            );
            return;
          }
          completeProjectContextAction(
            token,
            false,
            () => projectContextController.retryPersistence(token),
          );
        }}
        onSendWithoutContext={() =>
          queuePendingProjectSendAfterDismiss(
            pendingProjectSend,
            'without_context',
          )
        }
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
