import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { ProjectsSurface } from '../src/components/ProjectsSurface';
import { SlidingSurface } from '../src/components/SlidingSurface';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
  translate,
} from '../src/preferences';

jest.mock('../src/native/LocalProjects', () => ({
  LocalProjects: {
    isAvailable: jest.fn(),
    list: jest.fn(),
    create: jest.fn(),
    clone: jest.fn(),
    startClone: jest.fn(),
    cloneStatus: jest.fn(),
    cancelClone: jest.fn(),
    status: jest.fn(),
    diff: jest.fn(),
    stageAll: jest.fn(),
    commit: jest.fn(),
    setRemote: jest.fn(),
    credentialStatus: jest.fn(),
    presentCredentialPrompt: jest.fn(),
    clearCredential: jest.fn(),
    push: jest.fn(),
    pushReceipts: jest.fn(),
    cancelPush: jest.fn(),
  },
}));

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const mockLocalProjects = (
  jest.requireMock('../src/native/LocalProjects') as {
    LocalProjects: Record<string, jest.Mock>;
  }
).LocalProjects;

const project = {
  schema_version: 1 as const,
  id: 'project-1',
  name: 'demo',
  workspace_path: 'projects/project-1/repo',
  created_at: '2026-08-24T00:00:00.000Z',
  updated_at: '2026-08-24T00:00:00.000Z',
  origin_url: 'https://github.com/example/demo.git',
};

function cloneSnapshot(phase: string, cancelRequested = false) {
  return {
    schema_version: 1,
    operation_id: 'clone-1',
    name: 'copy',
    phase,
    cancel_requested: cancelRequested,
    received_objects: 2,
    total_objects: 8,
    received_bytes: 4096,
    completed_files: 0,
    total_files: 0,
    project: phase === 'succeeded' ? project : null,
    error_code: phase === 'failed' ? 'git' : null,
  };
}

const dirtyStatus = {
  project_id: project.id,
  branch: 'main',
  head_oid: '0123456789abcdef',
  clean: false,
  has_conflicts: false,
  ahead: 1,
  behind: 0,
  entries: [
    {
      path: 'README.md',
      index_status: 'added',
      worktree_status: 'unmodified',
      conflicted: false,
    },
    {
      path: 'src/app.ts',
      index_status: 'unmodified',
      worktree_status: 'added',
      conflicted: false,
    },
  ],
};

const diff = {
  project_id: project.id,
  staged: false,
  truncated: false,
  patch: 'diff --git a/README.md b/README.md\n+hello\n',
  files: [
    { path: 'README.md', status: 'modified', additions: 1, deletions: 0 },
  ],
};

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const mountedRenderers = new Set<Renderer>();

afterEach(async () => {
  await act(async () => {
    for (const renderer of mountedRenderers) renderer.unmount();
  });
  mountedRenderers.clear();
  jest.useRealTimers();
});

async function renderSurface({
  boundProjectId = null,
  gitHttpsProxyUrl = null,
  onChatInProject = jest.fn(),
  onDismiss = jest.fn(),
  onOpenFiles = jest.fn(),
  onUnbindFromChat = jest.fn(),
}: {
  boundProjectId?: string | null;
  gitHttpsProxyUrl?: string | null;
  onChatInProject?: jest.Mock;
  onDismiss?: jest.Mock;
  onOpenFiles?: jest.Mock;
  onUnbindFromChat?: jest.Mock;
} = {}): Promise<Renderer> {
  const store = createPreferencesStore({
    initialPreferences: {
      ...createDefaultPreferences(),
      gitHttpsProxyUrl,
      locale: 'en-US',
    },
  });
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <ProjectsSurface
          boundProjectId={boundProjectId}
          visible
          onChatInProject={onChatInProject}
          onClose={jest.fn()}
          onDismiss={onDismiss}
          onOpenFiles={onOpenFiles}
          onUnbindFromChat={onUnbindFromChat}
        />
      </AppPresentationProvider>,
    );
    await settle();
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  mountedRenderers.add(renderer);
  return renderer;
}

