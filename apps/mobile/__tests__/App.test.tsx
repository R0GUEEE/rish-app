/**
 * @format
 */

import React from 'react';
import { Alert, Keyboard, StyleSheet } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import App from '../App';

jest.mock('../src/native/LocalRuntime', () => ({
  LocalRuntime: {
    isAvailable: jest.fn(),
    createCompletionRequestId: jest.fn(),
    bootstrap: jest.fn(),
    credentialStatus: jest.fn(),
    presentCredentialPrompt: jest.fn(),
    clearCredential: jest.fn(),
    complete: jest.fn(),
    cancelCompletion: jest.fn(),
    persistSession: jest.fn(),
    loadSession: jest.fn(),
  },
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
      workspace_id: string | null;
      thinking_mode: string;
      messages: Array<{
        role: string;
        text: string;
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
      attachments: Array<{
        id: string;
        kind: string;
        thumbnail_data_url?: string;
      }>;
    }>;
  };
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
    () => `request-${++requestCounter}`,
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

test('starts a project-bound chat and surfaces its cwd context in the composer', async () => {
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

  expect(lastPersistedState().conversations.at(-1)?.project_id).toBe(
    'project-1',
  );
  expect(
    root.findAllByProps({ accessibilityLabel: 'Project demo' }).length,
  ).toBeGreaterThanOrEqual(1);
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

  expect(mockLocalRuntime.complete).toHaveBeenCalledWith(
    'deepseek-v4-flash',
    [{ role: 'user', content: 'First turn' }],
    'request-1',
    'high',
  );
  const persisted = lastPersistedState();
  expect(persisted.messages.map(message => message.role)).toEqual([
    'user',
    'assistant',
  ]);
  expect(persisted.messages[1]?.text).toBe('SIMULATOR_LOCAL_OK');
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
  expect(
    root.findByProps({ accessibilityLabel: 'Send message' }).props.disabled,
  ).toBe(false);

  await act(async () => {
    actionByLabel(root, 'Send message').props.onPress();
    await settle();
  });

  expect(mockLocalRuntime.complete).toHaveBeenCalledWith(
    'deepseek-v4-flash-vision-exp',
    [
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
    'request-1',
    'high',
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

test('discards sent attachments only after their conversation is persisted as deleted', async () => {
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

  expect(mockLocalAttachments.discard).toHaveBeenCalledWith(['delete-image']);
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
    expanded: true,
  });

  await act(async () => {
    optionInComposerPanel(root, 'Use V4 Pro').props.onPress();
    await settle();
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
  mockLocalRuntime.complete
    .mockRejectedValueOnce(new Error('network unavailable'))
    .mockResolvedValueOnce({
      text: 'Recovered',
      model: 'deepseek-v4-flash',
      request_id: 'request-2',
      latency_ms: 50,
      reasoning: 'Retrying the local request.',
      thinking_mode: 'high',
    });
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
    root.findByProps({ accessibilityLabel: 'Retry response' }).props.onPress();
    await settle();
  });
  expect(mockLocalRuntime.complete).toHaveBeenCalledTimes(2);
  expect(lastPersistedState().messages.at(-1)?.text).toBe('Recovered');
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
  mockLocalRuntime.complete
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce({
      text: 'Recovered with the PDF',
      model: 'deepseek-v4-flash',
      request_id: 'request-2',
      latency_ms: 50,
      reasoning: '',
      thinking_mode: 'high',
    });
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

  expect(mockLocalRuntime.complete).toHaveBeenCalledTimes(2);
  expect(mockLocalRuntime.complete.mock.calls[1]?.[1]).toEqual(
    mockLocalRuntime.complete.mock.calls[0]?.[1],
  );
  expect(
    mockLocalRuntime.complete.mock.calls[1]?.[1]?.[0]?.attachments,
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

  expect(mockLocalRuntime.complete.mock.calls.at(-1)?.[0]).toBe(
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

  expect(mockLocalRuntime.complete.mock.calls.at(-1)?.[0]).toBe(
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

  expect(mockLocalRuntime.complete.mock.calls.at(-1)?.[0]).toBe(
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

  expect(mockLocalRuntime.complete.mock.calls.at(-1)?.[3]).toBe('max');
  expect(lastPersistedState().conversations[0]?.thinking_mode).toBe('max');

  await act(async () => actionByLabel(root, 'Open navigation').props.onPress());
  await act(async () => actionByLabel(root, 'Settings').props.onPress());
  expect(root.findAllByProps({ children: 'Thinking mode' })).toHaveLength(0);
});

test('passes thinking mode and renders persisted reasoning when enabled', async () => {
  mockLocalRuntime.complete.mockResolvedValue({
    text: 'Reasoned answer',
    model: 'deepseek-v4-flash',
    request_id: 'request-reasoning',
    latency_ms: 88,
    reasoning: 'I inspected the request before answering.',
    thinking_mode: 'high',
  });
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

  expect(mockLocalRuntime.complete.mock.calls.at(-1)?.[3]).toBe('high');
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
  let resolveCompletion: ((value: unknown) => void) | undefined;
  mockLocalRuntime.complete.mockReturnValue(
    new Promise(resolve => {
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
  expect(mockLocalRuntime.cancelCompletion).toHaveBeenCalledWith('request-1');

  await act(async () => {
    resolveCompletion?.({
      text: 'Too late',
      model: 'deepseek-v4-flash',
      request_id: 'late',
      latency_ms: 99,
      reasoning: '',
      thinking_mode: 'high',
    });
    await settle();
  });
  expect(lastPersistedState().messages.map(message => message.text)).toEqual([
    'Stop me',
  ]);
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
