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

const rootFile = {
  path: 'note.md',
  name: 'note.md',
  kind: 'file' as const,
  size: 5,
  modified_at: '2026-08-24T00:00:00.000Z',
  revision: 'rev-1',
};

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function renderDrawer({
  confirmDestructive = true,
  projectScope,
  readOnly = false,
}: {
  confirmDestructive?: boolean;
  projectScope?: { rootPath: string; label: string };
  readOnly?: boolean;
} = {}): Promise<Renderer> {
  const store = createPreferencesStore({
    initialPreferences: {
      ...createDefaultPreferences(),
      locale: 'en-US',
    },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <WorkspaceDrawer
          confirmDestructive={confirmDestructive}
          onClose={jest.fn()}
          projectScope={projectScope}
          readOnly={readOnly}
          visible
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
  mockLocalWorkspace.listDirectory.mockResolvedValue({ path: '', entries: [] });
  mockLocalWorkspace.listTrash.mockResolvedValue({
    entries: [],
    invalid_record_count: 0,
  });
  mockLocalDocuments.isAvailable.mockReturnValue(true);
  mockLocalDocuments.presentImportPicker.mockResolvedValue({
    schema_version: 1,
    status: 'imported',
    destination_root: '',
    entries: [{ path: 'imported.txt', kind: 'file', size: 7 }],
  });
  mockLocalDocuments.presentExportPicker.mockResolvedValue({
    schema_version: 1,
    status: 'exported',
    item_count: 1,
  });
});

test('stays in a selected subdirectory instead of reinitializing the root', async () => {
  const docs = {
    path: 'docs',
    name: 'docs',
    kind: 'directory' as const,
    size: 0,
    modified_at: '2026-08-24T00:00:00.000Z',
  };
  mockLocalWorkspace.listDirectory.mockImplementation(async (path: string) =>
    path === ''
      ? { path: '', entries: [docs] }
      : { path: 'docs', entries: [{ ...rootFile, path: 'docs/note.md' }] },
  );
  const renderer = await renderDrawer();

  await act(async () => {
    actionByLabel(renderer.root, 'Open docs').props.onPress();
    await settle();
  });

  expect(
    renderer.root.findByProps({ children: 'workspace/docs' }),
  ).toBeDefined();
  expect(
    mockLocalWorkspace.listDirectory.mock.calls.map(([path]) => path),
  ).toEqual(['', 'docs']);
});

test('roots project files at the selected worktree and hides Git metadata', async () => {
  const rootPath = 'projects/project-1/repo';
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: rootPath,
    entries: [
      { ...rootFile, path: `${rootPath}/note.md` },
      {
        path: `${rootPath}/.git`,
        name: '.git',
        kind: 'directory',
        size: 0,
        modified_at: '2026-08-24T00:00:00.000Z',
      },
    ],
  });
  const renderer = await renderDrawer({
    projectScope: { rootPath, label: 'demo' },
  });

  expect(mockLocalWorkspace.listDirectory).toHaveBeenCalledWith(rootPath);
  expect(
    renderer.root.findAllByProps({ children: 'demo' }).length,
  ).toBeGreaterThan(0);
  expect(
    renderer.root.findAllByProps({ accessibilityLabel: 'Open .git' }),
  ).toHaveLength(0);
  expect(actionByLabel(renderer.root, 'Open note.md')).toBeDefined();
  await act(async () => {
    actionByLabel(renderer.root, 'Export note.md to Files').props.onPress();
    await settle();
  });
  expect(mockLocalDocuments.presentExportPicker).toHaveBeenCalledWith([
    `${rootPath}/note.md`,
  ]);
});

test('does not create or rename project Git metadata through the file UI', async () => {
  const rootPath = 'projects/project-1/repo';
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: rootPath,
    entries: [{ ...rootFile, path: `${rootPath}/note.md` }],
  });
  const renderer = await renderDrawer({
    projectScope: { rootPath, label: 'demo' },
  });

  await act(async () =>
    actionByLabel(renderer.root, 'New folder').props.onPress(),
  );
  await act(async () => {
    renderer.root
      .findByProps({ accessibilityLabel: 'Name' })
      .props.onChangeText('.git');
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Create').props.onPress();
    await settle();
  });
  expect(mockLocalWorkspace.createDirectory).not.toHaveBeenCalled();
  expect(
    renderer.root.findByProps({
      children: 'Git metadata is managed by Rish and cannot be edited here.',
    }),
  ).toBeDefined();

  await act(async () =>
    actionByLabel(renderer.root, 'Rename note.md').props.onPress(),
  );
  await act(async () =>
    renderer.root
      .findAllByProps({ accessibilityLabel: 'Rename' })
      .find(instance => typeof instance.props.onChangeText === 'function')
      ?.props.onChangeText('.git'),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Rename').props.onPress();
    await settle();
  });
  expect(mockLocalWorkspace.renameEntry).not.toHaveBeenCalled();
});

