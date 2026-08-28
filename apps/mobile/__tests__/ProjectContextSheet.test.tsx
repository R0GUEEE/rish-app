import React from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Modal,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import {
  PROJECT_CONTEXT_MAX_BYTES,
} from '../src/components/ProjectContextStrip';
import {
  ProjectContextSheet,
  type ProjectContextSheetProps,
} from '../src/components/ProjectContextSheet';
import { SlidingSurface } from '../src/components/SlidingSurface';
import type {
  ProjectContextCandidatePageV1,
  ProjectContextManifestV1,
} from '../src/project-context';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  TRANSLATIONS,
  createDefaultPreferences,
  createPreferencesStore,
  type ResolvedLocale,
} from '../src/preferences';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 59, right: 0, bottom: 34, left: 0 }),
}));

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const activeRenderers: Renderer[] = [];

beforeEach(() => jest.useFakeTimers());

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
    while (activeRenderers.length > 0) activeRenderers.pop()?.unmount();
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
});

type Candidate = ProjectContextCandidatePageV1['candidates'][number];

const candidates: readonly Candidate[] = [
  {
    path: 'README.md',
    size: 1000,
    revision: 'a'.repeat(40),
    git_state: 'unchanged',
    eligible: true,
    omission_reason: null,
  },
  {
    path: 'src/changed.ts',
    size: 2000,
    revision: 'b'.repeat(40),
    git_state: 'staged',
    eligible: true,
    omission_reason: null,
  },
  {
    path: 'src/conflict.ts',
    size: 3000,
    revision: 'c'.repeat(40),
    git_state: 'conflicted',
    eligible: true,
    omission_reason: null,
  },
  {
    path: '.env',
    size: 100,
    revision: 'd'.repeat(40),
    git_state: 'unstaged',
    eligible: false,
    omission_reason: 'secret_path',
  },
];

const manifest: ProjectContextManifestV1 = {
  schema_version: 1,
  snapshot_id: SNAPSHOT_ID,
  project_id: PROJECT_ID,
  project_name: 'demo',
  branch: 'main',
  head_oid: '0123456789abcdef0123456789abcdef01234567',
  clean: false,
  conflicted: false,
  captured_at: '2026-08-28T00:00:00.000Z',
  policy_version: 'chat-read-v1.0.0',
  provider_host: 'api.deepseek.com',
  model: 'deepseek-v4-flash',
  included: [
    {
      path: 'README.md',
      source: 'tracked_file',
      bytes: 1000,
      sha256: 'e'.repeat(64),
    },
    {
      path: 'src/changed.ts',
      source: 'staged_diff',
      bytes: 2000,
      sha256: 'f'.repeat(64),
    },
  ],
  omitted: [],
  context_bytes: 3000,
  estimated_tokens: 750,
  snapshot_sha256: '1'.repeat(64),
  source_fingerprint: '2'.repeat(64),
};

const correctedDisclosure =
  'Confirming authorizes Rish to send only the listed content as read-only model context. It does not authorize file edits, commands, commits, or pushes. Those actions remain governed by separate tool approvals.';

function presentation(children: React.ReactNode, locale: ResolvedLocale) {
  const store = createPreferencesStore({
    initialPreferences: {
      ...createDefaultPreferences(),
      locale,
    },
  });
  return (
    <AppPresentationProvider store={store}>{children}</AppPresentationProvider>
  );
}

type Harness = {
  readonly renderer: Renderer;
  readonly callbacks: {
    readonly onQueryChange: jest.Mock;
    readonly onFilterChange: jest.Mock;
    readonly onTogglePath: jest.Mock;
    readonly onLoadMore: jest.Mock;
    readonly onPrepare: jest.Mock;
    readonly onConfirm: jest.Mock;
    readonly onRefreshCandidates: jest.Mock;
    readonly onRefreshContext: jest.Mock;
    readonly onDisable: jest.Mock;
    readonly onClose: jest.Mock;
    readonly onCancelCandidate: jest.Mock;
    readonly onCancelRecovery: jest.Mock;
    readonly onRetryPersistence: jest.Mock;
    readonly onRetryCleanup: jest.Mock;
    readonly onRefreshAndSend: jest.Mock;
    readonly onSendWithoutContext: jest.Mock;
    readonly onDismiss: jest.Mock;
  };
  readonly props: ProjectContextSheetProps;
};

async function renderSheet(
  overrides: Partial<ProjectContextSheetProps> = {},
  locale: ResolvedLocale = 'en-US',
): Promise<Harness> {
  const callbacks = {
    onQueryChange: jest.fn(),
    onFilterChange: jest.fn(),
    onTogglePath: jest.fn(),
    onLoadMore: jest.fn(),
    onPrepare: jest.fn(),
    onConfirm: jest.fn(),
    onRefreshCandidates: jest.fn(),
    onRefreshContext: jest.fn(),
    onDisable: jest.fn(),
    onClose: jest.fn(),
    onCancelCandidate: jest.fn(),
    onCancelRecovery: jest.fn(),
    onRetryPersistence: jest.fn(),
    onRetryCleanup: jest.fn(),
    onRefreshAndSend: jest.fn(),
    onSendWithoutContext: jest.fn(),
    onDismiss: jest.fn(),
  };
  const props: ProjectContextSheetProps = {
    visible: true,
    actionKey: 'owner-a:0',
    mode: 'candidates',
    projectName: 'demo',
    query: '',
    filter: 'all',
    candidates,
    selectedPaths: ['src/changed.ts'],
    selectedCandidates: [candidates[1]!],
    nextCursor: 'opaque-cursor',
    loading: false,
    loadingMore: false,
    checking: false,
    unavailable: false,
    errorCode: null,
    manifest: null,
    hasActiveContext: true,
    confirmationRequired: true,
    recoveryAction: null,
    recoveryRefreshDisabled: false,
    recoverySendWithoutDisabled: false,
    disabled: false,
    busyAction: null,
    ...callbacks,
    ...overrides,
  };
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      presentation(<ProjectContextSheet {...props} />, locale),
    );
    await Promise.resolve();
  });
  if (renderer === undefined) throw new Error('renderer missing');
  activeRenderers.push(renderer);
  return { renderer, callbacks, props };
}

