/**
 * @format
 */

import React from 'react';
import { AccessibilityInfo, Alert, Keyboard, StyleSheet } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import App from '../App';
import { AccountSheet } from '../src/components/AccountSheet';
import { ChatDrawer } from '../src/components/ChatDrawer';
import { ChatComposer } from '../src/components/ChatComposer';
import { ConversationActionSheet } from '../src/components/ConversationActionSheet';
import { EmptyChat } from '../src/components/EmptyChat';
import { ProjectContextSheet } from '../src/components/ProjectContextSheet';
import { ProjectContextStrip } from '../src/components/ProjectContextStrip';
import { ProjectsSurface } from '../src/components/ProjectsSurface';
import { SettingsSheet } from '../src/components/SettingsSheet';
import { WorkspacePickerSheet } from '../src/components/WorkspacePickerSheet';
import { ModelPicker } from '../src/components/ModelPicker';
import { MirrorSettingsSheet } from '../src/components/MirrorSettingsSheet';
import { ConversationOptionsPicker } from '../src/components/ConversationOptionsPicker';
import { HarnessPicker } from '../src/components/HarnessPicker';
import { RuntimeEvidenceSheet } from '../src/components/RuntimeEvidenceSheet';
import { WorkspaceDrawer } from '../src/components/WorkspaceDrawer';
import { createChatStore } from '../src/state';
import type {
  ProjectContextInspectionV1,
  ProjectContextManifestV1,
} from '../src/project-context';

jest.mock('../src/native/LocalRuntime', () => ({
  LocalRuntime: {
    isAvailable: jest.fn(),
    isCompletionV2Available: jest.fn(() => false),
    createCompletionRequestId: jest.fn(),
    bootstrap: jest.fn(),
    credentialStatus: jest.fn(),
    presentCredentialPrompt: jest.fn(),
    clearCredential: jest.fn(),
    complete: jest.fn(),
    completeV2: jest.fn(),
    recordModelTransition: jest.fn(),
    cancelCompletion: jest.fn(),
    persistSession: jest.fn(),
    loadSession: jest.fn(),
  },
}));
jest.mock('../src/agent/runAgentTurn', () => ({
  runAgentTurn: jest.fn(),
}));
jest.mock('../src/native/LocalAttachments', () => ({
  LocalAttachments: {
    isAvailable: jest.fn(),
    present: jest.fn(),
    discard: jest.fn(),
    prune: jest.fn(),
    preview: jest.fn(),
    presentPreview: jest.fn(),
  },
}));
jest.mock('../src/native/LocalWorkspace', () => ({
  LocalWorkspace: {
    isAvailable: jest.fn(),
    capabilities: jest.fn(),
    listDirectory: jest.fn(),
    readText: jest.fn(),
    writeText: jest.fn(),
    createDirectory: jest.fn(),
    renameEntry: jest.fn(),
    trashEntry: jest.fn(),
    listTrash: jest.fn(),
    restoreFromTrash: jest.fn(),
    executePortableTool: jest.fn(),
  },
}));
jest.mock('../src/native/LocalProjects', () => ({
  LocalProjects: {
    isAvailable: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    clone: jest.fn(),
    status: jest.fn(),
    diff: jest.fn(),
    stageAll: jest.fn(),
    commit: jest.fn(),
    setRemote: jest.fn(),
    credentialStatus: jest.fn(),
    presentCredentialPrompt: jest.fn(),
    clearCredential: jest.fn(),
    push: jest.fn(),
  },
}));
jest.mock('../src/native/LocalProjectContext', () => {
  const actual = jest.requireActual('../src/native/LocalProjectContext');
  return {
    ...actual,
    LocalProjectContext: {
      isAvailable: jest.fn(),
      listCandidates: jest.fn(),
      prepare: jest.fn(),
      confirm: jest.fn(),
      inspect: jest.fn(),
      discard: jest.fn(),
    },
  };
});
jest.mock('../src/native/LocalMirrors', () => ({
  LocalMirrors: {
    isAvailable: jest.fn(),
    apply: jest.fn(),
    status: jest.fn(),
  },
}));
jest.mock('../src/native/LocalWorkspaces', () => ({
  LocalWorkspaces: {
    isAvailable: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    grantFolder: jest.fn(),
    importFolder: jest.fn(),
    resolve: jest.fn(),
    forget: jest.fn(),
  },
}));
jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react') as typeof React;
  return {
    SafeAreaProvider: ({ children }: React.PropsWithChildren) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
  };
});

type MockLocalRuntime = Record<
  | 'isAvailable'
  | 'createCompletionRequestId'
  | 'bootstrap'
  | 'credentialStatus'
  | 'presentCredentialPrompt'
  | 'clearCredential'
  | 'complete'
  | 'completeV2'
  | 'isCompletionV2Available'
  | 'recordModelTransition'
  | 'cancelCompletion'
  | 'persistSession'
  | 'loadSession',
  jest.Mock
>;
const mockLocalRuntime = (
  jest.requireMock('../src/native/LocalRuntime') as {
    LocalRuntime: MockLocalRuntime;
  }
).LocalRuntime;
const mockRunAgentTurn = (
  jest.requireMock('../src/agent/runAgentTurn') as {
    runAgentTurn: jest.Mock;
  }
).runAgentTurn;
const mockLocalAttachments = (
  jest.requireMock('../src/native/LocalAttachments') as {
    LocalAttachments: Record<string, jest.Mock>;
  }
).LocalAttachments;
const mockLocalWorkspaces = (
  jest.requireMock('../src/native/LocalWorkspaces') as {
    LocalWorkspaces: Record<string, jest.Mock>;
  }
).LocalWorkspaces;
const mockLocalWorkspace = (
  jest.requireMock('../src/native/LocalWorkspace') as {
    LocalWorkspace: Record<string, jest.Mock>;
  }
).LocalWorkspace;
const mockLocalProjects = (
  jest.requireMock('../src/native/LocalProjects') as {
    LocalProjects: Record<string, jest.Mock>;
  }
).LocalProjects;
const mockLocalProjectContext = (
  jest.requireMock('../src/native/LocalProjectContext') as {
    LocalProjectContext: Record<string, jest.Mock>;
  }
).LocalProjectContext;
const mockLocalMirrors = (
  jest.requireMock('../src/native/LocalMirrors') as {
    LocalMirrors: Record<string, jest.Mock>;
  }
).LocalMirrors;

const proof = {
  schema_version: 2,
  mode: 'local_substrate',
  platform: 'ios_simulator',
  bundle_id: 'dev.zseven.dsh.mobile',
  runtime_id: 'runtime-1',
  launch_instance_id: 'launch-1',
  process_id: 123,
  generated_at: '2026-08-24T00:00:00.000Z',
  container_root: 'Application Support',
  session_store: 'sessions.json',
  model_transport: 'url_session',
  rish_backend: 'portable_applet',
  rish_protocol_version: 1,
  rish_probe: { path_kind: 'portable_applet' },
  mac_dsh_port_3180_reachable: false,
  checks: {
    credential_in_keychain: true,
    model_response_received: false,
    session_restored_after_restart: false,
    rish_applet_executed: true,
  },
};

type StrictCompletionRequest = {
  schemaVersion: 2 | 3;
  turnId: string;
  attemptId: string;
  roundId: string;
  roundIndex: number;
  model: string;
  thinkingMode: string;
  visibleHistory?: Array<{ attachments?: unknown }>;
  projectContext?: {
    schemaVersion: number;
    snapshotId: string;
    consentReceiptId: string;
    conversationId: string;
    projectId: string;
    provider: string;
    policy: string;
  } | null;
};

function strictCompletionResult(
  request: StrictCompletionRequest,
  overrides: Record<string, unknown> = {},
) {
  return {
    schema_version: request.schemaVersion,
    turn_id: request.turnId,
    attempt_id: request.attemptId,
    round_id: request.roundId,
    round_index: request.roundIndex,
    provider_request_id: request.roundId,
    provider_response_id: `resp_${request.roundId}`,
    requested_model: request.model,
    model: request.model,
    thinking_mode: request.thinkingMode,
    text: 'STRICT_LOCAL_OK',
    reasoning: '',
    tool_calls: [],
    finish_reason: 'stop',
    latency_ms: 24,
    visible_history_sha256: 'a'.repeat(64),
    model_input_sha256: 'b'.repeat(64),
    request_body_sha256: 'c'.repeat(64),
    project_context_receipt: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const CONTEXT_PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const CONTEXT_RUNTIME_ID = '11111111-1111-4111-8111-111111111111';
const CONTEXT_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const CONTEXT_CONSENT_ID = '33333333-3333-4333-8333-333333333333';
const CONTEXT_PREPARATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const contextProject = {
  schema_version: 1 as const,
  id: CONTEXT_PROJECT_ID,
  name: 'verified-demo',
  workspace_path: `projects/${CONTEXT_PROJECT_ID}/repo`,
  created_at: '2026-08-28T00:00:00.000Z',
  updated_at: '2026-08-28T00:00:00.000Z',
  origin_url: null,
};

function contextManifest(): ProjectContextManifestV1 {
  return {
    schema_version: 1,
    snapshot_id: CONTEXT_SNAPSHOT_ID,
    project_id: CONTEXT_PROJECT_ID,
    project_name: contextProject.name,
    branch: 'main',
    head_oid: '0'.repeat(40),
    clean: true,
    conflicted: false,
    captured_at: '2026-08-28T00:00:00.000Z',
    policy_version: 'chat-read-v1.0.0',
    provider_host: 'api.deepseek.com',
    model: 'deepseek-v4-flash',
    included: [
      {
        path: 'README.md',
        source: 'tracked_file',
        bytes: 16,
        sha256: 'f'.repeat(64),
      },
    ],
    omitted: [],
    context_bytes: 16,
    estimated_tokens: 4,
    snapshot_sha256: 'd'.repeat(64),
    source_fingerprint: 'e'.repeat(64),
  };
}

function storedProjectContext(confirmed: boolean) {
  let messageId = 0;
  const lifecycleIds = [
    CONTEXT_RUNTIME_ID,
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
    '77777777-7777-4777-8777-777777777777',
    '88888888-8888-4888-8888-888888888888',
    '99999999-9999-4999-8999-999999999999',
  ];
  const stored = createChatStore({
    now: () => '2026-08-28T00:00:00.000Z',
    createId: kind => `${kind}-${++messageId}`,
    createLifecycleId: () => lifecycleIds.shift()!,
  });
  const conversationId = stored.createConversation({
    projectId: CONTEXT_PROJECT_ID,
  });
  expect(stored.ensureRuntimeContextId(conversationId)).toBe(
    CONTEXT_RUNTIME_ID,
  );
  const manifest = contextManifest();
  const initial = stored.getState().conversations[conversationId]!;
  const prepared = stored.replaceProjectContextPrepared(
    {
      conversationId,
      projectId: CONTEXT_PROJECT_ID,
      runtimeContextId: CONTEXT_RUNTIME_ID,
      modelId: initial.modelId,
      expectedContext: initial.projectContext!,
    },
    {
      preparationId: CONTEXT_PREPARATION_ID,
      selectedPaths: ['README.md'],
      manifest,
    },
  );
  expect(prepared?.commit()).toBe(true);
  if (confirmed) {
    const preparedConversation = stored.getState().conversations[conversationId]!;
    const transaction = stored.replaceProjectContextConfirmed(
      {
        conversationId,
        projectId: CONTEXT_PROJECT_ID,
        runtimeContextId: CONTEXT_RUNTIME_ID,
        modelId: preparedConversation.modelId,
        expectedContext: preparedConversation.projectContext!,
      },
      {
        preparationId: CONTEXT_PREPARATION_ID,
        selectedPaths: ['README.md'],
        manifest,
        consent: {
          schema_version: 1,
          consent_receipt_id: CONTEXT_CONSENT_ID,
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: manifest.snapshot_sha256,
          confirmed_at: '2026-08-28T00:00:01.000Z',
        },
      },
    );
    expect(transaction?.commit()).toBe(true);
  }
  return { stored, conversationId, manifest };
}

function storedSetupProject() {
  const stored = createChatStore({
    now: () => '2026-08-28T00:00:00.000Z',
  });
  const conversationId = stored.createConversation({
    projectId: CONTEXT_PROJECT_ID,
  });
  return { stored, conversationId };
}

function storedLifecycleCheckpoint(
  phase: 'intent' | 'cleanup_pending' | 'ready_to_finalize',
) {
  const fixture = storedProjectContext(true);
  const conversation = fixture.stored.getState().conversations[
    fixture.conversationId
  ]!;
  const begun = fixture.stored.beginProjectContextDestructiveTransition({
    lifecycleId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    action: 'unbind',
    targetProjectId: null,
    owner: {
      conversationId: fixture.conversationId,
      projectId: conversation.projectId!,
      runtimeContextId: conversation.runtimeContextId,
      modelId: conversation.modelId,
      expectedUpdatedAt: conversation.updatedAt,
      expectedContext: conversation.projectContext!,
    },
  })!;
  expect(begun.commit()).toBe(true);
  if (phase !== 'intent') {
    const transition = fixture.stored.getState()
      .projectContextDestructiveTransition!;
    const tombstone =
      fixture.stored.tombstoneProjectContextDestructiveTransition({
        lifecycleId: transition.lifecycleId,
        epoch: transition.epoch,
        action: transition.action,
        targetProjectId: transition.targetProjectId,
        expectedTransition: transition,
      })!;
    expect(tombstone.commit()).toBe(true);
  }
  if (phase === 'ready_to_finalize') {
    const transition = fixture.stored.getState()
      .projectContextDestructiveTransition!;
    const ready =
      fixture.stored.markProjectContextDestructiveCleanupComplete({
        lifecycleId: transition.lifecycleId,
        epoch: transition.epoch,
        action: transition.action,
        targetProjectId: transition.targetProjectId,
        expectedTransition: transition,
      })!;
    expect(ready.commit()).toBe(true);
  }
  return fixture;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderApp(): Promise<Renderer> {
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(<App />);
    await settle();
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
}

function lastPersistedState() {
  const calls = mockLocalRuntime.persistSession.mock.calls;
  const serialized = calls.at(-1)?.[0];
  if (typeof serialized !== 'string') throw new Error('no persisted state');
  return JSON.parse(serialized) as {
    active_conversation_id: string;
    conversations: Array<{
      id: string;
      model_id: string;
      project_id: string | null;
      project_context: null | {
        status: string;
        selected_paths: string[];
        manifest: null | { snapshot_id: string };
        consent: null | { consent_receipt_id: string };
      };
      workspace_id: string | null;
      thinking_mode: string;
      attempts?: Array<{
        attempt_id: string;
        status: string;
        context_disposition?: string;
        project_context?: null | { snapshot_id: string };
        assistant_message_id: string | null;
        failure_code: string | null;
        rounds: Array<{ round_id: string }>;
      }>;
      messages: Array<{
        role: string;
        text: string;
        metadata?: { model_id?: string };
        attachments: Array<{
          id: string;
          kind: string;
          thumbnail_data_url?: string;
        }>;
      }>;
    }>;
    messages: Array<{
      role: string;
      text: string;
      metadata?: { model_id?: string };
      attachments: Array<{
        id: string;
        kind: string;
        thumbnail_data_url?: string;
      }>;
    }>;
  };
}

function persistedStates(): Array<ReturnType<typeof lastPersistedState>> {
  return mockLocalRuntime.persistSession.mock.calls.flatMap(call => {
    const value = call[0];
    return typeof value === 'string'
      ? [JSON.parse(value) as ReturnType<typeof lastPersistedState>]
      : [];
  });
}

function actionByLabel(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance {
  const action = root
    .findAllByProps({ accessibilityLabel: label })
    .find(instance => typeof instance.props.onPress === 'function');
  if (action === undefined) throw new Error(`no actionable ${label}`);
  return action;
}

function visibleContextSheets(root: ReactTestInstance): ReactTestInstance[] {
  return root
    .findAllByType(ProjectContextSheet)
    .filter(sheet => sheet.props.visible === true);
}

async function openProjectsSurface(root: ReactTestInstance): Promise<void> {
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    root.findByType(ChatDrawer).props.onOpenProjects();
    root.findByType(ChatDrawer).props.onDismiss();
    await settle();
  });
  expect(root.findByType(ProjectsSurface).props.visible).toBe(true);
}

async function renderSetupProjectApp(): Promise<Renderer> {
  const fixture = storedSetupProject();
  mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [contextProject],
  });
  return await renderApp();
}

async function enterPendingProjectRecovery(
  root: ReactTestInstance,
  text: string,
) {
  await act(async () =>
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText(text),
  );
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
}

async function preparePendingProjectDisclosure(root: ReactTestInstance) {
  await act(async () =>
    actionByLabel(root, 'Refresh and send').props.onPress(),
  );
  await act(async () => {
    jest.advanceTimersByTime(180);
    await settle();
  });
  await act(async () =>
    root
      .findByProps({ testID: 'project-context-candidate-README.md' })
      .props.onPress(),
  );
  await act(async () => {
    actionByLabel(root, 'Prepare context').props.onPress();
    await settle();
    await settle();
  });
}

function composerOptionsChip(root: ReactTestInstance): ReactTestInstance {
  const chip = root
    .findAllByProps({ testID: 'composer-options-chip' })
    .find(instance => typeof instance.props.onPress === 'function');
  if (chip === undefined) throw new Error('no composer options chip');
  return chip;
}

function optionInComposerPanel(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance {
  const popover = root.findAllByProps({
    testID: 'conversation-options-popover',
  })[0];
  if (popover === undefined) throw new Error('composer panel not rendered');
  return actionByLabel(popover, label);
}

test('binds the active conversation to a chosen local workspace', async () => {
  mockLocalWorkspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [
      {
        schema_version: 1,
        workspace_id: 'ws-alpha',
        display_name: 'Alpha',
        origin: 'rish_created',
        created_at: '2026-08-27T01:00:00.000Z',
        last_opened_at: '2026-08-27T01:00:00.000Z',
        status: 'ok',
      },
      {
        schema_version: 1,
        workspace_id: 'ws-beta',
        display_name: 'Beta',
        origin: 'granted_folder',
        created_at: '2026-08-27T01:00:00.000Z',
        last_opened_at: '2026-08-27T01:00:00.000Z',
        status: 'ok',
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () =>
    actionByLabel(root, 'Choose workspace').props.onPress(),
  );
  await act(async () => settle());
  const sheetHosts = () =>
    root
      .findAllByProps({ testID: 'workspace-picker-sheet' })
      .filter(node => typeof node.type === 'string');
  expect(sheetHosts()).toHaveLength(1);

  await act(async () => {
    const popover = root.findByProps({
      testID: 'workspace-picker-sheet',
    }) as ReactTestInstance;
    actionByLabel(popover, 'Use Alpha').props.onPress();
    await settle();
  });

  expect(sheetHosts()).toHaveLength(0);
  expect(lastPersistedState().conversations[0]?.workspace_id).toBe('ws-alpha');
});

async function chooseAttachmentSource(
  root: ReactTestInstance,
  label: 'Camera' | 'Photos' | 'Files',
) {
  const modal = root.findByProps({ testID: 'attachment-menu-modal' });
  await act(async () => actionByLabel(root, label).props.onPress());
  await act(async () => {
    modal.props.onDismiss();
    await settle();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  let requestCounter = 0;
  mockLocalRuntime.isAvailable.mockReturnValue(true);
  mockLocalRuntime.createCompletionRequestId.mockImplementation(
    () =>
      `${String(++requestCounter).padStart(
        8,
        '0',
      )}-0000-4000-8000-000000000000`,
  );
  mockLocalRuntime.credentialStatus.mockResolvedValue({ status: 'configured' });
  mockLocalRuntime.bootstrap.mockResolvedValue({ proof, rish: {} });
  mockLocalRuntime.loadSession.mockResolvedValue(null);
  mockLocalRuntime.persistSession.mockResolvedValue(true);
  mockLocalRuntime.complete.mockResolvedValue({
    text: 'SIMULATOR_LOCAL_OK',
    model: 'deepseek-v4-flash',
    request_id: 'request-1',
    latency_ms: 42,
    reasoning: '',
    thinking_mode: 'high',
  });
  mockLocalRuntime.completeV2.mockImplementation(
    async (request: StrictCompletionRequest) =>
      strictCompletionResult(request),
  );
  mockRunAgentTurn.mockResolvedValue({
    status: 'failed',
    traces: [],
    failure: { code: 'E_AGENT_FAILED' },
  });
  mockLocalRuntime.recordModelTransition.mockResolvedValue({ recorded: 1 });
  mockLocalRuntime.cancelCompletion.mockResolvedValue({ status: 'cancelled' });
  mockLocalRuntime.presentCredentialPrompt.mockResolvedValue({
    status: 'configured',
  });
  mockLocalRuntime.clearCredential.mockResolvedValue({ status: 'cleared' });
  mockLocalAttachments.isAvailable.mockReturnValue(true);
  mockLocalAttachments.present.mockResolvedValue({
    schema_version: 1,
    status: 'cancelled',
    attachments: [],
  });
  mockLocalAttachments.discard.mockResolvedValue({
    schema_version: 1,
    discarded_count: 0,
  });
  mockLocalAttachments.prune.mockResolvedValue({
    schema_version: 1,
    removed_count: 0,
  });
  mockLocalAttachments.preview.mockResolvedValue({
    schema_version: 1,
    id: 'attachment-1',
    thumbnail_data_url: null,
  });
  mockLocalAttachments.presentPreview.mockResolvedValue({
    schema_version: 1,
    status: 'closed',
  });
  mockLocalWorkspace.isAvailable.mockReturnValue(true);
  mockLocalWorkspace.listDirectory.mockResolvedValue({ path: '', entries: [] });
  mockLocalWorkspace.listTrash.mockResolvedValue({
    entries: [],
    invalid_record_count: 0,
  });
  mockLocalWorkspace.writeText.mockResolvedValue({
    created: true,
    file: {
      path: 'note.md',
      name: 'note.md',
      kind: 'file',
      size: 0,
      modified_at: '2026-08-24T00:00:00.000Z',
      revision: 'rev-1',
    },
  });
  mockLocalWorkspace.createDirectory.mockResolvedValue({
    directory: {
      path: 'docs',
      name: 'docs',
      kind: 'directory',
      size: 0,
      modified_at: '2026-08-24T00:00:00.000Z',
    },
  });
  mockLocalWorkspace.executePortableTool.mockResolvedValue({
    tool: 'sha256sum',
    path: 'note.md',
    exit_code: 0,
    stdout: 'abc  note.md\n',
    stderr: '',
    protocol_version: 1,
    path_kind: 'portable_applet',
  });
  mockLocalProjects.isAvailable.mockReturnValue(true);
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [],
  });
  mockLocalProjects.status.mockResolvedValue({
    schema_version: 1,
    project_id: 'project-1',
    branch: 'main',
    head_oid: null,
    clean: true,
    has_conflicts: false,
    ahead: 0,
    behind: 0,
    entries: [],
  });
  mockLocalProjects.diff.mockResolvedValue({
    schema_version: 1,
    project_id: 'project-1',
    staged: false,
    truncated: false,
    patch: '',
    files: [],
  });
  mockLocalProjects.credentialStatus.mockResolvedValue({
    schema_version: 1,
    project_id: 'project-1',
    host: '',
    configured: false,
  });
  mockLocalProjectContext.isAvailable.mockReturnValue(true);
  mockLocalProjectContext.listCandidates.mockImplementation(
    async (projectId: string) => ({
      schema_version: 1,
      project_id: projectId,
      candidates: [],
      next_cursor: null,
    }),
  );
  mockLocalProjectContext.prepare.mockRejectedValue({
    code: 'E_CONTEXT_REQUEST_INVALID',
  });
  mockLocalProjectContext.confirm.mockRejectedValue({
    code: 'E_CONTEXT_REQUEST_INVALID',
  });
  mockLocalProjectContext.inspect.mockRejectedValue({
    code: 'E_CONTEXT_SNAPSHOT_MISSING',
  });
  mockLocalProjectContext.discard.mockResolvedValue({
    schema_version: 1,
    status: 'discarded',
  });
  mockLocalMirrors.isAvailable.mockReturnValue(true);
  mockLocalMirrors.status.mockResolvedValue(null);
  mockLocalMirrors.apply.mockResolvedValue({
    schema_version: 1,
    status: 'staged',
    staged_at: '2026-08-24T00:00:00.000Z',
    guest_runtime_mounted: false,
    root: 'rish-guest-overlay',
    entries: [],
  });
});

afterEach(() => {
  jest.useRealTimers();
});

test('boots into a usable local empty chat', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.editable,
  ).toBe(true);
  expect(
    root.findByProps({ accessibilityLabel: 'Open navigation' }),
  ).toBeDefined();
  expect(
    root.findAllByProps({ accessibilityLabel: 'Show runtime evidence' }),
  ).toHaveLength(0);
  expect(root.findByProps({ accessibilityLabel: 'Rish' })).toBeDefined();
  expect(mockLocalRuntime.bootstrap).toHaveBeenCalledTimes(1);
});

