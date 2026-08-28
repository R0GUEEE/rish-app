import React from 'react';
import { StyleSheet, Text } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { AppIcon } from '../src/components/AppIcon';
import {
  PROJECT_CONTEXT_MAX_BYTES,
  ProjectContextStrip,
} from '../src/components/ProjectContextStrip';
import {
  PROJECT_CONTEXT_SCHEMA_VERSION,
  type ProjectContextManifestV1,
  type ProjectContextState,
  type ProjectContextStatus,
} from '../src/project-context';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  TRANSLATIONS,
  createDefaultPreferences,
  createPreferencesStore,
  type ResolvedLocale,
} from '../src/preferences';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const CONSENT_ID = '33333333-3333-4333-8333-333333333333';

const manifest: ProjectContextManifestV1 = {
  schema_version: PROJECT_CONTEXT_SCHEMA_VERSION,
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
      bytes: 1250,
      sha256: 'a'.repeat(64),
    },
    {
      path: 'src/a.ts',
      source: 'staged_diff',
      bytes: 2000,
      sha256: 'b'.repeat(64),
    },
    {
      path: 'src/a.ts',
      source: 'worktree_diff',
      bytes: 500,
      sha256: 'f'.repeat(64),
    },
    {
      path: 'src/b.ts',
      source: 'worktree_diff',
      bytes: 3000,
      sha256: 'c'.repeat(64),
    },
  ],
  omitted: [],
  context_bytes: 6250,
  estimated_tokens: 1563,
  snapshot_sha256: 'd'.repeat(64),
  source_fingerprint: 'e'.repeat(64),
};

const consent = {
  schema_version: PROJECT_CONTEXT_SCHEMA_VERSION,
  consent_receipt_id: CONSENT_ID,
  snapshot_id: SNAPSHOT_ID,
  snapshot_sha256: manifest.snapshot_sha256,
  confirmed_at: '2026-08-28T00:00:01.000Z',
} as const;

const partialManifest: ProjectContextManifestV1 = {
  ...manifest,
  omitted: [{ path: 'secrets.env', reason: 'secret_path' }],
};

function contextState(
  status: ProjectContextStatus,
  overrides: Partial<ProjectContextState> = {},
): ProjectContextState {
  const hasSnapshot =
    status === 'ready' || status === 'partial' || status === 'stale';
  const snapshot =
    status === 'partial' ? partialManifest : hasSnapshot ? manifest : null;
  return {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    projectId: PROJECT_ID,
    status,
    selectedPaths: ['README.md', 'src/a.ts', 'src/b.ts'],
    activePreparationId: status === 'checking' ? 'prepare-1' : null,
    snapshot,
    consent: status === 'ready' || status === 'partial' ? consent : null,
    staleReason: status === 'stale' ? 'project_changed' : null,
    errorCode: status === 'error' ? 'E_CONTEXT_TIMEOUT' : null,
    ...overrides,
  };
}

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

async function renderStrip(options: {
  state?: ProjectContextState;
  locale?: ResolvedLocale;
  disabled?: boolean;
  checking?: boolean;
  onPress?: jest.Mock;
} = {}): Promise<{ renderer: Renderer; onPress: jest.Mock }> {
  const onPress = options.onPress ?? jest.fn();
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      presentation(
        <ProjectContextStrip
          disabled={options.disabled ?? false}
          checking={options.checking ?? false}
          projectName="demo"
          state={options.state ?? contextState('ready')}
          onPress={onPress}
        />,
        options.locale ?? 'en-US',
      ),
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return { renderer, onPress };
}

function stripButton(root: ReactTestInstance): ReactTestInstance {
  const button = root
    .findAll(node => node.props.accessibilityRole === 'button')
    .find(node => typeof node.props.onPress === 'function');
  if (button === undefined) throw new Error('context strip button missing');
  return button;
}