test('forwards dismissal only after the Projects sliding surface finishes', async () => {
  const onDismiss = jest.fn();
  const renderer = await renderSurface({ onDismiss });
  const surface = renderer.root.findByType(SlidingSurface);

  expect(surface.props.onDismiss).toBe(onDismiss);
  await act(async () => surface.props.onDismiss());
  expect(onDismiss).toHaveBeenCalledTimes(1);
});

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

function inputByLabel(
  root: ReactTestInstance,
  label: string,
): ReactTestInstance {
  const input = root
    .findAllByProps({ accessibilityLabel: label })
    .find(instance => typeof instance.props.onChangeText === 'function');
  if (input === undefined) throw new Error(`no input ${label}`);
  return input;
}

async function openProject(renderer: Renderer) {
  await act(async () => {
    actionByLabel(renderer.root, 'Open project demo').props.onPress();
    await settle();
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLocalProjects.isAvailable.mockReturnValue(true);
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [project],
  });
  mockLocalProjects.create.mockResolvedValue({
    ...project,
    id: 'project-created',
    name: 'created',
    origin_url: null,
  });
  mockLocalProjects.clone.mockResolvedValue(project);
  mockLocalProjects.cloneStatus.mockResolvedValue(null);
  mockLocalProjects.startClone.mockResolvedValue(cloneSnapshot('succeeded'));
  mockLocalProjects.cancelClone.mockResolvedValue(
    cloneSnapshot('receiving', true),
  );
  mockLocalProjects.status.mockResolvedValue(dirtyStatus);
  mockLocalProjects.diff.mockResolvedValue(diff);
  mockLocalProjects.stageAll.mockResolvedValue(dirtyStatus);
  mockLocalProjects.commit.mockResolvedValue({
    project_id: project.id,
    oid: 'abcdef',
    summary: 'Update README',
    committed_at: '2026-08-24T00:00:00.000Z',
  });
  mockLocalProjects.setRemote.mockResolvedValue({
    project_id: project.id,
    name: 'origin',
    url: project.origin_url,
  });
  mockLocalProjects.credentialStatus.mockResolvedValue({
    project_id: project.id,
    host: 'github.com',
    configured: false,
  });
  mockLocalProjects.presentCredentialPrompt.mockResolvedValue({
    project_id: project.id,
    host: 'github.com',
    configured: true,
  });
  mockLocalProjects.clearCredential.mockResolvedValue({
    project_id: project.id,
    host: 'github.com',
    configured: false,
  });
  mockLocalProjects.push.mockResolvedValue({
    project_id: project.id,
    remote: 'origin',
    branch: 'main',
    oid: dirtyStatus.head_oid,
    pushed_at: '2026-08-24T00:00:00.000Z',
  });
  mockLocalProjects.pushReceipts.mockResolvedValue({
    schema_version: 1,
    project_id: project.id,
    receipts: [],
  });
  mockLocalProjects.cancelPush.mockResolvedValue({
    schema_version: 1,
    project_id: project.id,
    cancelled: true,
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const otherProject = {
  ...project,
  id: 'project-2',
  name: 'other',
  origin_url: 'https://example.org/other.git',
};

async function navigateToOther(renderer: Renderer) {
  await act(async () => {
    actionByLabel(renderer.root, 'Back to projects').props.onPress();
    await settle();
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Open project other').props.onPress();
    await settle();
  });
}

async function setVisible(renderer: Renderer, visible: boolean) {
  const presentation = renderer.root.findByType(AppPresentationProvider)
    .props as React.ComponentProps<typeof AppPresentationProvider>;
  const props = renderer.root.findByType(ProjectsSurface)
    .props as React.ComponentProps<typeof ProjectsSurface>;
  await act(async () => {
    renderer.update(
      <AppPresentationProvider {...presentation}>
        <ProjectsSurface {...props} visible={visible} />
      </AppPresentationProvider>,
    );
    await settle();
  });
}

test('late project A detail cannot overwrite project B data or remote credentials', async () => {
  const held = deferred<typeof dirtyStatus>();
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [project, otherProject],
  });
  mockLocalProjects.status.mockImplementation((id: string) =>
    id === project.id
      ? held.promise
      : Promise.resolve({
          ...dirtyStatus,
          project_id: id,
          branch: 'other-branch',
        }),
  );
  mockLocalProjects.credentialStatus.mockImplementation(async (id: string) => ({
    project_id: id,
    host: id,
    configured: id === project.id,
  }));
  mockLocalProjects.diff.mockImplementation(async (id: string) => ({
    ...diff,
    project_id: id,
    patch: id === project.id ? 'OLD-A-PATCH' : 'CURRENT-B-PATCH',
  }));
  const renderer = await renderSurface();
  await openProject(renderer);
  await navigateToOther(renderer);
  await act(async () => {
    held.resolve(dirtyStatus);
    await settle();
  });
  expect(inputByLabel(renderer.root, 'Origin HTTPS URL').props.value).toBe(
    otherProject.origin_url,
  );
  expect(
    renderer.root.findAllByProps({ children: 'other-branch' }).length,
  ).toBeGreaterThan(0);
  expect(
    renderer.root.findAllByProps({
      accessibilityLabel: 'Clear remote credential',
    }),
  ).toHaveLength(0);
  await act(async () =>
    actionByLabel(renderer.root, 'Changes').props.onPress(),
  );
  expect(
    renderer.root.findAllByProps({ children: 'OLD-A-PATCH' }),
  ).toHaveLength(0);
  expect(
    renderer.root.findAllByProps({ children: 'CURRENT-B-PATCH' }).length,
  ).toBeGreaterThan(0);
});

test.each(['success', 'failure'] as const)(
  'late A %s cannot unlock or report an error in still-loading B',
  async outcome => {
    const a = deferred<typeof dirtyStatus>();
    const b = deferred<typeof dirtyStatus>();
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [project, otherProject],
    });
    mockLocalProjects.status.mockImplementation((id: string) =>
      id === project.id ? a.promise : b.promise,
    );
    const renderer = await renderSurface();
    await openProject(renderer);
    await navigateToOther(renderer);
    await act(async () => {
      if (outcome === 'success') a.resolve(dirtyStatus);
      else a.reject(new Error('STALE-A-ERROR'));
      await settle();
    });
    expect(
      actionByLabel(renderer.root, 'Refresh project status').props.disabled,
    ).toBe(true);
    expect(JSON.stringify(renderer.toJSON())).not.toContain('STALE-A-ERROR');
    await act(async () => {
      b.resolve({ ...dirtyStatus, project_id: otherProject.id });
      await settle();
    });
    expect(
      actionByLabel(renderer.root, 'Refresh project status').props.disabled,
    ).toBe(false);
  },
);