test.each(['prepared', 'failed'] as const)(
  'surfaces Retry for a hydrated %s attempt without automatic HTTP',
  async status => {
    const lifecycleIds = [
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
    ];
    let messageId = 0;
    const stored = createChatStore({
      now: () => '2026-08-28T00:00:00.000Z',
      createId: kind => `${kind}-${++messageId}`,
      createLifecycleId: () => lifecycleIds.shift()!,
    });
    const conversationId = stored.createConversation();
    const prepared = stored.prepareTurnAttempt(
      conversationId,
      `${status} after restart`,
    )!;
    prepared.commit();
    if (status === 'failed') {
      stored.failAttempt(
        conversationId,
        prepared.attemptId,
        'E_COMPLETION_TRANSPORT',
      );
    }
    mockLocalRuntime.loadSession.mockResolvedValueOnce(stored.serialize());

    const renderer = await renderApp();
    expect(actionByLabel(renderer.root, 'Retry response')).toBeDefined();
    if (status === 'prepared') {
      expect(
        renderer.root.findByProps({ accessibilityLabel: 'Message DSH' }).props
          .editable,
      ).toBe(false);
      expect(actionByLabel(renderer.root, 'Send message').props.disabled).toBe(
        true,
      );
    }
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  },
);

test('runtime evidence retry refreshes proof without rehydrating active chat state', async () => {
  mockLocalRuntime.bootstrap
    .mockRejectedValueOnce(new Error('temporary proof failure'))
    .mockResolvedValueOnce({ proof, rish: {} });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => composerOptionsChip(root).props.onPress());
  await act(async () => {
    optionInComposerPanel(root, 'Use V4 Pro').props.onPress();
    await settle();
  });
  await act(async () => optionInComposerPanel(root, 'Done').props.onPress());
  const stale = JSON.parse(
    mockLocalRuntime.persistSession.mock.calls.at(-1)?.[0] as string,
  ) as { conversations: Array<{ model_id: string }> };
  if (stale.conversations[0] !== undefined) {
    stale.conversations[0].model_id = 'deepseek-v4-flash';
  }
  mockLocalRuntime.loadSession.mockResolvedValueOnce(JSON.stringify(stale));

  await act(async () =>
    actionByLabel(root, 'Show runtime evidence').props.onPress(),
  );
  await act(async () => {
    actionByLabel(root, 'Retry runtime check').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.bootstrap).toHaveBeenCalledTimes(2);
  expect(mockLocalRuntime.loadSession).not.toHaveBeenCalled();
  expect(composerOptionsChip(root).props.accessibilityLabel).toBe(
    'Model V4 Pro, thinking High',
  );
  expect(lastPersistedState().conversations[0]?.model_id).toBe(
    'deepseek-v4-pro',
  );
});

test('presents DSH as one built-in harness under the Rish runtime', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Harnesses').props.onPress());
  await act(async () => settle());

  expect(actionByLabel(root, 'Use DSH')).toBeDefined();
  expect(root.findByProps({ children: 'Harness manifest v1' })).toBeDefined();
  expect(root.findByProps({ children: 'Current harness' })).toBeDefined();
});

test('opens Projects as a full-width primary surface from the navigation drawer', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Projects').props.onPress();
    await settle();
  });

  expect(mockLocalProjects.list).toHaveBeenCalledTimes(1);
  expect(root.findByProps({ children: 'No projects yet' })).toBeDefined();
  expect(actionByLabel(root, 'New project')).toBeDefined();
});

describe('project context Home integration H1', () => {
  test('hydrates a confirmed snapshot as Checking until one native inspection confirms', async () => {
    const fixture = storedProjectContext(true);
    const inspection = deferred<ProjectContextInspectionV1>();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockReturnValueOnce(inspection.promise);

    const renderer = await renderApp();
    const root = renderer.root;
    expect(mockLocalProjectContext.inspect).toHaveBeenCalledTimes(1);
    expect(mockLocalProjectContext.inspect).toHaveBeenCalledWith(
      CONTEXT_SNAPSHOT_ID,
    );
    expect(root.findByProps({ children: 'Checking' })).toBeDefined();
    expect(root.findAllByProps({ children: 'Ready' })).toHaveLength(0);
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(mockLocalRuntime.complete).not.toHaveBeenCalled();

    inspection.resolve({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    await act(async () => settle());

    expect(root.findByProps({ children: 'Ready' })).toBeDefined();
    expect(mockLocalProjectContext.inspect).toHaveBeenCalledTimes(1);
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('fails closed when hydrated native inspection rejects', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockRejectedValueOnce({
      code: 'E_CONTEXT_TIMEOUT',
      message: 'RAW_NATIVE_SENTINEL /private/project',
    });

    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());

    expect(root.findByProps({ children: 'Error' })).toBeDefined();
    expect(root.findAllByProps({ children: 'Ready' })).toHaveLength(0);
    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.editable,
    ).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain(
      'RAW_NATIVE_SENTINEL',
    );
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(mockLocalRuntime.complete).not.toHaveBeenCalled();
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();
  });

  test('opens Context only after Projects starts dismissal and renders one Strip', async () => {
    jest.useFakeTimers();
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });
    await act(async () => {
      actionByLabel(root, `Open project ${contextProject.name}`).props.onPress();
      await settle();
    });

    await act(async () => {
      actionByLabel(root, 'Chat in this project').props.onPress();
      expect(visibleContextSheets(root)).toHaveLength(0);
      await settle();
    });
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });

    expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(mockLocalProjectContext.listCandidates).toHaveBeenCalledTimes(1);
    expect(root.findAllByType(ProjectContextStrip)).toHaveLength(1);
    expect(
      root.findAllByProps({ accessibilityLabel: `Project ${contextProject.name}` }),
    ).toHaveLength(0);
    expect(
      Object.prototype.hasOwnProperty.call(
        root.findByType(ChatComposer).props,
        'projectName',
      ),
    ).toBe(false);
    jest.useRealTimers();
  });

  test('opens current confirmed context as disclosure without confirmation', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValueOnce({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    await act(async () => settle());

    const sheet = visibleContextSheets(root)[0];
    expect(sheet?.props.mode).toBe('disclosure');
    expect(sheet?.props.confirmationRequired).toBe(false);
    expect(
      root.findAllByProps({ accessibilityLabel: 'Confirm context' }),
    ).toHaveLength(0);
  });

  test('shows Context Checking immediately after Projects dismisses while reinspection is pending', async () => {
    const fixture = storedProjectContext(true);
    const reinspection = deferred<ProjectContextInspectionV1>();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect
      .mockResolvedValueOnce({
        schema_version: 1,
        state: 'confirmed',
        manifest: fixture.manifest,
      })
      .mockReturnValueOnce(reinspection.promise);
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });

    await act(async () => {
      root.findByType(ProjectsSurface).props.onChatInProject(contextProject);
      await settle();
    });

    expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(visibleContextSheets(root)[0]?.props.checking).toBe(true);
    expect(mockLocalProjectContext.inspect).toHaveBeenCalledTimes(2);

    reinspection.resolve({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    await act(async () => settle());
    expect(visibleContextSheets(root)[0]?.props.checking).toBe(false);
  });

  test('selects a fresh candidate, prepares disclosure, and confirms durably with zero HTTP', async () => {
    jest.useFakeTimers();
    const manifest = contextManifest();
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'README.md',
          size: 16,
          revision: 'f'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    mockLocalProjectContext.prepare.mockResolvedValue(manifest);
    mockLocalProjectContext.confirm.mockResolvedValue({
      schema_version: 1,
      consent_receipt_id: CONTEXT_CONSENT_ID,
      snapshot_id: CONTEXT_SNAPSHOT_ID,
      snapshot_sha256: manifest.snapshot_sha256,
      confirmed_at: '2026-08-28T00:00:01.000Z',
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });
    await act(async () => {
      actionByLabel(root, `Open project ${contextProject.name}`).props.onPress();
      await settle();
    });
    await act(async () => {
      actionByLabel(root, 'Chat in this project').props.onPress();
      await settle();
    });
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });

    await act(async () =>
      root
        .findByProps({ testID: 'project-context-candidate-README.md' })
        .props.onPress(),
    );
    await act(async () => {
      actionByLabel(root, 'Prepare context').props.onPress();
      await settle();
      await settle();
    });
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('disclosure');
    expect(visibleContextSheets(root)[0]?.props.confirmationRequired).toBe(true);
    expect(visibleContextSheets(root)[0]?.props.manifest).toEqual(manifest);
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();

    await act(async () => {
      actionByLabel(root, 'Confirm context').props.onPress();
      await settle();
      await settle();
    });
    expect(mockLocalProjectContext.confirm).toHaveBeenCalledWith(
      CONTEXT_SNAPSHOT_ID,
    );
    expect(visibleContextSheets(root)).toHaveLength(0);
    const persisted = lastPersistedState().conversations.find(
      conversation => conversation.project_id === CONTEXT_PROJECT_ID,
    );
    expect(persisted?.project_context).toMatchObject({
      status: 'ready',
      selected_paths: ['README.md'],
      manifest: { snapshot_id: CONTEXT_SNAPSHOT_ID },
      consent: { consent_receipt_id: CONTEXT_CONSENT_ID },
    });
    expect(root.findByProps({ children: 'Ready' })).toBeDefined();
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(mockLocalRuntime.complete).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  test('opens a persisted prepared snapshot as disclosure requiring confirmation', async () => {
    const fixture = storedProjectContext(false);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValueOnce({
      schema_version: 1,
      state: 'prepared',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );

    const sheet = visibleContextSheets(root)[0];
    expect(sheet?.props.mode).toBe('disclosure');
    expect(sheet?.props.confirmationRequired).toBe(true);
    expect(actionByLabel(root, 'Confirm context')).toBeDefined();
  });

  test('opens a retryable completion owner read-only with zero context attach side effects', async () => {
    const fixture = storedProjectContext(true);
    const pending = fixture.stored.prepareTurnAttempt(
      fixture.conversationId,
      'Retry this project request',
    );
    expect(pending?.commit()).toBe(true);
    expect(
      fixture.stored.failAttempt(
        fixture.conversationId,
        pending!.attemptId,
        'E_COMPLETION_NATIVE',
      ),
    ).toBe(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });

    const renderer = await renderApp();
    const root = renderer.root;
    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();
    expect(mockLocalProjectContext.listCandidates).not.toHaveBeenCalled();
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    await act(async () => settle());

    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();
    expect(mockLocalProjectContext.listCandidates).not.toHaveBeenCalled();
    expect(
      root.findAllByProps({ accessibilityLabel: 'Stop response' }),
    ).toHaveLength(0);
  });

  test('hard-blocks model and options callbacks while Context owns an inspection', async () => {
    const fixture = storedProjectContext(true);
    const inspection = deferred<ProjectContextInspectionV1>();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockReturnValueOnce(inspection.promise);
    const renderer = await renderApp();
    const root = renderer.root;

    await act(async () => root.findByType(ChatComposer).props.onOptionsPress());
    await act(async () => root.findByType(ChatDrawer).props.onOpenSettings());
    expect(
      root.findAllByProps({ testID: 'conversation-options-popover' }),
    ).toHaveLength(0);
    expect(root.findByType(SettingsSheet).props.visible).toBe(false);
    await act(async () => root.findByType(SettingsSheet).props.onOpenModelPicker());
    expect(root.findByType(ModelPicker).props.visible).toBe(false);
    await act(async () =>
      root.findByType(ModelPicker).props.onSelect('deepseek-v4-pro'),
    );
    await act(async () =>
      root
        .findByType(ConversationOptionsPicker)
        .props.onSelectThinkingMode('max'),
    );
    expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();

    inspection.resolve({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    await act(async () => settle());
  });

  test('reconciles Context after a retryable Completion owner returns idle', async () => {
    const fixture = storedProjectContext(true);
    const pending = fixture.stored.prepareTurnAttempt(
      fixture.conversationId,
      'Retry and release context ownership',
    );
    expect(pending?.commit()).toBe(true);
    expect(
      fixture.stored.failAttempt(
        fixture.conversationId,
        pending!.attemptId,
        'E_COMPLETION_NATIVE',
      ),
    ).toBe(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    mockLocalRuntime.completeV2.mockImplementationOnce(
      async (request: StrictCompletionRequest) => ({
        ...strictCompletionResult(request, { text: 'Retry succeeded' }),
        project_context_receipt: {
          schema_version: 1,
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: fixture.manifest.snapshot_sha256,
          source_fingerprint: fixture.manifest.source_fingerprint,
          context_bytes: fixture.manifest.context_bytes,
          verified_at: '2026-08-28T00:00:02.000Z',
        },
      }),
    );
    const renderer = await renderApp();
    const root = renderer.root;
    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();

    await act(async () =>
      actionByLabel(root, 'Retry response').props.onPress(),
    );
    await act(async () => settle());

    expect(mockLocalProjectContext.inspect).toHaveBeenCalledTimes(1);
    expect(root.findByProps({ children: 'Ready' })).toBeDefined();
  });

  test('never projects prior-owner candidate metadata into a retryable conversation', async () => {
    jest.useFakeTimers();
    const fixture = storedProjectContext(true);
    fixture.stored.renameConversation(fixture.conversationId, 'Project A');
    fixture.stored.appendUserMessage(fixture.conversationId, 'Visible A');
    const conversationB = fixture.stored.createConversation({
      projectId: CONTEXT_PROJECT_ID,
    });
    const runtimeB = fixture.stored.ensureRuntimeContextId(conversationB)!;
    const initialB = fixture.stored.getState().conversations[conversationB]!;
    const preparedB = fixture.stored.replaceProjectContextPrepared(
      {
        conversationId: conversationB,
        projectId: CONTEXT_PROJECT_ID,
        runtimeContextId: runtimeB,
        modelId: initialB.modelId,
        expectedContext: initialB.projectContext!,
      },
      {
        preparationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        selectedPaths: ['README.md'],
        manifest: fixture.manifest,
      },
    );
    expect(preparedB?.commit()).toBe(true);
    const preparedConversationB =
      fixture.stored.getState().conversations[conversationB]!;
    const confirmedB = fixture.stored.replaceProjectContextConfirmed(
      {
        conversationId: conversationB,
        projectId: CONTEXT_PROJECT_ID,
        runtimeContextId: runtimeB,
        modelId: preparedConversationB.modelId,
        expectedContext: preparedConversationB.projectContext!,
      },
      {
        preparationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        selectedPaths: ['README.md'],
        manifest: fixture.manifest,
        consent: {
          schema_version: 1,
          consent_receipt_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: fixture.manifest.snapshot_sha256,
          confirmed_at: '2026-08-28T00:00:02.000Z',
        },
      },
    );
    expect(confirmedB?.commit()).toBe(true);
    fixture.stored.renameConversation(conversationB, 'Project B');
    const retryB = fixture.stored.prepareTurnAttempt(
      conversationB,
      'Visible B retry',
    );
    expect(retryB?.commit()).toBe(true);
    expect(
      fixture.stored.failAttempt(
        conversationB,
        retryB!.attemptId,
        'E_COMPLETION_NATIVE',
      ),
    ).toBe(true);
    fixture.stored.selectConversation(fixture.conversationId);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'SECRET_A.ts',
          size: 10,
          revision: 'a'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    await act(async () =>
      visibleContextSheets(root)[0]!.props.onRefreshCandidates(),
    );
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });
    expect(visibleContextSheets(root)[0]?.props.candidates).toHaveLength(1);
    mockLocalProjectContext.inspect.mockRejectedValueOnce({
      code: 'E_CONTEXT_TIMEOUT',
    });
    await act(async () =>
      visibleContextSheets(root)[0]!.props.onRefreshContext(),
    );
    await act(async () => settle());
    expect(root.findByProps({ children: 'Error' })).toBeDefined();
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () =>
      actionByLabel(root, 'Open chat Project B').props.onPress(),
    );
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );

    const sheetB = visibleContextSheets(root)[0]!;
    expect(sheetB.props.candidates).toEqual([]);
    expect(sheetB.props.selectedCandidates).toEqual([]);
    expect(sheetB.props.errorCode).toBeNull();
    expect(sheetB.props.checking).toBe(true);
    expect(root.findAllByProps({ children: 'Error' })).toHaveLength(0);
    expect(root.findAllByProps({ children: 'Recovery required' })).toHaveLength(
      0,
    );
    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.editable,
    ).toBe(true);
    mockLocalRuntime.completeV2.mockImplementationOnce(
      async (request: StrictCompletionRequest) => ({
        ...strictCompletionResult(request, { text: 'B retry completed' }),
        project_context_receipt: {
          schema_version: 1,
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: fixture.manifest.snapshot_sha256,
          source_fingerprint: fixture.manifest.source_fingerprint,
          context_bytes: fixture.manifest.context_bytes,
          verified_at: '2026-08-28T00:00:03.000Z',
        },
      }),
    );
    mockLocalProjectContext.inspect.mockClear();
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());

    await act(async () =>
      actionByLabel(root, 'Retry response').props.onPress(),
    );
    await act(async () => settle());
    expect(mockLocalProjectContext.inspect).toHaveBeenCalledTimes(1);
    expect(root.findByProps({ children: 'Ready' })).toBeDefined();
    jest.useRealTimers();
  });

  test('lets an unmounted pending search settle once without React updates', async () => {
    jest.useFakeTimers();
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });
    await act(async () => {
      actionByLabel(root, `Open project ${contextProject.name}`).props.onPress();
      await settle();
    });
    await act(async () => {
      actionByLabel(root, 'Chat in this project').props.onPress();
      await settle();
    });
    expect(mockLocalProjectContext.listCandidates).not.toHaveBeenCalled();
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await act(async () => renderer.unmount());
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });

    expect(mockLocalProjectContext.listCandidates).toHaveBeenCalledTimes(1);
    expect(
      consoleError.mock.calls.some(call =>
        call.some(value =>
          String(value).includes('not wrapped in act'),
        ),
      ),
    ).toBe(false);
    consoleError.mockRestore();
    jest.useRealTimers();
  });

  test('coalesces rapid project Chat transitions into one deferred Context open', async () => {
    jest.useFakeTimers();
    const firstPersist = deferred<boolean>();
    mockLocalRuntime.persistSession
      .mockImplementationOnce(() => firstPersist.promise)
      .mockResolvedValue(true);
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });
    await act(async () => {
      actionByLabel(root, `Open project ${contextProject.name}`).props.onPress();
      await settle();
    });
    const chat = root.findByType(ProjectsSurface).props.onChatInProject;

    await act(async () => {
      chat(contextProject);
      chat(contextProject);
      await settle();
    });
    expect(mockLocalRuntime.persistSession).toHaveBeenCalledTimes(1);
    firstPersist.resolve(true);
    await act(async () => settle());
    expect(visibleContextSheets(root)).toHaveLength(1);

    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(mockLocalRuntime.persistSession).toHaveBeenCalledTimes(1);
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });
    jest.useRealTimers();
  });

  test('keeps the project transition lock until Projects onDismiss consumes it', async () => {
    jest.useFakeTimers();
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });
    await act(async () => {
      actionByLabel(root, `Open project ${contextProject.name}`).props.onPress();
      await settle();
    });
    const chat = root.findByType(ProjectsSurface).props.onChatInProject;

    await act(async () => {
      await chat(contextProject);
      chat(contextProject);
      expect(mockLocalRuntime.persistSession).toHaveBeenCalledTimes(1);
    });
    expect(mockLocalRuntime.persistSession).toHaveBeenCalledTimes(1);
    expect(visibleContextSheets(root)).toHaveLength(1);
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });
    jest.useRealTimers();
  });

  test('rejects an old Sheet callback after close and reopen with the same owner', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    const oldRefresh = visibleContextSheets(root)[0]!.props.onRefreshContext;
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    mockLocalProjectContext.inspect.mockClear();

    await act(async () => oldRefresh());
    await act(async () => settle());
    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();
  });

  test('keeps the current Sheet callbacks live after a duplicate Strip press', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    const sheet = visibleContextSheets(root)[0]!;
    const actionKey = sheet.props.actionKey;
    const refresh = sheet.props.onRefreshContext;

    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    expect(visibleContextSheets(root)[0]?.props.actionKey).toBe(actionKey);
    mockLocalProjectContext.inspect.mockClear();
    await act(async () => refresh());
    await act(async () => settle());
    expect(mockLocalProjectContext.inspect).toHaveBeenCalledTimes(1);
  });

  test('returns accessibility focus to the Strip only after Sheet dismissal', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const focus = jest
      .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
      .mockImplementation(() => undefined);
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip-focus-target' }).props.onLayout({
        target: 77,
        nativeEvent: { layout: { x: 0, y: 0, width: 320, height: 44 } },
      }),
    );
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    const beforeClose = focus.mock.calls.length;
    const close = visibleContextSheets(root)[0]!.props.onClose;

    act(() => {
      close();
      expect(focus).toHaveBeenCalledTimes(beforeClose);
    });
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(focus).toHaveBeenCalledTimes(beforeClose + 1);
    focus.mockRestore();
  });

  test('stops a confirmed project image send after Vision invalidates context', async () => {
    jest.useFakeTimers();
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect
      .mockResolvedValueOnce({
        schema_version: 1,
        state: 'confirmed',
        manifest: fixture.manifest,
      })
      .mockRejectedValueOnce({ code: 'E_CONTEXT_TIMEOUT' });
    mockLocalAttachments.present.mockResolvedValueOnce({
      schema_version: 1,
      status: 'selected',
      attachments: [
        {
          schema_version: 1,
          id: 'project-image-1',
          kind: 'image',
          name: 'project.png',
          mime_type: 'image/png',
          size: 128,
          thumbnail_data_url: 'data:image/png;base64,AAAA',
        },
      ],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
    await chooseAttachmentSource(root, 'Photos');

    await act(async () => actionByLabel(root, 'Send message').props.onPress());
    await act(async () => settle());

    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(mockLocalRuntime.complete).not.toHaveBeenCalled();
    expect(root.findByType(ChatComposer).props.attachments).toEqual([
      expect.objectContaining({ id: 'project-image-1' }),
    ]);
    expect(
      lastPersistedState().conversations.find(
        conversation => conversation.project_id === CONTEXT_PROJECT_ID,
      )?.model_id,
    ).toBe('deepseek-v4-flash-vision-exp');
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('recovery');
    expect(visibleContextSheets(root)[0]?.props.disabled).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(3000);
      await settle();
    });
    jest.useRealTimers();
  });
});