test.each([
  ['setup_required', 'Setup required'],
  ['checking', 'Checking'],
  ['ready', 'Ready'],
  ['stale', 'Stale'],
  ['partial', 'Ready · Partial'],
  ['error', 'Error'],
  ['unavailable', 'Unavailable'],
] as const)('renders the %s state with text and an icon', async (status, label) => {
  const { renderer } = await renderStrip({ state: contextState(status) });

  expect(renderer.root.findByProps({ children: label })).toBeDefined();
  expect(renderer.root.findAllByType(AppIcon).length).toBeGreaterThanOrEqual(1);
  expect(stripButton(renderer.root).props.accessibilityLabel).toContain(label);
});

test('distinguishes prepared disclosure states from confirmed readiness', async () => {
  const reviewRequired = contextState('setup_required', {
    activePreparationId: 'prepare-1',
    snapshot: manifest,
    consent: null,
  });
  const reviewPartial = contextState('partial', {
    activePreparationId: 'prepare-2',
    snapshot: partialManifest,
    consent: null,
  });
  const confirmedPartial = contextState('partial', {
    activePreparationId: null,
    snapshot: partialManifest,
    consent,
  });

  for (const [state, label] of [
    [reviewRequired, 'Review required'],
    [reviewPartial, 'Review partial'],
    [confirmedPartial, 'Ready · Partial'],
  ] as const) {
    const { renderer } = await renderStrip({ state });
    expect(renderer.root.findByProps({ children: label })).toBeDefined();
    expect(stripButton(renderer.root).props.accessibilityLabel).toContain(label);
  }
});

test('shows Checking while the controller is inspecting a persisted snapshot', async () => {
  const { renderer } = await renderStrip({
    state: contextState('ready'),
    checking: true,
  });

  expect(renderer.root.findByProps({ children: 'Checking' })).toBeDefined();
  expect(stripButton(renderer.root).props.accessibilityLabel).toContain(
    'Checking',
  );
  expect(JSON.stringify(renderer.toJSON())).not.toContain('Ready · Partial');
});

test.each([
  [{ activePreparationId: 'prepare-live' }, 'Review required'],
  [{ staleReason: 'project_changed' }, 'Stale'],
  [{ errorCode: 'E_CONTEXT_TIMEOUT' }, 'Error'],
  [
    {
      snapshot: {
        ...manifest,
        project_id: '99999999-9999-4999-8999-999999999999',
      },
    },
    'Review required',
  ],
] as const)(
  'never presents a typed but unsendable ready state as Ready',
  async (overrides, expected) => {
    const { renderer } = await renderStrip({
      state: contextState('ready', overrides),
    });
    expect(renderer.root.findByProps({ children: expected })).toBeDefined();
    expect(
      renderer.root.findAllByProps({ children: 'Ready' }),
    ).toHaveLength(0);
  },
);

test('distinguishes an unchecked branch from a detached HEAD', async () => {
  const setup = await renderStrip({ state: contextState('setup_required') });
  const setupLabel = stripButton(setup.renderer.root).props
    .accessibilityLabel as string;
  expect(setupLabel).toContain('Branch not checked');
  expect(setupLabel).not.toContain('Detached HEAD');

  const detached = await renderStrip({
    state: contextState('ready', {
      snapshot: { ...manifest, branch: null },
    }),
  });
  expect(
    stripButton(detached.renderer.root).props.accessibilityLabel,
  ).toContain('Detached HEAD');
});

test('announces exact ready metadata and the persistent read-only boundary', async () => {
  const { renderer } = await renderStrip();
  const label = stripButton(renderer.root).props.accessibilityLabel as string;

  expect(label).toContain('demo');
  expect(label).toContain('main');
  expect(label).toContain('2 changed');
  expect(label).toContain('3 files');
  expect(label).not.toContain('4 files');
  expect(label).toContain('6.1 KB');
  expect(label).toContain('256 KB');
  expect(label).toContain('Ready');
  expect(label).toContain('Read-only context');
  expect(renderer.root.findByProps({ children: 'Read-only context' })).toBeDefined();
});