test('close and reopen invalidates the old detail even for the same project', async () => {
  const held = deferred<typeof dirtyStatus>();
  mockLocalProjects.status
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValue({ ...dirtyStatus, branch: 'reopened-branch' });
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () =>
    renderer.root.findByType(SlidingSurface).props.onClose(),
  );
  await setVisible(renderer, false);
  await setVisible(renderer, true);
  await act(async () => {
    held.resolve({ ...dirtyStatus, branch: 'STALE-CLOSED-BRANCH' });
    await settle();
  });
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    'STALE-CLOSED-BRANCH',
  );
  expect(
    renderer.root.findAllByProps({ children: 'reopened-branch' }).length,
  ).toBeGreaterThan(0);
});

test('a completed stage operation on A cannot refresh or overwrite B', async () => {
  const held = deferred<typeof dirtyStatus>();
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [project, otherProject],
  });
  mockLocalProjects.stageAll.mockImplementationOnce(() => held.promise);
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () =>
    actionByLabel(renderer.root, 'Changes').props.onPress(),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Stage all changes').props.onPress();
    await settle();
  });
  await navigateToOther(renderer);
  const before = mockLocalProjects.diff.mock.calls.length;
  await act(async () => {
    held.resolve(dirtyStatus);
    await settle();
  });
  expect(mockLocalProjects.diff.mock.calls).toHaveLength(before);
  expect(inputByLabel(renderer.root, 'Origin HTTPS URL').props.value).toBe(
    otherProject.origin_url,
  );
  expect(JSON.stringify(renderer.toJSON())).not.toContain(
    'All current changes were staged.',
  );
});