describe('project context Home integration H2', () => {
  test('keeps explicit fallback and Cancel available when native context is unavailable', async () => {
    mockLocalProjectContext.isAvailable.mockReturnValue(false);
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Fallback without native context');

    const refresh = actionByLabel(root, 'Refresh and send');
    const sendWithout = actionByLabel(root, 'Send without project context');
    const cancel = actionByLabel(root, 'Cancel');
    expect(refresh.props.disabled).toBe(true);
    expect(sendWithout.props.disabled).toBe(false);
    expect(cancel.props.disabled).toBe(false);

    await act(async () => refresh.props.onPress());
    expect(mockLocalProjectContext.listCandidates).not.toHaveBeenCalled();
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('freezes a raw setup draft and attachment into explicit recovery with zero HTTP', async () => {
    mockLocalAttachments.present.mockResolvedValueOnce({
      schema_version: 1,
      status: 'selected',
      attachments: [
        {
          schema_version: 1,
          id: 'pending-file-1',
          kind: 'text',
          name: 'notes.txt',
          mime_type: 'text/plain',
          size: 12,
        },
      ],
    });
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
    await chooseAttachmentSource(root, 'Files');

    await enterPendingProjectRecovery(root, '  raw setup request  ');

    const sheet = visibleContextSheets(root)[0];
    expect(sheet?.props.mode).toBe('recovery');
    for (const label of [
      'Refresh and send',
      'Send without project context',
      'Cancel',
    ]) {
      expect(actionByLabel(root, label)).toBeDefined();
    }
    expect(
      root.findAllByProps({ accessibilityLabel: 'Prepare context' }),
    ).toHaveLength(0);
    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
    ).toBe('  raw setup request  ');
    expect(root.findByType(ChatComposer).props.attachments).toEqual([
      expect.objectContaining({ id: 'pending-file-1', name: 'notes.txt' }),
    ]);
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(mockLocalRuntime.complete).not.toHaveBeenCalled();
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();
  });

  test('recovery Cancel clears only the pending intent and preserves the draft', async () => {
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Keep after cancel');
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('recovery');

    await act(async () => actionByLabel(root, 'Cancel').props.onPress());
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
    ).toBe('Keep after cancel');
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();

    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('candidates');
  });

  test('top close preserves pending recovery but any edit invalidates it permanently', async () => {
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'same text');
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();

    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('recovery');
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    await act(async () =>
      root
        .findByProps({ accessibilityLabel: 'Message DSH' })
        .props.onChangeText('changed text'),
    );
    await act(async () =>
      root
        .findByProps({ accessibilityLabel: 'Message DSH' })
        .props.onChangeText('same text'),
    );
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('candidates');
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('invalidates closed pending recovery when an EmptyChat suggestion changes the draft', async () => {
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'pending suggestion');
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    await act(async () =>
      root.findByType(EmptyChat).props.onSuggestion('Use this suggestion'),
    );
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );

    expect(visibleContextSheets(root)[0]?.props.mode).toBe('candidates');
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('invalidates a closed pending send before reusing the empty chat for another project', async () => {
    jest.useFakeTimers();
    const secondProject = {
      ...contextProject,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'second-project',
      workspace_path:
        'projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/repo',
    };
    const fixture = storedSetupProject();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject, secondProject],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Do not move this intent');
    const oldSheet = visibleContextSheets(root)[0]!;
    const staleSendWithout = oldSheet.props.onSendWithoutContext;
    const staleDismiss = oldSheet.props.onDismiss;
    await act(async () => oldSheet.props.onClose());

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });

    await act(async () => {
      await root.findByType(ProjectsSurface).props.onChatInProject(secondProject);
      await settle();
    });
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());

    expect(visibleContextSheets(root)[0]?.props.mode).toBe('candidates');
    await act(async () => staleSendWithout());
    await act(async () => staleDismiss());
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });
    jest.useRealTimers();
  });

  test('invalidates pending recovery when attachment ID order changes', async () => {
    mockLocalAttachments.present.mockResolvedValueOnce({
      schema_version: 1,
      status: 'selected',
      attachments: [
        {
          schema_version: 1,
          id: 'ordered-a',
          kind: 'text',
          name: 'a.txt',
          mime_type: 'text/plain',
          size: 1,
        },
        {
          schema_version: 1,
          id: 'ordered-b',
          kind: 'text',
          name: 'b.txt',
          mime_type: 'text/plain',
          size: 1,
        },
      ],
    });
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
    await chooseAttachmentSource(root, 'Files');
    await enterPendingProjectRecovery(root, 'Attachment ownership');
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());

    await act(async () =>
      actionByLabel(root, 'Remove a.txt').props.onPress({
        stopPropagation: jest.fn(),
      }),
    );
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('candidates');
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  });

  test('sends without context exactly once and only after Sheet dismissal', async () => {
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, '  explicit raw text  ');
    const sheet = visibleContextSheets(root)[0]!;
    const sendWithout = sheet.props.onSendWithoutContext;
    const dismiss = sheet.props.onDismiss;
    const staleSend = actionByLabel(root, 'Send message').props.onPress;

    act(() => {
      sendWithout();
      staleSend();
      expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    });
    await act(async () => settle());
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 2,
        projectContext: null,
        visibleHistory: [
          expect.objectContaining({ content: '  explicit raw text  ' }),
        ],
      }),
    );
    await act(async () => sendWithout());
    await act(async () => dismiss());
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
    const persisted = lastPersistedState().conversations.find(
      conversation => conversation.project_id === CONTEXT_PROJECT_ID,
    );
    expect(persisted?.attempts?.at(-1)).toMatchObject({
      status: 'completed',
      context_disposition: 'explicit_without_context',
      project_context: null,
    });
  });

  test('refreshes through explicit selection and confirmation, then sends schema3 after dismissal', async () => {
    jest.useFakeTimers();
    const manifest = contextManifest();
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'README.md',
          size: 16,
          revision: 'f'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    mockLocalProjectContext.prepare.mockResolvedValue(manifest);
    mockLocalProjectContext.confirm.mockResolvedValue({
      schema_version: 1,
      consent_receipt_id: CONTEXT_CONSENT_ID,
      snapshot_id: CONTEXT_SNAPSHOT_ID,
      snapshot_sha256: manifest.snapshot_sha256,
      confirmed_at: '2026-08-28T00:00:01.000Z',
    });
    mockLocalRuntime.completeV2.mockImplementationOnce(
      async (request: StrictCompletionRequest) => ({
        ...strictCompletionResult(request, { text: 'Context answer' }),
        project_context_receipt: {
          schema_version: 1,
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: manifest.snapshot_sha256,
          source_fingerprint: manifest.source_fingerprint,
          context_bytes: manifest.context_bytes,
          verified_at: '2026-08-28T00:00:02.000Z',
        },
      }),
    );
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Use confirmed context');
    await act(async () =>
      actionByLabel(root, 'Refresh and send').props.onPress(),
    );
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('candidates');
    await act(async () =>
      root
        .findByProps({ testID: 'project-context-candidate-README.md' })
        .props.onPress(),
    );
    await act(async () => {
      actionByLabel(root, 'Prepare context').props.onPress();
      await settle();
      await settle();
    });
    expect(visibleContextSheets(root)[0]?.props.confirmationRequired).toBe(true);
    const confirm = actionByLabel(root, 'Confirm context').props.onPress;
    act(() => {
      confirm();
      expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    });
    await act(async () => {
      await settle();
      await settle();
    });
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledWith(
      expect.objectContaining({
        schemaVersion: 3,
        projectContext: expect.objectContaining({
          snapshotId: CONTEXT_SNAPSHOT_ID,
          consentReceiptId: CONTEXT_CONSENT_ID,
          projectId: CONTEXT_PROJECT_ID,
        }),
      }),
    );
    await act(async () => confirm());
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
    ).toBe('');
    jest.useRealTimers();
  });

  test('waits for confirmed-context persistence retry before dismissing and sending', async () => {
    jest.useFakeTimers();
    const manifest = contextManifest();
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'README.md',
          size: 16,
          revision: 'f'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    mockLocalProjectContext.prepare.mockResolvedValue(manifest);
    mockLocalProjectContext.confirm.mockResolvedValue({
      schema_version: 1,
      consent_receipt_id: CONTEXT_CONSENT_ID,
      snapshot_id: CONTEXT_SNAPSHOT_ID,
      snapshot_sha256: manifest.snapshot_sha256,
      confirmed_at: '2026-08-28T00:00:01.000Z',
    });
    mockLocalRuntime.completeV2.mockImplementationOnce(
      async (request: StrictCompletionRequest) => ({
        ...strictCompletionResult(request, { text: 'Retried persistence answer' }),
        project_context_receipt: {
          schema_version: 1,
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: manifest.snapshot_sha256,
          source_fingerprint: manifest.source_fingerprint,
          context_bytes: manifest.context_bytes,
          verified_at: '2026-08-28T00:00:02.000Z',
        },
      }),
    );
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Persist before sending');
    await preparePendingProjectDisclosure(root);
    let candidate = '';
    mockLocalRuntime.persistSession.mockImplementationOnce(async json => {
      candidate = json;
      return false;
    });
    mockLocalRuntime.loadSession.mockImplementationOnce(async () => candidate);

    await act(async () => {
      actionByLabel(root, 'Confirm context').props.onPress();
      await settle();
      await settle();
    });
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(visibleContextSheets(root)[0]?.props.recoveryAction).toBe(
      'persistence',
    );
    expect(actionByLabel(root, 'Retry save')).toBeDefined();

    await act(async () => {
      actionByLabel(root, 'Retry save').props.onPress();
      await settle();
      await settle();
    });
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
    expect(visibleContextSheets(root)).toHaveLength(0);
    jest.useRealTimers();
  });

  test('keeps recovery disclosure and draft when native confirmation rejects', async () => {
    jest.useFakeTimers();
    const manifest = contextManifest();
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'README.md',
          size: 16,
          revision: 'f'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    mockLocalProjectContext.prepare.mockResolvedValue(manifest);
    mockLocalProjectContext.confirm.mockRejectedValueOnce({
      code: 'E_CONTEXT_TIMEOUT',
      message: 'RAW_CONFIRM_SENTINEL',
    });
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Keep after confirm failure');
    await preparePendingProjectDisclosure(root);

    await act(async () => {
      actionByLabel(root, 'Confirm context').props.onPress();
      await settle();
    });
    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
    ).toBe('Keep after confirm failure');
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(
      root.findAll(node =>
        Object.values(node.props).some(
          value =>
            typeof value === 'string' &&
            value.includes('RAW_CONFIRM_SENTINEL'),
        ),
      ),
    ).toHaveLength(0);
    jest.useRealTimers();
  });

  test('consumes a preserved pending intent before direct send after a hidden confirmation completes', async () => {
    jest.useFakeTimers();
    const manifest = contextManifest();
    const confirmation = deferred<{
      schema_version: 1;
      consent_receipt_id: string;
      snapshot_id: string;
      snapshot_sha256: string;
      confirmed_at: string;
    }>();
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'README.md',
          size: 16,
          revision: 'f'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    mockLocalProjectContext.prepare.mockResolvedValue(manifest);
    mockLocalProjectContext.confirm.mockReturnValueOnce(confirmation.promise);
    mockLocalRuntime.completeV2.mockImplementationOnce(
      async (request: StrictCompletionRequest) => ({
        ...strictCompletionResult(request),
        project_context_receipt: {
          schema_version: 1,
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: manifest.snapshot_sha256,
          source_fingerprint: manifest.source_fingerprint,
          context_bytes: manifest.context_bytes,
          verified_at: '2026-08-28T00:00:02.000Z',
        },
      }),
    );
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Confirm while hidden');
    await preparePendingProjectDisclosure(root);

    await act(async () =>
      actionByLabel(root, 'Confirm context').props.onPress(),
    );
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    confirmation.resolve({
      schema_version: 1,
      consent_receipt_id: CONTEXT_CONSENT_ID,
      snapshot_id: CONTEXT_SNAPSHOT_ID,
      snapshot_sha256: manifest.snapshot_sha256,
      confirmed_at: '2026-08-28T00:00:01.000Z',
    });
    await act(async () => {
      await settle();
      await settle();
    });
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();

    await act(async () => {
      actionByLabel(root, 'Send message').props.onPress();
      await settle();
      await settle();
    });
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('disclosure');
    await act(async () => visibleContextSheets(root)[0]!.props.onDismiss());
    expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });

  test('does not clear a newly edited draft when prepared durability resolves', async () => {
    jest.useFakeTimers();
    const manifest = contextManifest();
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'README.md',
          size: 16,
          revision: 'f'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    mockLocalProjectContext.prepare.mockResolvedValue(manifest);
    mockLocalProjectContext.confirm.mockResolvedValue({
      schema_version: 1,
      consent_receipt_id: CONTEXT_CONSENT_ID,
      snapshot_id: CONTEXT_SNAPSHOT_ID,
      snapshot_sha256: manifest.snapshot_sha256,
      confirmed_at: '2026-08-28T00:00:01.000Z',
    });
    mockLocalRuntime.completeV2.mockImplementationOnce(
      async (request: StrictCompletionRequest) => ({
        ...strictCompletionResult(request, { text: 'Raw equality answer' }),
        project_context_receipt: {
          schema_version: 1,
          snapshot_id: CONTEXT_SNAPSHOT_ID,
          snapshot_sha256: manifest.snapshot_sha256,
          source_fingerprint: manifest.source_fingerprint,
          context_bytes: manifest.context_bytes,
          verified_at: '2026-08-28T00:00:02.000Z',
        },
      }),
    );
    const completionPersist = deferred<boolean>();
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, '  raw  ');
    await preparePendingProjectDisclosure(root);
    mockLocalRuntime.persistSession.mockImplementation(async json => {
      const decoded = JSON.parse(json) as {
        conversations: Array<{ attempts?: unknown[] }>;
      };
      return decoded.conversations.some(
        conversation => (conversation.attempts?.length ?? 0) > 0,
      )
        ? completionPersist.promise
        : true;
    });

    await act(async () => {
      actionByLabel(root, 'Confirm context').props.onPress();
      await settle();
      await settle();
    });
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    await act(async () =>
      root
        .findByProps({ accessibilityLabel: 'Message DSH' })
        .props.onChangeText('raw'),
    );
    completionPersist.resolve(true);
    await act(async () => {
      await settle();
      await settle();
    });

    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
    ).toBe('raw');
    jest.useRealTimers();
  });

  test('copies pending text and attachment metadata before explicit schema2 send', async () => {
    const selectedAttachment = {
      schema_version: 1,
      id: 'immutable-file-1',
      kind: 'text',
      name: 'original.txt',
      mime_type: 'text/plain',
      size: 12,
      thumbnail_data_url: 'data:image/png;base64,RAW_PENDING_SENTINEL',
    } as const;
    mockLocalAttachments.present.mockResolvedValueOnce({
      schema_version: 1,
      status: 'selected',
      attachments: [selectedAttachment],
    });
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
    await chooseAttachmentSource(root, 'Files');
    await enterPendingProjectRecovery(root, '  immutable raw text  ');
    const liveAttachment = root.findByType(ChatComposer).props.attachments[0] as {
      name: string;
    };
    liveAttachment.name = 'MUTATED.txt';

    await act(async () =>
      actionByLabel(root, 'Send without project context').props.onPress(),
    );
    await act(async () => settle());
    const request = mockLocalRuntime.completeV2.mock.calls[0]?.[0] as {
      visibleHistory: Array<{
        content: string;
        attachments: Array<{ name: string }>;
      }>;
    };
    expect(request.visibleHistory[0]).toEqual(
      expect.objectContaining({
        content: '  immutable raw text  ',
        attachments: [expect.objectContaining({ name: 'original.txt' })],
      }),
    );
    expect(request.visibleHistory[0]?.attachments[0]).not.toHaveProperty(
      'thumbnail_data_url',
    );
    expect(JSON.stringify(request)).not.toContain('RAW_PENDING_SENTINEL');
  });

  test('locks Send without a fake Stop while native context preparation is active', async () => {
    jest.useFakeTimers();
    const manifest = contextManifest();
    const preparation = deferred<ProjectContextManifestV1>();
    mockLocalProjectContext.listCandidates.mockResolvedValue({
      schema_version: 1,
      project_id: CONTEXT_PROJECT_ID,
      candidates: [
        {
          path: 'README.md',
          size: 16,
          revision: 'f'.repeat(40),
          git_state: 'unchanged',
          eligible: true,
          omission_reason: null,
        },
      ],
      next_cursor: null,
    });
    mockLocalProjectContext.prepare.mockReturnValueOnce(preparation.promise);
    const renderer = await renderSetupProjectApp();
    const root = renderer.root;
    await enterPendingProjectRecovery(root, 'Locked while preparing');
    await act(async () =>
      actionByLabel(root, 'Refresh and send').props.onPress(),
    );
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });
    await act(async () =>
      root
        .findByProps({ testID: 'project-context-candidate-README.md' })
        .props.onPress(),
    );
    const staleSend = actionByLabel(root, 'Send message').props.onPress;
    await act(async () => actionByLabel(root, 'Prepare context').props.onPress());

    expect(actionByLabel(root, 'Send message').props.disabled).toBe(true);
    expect(
      root.findAllByProps({ accessibilityLabel: 'Stop response' }),
    ).toHaveLength(0);
    await act(async () => staleSend());
    expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('candidates');
    expect(visibleContextSheets(root)[0]?.props.busyAction).toBe('prepare');

    preparation.resolve(manifest);
    await act(async () => {
      await settle();
      await settle();
    });
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('disclosure');
    expect(visibleContextSheets(root)[0]?.props.confirmationRequired).toBe(true);
    jest.useRealTimers();
  });
});

