import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { WorkspaceDrawer } from '../src/components/WorkspaceDrawer';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import {
  workspaceRoot,
  type WorkspaceRootRefV1,
} from '../src/native/WorkspaceRoot';

jest.mock('../src/native/LocalWorkspace', () => ({
  LocalWorkspace: {
    isAvailable: jest.fn(),
    capabilities: jest.fn(),
    listV2: jest.fn(),
    readV2: jest.fn(),
    writeV2: jest.fn(),
    createDirectoryV2: jest.fn(),
    renameEntryV2: jest.fn(),
    trashEntryV2: jest.fn(),
    listTrashV2: jest.fn(),
    restoreFromTrashV2: jest.fn(),
    executePortableToolV2: jest.fn(),
  },
}));

jest.mock('../src/native/LocalDocuments', () => ({
  LocalDocuments: {
    isAvailable: jest.fn(),
    presentImportPicker: jest.fn(),
    presentExportPicker: jest.fn(),
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockLocalWorkspace = (
  jest.requireMock('../src/native/LocalWorkspace') as {
    LocalWorkspace: Record<string, jest.Mock>;
  }
).LocalWorkspace;
const mockLocalDocuments = (
  jest.requireMock('../src/native/LocalDocuments') as {
    LocalDocuments: Record<string, jest.Mock>;
  }
).LocalDocuments;

const ROOT = workspaceRoot('11111111-1111-4111-8111-111111111111', 1, null);
const PROJECT_ROOT = workspaceRoot(
  ROOT.workspace_id,
  ROOT.binding_revision,
  '22222222-2222-4222-8222-222222222222',
);
const rootFile = {
  path: 'note.md',
  name: 'note.md',
  kind: 'file' as const,
  size: 5,
  modified_at: '2026-08-24T00:00:00.000Z',
  revision: 'a'.repeat(64),
};

function entry(path: string, kind: 'file' | 'directory' = 'file') {
  return {
    path,
    name: path.split('/')[path.split('/').length - 1],
    kind,
    size: kind === 'file' ? 5 : 0,
    modified_at: '2026-08-24T00:00:00.000Z',
    revision: 'b'.repeat(64),
  };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolveValue => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function renderDrawer({
  root = ROOT,
  label = 'workspace',
  confirmDestructive = true,
  readOnly = false,
}: {
  root?: WorkspaceRootRefV1;
  label?: string;
  confirmDestructive?: boolean;
  readOnly?: boolean;
} = {}): Promise<Renderer> {
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <WorkspaceDrawer
          confirmDestructive={confirmDestructive}
          onClose={jest.fn()}
          readOnly={readOnly}
          visible
          workspaceLabel={label}
          workspaceRoot={root}
        />
      </AppPresentationProvider>,
    );
    await settle();
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return renderer;
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

beforeEach(() => {
  jest.clearAllMocks();
  mockLocalWorkspace.isAvailable.mockReturnValue(true);
  mockLocalWorkspace.listV2.mockImplementation(
    async (request: { path: string; root: WorkspaceRootRefV1 }) => ({
      schema_version: 1,
      root: request.root,
      path: request.path,
      entries: request.path === '' ? [] : [],
    }),
  );
  mockLocalWorkspace.listTrashV2.mockImplementation(
    async (request: { root: WorkspaceRootRefV1 }) => ({
      schema_version: 1,
      root: request.root,
      entries: [],
      invalid_record_count: 0,
    }),
  );
  mockLocalWorkspace.readV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: rootFile.path,
    file: rootFile,
    content: 'hello',
  });
  mockLocalWorkspace.writeV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    file: rootFile,
    created: false,
  });
  mockLocalWorkspace.createDirectoryV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    directory: entry('docs', 'directory'),
  });
  mockLocalWorkspace.renameEntryV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    entry: rootFile,
    from: 'note.md',
  });
  mockLocalWorkspace.trashEntryV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    receipt: {
      schema_version: 1,
      trash_id: '33333333-3333-4333-8333-333333333333',
      original_path: 'note.md',
      kind: 'file',
      deleted_at: '2026-08-24T00:00:00.000Z',
    },
  });
  mockLocalWorkspace.restoreFromTrashV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    entry: rootFile,
    trash_id: '33333333-3333-4333-8333-333333333333',
    original_path: 'note.md',
  });
  mockLocalWorkspace.executePortableToolV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    tool: 'sha256sum',
    path: 'note.md',
    exit_code: 0,
    stdout: 'hash',
    stderr: '',
    protocol_version: 1,
    path_kind: 'portable_applet',
  });
  mockLocalDocuments.isAvailable.mockReturnValue(true);
  mockLocalDocuments.presentImportPicker.mockImplementation(
    async (request: { root: WorkspaceRootRefV1; operation_id: string }) => ({
      schema_version: 1,
      status: 'imported',
      root: request.root,
      operation_id: request.operation_id,
      destination_path: '',
      entries: [{ path: 'imported.txt', kind: 'file', size: 7 }],
    }),
  );
  mockLocalDocuments.presentExportPicker.mockImplementation(
    async (request: { root: WorkspaceRootRefV1; operation_id: string }) => ({
      schema_version: 1,
      status: 'exported',
      root: request.root,
      operation_id: request.operation_id,
      item_count: 1,
    }),
  );
});

