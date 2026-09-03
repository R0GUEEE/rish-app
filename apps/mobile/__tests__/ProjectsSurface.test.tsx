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
  mockLocalProjects.clone.mockRejectedValueOnce(new Error('TLS failed'));
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

  expect(mockLocalProjects.clone).toHaveBeenCalledWith(
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

  expect(mockLocalProjects.clone).toHaveBeenCalledWith(
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
    inputByLabel(renderer.root, 'Push as new branch (optional)').props.onChangeText(
      'feature/g2',
    );
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