describe('project context Home integration H3', () => {
  test.each([
    ['intent', 1],
    ['cleanup_pending', 1],
    ['ready_to_finalize', 0],
  ] as const)(
    'resumes a hydrated %s lifecycle before normal Context attachment',
    async (phase, expectedDiscardCalls) => {
      const fixture = storedLifecycleCheckpoint(phase);
      mockLocalRuntime.loadSession.mockResolvedValueOnce(
        fixture.stored.serialize(),
      );
      mockLocalProjectContext.inspect.mockResolvedValue({
        schema_version: 1,
        state: 'confirmed',
        manifest: fixture.manifest,
      });

      const renderer = await renderApp();
      await act(async () => {
        await settle();
        await settle();
      });

      expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();
      expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(
        expectedDiscardCalls,
      );
      const persisted = JSON.parse(
        mockLocalRuntime.persistSession.mock.calls.at(-1)?.[0] as string,
      ) as {
        project_context_destructive_transition: unknown;
        conversations: Array<{
          id: string;
          project_id: string | null;
          project_context: unknown;
        }>;
      };
      expect(persisted.project_context_destructive_transition).toBeNull();
      expect(
        persisted.conversations.find(
          conversation => conversation.id === fixture.conversationId,
        ),
      ).toMatchObject({ project_id: null, project_context: null });
      expect(visibleContextSheets(renderer.root)).toHaveLength(0);
    },
  );

  test('restores cleanup recovery value-free when hydrated native discard fails', async () => {
    const fixture = storedLifecycleCheckpoint('cleanup_pending');
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjectContext.discard.mockRejectedValueOnce({
      code: 'E_CONTEXT_TIMEOUT',
      message: 'RAW_RESTART_CLEANUP_SENTINEL',
    });

    const renderer = await renderApp();
    await act(async () => {
      await settle();
      await settle();
    });

    const sheet = visibleContextSheets(renderer.root)[0];
    expect(sheet?.props.mode).toBe('lifecycle');
    expect(sheet?.props.lifecycle).toMatchObject({
      kind: 'transition',
      action: 'unbind',
      controllerState: {
        phase: 'cleanup_pending',
        failureCode: 'E_CONTEXT_TIMEOUT',
      },
    });
    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();
    expect(
      renderer.root.findAll(node =>
        Object.values(node.props).some(
          value =>
            typeof value === 'string' &&
            value.includes('RAW_RESTART_CLEANUP_SENTINEL'),
        ),
      ),
    ).toHaveLength(0);
  });

  test('keeps a restored journal visible when the native context bridge is unavailable', async () => {
    const fixture = storedLifecycleCheckpoint('cleanup_pending');
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjectContext.isAvailable.mockReturnValue(false);
    mockLocalProjectContext.discard.mockRejectedValueOnce({
      code: 'E_CONTEXT_NATIVE',
      message: 'RAW_UNAVAILABLE_SENTINEL',
    });

    const renderer = await renderApp();
    await act(async () => {
      await settle();
      await settle();
    });

    const sheet = visibleContextSheets(renderer.root)[0];
    expect(sheet?.props.mode).toBe('lifecycle');
    expect(sheet?.props.unavailable).toBe(true);
    expect(sheet?.props.lifecycle).toMatchObject({
      kind: 'transition',
      action: 'unbind',
      controllerState: {
        phase: 'cleanup_pending',
        failureCode: 'E_CONTEXT_NATIVE',
      },
    });
    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();
  });

  test('closes navigation and opens the blocking Context review before creating a new chat', async () => {
    const fixture = storedProjectContext(false);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValueOnce({
      schema_version: 1,
      state: 'prepared',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    const originalConversationId = root.findByType(ChatDrawer).props.activeId;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());

    await act(async () => {
      await root.findByType(ChatDrawer).props.onNewChat();
      root.findByType(ChatDrawer).props.onDismiss();
      await settle();
    });

    expect(root.findByType(ChatDrawer).props.visible).toBe(false);
    expect(root.findByType(ChatDrawer).props.activeId).toBe(
      originalConversationId,
    );
    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('disclosure');
    expect(visibleContextSheets(root)[0]?.props.confirmationRequired).toBe(true);
    expect(mockLocalRuntime.cancelCompletion).not.toHaveBeenCalled();
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();
  });

  test('keeps an active confirmed snapshot conversation and opens lifecycle delete confirmation', async () => {
    let deletePromise: Promise<unknown> | undefined;
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) => {
        const destructive = buttons?.find(button => button.style === 'destructive');
        const result = destructive?.onPress?.();
        if (result !== undefined) deletePromise = Promise.resolve(result);
      });
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      root.findByType(ChatDrawer).props.onOpenConversationMenu(
        fixture.conversationId,
      );
      root.findByType(ChatDrawer).props.onDismiss();
    });
    expect(root.findByType(ConversationActionSheet).props.visible).toBe(true);
    await act(async () => {
      root.findByType(ConversationActionSheet).props.onDelete();
      root.findByType(ConversationActionSheet).props.onDismiss();
      await settle();
      await deletePromise;
    });

    expect(root.findByType(ChatDrawer).props.activeId).toBe(
      fixture.conversationId,
    );
    expect(root.findAllByType(ProjectContextStrip)).toHaveLength(1);
    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('lifecycle');
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'confirmation',
      action: 'delete',
    });
    expect(actionByLabel(root, 'Delete chat')).toBeDefined();
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
    expect(mockLocalRuntime.cancelCompletion).not.toHaveBeenCalled();
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    expect(visibleContextSheets(root)).toHaveLength(0);
    await act(async () => root.findByType(ChatComposer).props.onOptionsPress());
    expect(root.findByType(ConversationOptionsPicker).props.visible).toBe(true);
    await act(async () =>
      root.findByType(ConversationOptionsPicker).props.onClose(),
    );
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    expect(
      root.findAllByProps({ accessibilityLabel: 'Pending project cleanup' }),
    ).toHaveLength(0);
    alert.mockRestore();
  });

  test('drops a stale snapshot delete confirmation after the selected owner changes', async () => {
    let staleConfirm: (() => unknown) | undefined;
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) => {
        const onPress = buttons?.find(
          button => button.style === 'destructive',
        )?.onPress;
        staleConfirm =
          typeof onPress === 'function' ? () => onPress() : undefined;
      });
    const fixture = storedProjectContext(true);
    const otherId = fixture.stored.createConversation({
      title: 'Other chat',
      select: false,
    });
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      root.findByType(ChatDrawer).props.onOpenConversationMenu(
        fixture.conversationId,
      );
      root.findByType(ChatDrawer).props.onDismiss();
    });
    await act(async () => {
      root.findByType(ConversationActionSheet).props.onDelete();
      root.findByType(ConversationActionSheet).props.onDismiss();
      await settle();
    });
    expect(staleConfirm).toEqual(expect.any(Function));

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      await root.findByType(ChatDrawer).props.onSelect(otherId);
      await settle();
    });
    expect(root.findByType(ChatDrawer).props.activeId).toBe(otherId);
    mockLocalRuntime.persistSession.mockClear();
    mockLocalProjectContext.discard.mockClear();

    await act(async () => {
      await staleConfirm?.();
      await settle();
    });

    expect(root.findByType(ChatDrawer).props.activeId).toBe(otherId);
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test('dismisses Projects into exact Context review when snapshot unbind is blocked by a candidate', async () => {
    const fixture = storedProjectContext(false);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'prepared',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    mockLocalRuntime.persistSession.mockClear();

    await openProjectsSurface(root);
    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
    });
    expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());

    expect(visibleContextSheets(root)[0]?.props.mode).toBe('disclosure');
    expect(visibleContextSheets(root)[0]?.props.confirmationRequired).toBe(true);
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
    expect(mockLocalRuntime.cancelCompletion).not.toHaveBeenCalled();
  });

  test('unbinds only after the context tombstone is durable and native cleanup succeeds', async () => {
    const fixture = storedProjectContext(true);
    const cleanup = deferred<{
      schema_version: 1;
      status: 'discarded';
    }>();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    mockLocalProjectContext.discard.mockReturnValueOnce(cleanup.promise);
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    mockLocalRuntime.persistSession.mockClear();

    await openProjectsSurface(root);
    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
    });
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());
    await act(async () => {
      actionByLabel(root, 'Disable context and unbind').props.onPress();
      await settle();
    });

    const beforeCleanup = persistedStates();
    expect(beforeCleanup.at(-1)?.conversations[0]).toMatchObject({
      project_id: CONTEXT_PROJECT_ID,
      project_context: {
        status: 'setup_required',
        manifest: null,
        consent: null,
      },
    });
    expect(root.findByType(ProjectsSurface).props.boundProjectId).toBe(
      CONTEXT_PROJECT_ID,
    );
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(1);
    expect(mockLocalProjectContext.discard).toHaveBeenCalledWith(
      CONTEXT_SNAPSHOT_ID,
    );
    cleanup.resolve({ schema_version: 1, status: 'discarded' });
    await act(async () => {
      await settle();
      await settle();
    });

    expect(persistedStates().at(-1)?.conversations[0]).toMatchObject({
      project_id: null,
      project_context: null,
    });
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(1);
  });

  test('keeps the project bound until Retry save completes a pending unbind', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    mockLocalRuntime.persistSession.mockClear();
    let candidate = '';
    mockLocalRuntime.persistSession
      .mockImplementationOnce(async json => {
        candidate = json;
        return false;
      })
      .mockResolvedValue(true);
    mockLocalRuntime.loadSession.mockImplementationOnce(async () => candidate);

    await openProjectsSurface(root);
    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
    });
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());
    await act(async () => settle());
    await act(async () => {
      actionByLabel(root, 'Disable context and unbind').props.onPress();
      await settle();
    });

    expect(root.findByType(ProjectsSurface).props.boundProjectId).toBe(
      CONTEXT_PROJECT_ID,
    );
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'transition',
      action: 'unbind',
      controllerState: { pendingPersistence: 'intent' },
    });
    expect(actionByLabel(root, 'Retry save')).toBeDefined();
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();

    await act(async () => {
      actionByLabel(root, 'Retry save').props.onPress();
      await settle();
      await settle();
    });
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(1);
    expect(persistedStates().at(-1)?.conversations[0]).toMatchObject({
      project_id: null,
      project_context: null,
    });
  });

  test('keeps the project bound until Retry cleanup succeeds exactly once', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    mockLocalProjectContext.discard
      .mockRejectedValueOnce({
        code: 'E_CONTEXT_TIMEOUT',
        message: 'RAW_UNBIND_CLEANUP_SENTINEL',
      })
      .mockResolvedValue({ schema_version: 1, status: 'discarded' });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    mockLocalRuntime.persistSession.mockClear();

    await openProjectsSurface(root);
    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
    });
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());
    await act(async () => settle());
    await act(async () => {
      actionByLabel(root, 'Disable context and unbind').props.onPress();
      await settle();
      await settle();
    });

    expect(root.findByType(ProjectsSurface).props.boundProjectId).toBe(
      CONTEXT_PROJECT_ID,
    );
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'transition',
      action: 'unbind',
      controllerState: {
        phase: 'cleanup_pending',
        failureCode: 'E_CONTEXT_TIMEOUT',
      },
    });
    expect(actionByLabel(root, 'Retry cleanup')).toBeDefined();
    expect(
      root.findAll(node =>
        Object.values(node.props).some(
          value =>
            typeof value === 'string' &&
            value.includes('RAW_UNBIND_CLEANUP_SENTINEL'),
        ),
      ),
    ).toHaveLength(0);
    const staleRetry = visibleContextSheets(root)[0]!.props
      .onRetryLifecycleCleanup;
    const staleToken = visibleContextSheets(root)[0]!.props.lifecycle
      .controllerState.token;

    await act(async () => {
      actionByLabel(root, 'Retry cleanup').props.onPress();
      await settle();
      await settle();
    });
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(2);
    expect(persistedStates().at(-1)?.conversations[0]).toMatchObject({
      project_id: null,
      project_context: null,
    });
    await act(async () => staleRetry(staleToken));
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(2);
  });

  test('does not unbind a snapshot referenced by an exact retry attempt', async () => {
    const fixture = storedProjectContext(true);
    const prepared = fixture.stored.prepareTurnAttempt(
      fixture.conversationId,
      'Keep the frozen snapshot',
    );
    expect(prepared?.commit()).toBe(true);
    expect(
      fixture.stored.failAttempt(
        fixture.conversationId,
        prepared!.attemptId,
        'E_COMPLETION_NATIVE',
      ),
    ).toBe(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    mockLocalRuntime.persistSession.mockClear();

    await openProjectsSurface(root);
    await act(async () => {
      await root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
    });

    expect(root.findByType(ProjectsSurface).props.boundProjectId).toBe(
      CONTEXT_PROJECT_ID,
    );
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
    expect(actionByLabel(root, 'Retry response')).toBeDefined();
    await act(async () =>
      root.findByProps({ testID: 'project-context-strip' }).props.onPress(),
    );
    expect(visibleContextSheets(root)[0]?.props.disabled).toBe(true);
  });

  test('creates a new project chat instead of rebinding an empty snapshot owner', async () => {
    jest.useFakeTimers();
    const secondProject = {
      ...contextProject,
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      name: 'second-project',
      workspace_path:
        'projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/repo',
    };
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject, secondProject],
    });
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });

    await act(async () => {
      await root.findByType(ProjectsSurface).props.onChatInProject(secondProject);
      await settle();
    });
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());

    const persisted = lastPersistedState();
    expect(persisted.conversations).toHaveLength(2);
    expect(
      persisted.conversations.find(
        conversation => conversation.id === fixture.conversationId,
      ),
    ).toMatchObject({
      project_id: CONTEXT_PROJECT_ID,
      project_context: {
        manifest: { snapshot_id: CONTEXT_SNAPSHOT_ID },
        consent: { consent_receipt_id: CONTEXT_CONSENT_ID },
      },
    });
    const selected = persisted.conversations.find(
      conversation => conversation.id === persisted.active_conversation_id,
    );
    expect(selected?.id).not.toBe(fixture.conversationId);
    expect(selected).toMatchObject({
      project_id: secondProject.id,
      project_context: { status: 'setup_required' },
    });
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(180);
      await settle();
    });
    jest.useRealTimers();
  });

  test('deletes a nonactive snapshot chat without selecting it and prunes only after commit', async () => {
    let deletePromise: Promise<unknown> | undefined;
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) => {
        const destructive = buttons?.find(
          button => button.style === 'destructive',
        );
        const result = destructive?.onPress?.();
        if (result !== undefined) deletePromise = Promise.resolve(result);
      });
    const fixture = storedProjectContext(true);
    fixture.stored.appendUserMessage(
      fixture.conversationId,
      'Project attachment',
      {
        attachments: [
          {
            schema_version: 1,
            id: 'attachment-project-delete',
            kind: 'text',
            name: 'project.txt',
            mime_type: 'text/plain',
            size: 12,
          },
        ],
      },
    );
    const activeId = fixture.stored.createConversation({ title: 'Keep me' });
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    await act(async () => {
      root
        .findByProps({ accessibilityLabel: 'Message DSH' })
        .props.onChangeText('active draft');
    });
    mockLocalAttachments.prune.mockClear();
    mockLocalAttachments.discard.mockClear();

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    expect(root.findByType(ChatDrawer).props.visible).toBe(true);
    await act(async () => {
      root.findByType(ChatDrawer).props.onOpenConversationMenu(
        fixture.conversationId,
      );
      root.findByType(ChatDrawer).props.onDismiss();
    });
    expect(root.findByType(ConversationActionSheet).props.visible).toBe(true);
    await act(async () => {
      root.findByType(ConversationActionSheet).props.onDelete();
      root.findByType(ConversationActionSheet).props.onDismiss();
      await settle();
      await deletePromise;
    });

    expect(root.findByType(ChatDrawer).props.activeId).toBe(activeId);
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'confirmation',
      action: 'delete',
    });
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
    expect(mockLocalAttachments.prune).not.toHaveBeenCalled();
    await act(async () => {
      actionByLabel(root, 'Delete chat').props.onPress();
      await settle();
      await settle();
    });

    expect(root.findByType(ChatDrawer).props.activeId).toBe(activeId);
    expect(
      root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
    ).toBe('active draft');
    expect(
      lastPersistedState().conversations.find(
        conversation => conversation.id === fixture.conversationId,
      ),
    ).toBeUndefined();
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(1);
    expect(mockLocalAttachments.prune).toHaveBeenCalledWith([]);
    expect(mockLocalAttachments.discard).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test('directly unbinds snapshot-free context with no journal or native discard', async () => {
    const fixture = storedSetupProject();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    const renderer = await renderApp();
    const root = renderer.root;
    mockLocalRuntime.persistSession.mockClear();

    await openProjectsSurface(root);
    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
      await settle();
    });

    const persisted = JSON.parse(
      mockLocalRuntime.persistSession.mock.calls.at(-1)?.[0] as string,
    ) as {
      project_context_destructive_transition: unknown;
      conversations: Array<{ project_id: string | null }>;
    };
    expect(persisted.project_context_destructive_transition).toBeNull();
    expect(persisted.conversations[0]?.project_id).toBeNull();
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
  });

  test('rolls back snapshot-free unbind when the direct session write is not committed', async () => {
    const fixture = storedSetupProject();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    const renderer = await renderApp();
    const root = renderer.root;
    mockLocalRuntime.persistSession.mockResolvedValueOnce(false);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());

    await openProjectsSurface(root);
    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
      await settle();
    });

    expect(root.findByType(ProjectsSurface).props.boundProjectId).toBe(
      CONTEXT_PROJECT_ID,
    );
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();
  });

  test.each(
    (['unbind', 'delete', 'rebind'] as const).flatMap(action =>
      (['not_committed', 'session_only', 'unknown'] as const).map(status => [
        action,
        status,
      ] as const),
    ),
  )(
    'keeps snapshot-free %s crash-safe for %s durability and retries once',
    async (action, status) => {
      const fixture = storedSetupProject();
      const secondProject = {
        ...contextProject,
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        name: 'second-project',
        workspace_path:
          'projects/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/repo',
      };
      mockLocalRuntime.loadSession.mockResolvedValueOnce(
        fixture.stored.serialize(),
      );
      mockLocalProjects.list.mockResolvedValue({
        schema_version: 1,
        projects: [contextProject, secondProject],
      });
      let deletePromise: Promise<unknown> | undefined;
      const alert = jest
        .spyOn(Alert, 'alert')
        .mockImplementation((_title, _message, buttons) => {
          const result = buttons
            ?.find(button => button.style === 'destructive')
            ?.onPress?.();
          if (result !== undefined) deletePromise = Promise.resolve(result);
        });
      const renderer = await renderApp();
      const root = renderer.root;
      let candidate = '';
      if (status === 'unknown') {
        mockLocalRuntime.persistSession.mockRejectedValueOnce(
          new Error('DIRECT_PERSIST_SENTINEL'),
        );
        mockLocalRuntime.loadSession.mockRejectedValueOnce(
          new Error('DIRECT_LOAD_SENTINEL'),
        );
      } else {
        mockLocalRuntime.persistSession.mockImplementationOnce(async json => {
          candidate = json;
          return false;
        });
        mockLocalRuntime.loadSession.mockImplementationOnce(async () =>
          status === 'session_only' ? candidate : fixture.stored.serialize(),
        );
      }

      if (action === 'unbind') {
        await openProjectsSurface(root);
        await act(async () => {
          root.findByType(ProjectsSurface).props.onUnbindFromChat();
          await settle();
          await settle();
        });
      } else if (action === 'rebind') {
        await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
        await act(async () => {
          actionByLabel(root, 'Projects').props.onPress();
          await settle();
        });
        await act(async () => {
          await root.findByType(ProjectsSurface).props.onChatInProject(
            secondProject,
          );
          await settle();
          await settle();
        });
      } else {
        await act(async () =>
          actionByLabel(root, 'Open navigation').props.onPress(),
        );
        await act(async () => {
          root.findByType(ChatDrawer).props.onOpenConversationMenu(
            fixture.conversationId,
          );
          root.findByType(ChatDrawer).props.onDismiss();
        });
        await act(async () => {
          root.findByType(ConversationActionSheet).props.onDelete();
          root.findByType(ConversationActionSheet).props.onDismiss();
          await settle();
          await deletePromise;
          await settle();
        });
      }

      if (action !== 'delete') {
        expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
        await act(async () => root.findByType(ProjectsSurface).props.onDismiss());
      }

      expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
        kind: 'direct_persistence',
        action,
      });
      const boundBeforeRetry = root.findByType(ProjectsSurface).props
        .boundProjectId;
      if (action === 'unbind') {
        expect(boundBeforeRetry).toBe(
          status === 'not_committed' ? CONTEXT_PROJECT_ID : null,
        );
      } else if (action === 'rebind') {
        expect(boundBeforeRetry).toBe(
          status === 'not_committed' ? CONTEXT_PROJECT_ID : secondProject.id,
        );
      } else {
        expect(root.findByType(ChatDrawer).props.activeId === fixture.conversationId).toBe(
          status === 'not_committed',
        );
      }
      expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();

      mockLocalRuntime.persistSession.mockResolvedValueOnce(true);
      await act(async () => {
        actionByLabel(root, 'Retry save').props.onPress();
        await settle();
        await settle();
      });
      expect(visibleContextSheets(root)).toHaveLength(0);
      if (action === 'unbind') {
        expect(root.findByType(ProjectsSurface).props.boundProjectId).toBeNull();
      } else if (action === 'rebind') {
        expect(root.findByType(ProjectsSurface).props.boundProjectId).toBe(
          secondProject.id,
        );
      } else {
        expect(root.findByType(ChatDrawer).props.activeId).not.toBe(
          fixture.conversationId,
        );
      }
      alert.mockRestore();
    },
  );

  test('busy lifecycle top close is presentation-only and late cleanup cannot reopen it', async () => {
    const fixture = storedProjectContext(true);
    const cleanup = deferred<{ schema_version: 1; status: 'discarded' }>();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    mockLocalProjectContext.discard.mockReturnValueOnce(cleanup.promise);
    const renderer = await renderApp();
    const root = renderer.root;
    await openProjectsSurface(root);
    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
    });
    await act(async () => root.findByType(ProjectsSurface).props.onDismiss());
    await act(async () => {
      actionByLabel(root, 'Disable context and unbind').props.onPress();
      await settle();
    });
    const sheet = visibleContextSheets(root)[0]!;
    await act(async () => sheet.props.onClose());
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(1);

    cleanup.resolve({ schema_version: 1, status: 'discarded' });
    await act(async () => {
      await settle();
      await settle();
    });
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(mockLocalProjectContext.discard).toHaveBeenCalledTimes(1);
    expect(lastPersistedState().conversations[0]?.project_id).toBeNull();
  });

  test('reopens nonactive direct persistence from one value-free Drawer row and rejects its stale callback', async () => {
    let deletePromise: Promise<unknown> | undefined;
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) => {
        const result = buttons
          ?.find(button => button.style === 'destructive')
          ?.onPress?.();
        if (result !== undefined) deletePromise = Promise.resolve(result);
      });
    const fixture = storedSetupProject();
    const activeId = fixture.stored.createConversation({ title: 'Active' });
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    const renderer = await renderApp();
    const root = renderer.root;
    mockLocalRuntime.persistSession.mockRejectedValueOnce(
      new Error('DIRECT_UNKNOWN_SENTINEL'),
    );
    mockLocalRuntime.loadSession.mockRejectedValueOnce(
      new Error('DIRECT_LOAD_SENTINEL'),
    );

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      root.findByType(ChatDrawer).props.onOpenConversationMenu(
        fixture.conversationId,
      );
      root.findByType(ChatDrawer).props.onDismiss();
    });
    await act(async () => {
      root.findByType(ConversationActionSheet).props.onDelete();
      root.findByType(ConversationActionSheet).props.onDismiss();
      await settle();
      await deletePromise;
      await settle();
    });
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());
    expect(visibleContextSheets(root)).toHaveLength(0);

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    const pending = actionByLabel(root, 'Pending project cleanup');
    const stalePending = pending.props.onPress;
    expect(pending.props.accessibilityLabel).toBe('Pending project cleanup');
    await act(async () => pending.props.onPress());
    expect(root.findByType(ChatDrawer).props.visible).toBe(false);
    await act(async () => root.findByType(ChatDrawer).props.onDismiss());
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'direct_persistence',
      action: 'delete',
    });
    expect(root.findByType(ChatDrawer).props.activeId).toBe(activeId);
    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();
    expect(mockLocalProjectContext.discard).not.toHaveBeenCalled();

    mockLocalRuntime.persistSession.mockResolvedValueOnce(true);
    await act(async () => {
      actionByLabel(root, 'Retry save').props.onPress();
      await settle();
      await settle();
    });
    expect(visibleContextSheets(root)).toHaveLength(0);
    await act(async () => stalePending());
    expect(visibleContextSheets(root)).toHaveLength(0);
    expect(root.findByType(ChatDrawer).props.activeId).toBe(activeId);
    alert.mockRestore();
  });

  test('reopens nonactive lifecycle cleanup from Drawer without selecting its target', async () => {
    let deletePromise: Promise<unknown> | undefined;
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) => {
        const result = buttons
          ?.find(button => button.style === 'destructive')
          ?.onPress?.();
        if (result !== undefined) deletePromise = Promise.resolve(result);
      });
    const fixture = storedProjectContext(true);
    const activeId = fixture.stored.createConversation({ title: 'Active' });
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjectContext.discard
      .mockRejectedValueOnce({ code: 'E_CONTEXT_TIMEOUT' })
      .mockResolvedValue({ schema_version: 1, status: 'discarded' });
    const renderer = await renderApp();
    const root = renderer.root;

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      root.findByType(ChatDrawer).props.onOpenConversationMenu(
        fixture.conversationId,
      );
      root.findByType(ChatDrawer).props.onDismiss();
    });
    await act(async () => {
      root.findByType(ConversationActionSheet).props.onDelete();
      root.findByType(ConversationActionSheet).props.onDismiss();
      await settle();
      await deletePromise;
    });
    await act(async () => {
      actionByLabel(root, 'Delete chat').props.onPress();
      await settle();
      await settle();
    });
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'transition',
      action: 'delete',
      controllerState: { phase: 'cleanup_pending' },
    });
    await act(async () => visibleContextSheets(root)[0]!.props.onClose());

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    const pending = actionByLabel(root, 'Pending project cleanup');
    await act(async () => pending.props.onPress());
    await act(async () => root.findByType(ChatDrawer).props.onDismiss());
    expect(root.findByType(ChatDrawer).props.activeId).toBe(activeId);
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'transition',
      action: 'delete',
      controllerState: { phase: 'cleanup_pending' },
    });
    expect(mockLocalProjectContext.inspect).not.toHaveBeenCalled();

    await act(async () => {
      actionByLabel(root, 'Retry cleanup').props.onPress();
      await settle();
      await settle();
    });
    expect(root.findByType(ChatDrawer).props.activeId).toBe(activeId);
    expect(
      lastPersistedState().conversations.find(
        conversation => conversation.id === fixture.conversationId,
      ),
    ).toBeUndefined();
    alert.mockRestore();
  });

  test('rejects stale Drawer and composer surface openers while lifecycle confirmation owns the screen', async () => {
    let deletePromise: Promise<unknown> | undefined;
    let staleDelete = () => undefined;
    const alert = jest
      .spyOn(Alert, 'alert')
      .mockImplementation((_title, _message, buttons) => {
        const result = buttons
          ?.find(button => button.style === 'destructive')
          ?.onPress?.();
        if (result !== undefined) deletePromise = Promise.resolve(result);
    });
    const fixture = storedProjectContext(true);
    const staleSelectTarget = fixture.stored.createConversation({
      title: 'Stale target',
      select: false,
    });
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalRuntime.bootstrap.mockResolvedValue({
      proof: {
        ...proof,
        checks: { ...proof.checks, rish_applet_executed: false },
      },
      rish: {},
    });
    const renderer = await renderApp();
    const root = renderer.root;
    const staleMainRuntime = actionByLabel(
      root,
      'Show runtime evidence',
    ).props.onPress;
    const composer = root.findByType(ChatComposer);
    const staleWorkspace = composer.props.onWorkspacePress;
    const staleOptions = composer.props.onOptionsPress;
    const staleContext = root.findByProps({
      testID: 'project-context-strip',
    }).props.onPress;
    const staleDrawerOpen = actionByLabel(root, 'Open navigation').props.onPress;
    await act(async () => staleDrawerOpen());
    const firstDrawer = root.findByType(ChatDrawer);
    const staleAccount = firstDrawer.props.onOpenAccount;
    const staleNew = firstDrawer.props.onNewChat;
    const staleSelect = () => firstDrawer.props.onSelect(staleSelectTarget);
    await act(async () => {
      firstDrawer.props.onOpenSettings();
      firstDrawer.props.onDismiss();
    });
    const staleModel = root.findByType(SettingsSheet).props.onOpenModelPicker;
    const staleEvidenceFromSettings = root.findByType(SettingsSheet).props
      .onOpenRuntime;
    const staleMirrors = root.findByType(SettingsSheet).props.onOpenMirrors;
    const staleProjectFiles = root.findByType(ProjectsSurface).props.onOpenFiles;
    const staleProjectChat = root.findByType(ProjectsSurface).props.onChatInProject;
    const staleProjectUnbind = root.findByType(ProjectsSurface).props
      .onUnbindFromChat;
    await act(async () => root.findByType(SettingsSheet).props.onClose());
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    const drawer = root.findByType(ChatDrawer);
    const staleProjects = drawer.props.onOpenProjects;
    const staleSettings = drawer.props.onOpenSettings;
    const staleHarnesses = drawer.props.onOpenHarnesses;
    const staleEvidence = drawer.props.onOpenRuntime;
    await act(async () => {
      drawer.props.onOpenConversationMenu(fixture.conversationId);
      drawer.props.onDismiss();
    });
    await act(async () => {
      staleDelete = root.findByType(ConversationActionSheet).props.onDelete;
      staleDelete();
      root.findByType(ConversationActionSheet).props.onDismiss();
      await settle();
      await deletePromise;
    });
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('lifecycle');
    mockLocalRuntime.persistSession.mockClear();
    const activeBefore = root.findByType(ChatDrawer).props.activeId;

    await act(async () => {
      staleNew();
      staleSelect();
      staleProjectChat(contextProject);
      staleDelete();
      staleProjects();
      staleSettings();
      staleWorkspace();
      staleOptions();
      staleModel();
      staleEvidenceFromSettings();
      staleMirrors();
      staleAccount();
      staleProjectFiles(contextProject);
      staleProjectUnbind();
      staleHarnesses();
      staleEvidence();
      staleMainRuntime();
      staleContext();
      staleDrawerOpen();
      root.findByType(ChatDrawer).props.onDismiss();
      await settle();
    });
    expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
    expect(root.findByType(SettingsSheet).props.visible).toBe(false);
    expect(root.findByType(ConversationOptionsPicker).props.visible).toBe(
      false,
    );
    expect(root.findByType(WorkspacePickerSheet).props.visible).toBe(false);
    expect(root.findByType(ModelPicker).props.visible).toBe(false);
    expect(root.findByType(HarnessPicker).props.visible).toBe(false);
    expect(root.findByType(RuntimeEvidenceSheet).props.visible).toBe(false);
    expect(root.findByType(AccountSheet).props.visible).toBe(false);
    expect(root.findByType(MirrorSettingsSheet).props.visible).toBe(false);
    expect(root.findByType(WorkspaceDrawer).props.visible).toBe(false);
    expect(root.findByType(ChatDrawer).props.visible).toBe(false);
    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'confirmation',
      action: 'delete',
    });
    expect(root.findByType(ChatDrawer).props.activeId).toBe(activeBefore);
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();
    alert.mockRestore();
  });

  test('rejects a stale Drawer Settings opener after Context disclosure takes authority', async () => {
    const fixture = storedProjectContext(true);
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    mockLocalProjectContext.inspect.mockResolvedValue({
      schema_version: 1,
      state: 'confirmed',
      manifest: fixture.manifest,
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    const staleOptions = root.findByType(ChatComposer).props.onOptionsPress;

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    const staleSettings = root.findByType(ChatDrawer).props.onOpenSettings;
    await act(async () => root.findByType(ChatDrawer).props.onClose());
    await act(async () => {
      root.findByProps({ testID: 'project-context-strip' }).props.onPress();
      await settle();
    });
    expect(visibleContextSheets(root)).toHaveLength(1);

    await act(async () => {
      staleSettings();
      staleOptions();
    });

    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(root.findByType(SettingsSheet).props.visible).toBe(false);
    expect(root.findByType(ConversationOptionsPicker).props.visible).toBe(
      false,
    );
  });

  test.each(['Drawer', 'Settings'] as const)(
    'blocks a stale composer Workspace opener behind %s',
    async surface => {
      const renderer = await renderApp();
      const root = renderer.root;
      await act(async () => settle());
      const staleWorkspace = root.findByType(ChatComposer).props
        .onWorkspacePress;

      await act(async () =>
        actionByLabel(root, 'Open navigation').props.onPress(),
      );
      if (surface === 'Settings') {
        await act(async () =>
          root.findByType(ChatDrawer).props.onOpenSettings(),
        );
        expect(root.findByType(SettingsSheet).props.visible).toBe(true);
      }

      await act(async () => staleWorkspace());

      expect(root.findByType(WorkspacePickerSheet).props.visible).toBe(false);
    },
  );

  test('rejects old Settings child openers after close and reopen', async () => {
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => settle());
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => root.findByType(ChatDrawer).props.onOpenSettings());
    const settings = root.findByType(SettingsSheet);
    const staleModel = settings.props.onOpenModelPicker;
    const staleMirrors = settings.props.onOpenMirrors;
    const staleRuntime = settings.props.onOpenRuntime;

    await act(async () => settings.props.onClose());
    expect(root.findByType(ChatDrawer).props.visible).toBe(true);
    await act(async () => root.findByType(ChatDrawer).props.onOpenSettings());
    expect(root.findByType(SettingsSheet).props.visible).toBe(true);

    await act(async () => {
      staleModel();
      staleMirrors();
      staleRuntime();
    });

    expect(root.findByType(ModelPicker).props.visible).toBe(false);
    expect(root.findByType(MirrorSettingsSheet).props.visible).toBe(false);
    expect(root.findByType(RuntimeEvidenceSheet).props.visible).toBe(false);
  });

  test('blocks every root surface and navigation mutation until lifecycle bootstrap settles', async () => {
    const restored = storedLifecycleCheckpoint('cleanup_pending');
    const load = deferred<string | null>();
    mockLocalRuntime.loadSession.mockReturnValueOnce(load.promise);
    mockLocalProjectContext.discard.mockRejectedValueOnce({
      code: 'E_CONTEXT_TIMEOUT',
      message: 'BOOTSTRAP_SURFACE_SENTINEL',
    });
    const renderer = await renderApp();
    const root = renderer.root;
    const initialActive = root.findByType(ChatDrawer).props.activeId;
    const composer = root.findByType(ChatComposer);
    const drawer = root.findByType(ChatDrawer);
    const settings = root.findByType(SettingsSheet);

    await act(async () => {
      actionByLabel(root, 'Open navigation').props.onPress();
      actionByLabel(root, 'Show runtime evidence').props.onPress();
      composer.props.onConfigure();
      composer.props.onOptionsPress();
      composer.props.onWorkspacePress();
      drawer.props.onOpenAccount();
      drawer.props.onOpenSettings();
      await drawer.props.onNewChat();
      await drawer.props.onSelect('stale-bootstrap-conversation');
      settings.props.onOpenModelPicker();
      settings.props.onOpenMirrors();
      settings.props.onOpenRuntime();
      await settle();
    });

    expect(root.findByType(ChatDrawer).props.visible).toBe(false);
    expect(root.findByType(SettingsSheet).props.visible).toBe(false);
    expect(root.findByType(AccountSheet).props.visible).toBe(false);
    expect(root.findByType(ModelPicker).props.visible).toBe(false);
    expect(root.findByType(MirrorSettingsSheet).props.visible).toBe(false);
    expect(root.findByType(RuntimeEvidenceSheet).props.visible).toBe(false);
    expect(root.findByType(ConversationOptionsPicker).props.visible).toBe(false);
    expect(root.findByType(WorkspacePickerSheet).props.visible).toBe(false);
    expect(root.findByType(ChatDrawer).props.activeId).toBe(initialActive);
    expect(mockLocalRuntime.persistSession).not.toHaveBeenCalled();

    load.resolve(restored.stored.serialize());
    await act(async () => {
      await settle();
      await settle();
    });

    expect(visibleContextSheets(root)).toHaveLength(1);
    expect(visibleContextSheets(root)[0]?.props.lifecycle).toMatchObject({
      kind: 'transition',
      controllerState: { phase: 'cleanup_pending' },
    });
    expect(root.findByType(ChatDrawer).props.visible).toBe(false);
    expect(root.findByType(SettingsSheet).props.visible).toBe(false);
    expect(root.findByType(RuntimeEvidenceSheet).props.visible).toBe(false);
  });

  test('closes Projects during an in-flight project transition and ignores its late persistence', async () => {
    const persisted = deferred<boolean>();
    mockLocalRuntime.persistSession.mockImplementationOnce(
      () => persisted.promise,
    );
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [contextProject],
    });
    const renderer = await renderApp();
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => {
      actionByLabel(root, 'Projects').props.onPress();
      await settle();
    });
    const chat = root.findByType(ProjectsSurface).props.onChatInProject;
    await act(async () => {
      chat(contextProject);
      await settle();
    });
    expect(mockLocalRuntime.persistSession).toHaveBeenCalledTimes(1);

    await act(async () => root.findByType(ProjectsSurface).props.onClose());
    expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
    persisted.resolve(true);
    await act(async () => {
      await settle();
      await settle();
      root.findByType(ProjectsSurface).props.onDismiss();
    });
    expect(visibleContextSheets(root)).toHaveLength(0);
  });

  test('does not auto-open direct recovery after Projects closes during an ambiguous write', async () => {
    const fixture = storedSetupProject();
    mockLocalRuntime.loadSession.mockResolvedValueOnce(fixture.stored.serialize());
    const persisted = deferred<boolean>();
    mockLocalRuntime.persistSession.mockImplementationOnce(
      () => persisted.promise,
    );
    const renderer = await renderApp();
    const root = renderer.root;
    await openProjectsSurface(root);

    await act(async () => {
      root.findByType(ProjectsSurface).props.onUnbindFromChat();
      await settle();
    });
    await act(async () => root.findByType(ProjectsSurface).props.onClose());
    expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    expect(root.findByType(ChatDrawer).props.visible).toBe(false);
    mockLocalRuntime.loadSession.mockRejectedValueOnce(
      new Error('AMBIGUOUS_LOAD_SENTINEL'),
    );
    persisted.resolve(false);
    await act(async () => {
      await settle();
      await settle();
      root.findByType(ProjectsSurface).props.onDismiss();
    });
    expect(visibleContextSheets(root)).toHaveLength(0);

    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    expect(actionByLabel(root, 'Pending project cleanup')).toBeDefined();
  });

  test('drops a queued Drawer opener when bootstrap restores lifecycle recovery first', async () => {
    const loaded = deferred<string | null>();
    const fixture = storedLifecycleCheckpoint('cleanup_pending');
    mockLocalRuntime.loadSession.mockReturnValueOnce(loaded.promise);
    mockLocalProjectContext.discard.mockRejectedValueOnce({
      code: 'E_CONTEXT_TIMEOUT',
    });
    let renderer: Renderer | undefined;
    await act(async () => {
      renderer = ReactTestRenderer.create(<App />);
      await settle();
    });
    if (renderer === undefined) throw new Error('renderer missing');
    const root = renderer.root;
    await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
    await act(async () => root.findByType(ChatDrawer).props.onOpenProjects());
    expect(root.findByType(ChatDrawer).props.visible).toBe(false);

    loaded.resolve(fixture.stored.serialize());
    await act(async () => {
      await settle();
      await settle();
    });
    expect(visibleContextSheets(root)[0]?.props.mode).toBe('lifecycle');
    await act(async () => root.findByType(ChatDrawer).props.onDismiss());
    expect(root.findByType(ProjectsSurface).props.visible).toBe(false);
    expect(visibleContextSheets(root)).toHaveLength(1);
  });
});