test('a push confirmation from an old view cannot dispatch after navigating to another project', async () => {
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [project, otherProject],
  });
  const alert = jest.spyOn(Alert, 'alert');
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () => {
    actionByLabel(renderer.root, 'Push').props.onPress();
  });
  const confirm = alert.mock.calls.at(-1)?.[2]?.[1]?.onPress;
  expect(confirm).toBeDefined();
  await navigateToOther(renderer);
  await act(async () => {
    confirm?.();
    await settle();
  });
  expect(mockLocalProjects.push).not.toHaveBeenCalled();
  alert.mockRestore();
});

test('a late commit cannot clear the current project draft or start an old-project refresh', async () => {
  const held = deferred<unknown>();
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [project, otherProject],
  });
  mockLocalProjects.commit.mockImplementationOnce(() => held.promise);
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () => {
    inputByLabel(renderer.root, 'Commit message').props.onChangeText(
      'commit A',
    );
    inputByLabel(renderer.root, 'Author name').props.onChangeText(
      'Test author',
    );
    inputByLabel(renderer.root, 'Author email').props.onChangeText(
      'test@example.invalid',
    );
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Commit staged changes').props.onPress();
    await settle();
  });
  await navigateToOther(renderer);
  await act(async () => {
    inputByLabel(renderer.root, 'Commit message').props.onChangeText(
      'keep B draft',
    );
  });
  const before = mockLocalProjects.status.mock.calls.length;
  await act(async () => {
    held.resolve({ project_id: project.id });
    await settle();
  });
  expect(mockLocalProjects.status.mock.calls).toHaveLength(before);
  expect(inputByLabel(renderer.root, 'Commit message').props.value).toBe(
    'keep B draft',
  );
});

test.each(['credential', 'remote'] as const)(
  'late %s mutation cannot change B or its credential state',
  async kind => {
    const held = deferred<unknown>();
    mockLocalProjects.list.mockResolvedValue({
      schema_version: 1,
      projects: [project, otherProject],
    });
    if (kind === 'credential')
      mockLocalProjects.presentCredentialPrompt.mockImplementationOnce(
        () => held.promise,
      );
    else mockLocalProjects.setRemote.mockImplementationOnce(() => held.promise);
    const renderer = await renderSurface();
    await openProject(renderer);
    await act(async () => {
      actionByLabel(
        renderer.root,
        kind === 'credential' ? 'Configure remote credential' : 'Save origin',
      ).props.onPress();
      await settle();
    });
    await navigateToOther(renderer);
    const before = mockLocalProjects.credentialStatus.mock.calls.length;
    await act(async () => {
      held.resolve({
        project_id: project.id,
        configured: true,
        host: 'old.example',
        url: 'https://old.example/repo.git',
      });
      await settle();
    });
    expect(mockLocalProjects.credentialStatus.mock.calls).toHaveLength(before);
    expect(inputByLabel(renderer.root, 'Origin HTTPS URL').props.value).toBe(
      otherProject.origin_url,
    );
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: 'Clear remote credential',
      }),
    ).toHaveLength(0);
  },
);

test('reopening the same project refreshes detail without discarding an unsaved remote draft', async () => {
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () => {
    inputByLabel(renderer.root, 'Origin HTTPS URL').props.onChangeText(
      'https://example.invalid/unsaved.git',
    );
  });
  await setVisible(renderer, false);
  await setVisible(renderer, true);
  expect(inputByLabel(renderer.root, 'Origin HTTPS URL').props.value).toBe(
    'https://example.invalid/unsaved.git',
  );
});

test('returning to a still-mutating project keeps its lock and refreshes after native completion', async () => {
  const held = deferred<typeof dirtyStatus>();
  mockLocalProjects.list.mockResolvedValue({
    schema_version: 1,
    projects: [project, otherProject],
  });
  mockLocalProjects.stageAll.mockImplementationOnce(() => held.promise);
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () => {
    actionByLabel(renderer.root, 'Changes').props.onPress();
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Stage all changes').props.onPress();
    await settle();
  });
  await navigateToOther(renderer);
  await act(async () => {
    actionByLabel(renderer.root, 'Back to projects').props.onPress();
    await settle();
  });
  await openProject(renderer);
  expect(
    actionByLabel(renderer.root, 'Refresh project status').props.disabled,
  ).toBe(true);
  mockLocalProjects.status.mockResolvedValue({
    ...dirtyStatus,
    branch: 'settled-A',
  });
  await act(async () => {
    held.resolve(dirtyStatus);
    await settle();
  });
  expect(
    actionByLabel(renderer.root, 'Refresh project status').props.disabled,
  ).toBe(false);
  expect(
    renderer.root.findAllByProps({ children: 'settled-A' }).length,
  ).toBeGreaterThan(0);
});