test('imports multiple Files items into the current project directory', async () => {
  const rootPath = 'projects/project-1/repo';
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: rootPath,
    entries: [],
  });
  mockLocalDocuments.presentImportPicker.mockResolvedValue({
    schema_version: 1,
    status: 'imported',
    destination_root: rootPath,
    entries: [
      { path: `${rootPath}/README.md`, kind: 'file', size: 12 },
      { path: `${rootPath}/src`, kind: 'directory', size: 0 },
    ],
  });
  const renderer = await renderDrawer({
    projectScope: { rootPath, label: 'demo' },
  });

  await act(async () => {
    actionByLabel(renderer.root, 'Import from Files').props.onPress();
    await settle();
  });

  expect(mockLocalDocuments.presentImportPicker).toHaveBeenCalledWith(rootPath);
  expect(mockLocalWorkspace.listDirectory).toHaveBeenCalledTimes(2);
  expect(
    renderer.root.findByProps({
      children: 'Imported 2 item(s) from Files.',
    }),
  ).toBeDefined();
});

test('exports the opened project file and treats picker cancellation as neutral', async () => {
  const rootPath = 'projects/project-1/repo';
  const projectFile = { ...rootFile, path: `${rootPath}/note.md` };
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: rootPath,
    entries: [projectFile],
  });
  mockLocalWorkspace.readText.mockResolvedValue({
    file: projectFile,
    content: 'hello',
  });
  const renderer = await renderDrawer({
    projectScope: { rootPath, label: 'demo' },
  });

  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Export to Files').props.onPress();
    await settle();
  });
  expect(mockLocalDocuments.presentExportPicker).toHaveBeenCalledWith([
    projectFile.path,
  ]);
  expect(
    renderer.root.findByProps({ children: 'Exported 1 item(s) to Files.' }),
  ).toBeDefined();

  mockLocalDocuments.presentExportPicker.mockResolvedValueOnce({
    schema_version: 1,
    status: 'cancelled',
    item_count: 0,
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Export to Files').props.onPress();
    await settle();
  });
  expect(
    renderer.root.findAllByProps({ children: 'Exported 0 item(s) to Files.' }),
  ).toHaveLength(0);
});

test('does not expose trash restoration while the workspace is read only', async () => {
  mockLocalWorkspace.listTrash.mockResolvedValue({
    entries: [
      {
        schema_version: 1,
        trash_id: 'trash-1',
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
  expect(mockLocalWorkspace.restoreFromTrash).not.toHaveBeenCalled();
});

test('keeps create and rename editors mutually exclusive', async () => {
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: '',
    entries: [rootFile],
  });
  const renderer = await renderDrawer();

  await act(async () => {
    actionByLabel(renderer.root, 'New file').props.onPress();
  });
  expect(actionByLabel(renderer.root, 'Create')).toBeDefined();

  await act(async () => {
    actionByLabel(renderer.root, 'Rename note.md').props.onPress();
  });
  expect(
    renderer.root.findAllByProps({ accessibilityLabel: 'Create' }),
  ).toHaveLength(0);
  expect(actionByLabel(renderer.root, 'Rename')).toBeDefined();

  await act(async () => {
    actionByLabel(renderer.root, 'New folder').props.onPress();
  });
  expect(
    renderer.root
      .findAllByProps({ accessibilityLabel: 'Rename' })
      .filter(instance => typeof instance.props.onPress === 'function'),
  ).toHaveLength(0);
  expect(actionByLabel(renderer.root, 'Create')).toBeDefined();
});

test('asks before closing a dirty editor when confirmation is enabled', async () => {
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: '',
    entries: [rootFile],
  });
  mockLocalWorkspace.readText.mockResolvedValue({
    file: rootFile,
    content: 'hello',
  });
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const renderer = await renderDrawer();

  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () => {
    renderer.root
      .findByProps({ accessibilityLabel: 'File content' })
      .props.onChangeText('changed');
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Close').props.onPress();
  });

  expect(alert).toHaveBeenCalledWith(
    'Save changes?',
    'note.md',
    expect.any(Array),
  );
  expect(
    renderer.root.findByProps({ accessibilityLabel: 'File content' }),
  ).toBeDefined();
  alert.mockRestore();
});

test('updates cached file metadata after a revision-protected save', async () => {
  mockLocalWorkspace.listDirectory.mockResolvedValue({
    path: '',
    entries: [rootFile],
  });
  mockLocalWorkspace.readText.mockResolvedValue({
    file: rootFile,
    content: 'hello',
  });
  mockLocalWorkspace.writeText.mockResolvedValue({
    created: false,
    file: { ...rootFile, size: 2048, revision: 'rev-2' },
  });
  const renderer = await renderDrawer();

  await act(async () => {
    actionByLabel(renderer.root, 'Open note.md').props.onPress();
    await settle();
  });
  await act(async () => {
    renderer.root
      .findByProps({ accessibilityLabel: 'File content' })
      .props.onChangeText('updated content');
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Save changes').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Close').props.onPress();
  });

  expect(renderer.root.findByProps({ children: '2.0 KB' })).toBeDefined();
  expect(mockLocalWorkspace.listDirectory).toHaveBeenCalledTimes(1);
});