test('starts a project-bound chat with one actionable context Strip', async () => {
  jest.useFakeTimers();
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [
      {
        schema_version: 1,
        id: 'project-1',
        name: 'demo',
        workspace_path: 'projects/project-1/repo',
        created_at: '2026-08-24T00:00:00.000Z',
        updated_at: '2026-08-24T00:00:00.000Z',
        origin_url: null,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Projects').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Open project demo').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Chat in this project').props.onPress();
    await settle();
  });
  await act(async () => {
    jest.advanceTimersByTime(180);
    await settle();
  });

  expect(lastPersistedState().conversations.at(-1)?.project_id).toBe(
    'project-1',
  );
  expect(root.findAllByType(ProjectContextStrip)).toHaveLength(1);
  expect(
    root.findAllByProps({ accessibilityLabel: 'Project demo' }),
  ).toHaveLength(0);
  jest.useRealTimers();
});

test('does not auto-route a setup-required project through AgentLoop', async () => {
  jest.useFakeTimers();
  mockLocalRuntime.isCompletionV2Available.mockReturnValue(true);
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [
      {
        schema_version: 1,
        id: 'project-1',
        name: 'demo',
        workspace_path: 'projects/project-1/repo',
        created_at: '2026-08-24T00:00:00.000Z',
        updated_at: '2026-08-24T00:00:00.000Z',
        origin_url: null,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Projects').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Open project demo').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Chat in this project').props.onPress();
    await settle();
  });
  await act(async () => {
    jest.advanceTimersByTime(180);
    await settle();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Wait for context');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(mockRunAgentTurn).not.toHaveBeenCalled();
  expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  expect(mockLocalRuntime.complete).not.toHaveBeenCalled();
  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
  ).toBe('Wait for context');
  expect(visibleContextSheets(root)[0]?.props.disabled).toBe(false);
  expect(
    root.findAllByProps({ accessibilityLabel: 'Retry response' }),
  ).toHaveLength(0);
  jest.useRealTimers();
});