test('routes list and navigation through one opaque root reference', async () => {
  const docs = entry('docs', 'directory');
  mockLocalWorkspace.listV2.mockImplementation(
    async (request: { path: string; root: WorkspaceRootRefV1 }) => ({
      schema_version: 1,
      root: request.root,
      path: request.path,
      entries:
        request.path === '' ? [docs] : [{ ...rootFile, path: 'docs/note.md' }],
    }),
  );
  const renderer = await renderDrawer({ root: ROOT });

  await act(async () => {
    actionByLabel(renderer.root, 'Open docs').props.onPress();
    await settle();
  });

  expect(
    mockLocalWorkspace.listV2.mock.calls.map(([request]) => request),
  ).toEqual([
    { schema_version: 1, root: ROOT, path: '', max_entries: 1000 },
    { schema_version: 1, root: ROOT, path: 'docs', max_entries: 1000 },
  ]);
  expect(
    renderer.root.findByProps({ children: 'workspace/docs' }),
  ).toBeDefined();
});

test('roots project files at the selected opaque project binding and hides Git metadata', async () => {
  mockLocalWorkspace.listV2.mockResolvedValue({
    schema_version: 1,
    root: PROJECT_ROOT,
    path: '',
    entries: [
      rootFile,
      { ...entry('.git', 'directory'), path: '.git', name: '.git' },
    ],
  });
  const renderer = await renderDrawer({ root: PROJECT_ROOT, label: 'demo' });

  expect(mockLocalWorkspace.listV2).toHaveBeenCalledWith({
    schema_version: 1,
    root: PROJECT_ROOT,
    path: '',
    max_entries: 1000,
  });
  expect(
    renderer.root.findAllByProps({ accessibilityLabel: 'Open .git' }),
  ).toHaveLength(0);
  expect(actionByLabel(renderer.root, 'Open note.md')).toBeDefined();
  await act(async () => {
    actionByLabel(renderer.root, 'Export note.md to Files').props.onPress();
    await settle();
  });
  expect(mockLocalDocuments.presentExportPicker).toHaveBeenCalledWith({
    schema_version: 1,
    root: PROJECT_ROOT,
    operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    source_paths: ['note.md'],
  });
});

test('does not create or rename Git metadata through the file UI', async () => {
  const renderer = await renderDrawer({ root: ROOT, label: 'demo' });
  await act(async () =>
    actionByLabel(renderer.root, 'New folder').props.onPress(),
  );
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: 'Name' })
      .props.onChangeText('.git'),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Create').props.onPress();
    await settle();
  });
  expect(mockLocalWorkspace.createDirectoryV2).not.toHaveBeenCalled();
  expect(
    renderer.root.findByProps({
      children: 'Git metadata is managed by Rish and cannot be edited here.',
    }),
  ).toBeDefined();
});