test('creates an isolated local project and opens its real detail response', async () => {
  const renderer = await renderSurface();

  await act(async () =>
    actionByLabel(renderer.root, 'New project').props.onPress(),
  );
  await act(async () =>
    inputByLabel(renderer.root, 'Project name').props.onChangeText('created'),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Create project').props.onPress();
    await settle();
  });

  expect(mockLocalProjects.create).toHaveBeenCalledWith('created');
  expect(mockLocalProjects.status).toHaveBeenCalledWith('project-created');
  expect(mockLocalProjects.credentialStatus).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ children: 'created' })).toBeDefined();
});

test('clones only through the native API and surfaces a native failure', async () => {
  const gitHttpsProxyUrl = 'http://127.0.0.1:7890/';
  mockLocalProjects.startClone.mockRejectedValueOnce(new Error('TLS failed'));
  const renderer = await renderSurface({ gitHttpsProxyUrl });

  await act(async () =>
    actionByLabel(renderer.root, 'Clone repository').props.onPress(),
  );
  await act(async () => {
    inputByLabel(renderer.root, 'Project name').props.onChangeText('copy');
    inputByLabel(renderer.root, 'Remote HTTPS URL').props.onChangeText(
      'https://github.com/example/demo.git',
    );
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Clone').props.onPress();
    await settle();
  });

  expect(mockLocalProjects.startClone).toHaveBeenCalledWith(
    'https://github.com/example/demo.git',
    'copy',
    { httpsProxyUrl: gitHttpsProxyUrl },
  );
  expect(
    renderer.root.findByProps({
      children: 'Git operation failed: TLS failed',
    }),
  ).toBeDefined();
  expect(
    renderer.root.findAllByProps({ children: 'Repository cloned locally.' }),
  ).toHaveLength(0);
});

test('passes an explicit null proxy when no HTTPS proxy is configured', async () => {
  const renderer = await renderSurface();

  await act(async () =>
    actionByLabel(renderer.root, 'Clone repository').props.onPress(),
  );
  await act(async () =>
    inputByLabel(renderer.root, 'Remote HTTPS URL').props.onChangeText(
      'https://github.com/example/demo.git',
    ),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Clone').props.onPress();
    await settle();
  });

  expect(mockLocalProjects.startClone).toHaveBeenCalledWith(
    'https://github.com/example/demo.git',
    undefined,
    { httpsProxyUrl: null },
  );
});

test('opens only the selected project worktree in Files', async () => {
  const onOpenFiles = jest.fn();
  const renderer = await renderSurface({ onOpenFiles });
  await openProject(renderer);

  await act(async () =>
    actionByLabel(renderer.root, 'Open project files').props.onPress(),
  );

  expect(onOpenFiles).toHaveBeenCalledWith(project);
  expect(
    renderer.root.findByProps({ children: project.workspace_path }),
  ).toBeDefined();
});

test('binds and unbinds the selected project through explicit chat actions', async () => {
  const onChatInProject = jest.fn();
  const first = await renderSurface({ onChatInProject });
  await openProject(first);
  await act(async () =>
    actionByLabel(first.root, 'Chat in this project').props.onPress(),
  );
  expect(onChatInProject).toHaveBeenCalledWith(project);

  const onUnbindFromChat = jest.fn();
  const second = await renderSurface({
    boundProjectId: project.id,
    onUnbindFromChat,
  });
  await openProject(second);
  await act(async () =>
    actionByLabel(second.root, 'Remove from this chat').props.onPress(),
  );
  expect(onUnbindFromChat).toHaveBeenCalledTimes(1);
});