function actionByLabel(root: ReactTestInstance, label: string) {
  const action = root
    .findAllByProps({ accessibilityLabel: label })
    .find(instance => typeof instance.props.onPress === 'function');
  if (action === undefined) throw new Error(`no actionable ${label}`);
  return action;
}

function flatStyle(instance: ReactTestInstance) {
  const raw =
    typeof instance.props.style === 'function'
      ? instance.props.style({ pressed: false })
      : instance.props.style;
  return StyleSheet.flatten(raw);
}

function renderedText(root: ReactTestInstance): string {
  const flatten = (value: unknown): string => {
    if (typeof value === 'string' || typeof value === 'number') {
      return String(value);
    }
    return Array.isArray(value) ? value.map(flatten).join('') : '';
  };
  return root
    .findAllByType(Text)
    .map(node => flatten(node.props.children))
    .join('\n');
}

test('uses one full-width bottom SlidingSurface and a virtualized candidate list', async () => {
  const { renderer } = await renderSheet();
  const surface = renderer.root.findByType(SlidingSurface);

  expect(surface.props.side).toBe('bottom');
  expect(surface.props.widthRatio).toBe(1);
  expect(surface.props.scrim).toBe(false);
  expect(renderer.root.findAllByType(Modal)).toHaveLength(0);
  expect(renderer.root.findByType(FlatList)).toBeDefined();
});

test('keeps an immediate 44 point title-bar close action during busy read-only state', async () => {
  const { renderer, callbacks } = await renderSheet({
    disabled: true,
    busyAction: 'confirm',
  });
  const close = actionByLabel(renderer.root, 'Close project context');
  expect(close.props.accessibilityRole).toBe('button');
  expect(close.props.disabled).not.toBe(true);
  expect(flatStyle(close).minHeight).toBeGreaterThanOrEqual(44);
  expect(flatStyle(close).minWidth).toBeGreaterThanOrEqual(44);

  await act(async () => close.props.onPress());
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
  expect(callbacks.onCancelCandidate).not.toHaveBeenCalled();
});

test('renders eligible and ineligible metadata rows with exact accessibility state', async () => {
  const { renderer, callbacks } = await renderSheet();
  const selected = renderer.root.findByProps({
    testID: 'project-context-candidate-src/changed.ts',
  });
  const ineligible = renderer.root.findByProps({
    testID: 'project-context-candidate-.env',
  });

  expect(selected.props.accessibilityRole).toBe('checkbox');
  expect(selected.props.accessibilityState).toEqual({
    checked: true,
    disabled: false,
  });
  expect(selected.props.accessibilityLabel).toContain('src/changed.ts');
  expect(selected.props.accessibilityLabel).toContain('2 KB');
  expect(selected.props.accessibilityLabel).toContain('Staged');
  expect(flatStyle(selected).minHeight).toBeGreaterThanOrEqual(44);
  expect(ineligible.props.accessibilityState).toEqual({
    checked: false,
    disabled: true,
  });
  expect(ineligible.props.accessibilityLabel).toContain('.env');
  expect(ineligible.props.accessibilityLabel).toContain('100 B');
  expect(ineligible.props.accessibilityLabel).toContain('Unstaged');
  expect(ineligible.props.accessibilityLabel).toContain('Secret path');
  expect(renderer.root.findByProps({ children: 'Secret path' })).toBeDefined();
  expect(renderedText(renderer.root)).not.toContain('RAW_FILE_CONTENT');

  await act(async () => selected.props.onPress());
  await act(async () => ineligible.props.onPress());
  expect(callbacks.onTogglePath).toHaveBeenCalledTimes(1);
  expect(callbacks.onTogglePath).toHaveBeenCalledWith('src/changed.ts');
});

test.each([
  ['all', ['README.md', 'src/changed.ts', 'src/conflict.ts', '.env']],
  ['selected', ['src/changed.ts']],
  ['changed', ['src/changed.ts', 'src/conflict.ts', '.env']],
] as const)('applies the %s metadata filter without a ScrollView', async (filter, paths) => {
  const { renderer } = await renderSheet({ filter });
  const list = renderer.root.findByType(FlatList);

  expect(list.props.data.map((row: Candidate) => row.path)).toEqual(paths);
  const filterAction = actionByLabel(
    renderer.root,
    filter === 'all' ? 'All files' : filter === 'selected' ? 'Selected files' : 'Changed files',
  );
  expect(filterAction.props.accessibilityState.selected).toBe(true);
});