test('imports into the current directory with the same root reference', async () => {
  mockLocalDocuments.presentImportPicker.mockImplementationOnce(
    async (request: { root: WorkspaceRootRefV1; operation_id: string }) => ({
      schema_version: 1,
      status: 'imported',
      root: request.root,
      operation_id: request.operation_id,
      destination_path: '',
      entries: [{ path: 'imported.txt', kind: 'file', size: 7 }],
    }),
  );
  const renderer = await renderDrawer({ root: PROJECT_ROOT, label: 'demo' });
  await act(async () => {
    actionByLabel(renderer.root, 'Import from Files').props.onPress();
    await settle();
  });
  expect(mockLocalDocuments.presentImportPicker).toHaveBeenCalledWith({
    schema_version: 1,
    root: PROJECT_ROOT,
    operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    destination_path: '',
  });
  expect(
    renderer.root.findByProps({ children: 'Imported 1 item(s) from Files.' }),
  ).toBeDefined();
});

test('exports an opened file and treats picker cancellation as neutral', async () => {
  mockLocalWorkspace.listV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: '',
    entries: [rootFile],
  });
  mockLocalWorkspace.readV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: rootFile.path,
    file: rootFile,
    content: 'hello',
  });
  mockLocalDocuments.presentExportPicker.mockImplementationOnce(
    async (request: { root: WorkspaceRootRefV1; operation_id: string }) => ({
      schema_version: 1,
      status: 'exported',
      root: request.root,
      operation_id: request.operation_id,
      item_count: 1,
    }),
  );
  const renderer = await renderDrawer({ root: ROOT, label: 'demo' });
  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Export to Files').props.onPress();
    await settle();
  });
  expect(mockLocalDocuments.presentExportPicker).toHaveBeenCalledWith({
    schema_version: 1,
    root: ROOT,
    operation_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    source_paths: ['note.md'],
  });
  expect(
    renderer.root.findByProps({ children: 'Exported 1 item(s) to Files.' }),
  ).toBeDefined();

  mockLocalDocuments.presentExportPicker.mockImplementationOnce(
    async (request: { root: WorkspaceRootRefV1; operation_id: string }) => ({
      schema_version: 1,
      status: 'cancelled',
      root: request.root,
      operation_id: request.operation_id,
      item_count: 0,
    }),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Export to Files').props.onPress();
    await settle();
  });
  expect(
    renderer.root.findAllByProps({ children: 'Exported 0 item(s) to Files.' }),
  ).toHaveLength(0);
});

test('does not expose write or trash controls in read-only mode', async () => {
  mockLocalWorkspace.listTrashV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    entries: [
      {
        schema_version: 1,
        trash_id: '33333333-3333-4333-8333-333333333333',
        original_path: 'note.md',
        kind: 'file',
        deleted_at: '2026-08-24T00:00:00.000Z',
      },
    ],
    invalid_record_count: 0,
  });
  const renderer = await renderDrawer({ readOnly: true });
  expect(
    renderer.root.findAllByProps({ accessibilityLabel: 'Restore note.md' }),
  ).toHaveLength(0);
  expect(actionByLabel(renderer.root, 'New file').props.disabled).toBe(true);
  expect(actionByLabel(renderer.root, 'Import from Files').props.disabled).toBe(
    true,
  );
  expect(mockLocalWorkspace.restoreFromTrashV2).not.toHaveBeenCalled();
});

test('sends the read revision back for an optimistic V2 write', async () => {
  mockLocalWorkspace.listV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: '',
    entries: [rootFile],
  });
  mockLocalWorkspace.readV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: rootFile.path,
    file: rootFile,
    content: 'hello',
  });
  mockLocalWorkspace.writeV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    file: { ...rootFile, size: 14, revision: 'c'.repeat(64) },
    created: false,
  });
  const renderer = await renderDrawer();
  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: 'File content' })
      .props.onChangeText('updated content'),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Save changes').props.onPress();
    await settle();
  });
  expect(mockLocalWorkspace.writeV2).toHaveBeenCalledWith({
    schema_version: 1,
    root: ROOT,
    path: 'note.md',
    content: 'updated content',
    expected_revision: rootFile.revision,
    create_only: false,
  });
});