test('sends verified project context through schema3 without AgentLoop', async () => {
  const runtimeContextId = '11111111-1111-4111-8111-111111111111';
  const snapshotId = '22222222-2222-4222-8222-222222222222';
  const consentReceiptId = '33333333-3333-4333-8333-333333333333';
  const projectId = '44444444-4444-4444-8444-444444444444';
  const preparationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const lifecycleIds = [
    runtimeContextId,
    '55555555-5555-4555-8555-555555555555',
    '66666666-6666-4666-8666-666666666666',
  ];
  let messageId = 0;
  const stored = createChatStore({
    now: () => '2026-08-28T00:00:00.000Z',
    createId: kind => `${kind}-${++messageId}`,
    createLifecycleId: () => lifecycleIds.shift()!,
  });
  const conversationId = stored.createConversation({ projectId });
  expect(stored.ensureRuntimeContextId(conversationId)).toBe(runtimeContextId);
  const manifest = {
    schema_version: 1 as const,
    snapshot_id: snapshotId,
    project_id: projectId,
    project_name: 'verified-demo',
    branch: 'main',
    head_oid: '0'.repeat(40),
    clean: true,
    conflicted: false,
    captured_at: '2026-08-28T00:00:00.000Z',
    policy_version: 'chat-read-v1.0.0' as const,
    provider_host: 'api.deepseek.com' as const,
    model: 'deepseek-v4-flash' as const,
    included: [
      {
        path: 'README.md',
        source: 'tracked_file' as const,
        bytes: 16,
        sha256: 'f'.repeat(64),
      },
    ],
    omitted: [],
    context_bytes: 16,
    estimated_tokens: 4,
    snapshot_sha256: 'd'.repeat(64),
    source_fingerprint: 'e'.repeat(64),
  };
  const consent = {
    schema_version: 1 as const,
    consent_receipt_id: consentReceiptId,
    snapshot_id: snapshotId,
    snapshot_sha256: 'd'.repeat(64),
    confirmed_at: '2026-08-28T00:00:01.000Z',
  };
  const preparedConversation = stored.getState().conversations[conversationId]!;
  const prepared = stored.replaceProjectContextPrepared(
    {
      conversationId,
      projectId,
      runtimeContextId,
      modelId: preparedConversation.modelId,
      expectedContext: preparedConversation.projectContext!,
    },
    {
      preparationId,
      selectedPaths: ['README.md'],
      manifest,
    },
  );
  expect(prepared).not.toBeNull();
  expect(prepared!.commit()).toBe(true);

  const confirmedConversation = stored.getState().conversations[conversationId]!;
  const confirmed = stored.replaceProjectContextConfirmed(
    {
      conversationId,
      projectId,
      runtimeContextId,
      modelId: confirmedConversation.modelId,
      expectedContext: confirmedConversation.projectContext!,
    },
    {
      preparationId,
      selectedPaths: ['README.md'],
      manifest,
      consent,
    },
  );
  expect(confirmed).not.toBeNull();
  expect(confirmed!.commit()).toBe(true);
  mockLocalRuntime.loadSession.mockResolvedValueOnce(stored.serialize());
  mockLocalProjectContext.inspect.mockResolvedValueOnce({
    schema_version: 1,
    state: 'confirmed',
    manifest,
  });
  mockLocalRuntime.completeV2.mockImplementationOnce(
    async (request: StrictCompletionRequest) => ({
      ...strictCompletionResult(request, { text: 'Verified context answer' }),
      project_context_receipt: {
        schema_version: 1,
        snapshot_id: snapshotId,
        snapshot_sha256: 'd'.repeat(64),
        source_fingerprint: 'e'.repeat(64),
        context_bytes: 16,
        verified_at: '2026-08-28T00:00:02.000Z',
      },
    }),
  );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Read verified project');
  });
  await act(async () => {
    await actionByLabel(root, 'Send message').props.onPress();
  });

  expect(mockLocalRuntime.completeV2).toHaveBeenCalledWith(
    expect.objectContaining({
      schemaVersion: 3,
      projectContext: {
        schemaVersion: 1,
        snapshotId,
        consentReceiptId,
        conversationId: runtimeContextId,
        projectId,
        provider: 'deepseek',
        policy: 'chat-read-v1',
      },
    }),
  );
  expect(mockRunAgentTurn).not.toHaveBeenCalled();
  expect(lastPersistedState().messages.at(-1)?.text).toBe(
    'Verified context answer',
  );
});

test('sends the complete conversation history and persists both messages', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('First turn');
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Send message' }).props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.complete).not.toHaveBeenCalled();
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledWith(
    expect.objectContaining({
      schemaVersion: 2,
      model: 'deepseek-v4-flash',
      thinkingMode: 'high',
      visibleHistory: [
        { role: 'user', content: 'First turn', attachments: [] },
      ],
      roundTranscript: [],
      tools: [],
      projectContext: null,
    }),
  );
  const persisted = lastPersistedState();
  expect(persisted.messages.map(message => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(persisted.messages[1]?.text).toBe('STRICT_LOCAL_OK');
});

test('preserves the draft and sends zero HTTP when prepared durability is absent', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'undurable-file',
        kind: 'text',
        name: 'undurable.txt',
        mime_type: 'text/plain',
        size: 32,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  mockLocalRuntime.persistSession.mockResolvedValueOnce(false);
  mockLocalRuntime.loadSession.mockResolvedValueOnce(null);

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Keep this draft');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
  ).toBe('Keep this draft');
  expect(actionByLabel(root, 'Remove undurable.txt')).toBeDefined();
  expect(mockLocalAttachments.discard).not.toHaveBeenCalledWith([
    'undurable-file',
  ]);
  expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  expect(mockLocalRuntime.complete).not.toHaveBeenCalled();
  expect(mockLocalRuntime.loadSession).toHaveBeenCalledTimes(2);
});

test('keeps draft ownership until prepared persistence resolves true', async () => {
  let resolvePersist!: (saved: boolean) => void;
  const renderer = await renderApp();
  const root = renderer.root;
  mockLocalRuntime.persistSession.mockReturnValueOnce(
    new Promise<boolean>(resolve => {
      resolvePersist = resolve;
    }),
  );
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Durable first');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await Promise.resolve();
  });
  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
  ).toBe('Durable first');
  expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();

  await act(async () => {
    resolvePersist(true);
    await settle();
  });
  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
  ).toBe('');
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
});

test('clears a durable draft after cancellation during its first persistence', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'cancel-draft-image',
        kind: 'image',
        name: 'cancel-draft.png',
        mime_type: 'image/png',
        size: 128,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Cancel during save');
  });
  let resolvePersist!: (saved: boolean) => void;
  mockLocalRuntime.persistSession.mockReturnValueOnce(
    new Promise<boolean>(resolve => {
      resolvePersist = resolve;
    }),
  );
  let sendPromise: Promise<unknown> | undefined;
  await act(async () => {
    const result = actionByLabel(root, 'Send message').props.onPress() as unknown;
    if (result instanceof Promise) sendPromise = result;
    await Promise.resolve();
  });
  expect(actionByLabel(root, 'Stop response')).toBeDefined();
  await act(async () => {
    await actionByLabel(root, 'Stop response').props.onPress();
  });
  await act(async () => {
    resolvePersist(true);
    await sendPromise;
  });

  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.value,
  ).toBe('');
  expect(
    root.findAllByProps({ accessibilityLabel: 'Remove cancel-draft.png' }),
  ).toHaveLength(0);
  expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
  expect(
    lastPersistedState().conversations[0]?.attempts?.at(-1)?.status,
  ).toBe('cancelled');
});

test('shows cancellation persistence failure instead of a false stopped notice', async () => {
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Cancel must persist');
  });
  let resolvePersist!: (saved: boolean) => void;
  mockLocalRuntime.persistSession
    .mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        resolvePersist = resolve;
      }),
    )
    .mockResolvedValueOnce(false);
  let sendPromise: Promise<unknown> | undefined;
  await act(async () => {
    const result = actionByLabel(root, 'Send message').props.onPress() as unknown;
    if (result instanceof Promise) sendPromise = result;
    await Promise.resolve();
  });
  await act(async () => {
    await actionByLabel(root, 'Stop response').props.onPress();
  });
  await act(async () => {
    resolvePersist(true);
    await sendPromise;
  });

  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('E_ATTEMPT_PERSISTENCE');
  expect(rendered).not.toContain('Response stopped.');
  expect(actionByLabel(root, 'Retry response')).toBeDefined();
});

test('adds an image attachment, switches to Flash Exp, and sends without text', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'image-1',
        kind: 'image',
        name: 'camera.jpg',
        mime_type: 'image/jpeg',
        size: 2048,
        thumbnail_data_url: 'data:image/jpeg;base64,dGh1bWI=',
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  expect(actionByLabel(root, 'Camera')).toBeDefined();
  expect(actionByLabel(root, 'Photos')).toBeDefined();
  expect(actionByLabel(root, 'Files')).toBeDefined();
  const attachmentModal = root.findByProps({
    testID: 'attachment-menu-modal',
  });
  await act(async () => actionByLabel(root, 'Photos').props.onPress());
  expect(mockLocalAttachments.present).not.toHaveBeenCalled();
  await act(async () => {
    attachmentModal.props.onDismiss();
    await settle();
  });

  expect(mockLocalAttachments.present).toHaveBeenCalledWith('photos');
  expect(actionByLabel(root, 'Remove camera.jpg')).toBeDefined();
  expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();
  expect(
    root.findByProps({ accessibilityLabel: 'Send message' }).props.disabled,
  ).toBe(false);

  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.completeV2).toHaveBeenCalledWith(
    expect.objectContaining({
      schemaVersion: 2,
      model: 'deepseek-v4-flash-vision-exp',
      thinkingMode: 'high',
      visibleHistory: [
        {
          role: 'user',
          content: '',
          attachments: [
            {
              schema_version: 1,
              id: 'image-1',
              kind: 'image',
              name: 'camera.jpg',
              mime_type: 'image/jpeg',
              size: 2048,
            },
          ],
        },
      ],
    }),
  );
  const persisted = lastPersistedState();
  expect(persisted.conversations[0]?.model_id).toBe(
    'deepseek-v4-flash-vision-exp',
  );
  expect(persisted.messages[0]?.attachments[0]).toMatchObject({
    id: 'image-1',
    kind: 'image',
  });
  expect(
    persisted.messages[0]?.attachments[0]?.thumbnail_data_url,
  ).toBeUndefined();
  expect(mockLocalAttachments.discard).not.toHaveBeenCalled();
  expect(mockLocalRuntime.recordModelTransition).toHaveBeenCalledTimes(1);
  expect(mockLocalRuntime.recordModelTransition).toHaveBeenCalledWith({
    attachment_busy: false,
    conversation_id: expect.any(String),
    draft_image_count: 1,
    from_model: 'deepseek-v4-flash',
    history_image_count: 0,
    request_epoch: 0,
    request_state: 'idle',
    source: 'send_image_guard',
    to_model: 'deepseek-v4-flash-vision-exp',
  });
});

test('ignores a stale attachment-menu dismissal after completion ownership changes', async () => {
  let activeRequest: StrictCompletionRequest | undefined;
  let resolveCompletion:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        activeRequest = request;
        resolveCompletion = resolve;
      }),
  );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  const menu = root.findByProps({ testID: 'attachment-menu-modal' });
  await act(async () => actionByLabel(root, 'Files').props.onPress());
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Own the composer first');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  await act(async () => {
    menu.props.onDismiss();
    await settle();
  });
  expect(mockLocalAttachments.present).not.toHaveBeenCalled();

  await act(async () => {
    await actionByLabel(root, 'Stop response').props.onPress();
    if (activeRequest !== undefined) {
      resolveCompletion?.(strictCompletionResult(activeRequest));
    }
    await settle();
  });
});

test('never discards a referenced attachment through a stale Remove callback', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'owned-file',
        kind: 'text',
        name: 'owned.txt',
        mime_type: 'text/plain',
        size: 64,
      },
    ],
  });
  let activeRequest: StrictCompletionRequest | undefined;
  let resolveCompletion:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        activeRequest = request;
        resolveCompletion = resolve;
      }),
  );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  const staleRemove = actionByLabel(root, 'Remove owned.txt').props.onPress;
  mockLocalAttachments.discard.mockClear();
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Persist this file');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  await act(async () => {
    staleRemove({ stopPropagation: jest.fn() });
  });
  expect(mockLocalAttachments.discard).not.toHaveBeenCalledWith(['owned-file']);
  expect(lastPersistedState().messages[0]?.attachments[0]?.id).toBe(
    'owned-file',
  );

  await act(async () => {
    await actionByLabel(root, 'Stop response').props.onPress();
    if (activeRequest !== undefined) {
      resolveCompletion?.(strictCompletionResult(activeRequest));
    }
    await settle();
  });
});

test('keeps the existing draft stable while another picker is in flight', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'existing-draft',
        kind: 'text',
        name: 'existing.txt',
        mime_type: 'text/plain',
        size: 10,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  const staleRemove = actionByLabel(root, 'Remove existing.txt').props.onPress;
  let resolvePicker:
    | ((value: {
        schema_version: number;
        status: string;
        attachments: Array<{
          schema_version: number;
          id: string;
          kind: string;
          name: string;
          mime_type: string;
          size: number;
        }>;
      }) => void)
    | undefined;
  mockLocalAttachments.present.mockReturnValueOnce(
    new Promise(resolve => {
      resolvePicker = resolve;
    }),
  );
  mockLocalAttachments.discard.mockClear();
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  expect(
    actionByLabel(root, 'Remove existing.txt').props.disabled,
  ).toBe(true);

  await act(async () => {
    staleRemove({ stopPropagation: jest.fn() });
  });
  expect(mockLocalAttachments.discard).not.toHaveBeenCalledWith([
    'existing-draft',
  ]);
  await act(async () => {
    resolvePicker?.({
      schema_version: 1,
      status: 'selected',
      attachments: [
        {
          schema_version: 1,
          id: 'new-draft',
          kind: 'text',
          name: 'new.txt',
          mime_type: 'text/plain',
          size: 20,
        },
      ],
    });
    await settle();
  });
  expect(actionByLabel(root, 'Remove existing.txt')).toBeDefined();
  expect(actionByLabel(root, 'Remove new.txt')).toBeDefined();
});

test('does not remove native bytes while an attachment preview is active', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'preview-owned',
        kind: 'text',
        name: 'preview-owned.txt',
        mime_type: 'text/plain',
        size: 12,
      },
    ],
  });
  let closePreview: ((value: unknown) => void) | undefined;
  mockLocalAttachments.presentPreview.mockReturnValueOnce(
    new Promise(resolve => {
      closePreview = resolve;
    }),
  );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  const staleRemove = actionByLabel(
    root,
    'Remove preview-owned.txt',
  ).props.onPress;
  mockLocalAttachments.discard.mockClear();
  await act(async () => {
    actionByLabel(root, 'Preview preview-owned.txt').props.onPress();
    await Promise.resolve();
  });
  expect(
    actionByLabel(root, 'Remove preview-owned.txt').props.disabled,
  ).toBe(true);

  await act(async () => {
    staleRemove({ stopPropagation: jest.fn() });
  });
  expect(mockLocalAttachments.discard).not.toHaveBeenCalledWith([
    'preview-owned',
  ]);
  await act(async () => {
    closePreview?.({ schema_version: 1, status: 'closed' });
    await settle();
  });
  expect(actionByLabel(root, 'Remove preview-owned.txt')).toBeDefined();
});

test('recovers the attachment button when a native picker promise never settles', async () => {
  mockLocalAttachments.present.mockReturnValueOnce(new Promise(() => {}));
  const renderer = await renderApp();
  const root = renderer.root;
  jest.useFakeTimers();

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');
  expect(
    root.findByProps({ accessibilityLabel: 'Add attachment' }).props
      .accessibilityState.busy,
  ).toBe(true);

  await act(async () => {
    jest.advanceTimersByTime(120_000);
    await settle();
  });

  expect(
    root.findByProps({ accessibilityLabel: 'Add attachment' }).props
      .accessibilityState.busy,
  ).toBe(false);
  expect(
    root.findByProps({
      children:
        'Could not add attachment: The attachment picker did not finish. Please try again.',
    }),
  ).toBeDefined();
  jest.useRealTimers();
});

test('blocks send and conversation options while the attachment picker is pending', async () => {
  let resolvePicker:
    | ((value: {
        schema_version: 1;
        status: 'cancelled';
        attachments: [];
      }) => void)
    | undefined;
  mockLocalAttachments.present.mockReturnValueOnce(
    new Promise(resolve => {
      resolvePicker = resolve;
    }),
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Do not race this picker');
  });
  await act(async () => composerOptionsChip(root).props.onPress());
  const staleModelPress = optionInComposerPanel(root, 'Use V4 Pro').props.onPress;
  const staleEffortPress = optionInComposerPanel(
    root,
    'Use Max thinking',
  ).props.onPress;
  await act(async () => optionInComposerPanel(root, 'Done').props.onPress());
  const staleOptionsOpen = composerOptionsChip(root).props.onPress;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');

  const send = actionByLabel(root, 'Send message');
  expect(send.props.disabled).toBe(true);
  expect(composerOptionsChip(root).props.disabled).toBe(true);
  expect(composerOptionsChip(root).props.accessibilityState).toEqual({
    disabled: true,
    expanded: false,
  });
  await act(async () => {
    staleModelPress();
    staleEffortPress();
    staleOptionsOpen();
    await settle();
  });
  expect(composerOptionsChip(root).props.accessibilityLabel).toBe(
    'Model V4 Flash, thinking High',
  );
  expect(
    root.findByProps({ testID: 'conversation-options-modal' }).props.visible,
  ).toBe(false);
  expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();

  // The screen owns a second guard: even a stale callback or programmatic
  // invocation cannot start a request while native attachment work is active.
  await act(async () => {
    send.props.onPress();
    await settle();
  });
  expect(mockLocalRuntime.complete).not.toHaveBeenCalled();

  await act(async () => {
    resolvePicker?.({
      schema_version: 1,
      status: 'cancelled',
      attachments: [],
    });
    await settle();
  });
  expect(actionByLabel(root, 'Send message').props.disabled).toBe(false);
});

test('discards a late attachment result when the originating conversation changed', async () => {
  let resolvePicker:
    | ((value: {
        schema_version: 1;
        status: 'selected';
        attachments: Array<{
          schema_version: 1;
          id: string;
          kind: 'image';
          name: string;
          mime_type: string;
          size: number;
        }>;
      }) => void)
    | undefined;
  mockLocalAttachments.present.mockReturnValueOnce(
    new Promise(resolve => {
      resolvePicker = resolve;
    }),
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Origin chat');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Create new chat').props.onPress();
    await settle();
  });
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Open chat Origin chat').props.onPress();
    await settle();
  });

  await act(async () => {
    resolvePicker?.({
      schema_version: 1,
      status: 'selected',
      attachments: [
        {
          schema_version: 1,
          id: 'late-image',
          kind: 'image',
          name: 'late.png',
          mime_type: 'image/png',
          size: 64,
        },
      ],
    });
    await settle();
  });

  expect(mockLocalAttachments.discard).toHaveBeenCalledWith(['late-image']);
  expect(root.findAllByProps({ accessibilityLabel: 'Remove late.png' })).toHaveLength(0);
  expect(
    lastPersistedState().conversations.every(
      conversation => conversation.model_id === 'deepseek-v4-flash',
    ),
  ).toBe(
    true,
  );
  expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();
});

test('suppresses a stale picker failure after leaving and returning to its conversation', async () => {
  let rejectPicker: ((error: Error) => void) | undefined;
  mockLocalAttachments.present.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectPicker = reject;
    }),
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Stable origin');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Create new chat').props.onPress();
    await settle();
  });
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Open chat Stable origin').props.onPress();
    await settle();
  });
  await act(async () => {
    rejectPicker?.(new Error('late picker failure'));
    await settle();
  });

  expect(
    root.findAllByProps({
      children: 'Could not add attachment: late picker failure',
    }),
  ).toHaveLength(0);
  expect(
    root.findByProps({ accessibilityLabel: 'Add attachment' }).props
      .accessibilityState.busy,
  ).toBe(false);
});

test('keeps the selected model when a draft image is selected then removed', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'removed-image',
        kind: 'image',
        name: 'remove-before-send.png',
        mime_type: 'image/png',
        size: 32,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => composerOptionsChip(root).props.onPress());
  await act(async () => {
    optionInComposerPanel(root, 'Use V4 Pro').props.onPress();
    await settle();
  });
  await act(async () => optionInComposerPanel(root, 'Done').props.onPress());

  mockLocalRuntime.recordModelTransition.mockClear();
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');
  expect(lastPersistedState().conversations[0]?.model_id).toBe(
    'deepseek-v4-pro',
  );
  expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();

  await act(async () => {
    actionByLabel(root, 'Remove remove-before-send.png').props.onPress({
      stopPropagation: jest.fn(),
    });
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Text only');
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.completeV2.mock.calls.at(-1)?.[0]?.model).toBe(
    'deepseek-v4-pro',
  );
  expect(lastPersistedState().conversations[0]?.model_id).toBe(
    'deepseek-v4-pro',
  );
  expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();
});

test('removes an unsent attachment from native storage', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'text-1',
        kind: 'text',
        name: 'notes.txt',
        mime_type: 'text/plain',
        size: 12,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  const stopPropagation = jest.fn();
  await act(async () => {
    actionByLabel(root, 'Remove notes.txt').props.onPress({ stopPropagation });
    await settle();
  });

  expect(stopPropagation).toHaveBeenCalledTimes(1);
  expect(mockLocalAttachments.discard).toHaveBeenCalledWith(['text-1']);
  expect(mockLocalAttachments.presentPreview).not.toHaveBeenCalled();
  expect(
    root.findByProps({ accessibilityLabel: 'Send message' }).props.disabled,
  ).toBe(true);
});

test('previews image, text, and PDF attachments from draft and history cards', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'preview-image',
        kind: 'image',
        name: 'preview.png',
        mime_type: 'image/png',
        size: 120,
        thumbnail_data_url: 'data:image/png;base64,cHJldmlldw==',
      },
      {
        schema_version: 1,
        id: 'preview-text',
        kind: 'text',
        name: 'preview.txt',
        mime_type: 'text/plain',
        size: 24,
      },
      {
        schema_version: 1,
        id: 'preview-pdf',
        kind: 'pdf',
        name: 'preview.pdf',
        mime_type: 'application/pdf',
        size: 2048,
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  for (const name of ['preview.png', 'preview.txt', 'preview.pdf']) {
    await act(async () => {
      actionByLabel(root, `Preview ${name}`).props.onPress();
      await settle();
    });
  }
  expect(
    mockLocalAttachments.presentPreview.mock.calls.map(call => call[0]),
  ).toEqual(['preview-image', 'preview-text', 'preview-pdf']);

  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  mockLocalAttachments.presentPreview.mockClear();
  for (const name of ['preview.png', 'preview.txt', 'preview.pdf']) {
    await act(async () => {
      actionByLabel(root, `Preview ${name}`).props.onPress();
      await settle();
    });
  }
  expect(
    mockLocalAttachments.presentPreview.mock.calls.map(call => call[0]),
  ).toEqual(['preview-image', 'preview-text', 'preview-pdf']);
});