test('emits search, filter, and one guarded pagination intent', async () => {
  const { renderer, callbacks } = await renderSheet();
  const search = renderer.root.findByType(TextInput);
  expect(search.props.maxLength).toBe(256);

  await act(async () => search.props.onChangeText('src'));
  await act(async () =>
    actionByLabel(renderer.root, 'Selected files').props.onPress(),
  );
  await act(async () => renderer.root.findByType(FlatList).props.onEndReached());
  expect(callbacks.onQueryChange).toHaveBeenCalledWith('src');
  expect(callbacks.onFilterChange).toHaveBeenCalledWith('selected');
  expect(callbacks.onLoadMore).toHaveBeenCalledTimes(1);

  const loading = await renderSheet({ loadingMore: true });
  await act(async () => loading.renderer.root.findByType(FlatList).props.onEndReached());
  expect(loading.callbacks.onLoadMore).not.toHaveBeenCalled();

  const terminalPage = await renderSheet({ nextCursor: null });
  await act(async () =>
    terminalPage.renderer.root.findByType(FlatList).props.onEndReached(),
  );
  expect(terminalPage.callbacks.onLoadMore).not.toHaveBeenCalled();
});

test('retains selected metadata across query and page changes', async () => {
  const selectedAcrossPages = candidates[1]!;
  const { renderer, callbacks } = await renderSheet({
    candidates: [candidates[0]!],
    selectedPaths: [selectedAcrossPages.path],
    selectedCandidates: [selectedAcrossPages],
    filter: 'selected',
  });
  const list = renderer.root.findByType(FlatList);
  expect(list.props.data.map((row: Candidate) => row.path)).toEqual([
    'src/changed.ts',
  ]);
  expect(actionByLabel(renderer.root, 'Prepare context').props.disabled).toBe(
    false,
  );
  expect(renderedText(renderer.root)).toContain('1 selected · 2.0 KB / 256 KB');
  await act(async () =>
    renderer.root
      .findByProps({ testID: 'project-context-candidate-src/changed.ts' })
      .props.onPress(),
  );
  expect(callbacks.onTogglePath).toHaveBeenCalledWith('src/changed.ts');
});

test.each([
  [{ loading: true }, 'Loading project files…'],
  [{ candidates: [], nextCursor: null }, 'No project files found'],
  [{ unavailable: true }, 'Project context is unavailable'],
  [{ errorCode: 'E_CONTEXT_NATIVE' }, 'Could not load project context'],
] as const)('keeps candidate state %j distinct', async (overrides, label) => {
  const { renderer } = await renderSheet(overrides);
  expect(renderer.root.findByProps({ children: label })).toBeDefined();
});

test('keeps native context checking distinct from candidate list loading', async () => {
  const { renderer } = await renderSheet({ checking: true, loading: true });
  const checking = renderer.root.findByProps({
    children: 'Checking project context',
  });
  const loading = renderer.root.findByProps({
    children: 'Loading project files…',
  });

  expect(checking.props.accessibilityLiveRegion).toBe('polite');
  expect(checking.props.accessibilityRole).toBe('status');
  expect(loading.props.accessibilityLiveRegion).toBe('polite');
  expect(checking).not.toBe(loading);
});

test.each([
  ['candidates', null],
  ['disclosure', manifest],
  ['recovery', null],
] as const)(
  'shows value-free checking status in %s mode',
  async (mode, currentManifest) => {
    const unsafeCheckingProps = {
      checking: true,
      checkingDetail: 'RAW_NATIVE_DETAIL /private/project',
    } as Partial<ProjectContextSheetProps> & {
      readonly checkingDetail: string;
    };
    const { renderer } = await renderSheet({
      ...unsafeCheckingProps,
      mode,
      manifest: currentManifest,
    });
    const output = renderedText(renderer.root);
    expect(output).toContain('Checking project context');
    expect(output).not.toContain('RAW_NATIVE_DETAIL');
    expect(output).not.toContain('/private/project');
  },
);

test('localizes native context checking independently in Chinese', async () => {
  const { renderer } = await renderSheet(
    { checking: true, mode: 'disclosure', manifest },
    'zh-CN',
  );
  expect(renderedText(renderer.root)).toContain('正在检查项目上下文');
  expect(renderedText(renderer.root)).not.toContain('Loading project files');
});

test('blocks Prepare when selected candidate bytes exceed the fixed budget', async () => {
  const oversized = [
    { ...candidates[0], path: 'large-a.bin', size: 140 * 1024 },
    { ...candidates[1], path: 'large-b.bin', size: 140 * 1024 },
  ];
  const { renderer, callbacks } = await renderSheet({
    candidates: oversized,
    selectedPaths: oversized.map(row => row.path),
    selectedCandidates: oversized,
  });
  const prepare = actionByLabel(renderer.root, 'Prepare context');

  expect(prepare.props.disabled).toBe(true);
  expect(prepare.props.accessibilityState).toMatchObject({ disabled: true });
  expect(renderer.root.findByProps({ children: 'Selection exceeds 256 KB' })).toBeDefined();
  await act(async () => prepare.props.onPress());
  expect(callbacks.onPrepare).not.toHaveBeenCalled();
});