test('asks before closing a dirty editor', async () => {
  mockLocalWorkspace.listV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: '',
    entries: [rootFile],
  });
  mockLocalWorkspace.readV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: rootFile.path,
    file: rootFile,
    content: 'hello',
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const renderer = await renderDrawer();
  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () =>
    renderer.root
      .findByProps({ accessibilityLabel: 'File content' })
      .props.onChangeText('changed'),
  );
  await act(async () => actionByLabel(renderer.root, 'Close').props.onPress());
  expect(alert).toHaveBeenCalledWith(
    'Save changes?',
    'note.md',
    expect.any(Array),
  );
  alert.mockRestore();
});

test('clears create and rename state when the workspace root changes', async () => {
  const nextRoot = workspaceRoot(ROOT.workspace_id, ROOT.binding_revision + 1);
  mockLocalWorkspace.listV2.mockImplementation(
    async (request: { root: WorkspaceRootRefV1; path: string }) => ({
      schema_version: 1,
      root: request.root,
      path: request.path,
      entries: request.path === '' ? [rootFile] : [],
    }),
  );
  const renderer = await renderDrawer();
  await act(async () =>
    actionByLabel(renderer.root, 'New folder').props.onPress(),
  );
  expect(
    renderer.root.findByProps({ accessibilityLabel: 'Name' }),
  ).toBeDefined();
  await act(async () => {
    renderer.update(
      <AppPresentationProvider
        store={createPreferencesStore({
          initialPreferences: {
            ...createDefaultPreferences(),
            locale: 'en-US',
          },
        })}
      >
        <WorkspaceDrawer onClose={jest.fn()} visible workspaceRoot={nextRoot} />
      </AppPresentationProvider>,
    );
    await settle();
  });
  expect(
    renderer.root.findAllByProps({ accessibilityLabel: 'Name' }),
  ).toHaveLength(0);
});

test('does not execute a destructive alert action after a live root change', async () => {
  const nextRoot = workspaceRoot(ROOT.workspace_id, ROOT.binding_revision + 1);
  mockLocalWorkspace.listV2.mockImplementation(
    async (request: { root: WorkspaceRootRefV1; path: string }) => ({
      schema_version: 1,
      root: request.root,
      path: request.path,
      entries: request.path === '' ? [rootFile] : [],
    }),
  );
  let buttons: readonly { text?: string; onPress?: () => void }[] = [];
  const alert = jest
    .spyOn(Alert, 'alert')
    .mockImplementation((_title, _message, suppliedButtons) => {
      buttons = (suppliedButtons ?? []) as readonly {
        text?: string;
        onPress?: () => void;
      }[];
    });
  const renderer = await renderDrawer();
  await act(async () =>
    actionByLabel(renderer.root, 'Delete note.md').props.onPress(),
  );
  await act(async () => {
    renderer.update(
      <AppPresentationProvider
        store={createPreferencesStore({
          initialPreferences: {
            ...createDefaultPreferences(),
            locale: 'en-US',
          },
        })}
      >
        <WorkspaceDrawer onClose={jest.fn()} visible workspaceRoot={nextRoot} />
      </AppPresentationProvider>,
    );
    await settle();
  });
  const destructive = buttons.find(button => button.text === 'Move to Trash');
  await act(async () => {
    destructive?.onPress?.();
    await settle();
  });
  expect(mockLocalWorkspace.trashEntryV2).not.toHaveBeenCalled();
  alert.mockRestore();
});