test('serializes preview presentation and recovers from a native rejection', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'busy-text',
        kind: 'text',
        name: 'busy.txt',
        mime_type: 'text/plain',
        size: 10,
      },
      {
        schema_version: 1,
        id: 'busy-pdf',
        kind: 'pdf',
        name: 'busy.pdf',
        mime_type: 'application/pdf',
        size: 100,
      },
    ],
  });
  let closePreview: ((value: unknown) => void) | undefined;
  mockLocalAttachments.presentPreview.mockReturnValueOnce(
    new Promise(resolve => {
      closePreview = resolve;
    }),
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  await act(async () =>
    actionByLabel(root, 'Preview busy.txt').props.onPress(),
  );

  expect(
    actionByLabel(root, 'Preview busy.txt').props.accessibilityState.busy,
  ).toBe(true);
  expect(actionByLabel(root, 'Preview busy.pdf').props.disabled).toBe(true);
  expect(mockLocalAttachments.presentPreview).toHaveBeenCalledTimes(1);

  await act(async () => {
    closePreview?.({ schema_version: 1, status: 'closed' });
    await settle();
  });
  expect(actionByLabel(root, 'Preview busy.pdf').props.disabled).toBe(false);

  mockLocalAttachments.presentPreview.mockRejectedValueOnce(
    new Error('preview controller unavailable'),
  );
  await act(async () => {
    actionByLabel(root, 'Preview busy.pdf').props.onPress();
    await settle();
  });
  expect(
    root.findByProps({
      children: 'Could not preview attachment: preview controller unavailable',
    }),
  ).toBeDefined();
  expect(
    actionByLabel(root, 'Preview busy.pdf').props.accessibilityState.busy,
  ).toBe(false);
});

test('enforces the six-attachment limit across repeated picker sessions', async () => {
  const attachment = (index: number) => ({
    schema_version: 1,
    id: `text-${index}`,
    kind: 'text',
    name: `note-${index}.txt`,
    mime_type: 'text/plain',
    size: 1,
  });
  mockLocalAttachments.present
    .mockResolvedValueOnce({
      schema_version: 1,
      status: 'selected',
      attachments: [1, 2, 3, 4, 5].map(attachment),
    })
    .mockResolvedValueOnce({
      schema_version: 1,
      status: 'selected',
      attachments: [6, 7].map(attachment),
    });
  const renderer = await renderApp();
  const root = renderer.root;

  for (let selection = 0; selection < 2; selection += 1) {
    await act(async () =>
      actionByLabel(root, 'Add attachment').props.onPress(),
    );
    await chooseAttachmentSource(root, 'Files');
  }

  expect(actionByLabel(root, 'Remove note-6.txt')).toBeDefined();
  expect(
    root.findAllByProps({ accessibilityLabel: 'Remove note-7.txt' }),
  ).toHaveLength(0);
  expect(mockLocalAttachments.discard).toHaveBeenCalledWith(['text-7']);
  expect(
    root.findByProps({
      children: 'Up to 6 attachments and 24 MB per message.',
    }),
  ).toBeDefined();
});

test('restores persisted image thumbnails through the bounded preview API', async () => {
  const imageAttachment = {
    schema_version: 1,
    id: 'restored-image',
    kind: 'image',
    name: 'restored.png',
    mime_type: 'image/png',
    size: 99,
  };
  const message = {
    id: 'message-restored',
    role: 'user',
    text: 'Inspect this',
    created_at: '2026-08-24T00:00:01.000Z',
    attachments: [imageAttachment],
  };
  mockLocalRuntime.loadSession.mockResolvedValueOnce(
    JSON.stringify({
      schema_version: 4,
      active_conversation_id: 'conversation-restored',
      conversations: [
        {
          id: 'conversation-restored',
          project_id: null,
          title: 'Inspect this',
          title_source: 'auto',
          model_id: 'deepseek-v4-flash-vision-exp',
          thinking_mode: 'high',
          messages: [message],
          created_at: '2026-08-24T00:00:00.000Z',
          updated_at: '2026-08-24T00:00:01.000Z',
        },
      ],
      messages: [message],
    }),
  );
  mockLocalAttachments.preview.mockResolvedValueOnce({
    schema_version: 1,
    id: 'restored-image',
    thumbnail_data_url: 'data:image/png;base64,cmVzdG9yZWQ=',
  });

  const renderer = await renderApp();
  const root = renderer.root;

  expect(mockLocalAttachments.prune).toHaveBeenCalledWith(['restored-image']);
  expect(mockLocalAttachments.preview).toHaveBeenCalledWith('restored-image');
  expect(
    root.findAll(
      node => node.props.source?.uri === 'data:image/png;base64,cmVzdG9yZWQ=',
    ).length,
  ).toBeGreaterThanOrEqual(1);
});

test('globally prunes sent attachments only after their conversation is persisted as deleted', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'delete-image',
        kind: 'image',
        name: 'delete-me.jpg',
        mime_type: 'image/jpeg',
        size: 100,
      },
    ],
  });
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) => {
      buttons?.find(button => button.style === 'destructive')?.onPress?.();
    });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  expect(mockLocalAttachments.discard).not.toHaveBeenCalled();

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () =>
    actionByLabel(root, 'Chat actions for delete-me.jpg').props.onPress(),
  );
  await act(async () => {
    actionByLabel(root, 'Delete conversation').props.onPress();
    await settle();
  });

  expect(mockLocalAttachments.prune).toHaveBeenLastCalledWith([]);
  expect(mockLocalAttachments.discard).not.toHaveBeenCalled();
  expect(lastPersistedState().messages).toEqual([]);
  alert.mockRestore();
});

test('creates a second chat without overwriting the completed conversation', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Keep this chat');
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Send message' }).props.onPress();
    await settle();
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Open navigation' }).props.onPress();
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Create new chat' }).props.onPress();
    await settle();
  });

  const persisted = lastPersistedState();
  expect(persisted.conversations).toHaveLength(2);
  expect(
    persisted.conversations.some(
      conversation => conversation.messages.length === 2,
    ),
  ).toBe(true);
  expect(persisted.messages).toEqual([]);
});

test('creates a file through the app-owned workspace drawer', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Files').props.onPress());
  await act(async () => {
    await settle();
  });
  await act(async () => actionByLabel(root, 'New file').props.onPress());
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Name' })
      .props.onChangeText('note.md');
  });
  await act(async () => {
    actionByLabel(root, 'Create').props.onPress();
    await settle();
  });

  expect(mockLocalWorkspace.writeText).toHaveBeenCalledWith('note.md', '', {
    createOnly: true,
  });
});

test('opens the honest local profile entry from the drawer footer', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  expect(actionByLabel(root, 'Settings')).toBeDefined();
  await act(async () =>
    actionByLabel(root, 'Open local profile').props.onPress(),
  );
  await act(async () => settle());

  expect(root.findByProps({ children: 'Profile' })).toBeDefined();
  expect(
    root.findByProps({ accessibilityLabel: 'Sign in · coming soon' }).props
      .accessibilityState,
  ).toEqual({ disabled: true });
});

test('closes settings back to the still-open navigation drawer', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Settings').props.onPress());
  expect(root.findByProps({ children: 'Settings' })).toBeDefined();

  await act(async () => actionByLabel(root, 'Close settings').props.onPress());
  await act(async () => settle());

  expect(actionByLabel(root, 'Open local profile')).toBeDefined();
  expect(actionByLabel(root, 'Settings')).toBeDefined();
  expect(
    root
      .findAllByProps({ children: 'Settings' })
      .filter(node => node.props.accessibilityRole === 'header'),
  ).toHaveLength(0);
});

test('opens one combined composer options panel and keeps it open across changes', async () => {
  const dismissKeyboard = jest
    .spyOn(Keyboard, 'dismiss')
    .mockImplementation(() => undefined);
  const renderer = await renderApp();
  const root = renderer.root;

  expect(composerOptionsChip(root).props.accessibilityState).toEqual({
    disabled: false,
    expanded: false,
  });

  await act(async () => composerOptionsChip(root).props.onPress());
  expect(dismissKeyboard).toHaveBeenCalledTimes(1);
  const modal = () => root.findByProps({ testID: 'conversation-options-modal' });
  expect(modal().props.visible).toBe(true);
  expect(
    root.findByProps({ testID: 'model-picker-modal' }).props.visible,
  ).toBe(false);
  expect(composerOptionsChip(root).props.accessibilityState).toEqual({
    disabled: false,
    expanded: true,
  });

  await act(async () => {
    optionInComposerPanel(root, 'Use V4 Pro').props.onPress();
    await settle();
  });
  expect(mockLocalRuntime.recordModelTransition).toHaveBeenCalledWith({
    attachment_busy: false,
    conversation_id: expect.any(String),
    draft_image_count: 0,
    from_model: 'deepseek-v4-flash',
    history_image_count: 0,
    request_epoch: 0,
    request_state: 'idle',
    source: 'composer_picker',
    to_model: 'deepseek-v4-pro',
  });
  expect(modal().props.visible).toBe(true);
  expect(dismissKeyboard).toHaveBeenCalledTimes(1);
  expect(composerOptionsChip(root).props.accessibilityLabel).toBe(
    'Model V4 Pro, thinking High',
  );

  await act(async () => {
    optionInComposerPanel(root, 'Use Max thinking').props.onPress();
    await settle();
  });
  expect(modal().props.visible).toBe(true);

  await act(async () =>
    optionInComposerPanel(root, 'Done').props.onPress(),
  );
  await act(async () => settle());
  expect(modal().props.visible).toBe(false);
  expect(composerOptionsChip(root).props.accessibilityState).toEqual({
    disabled: false,
    expanded: false,
  });
  expect(composerOptionsChip(root).props.accessibilityLabel).toBe(
    'Model V4 Pro, thinking Max',
  );

  dismissKeyboard.mockRestore();
});

test('closes the combined panel from its light scrim without changing anything', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => composerOptionsChip(root).props.onPress());
  await act(async () => {
    root
      .findByProps({ testID: 'conversation-options-backdrop' })
      .props.onPress();
  });
  await act(async () => settle());

  expect(
    root.findByProps({ testID: 'conversation-options-modal' }).props.visible,
  ).toBe(false);
  expect(composerOptionsChip(root).props.accessibilityLabel).toBe(
    'Model V4 Flash, thinking High',
  );
});

test('freezes model and effort while a request is in flight', async () => {
  let finishInitialPersist: ((value: boolean) => void) | undefined;
  let finishRequest:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  let frozenRequest: StrictCompletionRequest | undefined;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    (request: StrictCompletionRequest) => {
      frozenRequest = request;
      return new Promise(resolve => {
        finishRequest = resolve;
      });
    },
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => composerOptionsChip(root).props.onPress());
  const staleModelPress = optionInComposerPanel(root, 'Use V4 Pro').props.onPress;
  const staleEffortPress = optionInComposerPanel(
    root,
    'Use Max thinking',
  ).props.onPress;
  await act(async () => optionInComposerPanel(root, 'Done').props.onPress());
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Freeze this request');
  });
  mockLocalRuntime.persistSession.mockReturnValueOnce(
    new Promise(resolve => {
      finishInitialPersist = resolve;
    }),
  );
  const staleSendPress = actionByLabel(root, 'Send message').props.onPress;
  await act(async () => {
    staleSendPress();
    await settle();
  });

  expect(composerOptionsChip(root).props.disabled).toBe(true);
  expect(composerOptionsChip(root).props.accessibilityState).toEqual({
    disabled: true,
    expanded: false,
  });
  await act(async () => {
    // These callbacks came from the render before `sending`; the screen guard
    // must reject them rather than trusting only Pressable.disabled.
    staleModelPress();
    staleEffortPress();
    staleSendPress();
    await settle();
  });
  expect(lastPersistedState().conversations[0]).toMatchObject({
    model_id: 'deepseek-v4-flash',
    thinking_mode: 'high',
  });
  expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();
  expect(mockLocalRuntime.persistSession).toHaveBeenCalledTimes(1);
  expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();

  await act(async () => {
    finishInitialPersist?.(true);
    await settle();
  });
  expect(mockLocalRuntime.completeV2.mock.calls[0]?.[0]?.model).toBe(
    'deepseek-v4-flash',
  );
  expect(mockLocalRuntime.completeV2.mock.calls[0]?.[0]?.thinkingMode).toBe(
    'high',
  );

  await act(async () => {
    if (frozenRequest !== undefined) {
      finishRequest?.(
        strictCompletionResult(frozenRequest, {
          text: 'Frozen response',
          latency_ms: 9,
        }),
      );
    }
    await settle();
  });
  const persisted = lastPersistedState();
  expect(persisted.conversations[0]?.model_id).toBe('deepseek-v4-flash');
  expect(persisted.conversations[0]?.messages.at(-1)?.metadata?.model_id).toBe(
    'deepseek-v4-flash',
  );
});

test('keeps model, effort, and attachments frozen while persistence is pending', async () => {
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => composerOptionsChip(root).props.onPress());
  const staleModelPress = optionInComposerPanel(root, 'Use V4 Pro').props.onPress;
  const staleEffortPress = optionInComposerPanel(
    root,
    'Use Max thinking',
  ).props.onPress;
  await act(async () => optionInComposerPanel(root, 'Done').props.onPress());
  let candidate = '';
  mockLocalRuntime.persistSession.mockImplementationOnce(async json => {
    candidate = json;
    return false;
  });
  mockLocalRuntime.loadSession.mockImplementationOnce(async () => candidate);
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Hold pending state');
  });
  await act(async () => {
    await actionByLabel(root, 'Send message').props.onPress();
  });

  expect(actionByLabel(root, 'Retry response')).toBeDefined();
  expect(composerOptionsChip(root).props.disabled).toBe(true);
  expect(actionByLabel(root, 'Add attachment').props.disabled).toBe(true);
  expect(
    root.findAllByProps({ accessibilityLabel: 'Stop response' }),
  ).toHaveLength(0);
  expect(actionByLabel(root, 'Send message').props.disabled).toBe(true);
  expect(
    root.findAllByProps({ accessibilityLabel: 'Configure DeepSeek key' }),
  ).toHaveLength(0);
  await act(async () => {
    staleModelPress();
    staleEffortPress();
  });
  expect(lastPersistedState().conversations[0]).toMatchObject({
    model_id: 'deepseek-v4-flash',
    thinking_mode: 'high',
  });
  expect(mockLocalRuntime.recordModelTransition).not.toHaveBeenCalled();
  expect(mockLocalRuntime.completeV2).not.toHaveBeenCalled();
});

test('opens the compact model popover from settings and returns to settings', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Settings').props.onPress());
  await act(async () =>
    actionByLabel(root, 'Choose default model').props.onPress(),
  );

  const anchorStyle = StyleSheet.flatten(
    root.findByProps({ testID: 'model-picker-anchor' }).props.style,
  );
  expect(anchorStyle.paddingHorizontal).toBe(18);
  expect(anchorStyle.paddingBottom).toBe(52);
  expect(root.findByProps({ children: 'Settings' })).toBeDefined();

  await act(async () =>
    root.findByProps({ testID: 'model-picker-backdrop' }).props.onPress(),
  );
  expect(root.findByProps({ testID: 'model-picker-modal' }).props.visible).toBe(
    false,
  );
  expect(root.findByProps({ children: 'Settings' })).toBeDefined();

  await act(async () => actionByLabel(root, 'Close settings').props.onPress());
  await act(async () => settle());
  expect(actionByLabel(root, 'Open local profile')).toBeDefined();
});

test('audits settings model changes with their distinct source', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Settings').props.onPress());
  await act(async () =>
    actionByLabel(root, 'Choose default model').props.onPress(),
  );
  await act(async () => {
    actionByLabel(root, 'Use V4 Pro').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.recordModelTransition).toHaveBeenCalledWith(
    expect.objectContaining({
      from_model: 'deepseek-v4-flash',
      source: 'settings_picker',
      to_model: 'deepseek-v4-pro',
    }),
  );
});

test('stages a custom npm mirror through the native rish adapter', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Settings').props.onPress());
  await act(async () => actionByLabel(root, 'Package mirrors').props.onPress());
  await act(async () => settle());

  await act(async () => {
    root
      .findByProps({
        accessibilityLabel: 'Custom HTTPS base URL Node.js npm',
      })
      .props.onChangeText('https://registry.npmmirror.com');
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Use this mirror Node.js npm' })
      .props.onValueChange(true);
  });
  await act(async () => {
    actionByLabel(root, 'Save mirror configuration').props.onPress();
    await settle();
  });

  expect(mockLocalMirrors.apply).toHaveBeenCalledWith(
    expect.objectContaining({
      npm: {
        enabled: true,
        baseUrl: 'https://registry.npmmirror.com/',
      },
    }),
  );
  const persisted = JSON.parse(
    mockLocalRuntime.persistSession.mock.calls.at(-1)?.[0],
  ) as {
    preferences: { mirrors: { npm: { enabled: boolean; base_url: string } } };
  };
  expect(persisted.preferences.mirrors.npm).toEqual({
    enabled: true,
    base_url: 'https://registry.npmmirror.com/',
  });

  await act(async () => {
    actionByLabel(root, 'Back to settings').props.onPress();
    await settle();
  });
  expect(root.findByProps({ children: 'Settings' })).toBeDefined();
});

test('edits with revision protection and renders a real portable tool receipt', async () => {
  const file = {
    path: 'note.md',
    name: 'note.md',
    kind: 'file',
    size: 5,
    modified_at: '2026-08-24T00:00:00.000Z',
    revision: 'rev-1',
  };
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: '',
    entries: [file],
  });
  mockLocalWorkspace.readText.mockResolvedValue({ file, content: 'hello' });
  mockLocalWorkspace.writeText.mockResolvedValue({
    created: false,
    file: { ...file, size: 12, revision: 'rev-2' },
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Files').props.onPress());
  await act(async () => {
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'File content' })
      .props.onChangeText('hello mobile');
  });
  await act(async () => {
    actionByLabel(root, 'Save changes').props.onPress();
    await settle();
  });
  expect(mockLocalWorkspace.writeText).toHaveBeenCalledWith(
    'note.md',
    'hello mobile',
    { createOnly: false, expectedRevision: 'rev-1' },
  );

  await act(async () => {
    actionByLabel(root, 'SHA-256').props.onPress();
    await settle();
  });
  expect(mockLocalWorkspace.executePortableTool).toHaveBeenCalledWith(
    'sha256sum',
    'note.md',
    {},
  );
  expect(root.findByProps({ children: 'abc  note.md\n' })).toBeDefined();
});

test('opens chat actions from the drawer and persists a renamed title', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Rename this chat');
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Send message' }).props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Open navigation').props.onPress();
  });
  await act(async () => {
    actionByLabel(root, 'Chat actions for Rename this chat').props.onPress();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Conversation title' })
      .props.onChangeText('Renamed locally');
  });
  await act(async () => {
    actionByLabel(root, 'Save conversation title').props.onPress();
    await settle();
  });

  expect(lastPersistedState().conversations[0]?.id).toBeDefined();
  const lastSerialized = JSON.parse(
    mockLocalRuntime.persistSession.mock.calls.at(-1)?.[0],
  ) as {
    conversations: Array<{ title: string }>;
  };
  expect(lastSerialized.conversations[0]?.title).toBe('Renamed locally');
});

test('keeps the composer recoverable and retries a failed response', async () => {
  mockLocalRuntime.completeV2
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockImplementationOnce(async (request: StrictCompletionRequest) =>
      strictCompletionResult(request, {
        text: 'Recovered',
        latency_ms: 50,
        reasoning: 'Retrying the local request.',
      }),
    );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Retry me');
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Send message' }).props.onPress();
    await settle();
  });
  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.editable,
  ).toBe(true);
  expect(
    root.findByProps({ accessibilityLabel: 'Retry response' }),
  ).toBeDefined();

  await act(async () => {
    await root
      .findByProps({ accessibilityLabel: 'Retry response' })
      .props.onPress();
  });
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(2);
  expect(
    mockLocalRuntime.persistSession.mock.calls.map(call => {
      const state = JSON.parse(call[0] as string) as {
        conversations: Array<{ attempts?: Array<{ status: string }> }>;
      };
      return state.conversations[0]?.attempts?.at(-1)?.status ?? 'none';
    }),
  ).toEqual([
    'prepared',
    'sending',
    'failed',
    'prepared',
    'sending',
    'completed',
  ]);
  const persisted = lastPersistedState();
  expect(persisted.conversations[0]?.attempts?.at(-1)).toMatchObject({
    status: 'completed',
    assistant_message_id: expect.any(String),
  });
  expect(persisted.messages.at(-1)?.text).toBe('Recovered');
});

test('coalesces rapid Retry taps without hiding the successful outcome', async () => {
  mockLocalRuntime.completeV2.mockRejectedValueOnce(
    new Error('retry once'),
  );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Retry rapidly');
  });
  await act(async () => {
    await actionByLabel(root, 'Send message').props.onPress();
  });

  let retryRequest: StrictCompletionRequest | undefined;
  let resolveRetry:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        retryRequest = request;
        resolveRetry = resolve;
      }),
  );
  const retryPress = actionByLabel(root, 'Retry response').props.onPress;
  let firstTap: Promise<unknown> | undefined;
  let secondTap: Promise<unknown> | undefined;
  await act(async () => {
    const first = retryPress() as unknown;
    const second = retryPress() as unknown;
    if (first instanceof Promise) firstTap = first;
    if (second instanceof Promise) secondTap = second;
    await settle();
  });
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(2);

  await act(async () => {
    if (retryRequest !== undefined) {
      resolveRetry?.(
        strictCompletionResult(retryRequest, { text: 'One retry wins' }),
      );
    }
    await firstTap;
    await secondTap;
  });
  expect(lastPersistedState().messages.at(-1)?.text).toBe('One retry wins');
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).not.toContain('E_COMPLETION_BUSY');
  expect(rendered).not.toContain('E_COMPLETION_NATIVE');
  expect(
    root.findAllByProps({ accessibilityLabel: 'Retry response' }),
  ).toHaveLength(0);
});