test.each([
  { selectedPaths: [], selectedCandidates: [] },
  { loading: true },
  { unavailable: true },
  { errorCode: 'E_CONTEXT_NATIVE' as const },
])('hard-disables Prepare for non-actionable candidate state %#', async overrides => {
  const { renderer, callbacks } = await renderSheet(overrides);
  const prepare = actionByLabel(renderer.root, 'Prepare context');
  expect(prepare.props.disabled).toBe(true);
  await act(async () => prepare.props.onPress());
  expect(callbacks.onPrepare).not.toHaveBeenCalled();
});

test('does not enable active-context actions during first-time setup', async () => {
  const { renderer, callbacks } = await renderSheet({
    hasActiveContext: false,
  });
  for (const [label, callback] of [
    ['Refresh context', callbacks.onRefreshContext],
    ['Disable context', callbacks.onDisable],
  ] as const) {
    const action = actionByLabel(renderer.root, label);
    expect(action.props.disabled).toBe(true);
    await act(async () => action.props.onPress());
    expect(callback).not.toHaveBeenCalled();
  }
  expect(actionByLabel(renderer.root, 'Refresh files').props.disabled).toBe(
    false,
  );
  await act(async () =>
    actionByLabel(renderer.root, 'Refresh files').props.onPress(),
  );
  expect(callbacks.onRefreshCandidates).toHaveBeenCalledTimes(1);
  expect(callbacks.onRefreshContext).not.toHaveBeenCalled();
});

test('keeps every candidate action at least 44 points with busy and disabled semantics', async () => {
  const { renderer, callbacks } = await renderSheet({ busyAction: 'prepare' });
  for (const label of [
    'Prepare context',
    'Refresh files',
    'Refresh context',
    'Disable context',
  ]) {
    const action = actionByLabel(renderer.root, label);
    expect(flatStyle(action).minHeight).toBeGreaterThanOrEqual(44);
    expect(action.props.accessibilityState.disabled).toBe(true);
  }
  expect(actionByLabel(renderer.root, 'Prepare context').props.accessibilityState.busy).toBe(true);
  const cancel = actionByLabel(renderer.root, 'Cancel');
  expect(cancel.props.disabled).toBe(true);
  await act(async () => cancel.props.onPress());
  expect(callbacks.onCancelCandidate).not.toHaveBeenCalled();
});

test('always allows close but hard-disables candidate cancellation in read-only mode', async () => {
  const { renderer, callbacks } = await renderSheet({ disabled: true });
  const cancel = actionByLabel(renderer.root, 'Cancel');
  expect(cancel.props.disabled).toBe(true);
  await act(async () => cancel.props.onPress());
  await act(async () => renderer.root.findByType(SlidingSurface).props.onClose());
  expect(callbacks.onCancelCandidate).not.toHaveBeenCalled();
  expect(callbacks.onClose).toHaveBeenCalledTimes(1);
});

test('rejects a stale enabled mutation callback after the Sheet becomes disabled', async () => {
  const harness = await renderSheet();
  const stalePrepare = actionByLabel(
    harness.renderer.root,
    'Prepare context',
  ).props.onPress;
  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet {...harness.props} disabled />,
        'en-US',
      ),
    );
  });

  await act(async () => stalePrepare());
  expect(harness.callbacks.onPrepare).not.toHaveBeenCalled();
});

test('rejects a captured candidate cancellation after the Sheet becomes busy', async () => {
  const harness = await renderSheet();
  const staleCancel = actionByLabel(
    harness.renderer.root,
    'Cancel',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet {...harness.props} busyAction="prepare" />,
        'en-US',
      ),
    );
  });
  await act(async () => staleCancel());

  expect(harness.callbacks.onCancelCandidate).not.toHaveBeenCalled();
  expect(harness.callbacks.onClose).not.toHaveBeenCalled();
});

test('rejects a captured candidate cancellation after same-state owner replacement', async () => {
  const harness = await renderSheet();
  const staleCancel = actionByLabel(
    harness.renderer.root,
    'Cancel',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet {...harness.props} actionKey="owner-b:0" />,
        'en-US',
      ),
    );
  });
  await act(async () => staleCancel());

  expect(harness.callbacks.onCancelCandidate).not.toHaveBeenCalled();
});

test.each([
  ['E_CONTEXT_PERSISTENCE', 'Could not save project context'],
  [
    'E_CONTEXT_OWNER_STALE',
    'Project context changed. Reopen it to continue',
  ],
] as const)(
  'renders the stable controller error %s without native details',
  async (errorCode, message) => {
    const { renderer } = await renderSheet({ errorCode });
    const output = renderedText(renderer.root);
    expect(output).toContain(message);
    expect(output).not.toContain(errorCode);
    expect(output).not.toContain('/private/');
  },
);

test.each([
  ['persistence', 'Retry save', 'onRetryPersistence'],
  ['cleanup', 'Retry cleanup', 'onRetryCleanup'],
] as const)(
  'routes the %s recovery action exactly once',
  async (recoveryAction, label, callbackName) => {
    const harness = await renderSheet({
      recoveryAction,
      errorCode:
        recoveryAction === 'persistence'
          ? 'E_CONTEXT_PERSISTENCE'
          : 'E_CONTEXT_STORAGE',
    });
    const action = actionByLabel(harness.renderer.root, label);
    expect(action.props.disabled).toBe(false);
    expect(flatStyle(action).minHeight).toBeGreaterThanOrEqual(44);
    await act(async () => action.props.onPress());

    expect(harness.callbacks[callbackName]).toHaveBeenCalledTimes(1);
    expect(
      harness.callbacks[
        callbackName === 'onRetryPersistence'
          ? 'onRetryCleanup'
          : 'onRetryPersistence'
      ],
    ).not.toHaveBeenCalled();
  },
);