test('shows a real diff, stages all, and commits with explicit author fields', async () => {
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () =>
    actionByLabel(renderer.root, 'Changes').props.onPress(),
  );

  expect(renderer.root.findByProps({ children: diff.patch })).toBeDefined();
  expect(
    renderer.root.findByProps({ children: 'Staged: Added' }),
  ).toBeDefined();
  expect(
    renderer.root.findByProps({ children: 'Working tree: Added' }),
  ).toBeDefined();
  await act(async () => {
    actionByLabel(renderer.root, 'Stage all changes').props.onPress();
    await settle();
  });
  expect(mockLocalProjects.stageAll).toHaveBeenCalledWith(project.id);
  expect(mockLocalProjects.diff).toHaveBeenLastCalledWith(project.id, {
    staged: true,
  });

  await act(async () => {
    inputByLabel(renderer.root, 'Commit message').props.onChangeText(
      'Update README',
    );
    inputByLabel(renderer.root, 'Author name').props.onChangeText('Fini');
    inputByLabel(renderer.root, 'Author email').props.onChangeText(
      'fini@example.com',
    );
  });
  await act(async () => {
    actionByLabel(renderer.root, 'Commit staged changes').props.onPress();
    await settle();
  });

  expect(mockLocalProjects.commit).toHaveBeenCalledWith(project.id, {
    message: 'Update README',
    authorName: 'Fini',
    authorEmail: 'fini@example.com',
  });
});

test('localizes readable index and working-tree status labels', () => {
  expect(
    translate('zh-CN', 'projects.change.staged', {
      status: translate('zh-CN', 'projects.fileStatus.added'),
    }),
  ).toBe('已暂存：新增');
  expect(
    translate('zh-CN', 'projects.change.worktree', {
      status: translate('zh-CN', 'projects.fileStatus.modified'),
    }),
  ).toBe('工作区：已修改');
});

test('stores credentials natively and never pushes before confirmation', async () => {
  const gitHttpsProxyUrl = 'http://127.0.0.1:7890/';
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const renderer = await renderSurface({ gitHttpsProxyUrl });
  await openProject(renderer);

  await act(async () => {
    actionByLabel(renderer.root, 'Configure remote credential').props.onPress();
    await settle();
  });
  expect(mockLocalProjects.presentCredentialPrompt).toHaveBeenCalledWith(
    project.id,
    'en',
  );
  expect(
    renderer.root.findByProps({ children: 'Credential stored in Keychain' }),
  ).toBeDefined();
  await act(async () => {
    actionByLabel(renderer.root, 'Clear remote credential').props.onPress();
    await settle();
  });
  expect(mockLocalProjects.clearCredential).toHaveBeenCalledWith(project.id);

  await act(async () => actionByLabel(renderer.root, 'Push').props.onPress());
  expect(mockLocalProjects.push).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith(
    'Push this branch?',
    expect.stringContaining('main'),
    expect.any(Array),
  );

  const buttons = alert.mock.calls[0]?.[2];
  const confirm = Array.isArray(buttons)
    ? buttons.find(button => button.text === 'Push now')
    : undefined;
  await act(async () => {
    confirm?.onPress?.();
    await settle();
  });
  expect(mockLocalProjects.push).toHaveBeenCalledWith(project.id, {
    httpsProxyUrl: gitHttpsProxyUrl,
  });
});

test('shows the non-fast-forward message and pushes a named new branch', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const renderer = await renderSurface();
  await openProject(renderer);
  await act(async () => {
    inputByLabel(
      renderer.root,
      'Push as new branch (optional)',
    ).props.onChangeText('feature/g2');
    await settle();
  });
  mockLocalProjects.push.mockRejectedValueOnce(
    Object.assign(new Error('non-fast-forward'), { code: 'non-fast-forward' }),
  );
  await act(async () => actionByLabel(renderer.root, 'Push').props.onPress());
  expect(alert).toHaveBeenCalledWith(
    'Push this branch?',
    expect.stringContaining('new branch feature/g2 on github.com'),
    expect.any(Array),
  );
  const buttons = alert.mock.calls[0]?.[2];
  const confirm = Array.isArray(buttons)
    ? buttons.find(button => button.text === 'Push now')
    : undefined;
  await act(async () => {
    confirm?.onPress?.();
    await settle();
  });
  expect(mockLocalProjects.push).toHaveBeenCalledWith(project.id, {
    httpsProxyUrl: null,
    branch: 'feature/g2',
  });
  expect(
    renderer.root.findAllByProps({
      children: translate('en-US', 'projects.pushNonFastForward'),
    }).length,
  ).toBeGreaterThan(0);
  expect(mockLocalProjects.cancelPush).not.toHaveBeenCalled();
});