test('ignores a stale Retry callback after moving to another failed chat', async () => {
  mockLocalRuntime.completeV2
    .mockRejectedValueOnce(new Error('first failed'))
    .mockRejectedValueOnce(new Error('second failed'));
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('First failed chat');
  });
  await act(async () => {
    await actionByLabel(root, 'Send message').props.onPress();
  });
  const staleRetry = actionByLabel(root, 'Retry response').props.onPress;
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    await actionByLabel(root, 'Create new chat').props.onPress();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Second failed chat');
  });
  await act(async () => {
    await actionByLabel(root, 'Send message').props.onPress();
  });
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(2);

  await act(async () => {
    await staleRetry();
  });
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(2);
  expect(actionByLabel(root, 'Retry response')).toBeDefined();
  expect(lastPersistedState().messages.at(-1)?.text).toBe('Second failed chat');
});

test('blocks Retry while a native attachment picker owns the composer', async () => {
  mockLocalRuntime.completeV2.mockRejectedValueOnce(new Error('first failed'));
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Retry after picker');
  });
  await act(async () => {
    await actionByLabel(root, 'Send message').props.onPress();
  });
  const staleRetry = actionByLabel(root, 'Retry response').props.onPress;
  let rejectPicker: ((error: Error) => void) | undefined;
  mockLocalAttachments.present.mockReturnValueOnce(
    new Promise((_resolve, reject) => {
      rejectPicker = reject;
    }),
  );
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  expect(actionByLabel(root, 'Retry response').props.disabled).toBe(true);

  await act(async () => {
    await staleRetry();
  });
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
  await act(async () => {
    rejectPicker?.(new Error('picker released'));
    await settle();
  });
});

test('blocks Retry while native attachment preview owns the file', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'retry-preview',
        kind: 'text',
        name: 'retry-preview.txt',
        mime_type: 'text/plain',
        size: 8,
      },
    ],
  });
  mockLocalRuntime.completeV2.mockRejectedValueOnce(new Error('first failed'));
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Retry after preview');
  });
  await act(async () => {
    await actionByLabel(root, 'Send message').props.onPress();
  });
  const staleRetry = actionByLabel(root, 'Retry response').props.onPress;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Do not send during preview');
  });
  const staleSend = actionByLabel(root, 'Send message').props.onPress;
  let closePreview: ((value: unknown) => void) | undefined;
  mockLocalAttachments.presentPreview.mockReturnValueOnce(
    new Promise(resolve => {
      closePreview = resolve;
    }),
  );
  await act(async () => {
    actionByLabel(root, 'Preview retry-preview.txt').props.onPress();
    await Promise.resolve();
  });
  expect(actionByLabel(root, 'Retry response').props.disabled).toBe(true);

  await act(async () => {
    await staleRetry();
    await staleSend();
  });
  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(1);
  await act(async () => {
    closePreview?.({ schema_version: 1, status: 'closed' });
    await settle();
  });
});

test('retry keeps the exact attachment history', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'pdf-1',
        kind: 'pdf',
        name: 'spec.pdf',
        mime_type: 'application/pdf',
        size: 4096,
      },
    ],
  });
  mockLocalRuntime.completeV2
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementationOnce(async (request: StrictCompletionRequest) =>
      strictCompletionResult(request, {
        text: 'Recovered with the PDF',
        latency_ms: 50,
      }),
    );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Files');
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(root, 'Retry response').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.completeV2).toHaveBeenCalledTimes(2);
  expect(mockLocalRuntime.completeV2.mock.calls[1]?.[0]?.visibleHistory).toEqual(
    mockLocalRuntime.completeV2.mock.calls[0]?.[0]?.visibleHistory,
  );
  expect(
    mockLocalRuntime.completeV2.mock.calls[1]?.[0]?.visibleHistory?.[0]
      ?.attachments,
  ).toEqual([expect.objectContaining({ id: 'pdf-1', kind: 'pdf' })]);
});

test('reselects Flash Exp when existing history still contains an image', async () => {
  mockLocalAttachments.present.mockResolvedValueOnce({
    schema_version: 1,
    status: 'selected',
    attachments: [
      {
        schema_version: 1,
        id: 'history-image',
        kind: 'image',
        name: 'history.png',
        mime_type: 'image/png',
        size: 128,
        thumbnail_data_url: 'data:image/png;base64,aGlzdG9yeQ==',
      },
    ],
  });
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Add attachment').props.onPress());
  await chooseAttachmentSource(root, 'Photos');
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  await act(async () => composerOptionsChip(root).props.onPress());
  await act(async () => {
    optionInComposerPanel(root, 'Use V4 Pro').props.onPress();
  });
  await act(async () => {
    optionInComposerPanel(root, 'Done').props.onPress();
    await settle();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Continue with the same image context');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.completeV2.mock.calls.at(-1)?.[0]?.model).toBe(
    'deepseek-v4-flash-vision-exp',
  );
  expect(lastPersistedState().conversations[0]?.model_id).toBe(
    'deepseek-v4-flash-vision-exp',
  );
});

test('uses the model selected for the active conversation', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => composerOptionsChip(root).props.onPress());
  await act(async () => {
    optionInComposerPanel(root, 'Use V4 Pro').props.onPress();
  });
  await act(async () => {
    optionInComposerPanel(root, 'Done').props.onPress();
    await settle();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Use pro');
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Send message' }).props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.completeV2.mock.calls.at(-1)?.[0]?.model).toBe(
    'deepseek-v4-pro',
  );
  expect(lastPersistedState().conversations[0]?.model_id).toBe(
    'deepseek-v4-pro',
  );
});

test('offers the multimodal Flash Exp route in the model picker', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => composerOptionsChip(root).props.onPress());
  await act(async () => {
    optionInComposerPanel(root, 'Use Flash Exp').props.onPress();
  });
  await act(async () => {
    optionInComposerPanel(root, 'Done').props.onPress();
    await settle();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Inspect an image-capable route');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.completeV2.mock.calls.at(-1)?.[0]?.model).toBe(
    'deepseek-v4-flash-vision-exp',
  );
  expect(lastPersistedState().conversations[0]?.model_id).toBe(
    'deepseek-v4-flash-vision-exp',
  );
});

test('selects thinking beside the composer and persists it per conversation', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => composerOptionsChip(root).props.onPress());
  await act(async () => {
    optionInComposerPanel(root, 'Use Max thinking').props.onPress();
  });
  await act(async () => {
    optionInComposerPanel(root, 'Done').props.onPress();
    await settle();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Think deeply');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(
    mockLocalRuntime.completeV2.mock.calls.at(-1)?.[0]?.thinkingMode,
  ).toBe('max');
  expect(lastPersistedState().conversations[0]?.thinking_mode).toBe('max');

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Settings').props.onPress());
  expect(root.findAllByProps({ children: 'Thinking mode' })).toHaveLength(0);
});

test('passes thinking mode and renders persisted reasoning when enabled', async () => {
  mockLocalRuntime.completeV2.mockImplementation(
    async (request: StrictCompletionRequest) =>
      strictCompletionResult(request, {
        text: 'Reasoned answer',
        latency_ms: 88,
        reasoning: 'I inspected the request before answering.',
      }),
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Settings').props.onPress());
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Show reasoning' })
      .props.onValueChange(true);
    await settle();
  });
  await act(async () => actionByLabel(root, 'Close settings').props.onPress());
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Think first');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(
    mockLocalRuntime.completeV2.mock.calls.at(-1)?.[0]?.thinkingMode,
  ).toBe('high');
  expect(
    root.findByProps({ accessibilityLabel: 'Show reasoning' }),
  ).toBeDefined();
  const persisted = lastPersistedState();
  const assistant = persisted.conversations[0]?.messages.at(-1) as unknown as {
    metadata?: { reasoning?: string };
  };
  expect(assistant.metadata?.reasoning).toBe(
    'I inspected the request before answering.',
  );
});

test('stops an in-flight response and ignores its late resolution', async () => {
  let resolveCompletion:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  let stoppedRequest: StrictCompletionRequest | undefined;
  mockLocalRuntime.completeV2.mockImplementation(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        stoppedRequest = request;
        resolveCompletion = resolve;
      }),
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Stop me');
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Send message' }).props.onPress();
    await settle();
  });
  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Stop response' }).props.onPress();
    await settle();
  });
  expect(mockLocalRuntime.cancelCompletion).toHaveBeenCalledTimes(1);
  expect(mockLocalRuntime.cancelCompletion).toHaveBeenCalledWith(
    '00000001-0000-4000-8000-000000000000',
  );

  await act(async () => {
    if (stoppedRequest !== undefined) {
      resolveCompletion?.(
        strictCompletionResult(stoppedRequest, {
          text: 'Too late',
          latency_ms: 99,
        }),
      );
    }
    await settle();
  });
  expect(lastPersistedState().messages.map(message => message.text)).toEqual([
    'Stop me',
  ]);
});

test('ignores a stale Stop callback from an earlier completed request', async () => {
  const requests: StrictCompletionRequest[] = [];
  const resolvers: Array<
    (value: ReturnType<typeof strictCompletionResult>) => void
  > = [];
  mockLocalRuntime.completeV2.mockImplementation(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        requests.push(request);
        resolvers.push(resolve);
      }),
  );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('First request');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  const staleStop = actionByLabel(root, 'Stop response').props.onPress;
  await act(async () => {
    resolvers[0]?.(
      strictCompletionResult(requests[0]!, { text: 'First completed' }),
    );
    await settle();
  });
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Second request');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  expect(requests).toHaveLength(2);
  mockLocalRuntime.cancelCompletion.mockClear();

  await act(async () => {
    await staleStop();
  });
  expect(mockLocalRuntime.cancelCompletion).not.toHaveBeenCalled();

  await act(async () => {
    resolvers[1]?.(
      strictCompletionResult(requests[1]!, { text: 'Second completed' }),
    );
    await settle();
  });
  expect(lastPersistedState().messages.map(message => message.text)).toEqual([
    'First request',
    'First completed',
    'Second request',
    'Second completed',
  ]);
});

test('locks without Stop while a successful result is finalizing', async () => {
  let completionRequest: StrictCompletionRequest | undefined;
  let resolveCompletion:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        completionRequest = request;
        resolveCompletion = resolve;
      }),
  );
  let resolveFinalPersist!: (saved: boolean) => void;
  mockLocalRuntime.persistSession
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        resolveFinalPersist = resolve;
      }),
    );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Finalize success');
  });
  let sendPromise: Promise<unknown> | undefined;
  await act(async () => {
    const result = actionByLabel(root, 'Send message').props.onPress() as unknown;
    if (result instanceof Promise) sendPromise = result;
    await settle();
  });
  const staleStop = actionByLabel(root, 'Stop response').props.onPress;
  await act(async () => {
    resolveCompletion?.(
      strictCompletionResult(completionRequest!, { text: 'Finalized answer' }),
    );
    await settle();
  });

  expect(
    root.findAllByProps({ accessibilityLabel: 'Stop response' }),
  ).toHaveLength(0);
  expect(actionByLabel(root, 'Send message').props.disabled).toBe(true);
  await act(async () => {
    await staleStop();
  });
  expect(mockLocalRuntime.cancelCompletion).not.toHaveBeenCalled();
  await act(async () => {
    resolveFinalPersist(true);
    await sendPromise;
  });
  expect(lastPersistedState().messages.at(-1)?.text).toBe('Finalized answer');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Response stopped.');
});

test('locks without Stop while a failed result is becoming durable', async () => {
  let rejectCompletion!: (error: unknown) => void;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    () =>
      new Promise((_resolve, reject) => {
        rejectCompletion = reject;
      }),
  );
  let resolveFailurePersist!: (saved: boolean) => void;
  mockLocalRuntime.persistSession
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockReturnValueOnce(
      new Promise<boolean>(resolve => {
        resolveFailurePersist = resolve;
      }),
    );
  const renderer = await renderApp();
  const root = renderer.root;
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Finalize failure');
  });
  let sendPromise: Promise<unknown> | undefined;
  await act(async () => {
    const result = actionByLabel(root, 'Send message').props.onPress() as unknown;
    if (result instanceof Promise) sendPromise = result;
    await settle();
  });
  const staleStop = actionByLabel(root, 'Stop response').props.onPress;
  await act(async () => {
    rejectCompletion({ code: 'E_COMPLETION_TRANSPORT' });
    await settle();
  });

  expect(
    root.findAllByProps({ accessibilityLabel: 'Stop response' }),
  ).toHaveLength(0);
  expect(actionByLabel(root, 'Send message').props.disabled).toBe(true);
  await act(async () => {
    await staleStop();
  });
  expect(mockLocalRuntime.cancelCompletion).not.toHaveBeenCalled();
  await act(async () => {
    resolveFailurePersist(true);
    await sendPromise;
  });
  const rendered = JSON.stringify(renderer.toJSON());
  expect(rendered).toContain('E_COMPLETION_TRANSPORT');
  expect(rendered).not.toContain('Response stopped.');
  expect(actionByLabel(root, 'Retry response')).toBeDefined();
});

test('cancels and persists the active round before switching chats', async () => {
  const renderer = await renderApp();
  const root = renderer.root;
  const sendText = async (text: string) => {
    await act(async () => {
      root
        .findByProps({ accessibilityLabel: 'Message DSH' })
        .props.onChangeText(text);
    });
    await act(async () => {
      await actionByLabel(root, 'Send message').props.onPress();
    });
  };

  await sendText('Origin chat');
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    await actionByLabel(root, 'Create new chat').props.onPress();
  });
  await sendText('Destination chat');
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    await actionByLabel(root, 'Create new chat').props.onPress();
  });
  await sendText('Third chat');
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    await actionByLabel(root, 'Open chat Origin chat').props.onPress();
  });

  let activeRequest: StrictCompletionRequest | undefined;
  let resolveCompletion:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        activeRequest = request;
        resolveCompletion = resolve;
      }),
  );
  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Switch while active');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  expect(activeRequest).toBeDefined();
  mockLocalRuntime.persistSession.mockClear();
  const cancellation = deferred<{ status: 'cancelled' }>();
  mockLocalRuntime.cancelCompletion.mockReturnValueOnce(cancellation.promise);

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  const drawer = root.findByType(ChatDrawer);
  const destinationId = drawer.props.conversations.find(
    (conversation: { title: string }) => conversation.title === 'Destination chat',
  )?.id;
  const thirdId = drawer.props.conversations.find(
    (conversation: { title: string }) => conversation.title === 'Third chat',
  )?.id;
  await act(async () => {
    const first = drawer.props.onSelect(destinationId);
    const second = drawer.props.onSelect(thirdId);
    await settle();
    expect(mockLocalRuntime.cancelCompletion).toHaveBeenCalledTimes(1);
    cancellation.resolve({ status: 'cancelled' });
    await first;
    await second;
  });

  expect(mockLocalRuntime.cancelCompletion).toHaveBeenCalledWith(
    activeRequest?.roundId,
  );
  const switchedSnapshots = mockLocalRuntime.persistSession.mock.calls.map(
    call =>
      JSON.parse(call[0] as string) as {
        active_conversation_id: string;
        conversations: Array<{
          id: string;
          title: string;
          attempts: Array<{ status: string }>;
          messages: Array<{ text: string }>;
        }>;
      },
  );
  expect(
    switchedSnapshots.some(snapshot =>
      snapshot.conversations
        .find(conversation => conversation.title === 'Origin chat')
        ?.attempts.some(attempt => attempt.status === 'cancelled'),
    ),
  ).toBe(true);
  const selectedAfterSwitch = switchedSnapshots.at(-1)!;
  expect(
    selectedAfterSwitch.conversations.find(
      conversation => conversation.id === selectedAfterSwitch.active_conversation_id,
    )?.title,
  ).toBe('Destination chat');

  await act(async () => {
    if (activeRequest !== undefined) {
      resolveCompletion?.(
        strictCompletionResult(activeRequest, { text: 'Too late after switch' }),
      );
    }
    await settle();
  });
  expect(
    lastPersistedState().conversations.flatMap(conversation =>
      conversation.messages.map(message => message.text),
    ),
  ).not.toContain('Too late after switch');
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Response stopped.');
});

test('persists cancellation before deleting the active chat and ignores late output', async () => {
  let deletePromise: Promise<unknown> | undefined;
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, buttons) => {
      const destructive = buttons?.find(button => button.style === 'destructive');
      const invoke = destructive?.onPress as (() => unknown) | undefined;
      const result = invoke?.();
      if (
        typeof result === 'object' &&
        result !== null &&
        'then' in result
      ) {
        deletePromise = Promise.resolve(result);
      }
    });
  let activeRequest: StrictCompletionRequest | undefined;
  let resolveCompletion:
    | ((value: ReturnType<typeof strictCompletionResult>) => void)
    | undefined;
  mockLocalRuntime.completeV2.mockImplementationOnce(
    (request: StrictCompletionRequest) =>
      new Promise(resolve => {
        activeRequest = request;
        resolveCompletion = resolve;
      }),
  );
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    root
      .findByProps({ accessibilityLabel: 'Message DSH' })
      .props.onChangeText('Delete active chat');
  });
  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });
  expect(activeRequest).toBeDefined();
  mockLocalRuntime.persistSession.mockClear();
  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => {
    actionByLabel(root, 'Chat actions for Delete active chat').props.onPress();
    root.findByType(ChatDrawer).props.onDismiss();
  });
  await act(async () => {
    actionByLabel(root, 'Delete conversation').props.onPress();
    root.findByType(ConversationActionSheet).props.onDismiss();
    await settle();
    expect(alert).toHaveBeenCalledTimes(1);
    expect(deletePromise).toBeInstanceOf(Promise);
    await deletePromise;
  });

  expect(mockLocalRuntime.cancelCompletion).toHaveBeenCalledWith(
    activeRequest?.roundId,
  );
  const deletionSnapshots = mockLocalRuntime.persistSession.mock.calls.map(
    call =>
      JSON.parse(call[0] as string) as {
        conversations: Array<{
          title: string;
          attempts: Array<{ status: string }>;
          messages: Array<{ text: string }>;
        }>;
      },
  );
  const cancelledIndex = deletionSnapshots.findIndex(snapshot =>
    snapshot.conversations
      .find(conversation => conversation.title === 'Delete active chat')
      ?.attempts.some(attempt => attempt.status === 'cancelled'),
  );
  const deletedIndex = deletionSnapshots.findIndex(
    snapshot =>
      !snapshot.conversations.some(
        conversation => conversation.title === 'Delete active chat',
      ),
  );
  expect(cancelledIndex).toBeGreaterThanOrEqual(0);
  expect(deletedIndex).toBeGreaterThan(cancelledIndex);

  await act(async () => {
    if (activeRequest !== undefined) {
      resolveCompletion?.(
        strictCompletionResult(activeRequest, { text: 'Too late after delete' }),
      );
    }
    await settle();
  });
  expect(
    lastPersistedState().conversations.some(
      conversation =>
        conversation.messages.some(message => message.text === 'Too late after delete'),
    ),
  ).toBe(false);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Response stopped.');
  alert.mockRestore();
});

test('offers native credential recovery when no key is configured', async () => {
  mockLocalRuntime.credentialStatus.mockResolvedValue({ status: 'missing' });
  const renderer = await renderApp();
  const root = renderer.root;

  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.editable,
  ).toBe(false);
  await act(async () => {
    actionByLabel(root, 'Configure DeepSeek key').props.onPress();
  });
  await act(async () => {
    const configureButtons = root
      .findAllByProps({ accessibilityLabel: 'Configure DeepSeek key' })
      .filter(instance => typeof instance.props.onPress === 'function');
    configureButtons.at(-1)?.props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.presentCredentialPrompt).toHaveBeenCalledTimes(1);
  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.editable,
  ).toBe(true);
});

test('applies and persists light theme plus Simplified Chinese immediately', async () => {
  const renderer = await renderApp();
  const root = renderer.root;

  await act(async () => {
    actionByLabel(root, 'Open navigation').props.onPress();
  });
  await act(async () => {
    actionByLabel(root, 'Settings').props.onPress();
  });
  await act(async () => {
    actionByLabel(root, 'Light').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(root, '简体中文').props.onPress();
    await settle();
  });

  expect(root.findByProps({ children: '设置' })).toBeDefined();
  const serialized = mockLocalRuntime.persistSession.mock.calls.at(-1)?.[0];
  const persisted = JSON.parse(serialized) as {
    preferences: { theme_mode: string; locale: string };
  };
  expect(persisted.preferences).toMatchObject({
    theme_mode: 'light',
    locale: 'zh-CN',
  });
});

test('fails gracefully when the platform has no local native adapter', async () => {
  mockLocalRuntime.isAvailable.mockReturnValue(false);
  const renderer = await renderApp();
  const root = renderer.root;

  expect(mockLocalRuntime.credentialStatus).not.toHaveBeenCalled();
  expect(
    root.findByProps({ accessibilityLabel: 'Message DSH' }).props.editable,
  ).toBe(false);
  await act(async () => {
    actionByLabel(root, 'Configure DeepSeek key').props.onPress();
  });
  const adapterButton = root
    .findAllByProps({ accessibilityLabel: 'Configure DeepSeek key' })
    .find(instance => instance.props.disabled === true);
  expect(adapterButton).toBeDefined();
});