test('hard-guards a captured persistence retry after recovery ownership changes', async () => {
  const harness = await renderSheet({ recoveryAction: 'persistence' });
  const staleRetry = actionByLabel(
    harness.renderer.root,
    'Retry save',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet
          {...harness.props}
          recoveryAction="cleanup"
        />,
        'en-US',
      ),
    );
  });
  await act(async () => staleRetry());

  expect(harness.callbacks.onRetryPersistence).not.toHaveBeenCalled();
  expect(harness.callbacks.onRetryCleanup).not.toHaveBeenCalled();
});

test('hard-guards a captured retry after same-state owner replacement', async () => {
  const harness = await renderSheet({ recoveryAction: 'persistence' });
  const staleRetry = actionByLabel(
    harness.renderer.root,
    'Retry save',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet
          {...harness.props}
          actionKey="owner-b:0"
          recoveryAction="persistence"
        />,
        'en-US',
      ),
    );
  });
  await act(async () => staleRetry());

  expect(harness.callbacks.onRetryPersistence).not.toHaveBeenCalled();
});

test('renders only the explicit stale pending-send recovery choices', async () => {
  const harness = await renderSheet({
    mode: 'recovery',
    candidates: [],
    selectedPaths: [],
    selectedCandidates: [],
    manifest,
    hasActiveContext: false,
    confirmationRequired: false,
  });

  for (const label of [
    'Refresh and send',
    'Send without project context',
    'Cancel',
  ]) {
    expect(actionByLabel(harness.renderer.root, label)).toBeDefined();
  }
  expect(renderedText(harness.renderer.root)).not.toContain(
    'No project files found',
  );
  for (const label of [
    'Prepare context',
    'Confirm context',
    'Confirm partial context',
    'Refresh files',
    'Refresh context',
    'Disable context',
    'Retry save',
    'Retry cleanup',
  ]) {
    expect(
      harness.renderer.root.findAllByProps({ accessibilityLabel: label }),
    ).toHaveLength(0);
  }

  await act(async () =>
    actionByLabel(harness.renderer.root, 'Refresh and send').props.onPress(),
  );
  await act(async () =>
    actionByLabel(
      harness.renderer.root,
      'Send without project context',
    ).props.onPress(),
  );
  await act(async () =>
    actionByLabel(harness.renderer.root, 'Cancel').props.onPress(),
  );
  expect(harness.callbacks.onRefreshAndSend).toHaveBeenCalledTimes(1);
  expect(harness.callbacks.onSendWithoutContext).toHaveBeenCalledTimes(1);
  expect(harness.callbacks.onCancelRecovery).toHaveBeenCalledTimes(1);
  expect(harness.callbacks.onClose).not.toHaveBeenCalled();
  expect(harness.callbacks.onCancelCandidate).not.toHaveBeenCalled();
});

test('keeps explicit fallback and cancellation available when refresh is unavailable', async () => {
  const recoveryOverrides = {
    mode: 'recovery' as const,
    unavailable: true,
    recoveryRefreshDisabled: true,
    recoverySendWithoutDisabled: false,
  } as Partial<ProjectContextSheetProps> & {
    recoveryRefreshDisabled: boolean;
    recoverySendWithoutDisabled: boolean;
  };
  const harness = await renderSheet(recoveryOverrides);
  const refresh = actionByLabel(harness.renderer.root, 'Refresh and send');
  const sendWithout = actionByLabel(
    harness.renderer.root,
    'Send without project context',
  );
  const cancel = actionByLabel(harness.renderer.root, 'Cancel');

  expect(refresh.props.disabled).toBe(true);
  expect(sendWithout.props.disabled).toBe(false);
  expect(cancel.props.disabled).toBe(false);
  await act(async () => refresh.props.onPress());
  await act(async () => sendWithout.props.onPress());
  await act(async () => cancel.props.onPress());

  expect(harness.callbacks.onRefreshAndSend).not.toHaveBeenCalled();
  expect(harness.callbacks.onSendWithoutContext).toHaveBeenCalledTimes(1);
  expect(harness.callbacks.onCancelRecovery).toHaveBeenCalledTimes(1);
});

test.each([
  { disabled: true },
  { busyAction: 'refresh' as const },
])('hard-disables recovery cancellation for state %j', async overrides => {
  const harness = await renderSheet({ mode: 'recovery', ...overrides });
  const cancel = actionByLabel(harness.renderer.root, 'Cancel');

  expect(cancel.props.disabled).toBe(true);
  await act(async () => cancel.props.onPress());
  expect(harness.callbacks.onCancelRecovery).not.toHaveBeenCalled();
  expect(harness.callbacks.onClose).not.toHaveBeenCalled();

  await act(async () =>
    actionByLabel(
      harness.renderer.root,
      'Close project context',
    ).props.onPress(),
  );
  await act(async () =>
    harness.renderer.root.findByType(SlidingSurface).props.onClose(),
  );
  expect(harness.callbacks.onClose).toHaveBeenCalledTimes(2);
});