test('renders the native push receipt after a successful push', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  const renderer = await renderSurface();
  await openProject(renderer);
  expect(
    renderer.root.findAllByProps({ children: 'No push receipt recorded yet.' })
      .length,
  ).toBeGreaterThan(0);
  const receipt = {
    schema_version: 1,
    remote: 'origin',
    host: 'github.com',
    branch: 'main',
    local_oid: '0123456789abcdef0123456789abcdef01234567',
    remote_oid: '0123456789abcdef0123456789abcdef01234567',
    pushed_at: '2026-09-03T12:00:00.000Z',
  };
  mockLocalProjects.push.mockResolvedValueOnce({
    schema_version: 1,
    project_id: project.id,
    remote: 'origin',
    branch: 'main',
    oid: receipt.local_oid,
    pushed_at: receipt.pushed_at,
    receipt,
  });
  mockLocalProjects.pushReceipts.mockResolvedValue({
    schema_version: 1,
    project_id: project.id,
    receipts: [receipt],
  });
  await act(async () => actionByLabel(renderer.root, 'Push').props.onPress());
  const buttons = alert.mock.calls[0]?.[2];
  const confirm = Array.isArray(buttons)
    ? buttons.find(button => button.text === 'Push now')
    : undefined;
  await act(async () => {
    confirm?.onPress?.();
    await settle();
  });
  const rendered = renderer.root.findAll(
    node =>
      typeof node.props.children === 'string' &&
      node.props.children.startsWith('main → github.com · local 0123456789ab'),
  );
  expect(rendered.length).toBeGreaterThan(0);
  expect(
    renderer.root.findAllByProps({ children: 'Branch pushed successfully.' })
      .length,
  ).toBeGreaterThan(0);
});

async function startTestClone(renderer: Renderer) {
  await act(async () =>
    actionByLabel(renderer.root, 'Clone repository').props.onPress(),
  );
  await act(async () =>
    inputByLabel(renderer.root, 'Remote HTTPS URL').props.onChangeText(
      'https://example.com/copy.git',
    ),
  );
  await act(async () => {
    actionByLabel(renderer.root, 'Clone').props.onPress();
    await settle();
  });
}

async function pollClone() {
  await act(async () => {
    jest.advanceTimersByTime(400);
    await settle();
  });
}

test('shows native transfer progress and waits for real cancellation before retry', async () => {
  jest.useFakeTimers();
  mockLocalProjects.startClone.mockResolvedValue(cloneSnapshot('receiving'));
  const renderer = await renderSurface();
  await startTestClone(renderer);
  expect(
    renderer.root.findAllByProps({ children: '2/8 objects · 4 KiB received' })
      .length,
  ).toBeGreaterThan(0);
  await act(async () => {
    renderer.root
      .findByProps({ testID: 'projects-clone-operation-cancel' })
      .props.onPress();
    await settle();
  });
  expect(mockLocalProjects.cancelClone).toHaveBeenCalledWith('clone-1');
  expect(actionByLabel(renderer.root, 'Clone').props.disabled).toBe(true);
  expect(
    renderer.root.findAllByProps({
      children:
        'Cancelling… Waiting for the current network call to stop (up to 30 seconds).',
    }).length,
  ).toBeGreaterThan(0);
  mockLocalProjects.cloneStatus.mockResolvedValue(
    cloneSnapshot('cancelled', true),
  );
  await pollClone();
  expect(actionByLabel(renderer.root, 'Clone').props.disabled).toBe(false);
  expect(
    renderer.root.findAllByProps({
      children: 'Clone cancelled. No project was published.',
    }).length,
  ).toBeGreaterThan(0);
  expect(mockLocalProjects.status).not.toHaveBeenCalled();
});