test('ignores a late result from an earlier workspace reference generation', async () => {
  const nextRoot = workspaceRoot(ROOT.workspace_id, ROOT.binding_revision + 1);
  const oldList = deferred<unknown>();
  const oldTrash = deferred<unknown>();
  let listCall = 0;
  mockLocalWorkspace.listV2.mockImplementation(
    (request: { root: WorkspaceRootRefV1; path: string }) => {
      listCall += 1;
      if (listCall === 1) return oldList.promise;
      return Promise.resolve({
        schema_version: 1,
        root: request.root,
        path: request.path,
        entries: [{ ...rootFile, name: 'new.md', path: 'new.md' }],
      });
    },
  );
  let trashCall = 0;
  mockLocalWorkspace.listTrashV2.mockImplementation(
    (request: { root: WorkspaceRootRefV1 }) => {
      trashCall += 1;
      if (trashCall === 1) return oldTrash.promise;
      return Promise.resolve({
        schema_version: 1,
        root: request.root,
        entries: [],
        invalid_record_count: 0,
      });
    },
  );
  const store = createPreferencesStore({
    initialPreferences: { ...createDefaultPreferences(), locale: 'en-US' },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <WorkspaceDrawer onClose={jest.fn()} visible workspaceRoot={ROOT} />
      </AppPresentationProvider>,
    );
    await settle();
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  await act(async () => {
    renderer!.update(
      <AppPresentationProvider store={store}>
        <WorkspaceDrawer onClose={jest.fn()} visible workspaceRoot={nextRoot} />
      </AppPresentationProvider>,
    );
    await settle();
  });
  await act(async () => {
    oldList.resolve({
      schema_version: 1,
      root: ROOT,
      path: '',
      entries: [{ ...rootFile, name: 'old.md', path: 'old.md' }],
    });
    oldTrash.resolve({
      schema_version: 1,
      root: ROOT,
      entries: [],
      invalid_record_count: 0,
    });
    await settle();
  });
  expect(renderer.root.findAllByProps({ children: 'old.md' })).toHaveLength(0);
  expect(
    renderer.root.findAllByProps({ children: 'new.md' }).length,
  ).toBeGreaterThan(0);
});

async function openExportFixture(confirmDestructive = true) {
  mockLocalWorkspace.listV2.mockResolvedValue({
    schema_version: 1,
    root: ROOT,
    path: '',
    entries: [rootFile],
  });
  const renderer = await renderDrawer({ root: ROOT, confirmDestructive });
  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  return renderer;
}

function contentInput(renderer: Renderer) {
  return renderer.root.findByProps({ accessibilityLabel: 'File content' });
}

test('unsaved edits disable export even when destructive confirmations are off', async () => {
  const renderer = await openExportFixture(false);
  const staleExport = actionByLabel(renderer.root, 'Export to Files').props
    .onPress;
  await act(async () => {
    contentInput(renderer).props.onChangeText('unsaved 中文');
    // The queued old callback must observe the edit before React rerenders.
    staleExport();
    await settle();
  });
  expect(actionByLabel(renderer.root, 'Export to Files').props.disabled).toBe(
    true,
  );
  expect(
    renderer.root.findAllByProps({
      children: 'Save your changes before exporting this file.',
    }).length,
  ).toBeGreaterThan(0);
  expect(mockLocalDocuments.presentExportPicker).not.toHaveBeenCalled();
  expect(mockLocalWorkspace.writeV2).not.toHaveBeenCalled();
});

test('explicit save completes before export reads the saved UTF-8 bytes', async () => {
  const { Buffer: TestBuffer } = jest.requireActual('buffer') as {
    Buffer: { from(value: string, encoding: 'utf8'): Uint8Array };
  };
  let disk = 'hello';
  let exported: Uint8Array | undefined;
  mockLocalWorkspace.writeV2.mockImplementation(async request => {
    expect(request.expected_revision).toBe(rootFile.revision);
    disk = request.content;
    return {
      schema_version: 1,
      root: ROOT,
      file: { ...rootFile, revision: 'c'.repeat(64) },
      created: false,
    };
  });
  mockLocalDocuments.presentExportPicker.mockImplementation(async request => {
    exported = TestBuffer.from(disk, 'utf8');
    return {
      schema_version: 1,
      root: ROOT,
      operation_id: request.operation_id,
      status: 'exported',
      item_count: 1,
    };
  });
  const renderer = await openExportFixture();
  await act(async () =>
    contentInput(renderer).props.onChangeText('saved 中文\n'),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Save changes').props.onPress();
    await settle();
  });
  expect(actionByLabel(renderer.root, 'Export to Files').props.disabled).toBe(
    false,
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Export to Files').props.onPress();
    await settle();
  });
  expect(exported).toEqual(TestBuffer.from('saved 中文\n', 'utf8'));
});