test('hard-guards a captured recovery cancellation after same-state owner replacement', async () => {
  const harness = await renderSheet({ mode: 'recovery' });
  const staleCancel = actionByLabel(
    harness.renderer.root,
    'Cancel',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet
          {...harness.props}
          actionKey="owner-b:0"
          mode="recovery"
        />,
        'en-US',
      ),
    );
  });
  await act(async () => staleCancel());

  expect(harness.callbacks.onCancelRecovery).not.toHaveBeenCalled();
  expect(harness.callbacks.onClose).not.toHaveBeenCalled();
});

test('hard-guards stale pending-send actions after recovery mode is disabled', async () => {
  const harness = await renderSheet({ mode: 'recovery' });
  const staleRefresh = actionByLabel(
    harness.renderer.root,
    'Refresh and send',
  ).props.onPress;
  const staleWithoutContext = actionByLabel(
    harness.renderer.root,
    'Send without project context',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet {...harness.props} disabled mode="recovery" />,
        'en-US',
      ),
    );
  });
  await act(async () => staleRefresh());
  await act(async () => staleWithoutContext());

  expect(harness.callbacks.onRefreshAndSend).not.toHaveBeenCalled();
  expect(harness.callbacks.onSendWithoutContext).not.toHaveBeenCalled();
});

test('hard-guards stale pending-send actions after same-state owner replacement', async () => {
  const harness = await renderSheet({ mode: 'recovery' });
  const staleRefresh = actionByLabel(
    harness.renderer.root,
    'Refresh and send',
  ).props.onPress;
  const staleWithoutContext = actionByLabel(
    harness.renderer.root,
    'Send without project context',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet
          {...harness.props}
          actionKey="owner-b:0"
          mode="recovery"
        />,
        'en-US',
      ),
    );
  });
  await act(async () => staleRefresh());
  await act(async () => staleWithoutContext());

  expect(harness.callbacks.onRefreshAndSend).not.toHaveBeenCalled();
  expect(harness.callbacks.onSendWithoutContext).not.toHaveBeenCalled();
});

test('renders metadata-only disclosure and the corrected authorization boundary', async () => {
  const { renderer } = await renderSheet({
    mode: 'disclosure',
    manifest,
  });
  const output = renderedText(renderer.root);

  expect(renderer.root.findByType(FlatList)).toBeDefined();

  expect(output).toContain('api.deepseek.com');
  expect(output).toContain('deepseek-v4-flash');
  expect(output).toContain('main');
  expect(output).toContain('0123456');
  expect(output).toContain('README.md');
  expect(output).toContain('Tracked file');
  expect(output).toContain('1000 B');
  expect(output).toContain('750 approximate tokens');
  expect(output).toContain('2026-08-28T00:00:00.000Z');
  expect(output).toContain(manifest.snapshot_sha256.slice(0, 12));
  expect(output).toContain(correctedDisclosure);
  expect(output).not.toContain('RAW_FILE_CONTENT');
  expect(output).not.toContain('cannot edit files');
});

test('renders the corrected Chinese disclosure instead of a global capability claim', async () => {
  const partial: ProjectContextManifestV1 = {
    ...manifest,
    omitted: [{ path: '.env', reason: 'secret_path' }],
  };
  const { renderer } = await renderSheet(
    { mode: 'disclosure', manifest: partial },
    'zh-CN',
  );
  const output = renderedText(renderer.root);
  expect(output).toContain(
    '确认后，Rish 仅会将列表中的内容作为只读模型上下文发送。此授权不包含文件编辑、命令、提交或推送；这些操作仍由独立的工具审批管理。',
  );
  expect(output).toContain('确认部分上下文');
  expect(output).toContain('机密路径');
  expect(output).not.toContain('无法编辑文件');
});

test('renders the explicit stale recovery choices and persistence error in Chinese', async () => {
  const { renderer } = await renderSheet(
    {
      mode: 'recovery',
      errorCode: 'E_CONTEXT_PERSISTENCE',
    },
    'zh-CN',
  );
  const output = renderedText(renderer.root);
  expect(output).toContain('刷新并发送');
  expect(output).toContain('不使用项目上下文发送');
  expect(output).toContain('取消');
  expect(output).toContain('无法保存项目上下文');
});

test('never renders raw content or absolute-path metadata extras', async () => {
  const unsafeCandidate = {
    ...candidates[0],
    content: 'RAW_FILE_CONTENT',
    absolute_path: '/private/ABSOLUTE_PATH_SENTINEL',
  } as Candidate & { content: string; absolute_path: string };
  const unsafeIncluded = {
    ...manifest.included[0]!,
    content: 'RAW_FILE_CONTENT',
    absolute_path: '/private/ABSOLUTE_PATH_SENTINEL',
  };
  const unsafeManifest: ProjectContextManifestV1 & {
    absolute_path: string;
  } = {
    ...manifest,
    absolute_path: '/private/ABSOLUTE_PATH_SENTINEL',
    included: [unsafeIncluded],
  };
  const candidateView = await renderSheet({ candidates: [unsafeCandidate] });
  const disclosureView = await renderSheet({
    mode: 'disclosure',
    manifest: unsafeManifest,
  });
  for (const output of [
    renderedText(candidateView.renderer.root),
    renderedText(disclosureView.renderer.root),
  ]) {
    expect(output).not.toContain('RAW_FILE_CONTENT');
    expect(output).not.toContain('/private/ABSOLUTE_PATH_SENTINEL');
  }
});