test('reopens the same native operation without restarting or navigating on late success', async () => {
  jest.useFakeTimers();
  mockLocalProjects.startClone.mockResolvedValue(cloneSnapshot('connecting'));
  const renderer = await renderSurface();
  await startTestClone(renderer);
  await setVisible(renderer, false);
  mockLocalProjects.cloneStatus.mockResolvedValue(cloneSnapshot('receiving'));
  await setVisible(renderer, true);
  expect(
    renderer.root.findAllByProps({ children: 'Receiving objects…' }).length,
  ).toBeGreaterThan(0);
  mockLocalProjects.cloneStatus.mockResolvedValue(cloneSnapshot('succeeded'));
  await pollClone();
  expect(mockLocalProjects.startClone).toHaveBeenCalledTimes(1);
  expect(mockLocalProjects.status).not.toHaveBeenCalled();
  expect(actionByLabel(renderer.root, 'Open project demo')).toBeDefined();
});

test('cancel arriving after publication reports success without stealing navigation', async () => {
  jest.useFakeTimers();
  mockLocalProjects.startClone.mockResolvedValue(cloneSnapshot('validating'));
  mockLocalProjects.cancelClone.mockResolvedValue(cloneSnapshot('succeeded'));
  const renderer = await renderSurface();
  await startTestClone(renderer);
  await act(async () => {
    renderer.root
      .findByProps({ testID: 'projects-clone-operation-cancel' })
      .props.onPress();
    await settle();
  });
  expect(mockLocalProjects.status).not.toHaveBeenCalled();
  expect(
    renderer.root.findAllByProps({ children: 'Repository cloned locally.' })
      .length,
  ).toBeGreaterThan(0);
  expect(
    renderer.root.findAllByProps({
      children: 'Clone cancelled. No project was published.',
    }),
  ).toHaveLength(0);
});

test('a query from before start cannot overwrite the new clone operation', async () => {
  jest.useFakeTimers();
  const held = deferred<ReturnType<typeof cloneSnapshot>>();
  mockLocalProjects.cloneStatus.mockReturnValueOnce(held.promise);
  mockLocalProjects.startClone.mockResolvedValue(cloneSnapshot('receiving'));
  const renderer = await renderSurface();
  await startTestClone(renderer);
  await act(async () => {
    held.resolve({ ...cloneSnapshot('failed'), operation_id: 'old' });
    await settle();
  });
  expect(
    renderer.root.findAllByProps({ children: 'Receiving objects…' }).length,
  ).toBeGreaterThan(0);
  expect(actionByLabel(renderer.root, 'Clone').props.disabled).toBe(true);
});

test('a transport failure has a retryable terminal state', async () => {
  jest.useFakeTimers();
  mockLocalProjects.startClone.mockResolvedValue(cloneSnapshot('connecting'));
  const renderer = await renderSurface();
  await startTestClone(renderer);
  mockLocalProjects.cloneStatus.mockResolvedValue({
    ...cloneSnapshot('failed'),
    error_code: 'timeout',
  });
  await pollClone();
  expect(actionByLabel(renderer.root, 'Clone').props.disabled).toBe(false);
  expect(
    renderer.root.findAllByProps({
      children: 'The server took too long. Check the connection and try again.',
    }).length,
  ).toBeGreaterThan(0);
});

test('cancel before the native start reply is forwarded once identity arrives', async () => {
  jest.useFakeTimers();
  const held = deferred<ReturnType<typeof cloneSnapshot>>();
  mockLocalProjects.startClone.mockReturnValue(held.promise);
  const renderer = await renderSurface();
  await startTestClone(renderer);
  await act(async () =>
    renderer.root
      .findByProps({ testID: 'projects-clone-cancel' })
      .props.onPress(),
  );
  expect(mockLocalProjects.cancelClone).not.toHaveBeenCalled();
  await act(async () => {
    held.resolve(cloneSnapshot('queued'));
    await settle();
  });
  expect(mockLocalProjects.cancelClone).toHaveBeenCalledWith('clone-1');
  expect(mockLocalProjects.status).not.toHaveBeenCalled();
});