test('save conflict keeps the draft and never opens the export picker', async () => {
  mockLocalWorkspace.writeV2.mockRejectedValueOnce(
    new Error('File revision changed'),
  );
  const renderer = await openExportFixture();
  await act(async () =>
    contentInput(renderer).props.onChangeText('keep my draft'),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Save changes').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Export to Files').props.onPress();
    await settle();
  });
  expect(contentInput(renderer).props.value).toBe('keep my draft');
  expect(actionByLabel(renderer.root, 'Export to Files').props.disabled).toBe(
    true,
  );
  expect(mockLocalDocuments.presentExportPicker).not.toHaveBeenCalled();
  expect(
    renderer.root.findAllByProps({ children: 'Exported 1 item(s) to Files.' }),
  ).toHaveLength(0);
});

test('a queued edit during save stays dirty and cannot be exported', async () => {
  const held = deferred<unknown>();
  mockLocalWorkspace.writeV2.mockReturnValueOnce(held.promise);
  const renderer = await openExportFixture();
  await act(async () =>
    contentInput(renderer).props.onChangeText('saving version'),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Save changes').props.onPress();
    await settle();
  });
  expect(contentInput(renderer).props.editable).toBe(false);
  await act(async () => {
    contentInput(renderer).props.onChangeText('newer queued edit');
    held.resolve({
      schema_version: 1,
      root: ROOT,
      file: { ...rootFile, revision: 'c'.repeat(64) },
      created: false,
    });
    await settle();
  });
  expect(contentInput(renderer).props.value).toBe('newer queued edit');
  expect(actionByLabel(renderer.root, 'Export to Files').props.disabled).toBe(
    true,
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Export to Files').props.onPress();
    await settle();
  });
  expect(mockLocalDocuments.presentExportPicker).not.toHaveBeenCalled();
});

test('an export callback from a closed editor cannot export a reopened file', async () => {
  const renderer = await openExportFixture();
  const staleExport = actionByLabel(renderer.root, 'Export to Files').props
    .onPress;
  await act(async () => actionByLabel(renderer.root, 'Close').props.onPress());
  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () => {
    staleExport();
    await settle();
  });
  expect(mockLocalDocuments.presentExportPicker).not.toHaveBeenCalled();
});

test('duplicate export clicks produce one picker and late success cannot update a reopened editor', async () => {
  const held = deferred<unknown>();
  mockLocalDocuments.presentExportPicker.mockReturnValueOnce(held.promise);
  const renderer = await openExportFixture();
  const exportAction = actionByLabel(renderer.root, 'Export to Files').props
    .onPress;
  await act(async () => {
    exportAction();
    exportAction();
    await settle();
  });
  expect(mockLocalDocuments.presentExportPicker).toHaveBeenCalledTimes(1);
  const request = mockLocalDocuments.presentExportPicker.mock.calls[0]?.[0];
  await act(async () => actionByLabel(renderer.root, 'Close').props.onPress());
  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () => {
    held.resolve({
      schema_version: 1,
      root: ROOT,
      operation_id: request.operation_id,
      status: 'exported',
      item_count: 1,
    });
    await settle();
  });
  expect(
    renderer.root.findAllByProps({ children: 'Exported 1 item(s) to Files.' }),
  ).toHaveLength(0);
  expect(contentInput(renderer).props.value).toBe('hello');
});