test('allows explicit Partial confirmation with omissions including budget_exceeded', async () => {
  const partial: ProjectContextManifestV1 = {
    ...manifest,
    context_bytes: PROJECT_CONTEXT_MAX_BYTES,
    estimated_tokens: Math.ceil(PROJECT_CONTEXT_MAX_BYTES / 4),
    omitted: [
      { path: 'generated.bin', reason: 'budget_exceeded' },
      { path: '.env', reason: 'secret_path' },
    ],
  };
  const { renderer, callbacks } = await renderSheet({
    mode: 'disclosure',
    manifest: partial,
  });
  const confirm = actionByLabel(renderer.root, 'Confirm partial context');

  expect(confirm.props.disabled).toBe(false);
  expect(renderer.root.findByProps({ children: 'Budget exceeded' })).toBeDefined();
  expect(renderer.root.findByProps({ children: 'Secret path' })).toBeDefined();
  await act(async () => confirm.props.onPress());
  expect(callbacks.onConfirm).toHaveBeenCalledTimes(1);
});

test('does not offer confirmation while inspecting the already active manifest', async () => {
  const { renderer, callbacks } = await renderSheet({
    mode: 'disclosure',
    manifest,
    confirmationRequired: false,
  });

  expect(
    renderer.root.findAllByProps({ accessibilityLabel: 'Confirm context' }),
  ).toHaveLength(0);
  expect(
    renderer.root.findAllByProps({
      accessibilityLabel: 'Confirm partial context',
    }),
  ).toHaveLength(0);
  expect(actionByLabel(renderer.root, 'Refresh context').props.disabled).toBe(
    false,
  );
  expect(actionByLabel(renderer.root, 'Disable context').props.disabled).toBe(
    false,
  );
  expect(actionByLabel(renderer.root, 'Cancel').props.disabled).toBe(false);
  expect(callbacks.onConfirm).not.toHaveBeenCalled();
});

test('hard-guards a captured disclosure confirmation after switching to active inspection', async () => {
  const harness = await renderSheet({
    mode: 'disclosure',
    manifest,
    confirmationRequired: true,
  });
  const staleConfirm = actionByLabel(
    harness.renderer.root,
    'Confirm context',
  ).props.onPress;

  await act(async () => {
    harness.renderer.update(
      presentation(
        <ProjectContextSheet
          {...harness.props}
          confirmationRequired={false}
          manifest={manifest}
          mode="disclosure"
        />,
        'en-US',
      ),
    );
  });
  await act(async () => staleConfirm());

  expect(harness.callbacks.onConfirm).not.toHaveBeenCalled();
});

test('blocks disclosure confirmation only when manifest context bytes exceed budget', async () => {
  const invalidManifest = {
    ...manifest,
    context_bytes: PROJECT_CONTEXT_MAX_BYTES + 1,
    estimated_tokens: Math.ceil((PROJECT_CONTEXT_MAX_BYTES + 1) / 4),
  };
  const { renderer, callbacks } = await renderSheet({
    mode: 'disclosure',
    manifest: invalidManifest,
  });
  const confirm = actionByLabel(renderer.root, 'Confirm context');
  expect(confirm.props.disabled).toBe(true);
  await act(async () => confirm.props.onPress());
  expect(callbacks.onConfirm).not.toHaveBeenCalled();
});

test.each([
  [{ errorCode: 'E_CONTEXT_NATIVE' as const }, 'Could not load project context'],
  [{ unavailable: true }, 'Project context is unavailable'],
] as const)(
  'fails disclosure closed for recovery state %j while retaining an exit',
  async (overrides, label) => {
    const { renderer, callbacks } = await renderSheet({
      mode: 'disclosure',
      manifest,
      ...overrides,
    });
    const confirm = actionByLabel(renderer.root, 'Confirm context');
    expect(confirm.props.disabled).toBe(true);
    const notice = renderer.root.findByProps({ children: label });
    expect(notice.props.accessibilityLiveRegion).toBe('polite');
    expect(actionByLabel(renderer.root, 'Cancel').props.disabled).toBe(false);
    expect(actionByLabel(renderer.root, 'Refresh context').props.disabled).toBe(
      false,
    );
    await act(async () => confirm.props.onPress());
    expect(callbacks.onConfirm).not.toHaveBeenCalled();
  },
);

test('keeps disclosure actions reachable, 44 point, and independently routed', async () => {
  const { renderer, callbacks } = await renderSheet({
    mode: 'disclosure',
    manifest,
  });
  for (const [label, callback] of [
    ['Confirm context', callbacks.onConfirm],
    ['Refresh context', callbacks.onRefreshContext],
    ['Disable context', callbacks.onDisable],
    ['Cancel', callbacks.onCancelCandidate],
  ] as const) {
    const action = actionByLabel(renderer.root, label);
    expect(flatStyle(action).minHeight).toBeGreaterThanOrEqual(44);
    await act(async () => action.props.onPress());
    expect(callback).toHaveBeenCalledTimes(1);
  }
});