test.each([
  [{ clean: true, conflicted: false }, 'Clean'],
  [{ clean: false, conflicted: false }, 'Changed'],
  [{ clean: false, conflicted: true }, 'Conflicted'],
] as const)('does not encode repository state by color alone', async (flags, label) => {
  const state = contextState('ready', {
    snapshot: { ...manifest, ...flags },
  });
  const { renderer } = await renderStrip({ state });

  expect(renderer.root.findByProps({ children: label })).toBeDefined();
  expect(stripButton(renderer.root).props.accessibilityLabel).toContain(label);
});

test('is a Dynamic Type-safe 44 point target and invokes the detail action', async () => {
  const { renderer, onPress } = await renderStrip();
  const button = stripButton(renderer.root);
  const rawStyle =
    typeof button.props.style === 'function'
      ? button.props.style({ pressed: false })
      : button.props.style;
  const style = StyleSheet.flatten(rawStyle);

  expect(style.minHeight).toBeGreaterThanOrEqual(44);
  expect(style.height).toBeUndefined();
  const primary = renderer.root.findByProps({
    testID: 'project-context-strip-primary',
  });
  expect(primary.props.numberOfLines).toBeUndefined();
  renderer.root.findAllByType(Text).forEach(node => {
    expect(node.props.allowFontScaling).not.toBe(false);
  });

  await act(async () => button.props.onPress());
  expect(onPress).toHaveBeenCalledTimes(1);
});

test('exposes disabled state without changing the read-only message', async () => {
  const { renderer, onPress } = await renderStrip({ disabled: true });
  const button = stripButton(renderer.root);

  expect(button.props.disabled).toBe(true);
  expect(button.props.accessibilityState).toEqual({ disabled: true });
  expect(button.props.accessibilityLabel).toContain('Read-only context');
  await act(async () => button.props.onPress());
  expect(onPress).not.toHaveBeenCalled();
});

test('rejects an enabled press callback captured before the strip is disabled', async () => {
  const state = contextState('ready');
  const onPress = jest.fn();
  const { renderer } = await renderStrip({ state, onPress });
  const stalePress = stripButton(renderer.root).props.onPress;
  await act(async () => {
    renderer.update(
      presentation(
        <ProjectContextStrip
          disabled
          projectName="demo"
          state={state}
          onPress={onPress}
        />,
        'en-US',
      ),
    );
  });

  await act(async () => stalePress());
  expect(onPress).not.toHaveBeenCalled();
});

test('renders localized Chinese metadata and keeps translation keys identical', async () => {
  const { renderer } = await renderStrip({ locale: 'zh-CN' });
  const label = stripButton(renderer.root).props.accessibilityLabel as string;

  expect(label).toContain('就绪');
  expect(label).toContain('只读上下文');
  expect(label).toContain('3 个文件');
  expect(Object.keys(TRANSLATIONS['zh-CN']).sort()).toEqual(
    Object.keys(TRANSLATIONS['en-US']).sort(),
  );
});

test('defines the complete localized strip vocabulary', () => {
  const requiredKeys = [
    'context.strip.status.setupRequired',
    'context.strip.status.reviewRequired',
    'context.strip.status.checking',
    'context.strip.status.ready',
    'context.strip.status.stale',
    'context.strip.status.partial',
    'context.strip.status.reviewPartial',
    'context.strip.status.readyPartial',
    'context.strip.status.error',
    'context.strip.status.unavailable',
    'context.strip.repository.clean',
    'context.strip.repository.changed',
    'context.strip.repository.conflicted',
    'context.strip.branch.detached',
    'context.strip.branch.unchecked',
    'context.strip.changedCount',
    'context.strip.fileCount',
    'context.strip.byteBudget',
    'context.strip.estimatedTokens',
    'context.strip.readOnly',
    'context.strip.openDetails',
    'context.strip.accessibility',
  ] as const;

  for (const locale of ['en-US', 'zh-CN'] as const) {
    for (const key of requiredKeys) {
      expect(
        Object.prototype.hasOwnProperty.call(TRANSLATIONS[locale], key),
      ).toBe(true);
      expect(TRANSLATIONS[locale][key as keyof typeof TRANSLATIONS['en-US']]).toBeTruthy();
    }
  }
  expect(PROJECT_CONTEXT_MAX_BYTES).toBe(262144);
});