test('uses restrained live announcements without making the list itself live', async () => {
  const loading = await renderSheet({ loading: true });
  const announcement = loading.renderer.root.findByProps({
    children: 'Loading project files…',
  });
  expect(announcement.props.accessibilityLiveRegion).toBe('polite');
  expect(loading.renderer.root.findByType(FlatList).props.accessibilityLiveRegion).toBeUndefined();

  const disclosure = await renderSheet({ mode: 'disclosure', manifest });
  expect(
    disclosure.renderer.root.findByProps({
      testID: 'project-context-budget-announcement',
    }).props.accessibilityLiveRegion,
  ).toBe('polite');
});

test('does not truncate Dynamic Type content or trap bottom actions in a fixed height', async () => {
  const { renderer } = await renderSheet({ mode: 'disclosure', manifest });
  renderer.root.findAllByType(Text).forEach(node => {
    expect(node.props.allowFontScaling).not.toBe(false);
    expect(node.props.numberOfLines).toBeUndefined();
  });
  const body = renderer.root.findByProps({ testID: 'project-context-sheet-body' });
  expect(StyleSheet.flatten(body.props.style).height).toBeUndefined();
});

test('focuses the title once after every presentation and never during close', async () => {
  const focus = jest
    .spyOn(AccessibilityInfo, 'setAccessibilityFocus')
    .mockImplementation(() => undefined);
  const { renderer, callbacks, props } = await renderSheet();
  const title = renderer.root.findByProps({
    testID: 'project-context-sheet-title',
  });
  expect(title.props.accessibilityRole).toBe('header');
  await act(async () =>
    title.props.onLayout({
      target: 42,
      nativeEvent: {
        layout: { x: 0, y: 0, width: 320, height: 44 },
      },
    }),
  );
  expect(focus).toHaveBeenCalledTimes(1);
  const presented = renderer.root.findByType(SlidingSurface).props.onPresented;
  expect(typeof presented).toBe('function');
  await act(async () => presented());
  expect(focus).toHaveBeenCalledTimes(1);

  await act(async () =>
    renderer.root.findByType(SlidingSurface).props.onClose(),
  );
  expect(focus).toHaveBeenCalledTimes(1);
  expect(callbacks.onDismiss).not.toHaveBeenCalled();

  await act(async () => {
    renderer.update(
      presentation(<ProjectContextSheet {...props} visible={false} />, 'en-US'),
    );
  });
  expect(callbacks.onDismiss).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalledTimes(1);

  await act(async () => {
    renderer.update(
      presentation(<ProjectContextSheet {...props} visible />, 'en-US'),
    );
  });
  expect(focus).toHaveBeenCalledTimes(2);
  focus.mockRestore();
});

test('defines key-identical English and Chinese Sheet vocabulary', () => {
  const requiredKeys = [
    'context.sheet.title',
    'context.sheet.close',
    'context.sheet.search',
    'context.sheet.filter.all',
    'context.sheet.filter.selected',
    'context.sheet.filter.changed',
    'context.sheet.loading',
    'context.sheet.checking',
    'context.sheet.empty',
    'context.sheet.unavailable',
    'context.sheet.loadError',
    'context.sheet.error.persistence',
    'context.sheet.error.ownerStale',
    'context.sheet.omission.secretPath',
    'context.sheet.omission.generated',
    'context.sheet.omission.lockfile',
    'context.sheet.omission.suspectedSecret',
    'context.sheet.omission.binary',
    'context.sheet.omission.invalidEncoding',
    'context.sheet.omission.notTracked',
    'context.sheet.omission.budgetExceeded',
    'context.sheet.omission.policy',
    'context.sheet.git.unchanged',
    'context.sheet.git.staged',
    'context.sheet.git.unstaged',
    'context.sheet.git.conflicted',
    'context.sheet.source.trackedFile',
    'context.sheet.source.stagedDiff',
    'context.sheet.source.worktreeDiff',
    'context.sheet.prepare',
    'context.sheet.confirm',
    'context.sheet.confirmPartial',
    'context.sheet.refreshFiles',
    'context.sheet.refreshContext',
    'context.sheet.disable',
    'context.sheet.retryPersistence',
    'context.sheet.retryCleanup',
    'context.sheet.refreshAndSend',
    'context.sheet.sendWithoutContext',
    'context.sheet.cancel',
    'context.sheet.disclosure',
    'context.sheet.disclosure.provider',
    'context.sheet.disclosure.model',
    'context.sheet.disclosure.branch',
    'context.sheet.disclosure.head',
    'context.sheet.disclosure.capturedAt',
    'context.sheet.disclosure.included',
    'context.sheet.disclosure.omitted',
    'context.sheet.disclosure.budget',
    'context.sheet.disclosure.digest',
    'context.sheet.approximateTokens',
  ] as const;
  for (const locale of ['en-US', 'zh-CN'] as const) {
    for (const key of requiredKeys) {
      expect(
        Object.prototype.hasOwnProperty.call(TRANSLATIONS[locale], key),
      ).toBe(true);
    }
  }
  expect(Object.keys(TRANSLATIONS['zh-CN']).sort()).toEqual(
    Object.keys(TRANSLATIONS['en-US']).sort(),
  );
});
