const mockNativeLocalWorkspaces = {
  list: jest.fn(),
  resolveMetadata: jest.fn(),
  queryOperation: jest.fn(),
  create: jest.fn(),
  presentFolderPicker: jest.fn(),
  grantFolder: jest.fn(),
  importFolder: jest.fn(),
  forget: jest.fn(),
  deleteOwnedContent: jest.fn(),
  cancelPicker: jest.fn(),
};

import React from 'react';
import { Modal, StyleSheet } from 'react-native';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalWorkspaces =
  mockNativeLocalWorkspaces;
const { WorkspacePickerSheet } = jest.requireActual(
  '../src/components/WorkspacePickerSheet',
) as typeof import('../src/components/WorkspacePickerSheet');

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const activeRoots: ReactTestRenderer.ReactTestRenderer[] = [];

beforeEach(() => {
  jest.resetAllMocks();
});

afterEach(() => {
  while (activeRoots.length > 0) {
    activeRoots.pop()?.unmount();
  }
});

function descriptor(id: string, name: string, status = 'ok') {
  return {
    schema_version: 2 as const,
    workspace_id: id,
    display_name: name,
    origin: 'rish_created' as const,
    created_at: '2026-08-27T01:00:00.000Z',
    last_opened_at: '2026-08-27T01:00:00.000Z',
    status,
    binding_revision: 1,
    capabilities: {
      read: false,
      write: false,
      git: false,
      project_context: false,
      files_visible: true,
    },
  };
}

function presentation(children: React.ReactNode) {
  const { AppPresentationProvider } = jest.requireActual(
    '../src/presentation/AppPresentation',
  ) as typeof import('../src/presentation/AppPresentation');
  const { createDefaultPreferences, createPreferencesStore } = jest.requireActual(
    '../src/preferences',
  ) as typeof import('../src/preferences');
  const store = createPreferencesStore({
    initialPreferences: {
      ...createDefaultPreferences(),
      locale: 'en-US',
    },
  });
  return (
    <AppPresentationProvider store={store}>{children}</AppPresentationProvider>
  );
}

async function renderSheet(
  props: {
    activeWorkspaceId?: string | null;
    onClose?: jest.Mock;
    onSelect?: jest.Mock<void, [string]>;
  } = {},
): Promise<Renderer> {
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      presentation(
        <WorkspacePickerSheet
          activeWorkspaceId={props.activeWorkspaceId ?? null}
          visible
          onClose={props.onClose ?? jest.fn()}
          onSelect={props.onSelect ?? jest.fn()}
        />,
      ),
    );
  });
  await act(async () => {});
  if (renderer === undefined) throw new Error('renderer was not created');
  activeRoots.push(renderer);
  return renderer;
}

function actionByLabel(root: ReactTestInstance, label: string) {
  const action = root
    .findAllByProps({ accessibilityLabel: label })
    .find(instance => typeof instance.props.onPress === 'function');
  if (action === undefined) throw new Error(`no actionable ${label}`);
  return action;
}

test('presents through a modal whose scrim fades instead of sliding', async () => {
  mockNativeLocalWorkspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [],
  });

  const renderer = await renderSheet();

  const modal = renderer.root.findByType(Modal);
  expect(modal.props.animationType).toBe('none');
  expect(modal.props.presentationStyle).toBe('overFullScreen');
  const backdrop = renderer.root.findByProps({
    testID: 'workspace-picker-backdrop',
  });
  const backdropStyle = StyleSheet.flatten(backdrop.props.style);
  // The scrim's opacity is an Animated value, so it fades in place; only the
  // card itself translates. A static sliding modal would not carry opacity.
  expect(backdropStyle.opacity).toBeDefined();
  expect(typeof backdropStyle.backgroundColor).toBe('string');
  expect(backdropStyle.backgroundColor).toContain('rgba');
});

test('lists workspaces with structured access states', async () => {
  mockNativeLocalWorkspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [
      descriptor('ws-alpha', 'Alpha'),
      descriptor('ws-beta', 'Beta', 'revoked'),
    ],
  });

  const renderer = await renderSheet({ activeWorkspaceId: 'ws-alpha' });

  expect(actionByLabel(renderer.root, 'Use Alpha')).toBeDefined();
  expect(actionByLabel(renderer.root, 'Use Beta').props.accessibilityState)
    .toEqual({ checked: false, disabled: true });
  expect(
    actionByLabel(renderer.root, 'Use Alpha').props.accessibilityState,
  ).toEqual({ checked: true, disabled: false });
});

test('selects a workspace through its row without closing the sheet', async () => {
  mockNativeLocalWorkspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [descriptor('ws-alpha', 'Alpha')],
  });
  const onSelect = jest.fn();
  const renderer = await renderSheet({ onSelect });

  await act(async () => {
    actionByLabel(renderer.root, 'Use Alpha').props.onPress();
  });

  expect(onSelect).toHaveBeenCalledWith('ws-alpha');
  expect(mockNativeLocalWorkspaces.list).toHaveBeenCalledTimes(1);
});

test('creates a named Rish workspace and reloads the registry', async () => {
  mockNativeLocalWorkspaces.list
    .mockResolvedValueOnce({ schema_version: 1, workspaces: [] })
    .mockResolvedValueOnce({
      schema_version: 1,
      workspaces: [descriptor('ws-new', 'Scratch')],
    });
  mockNativeLocalWorkspaces.create.mockResolvedValue(
    descriptor('ws-new', 'Scratch'),
  );

  const renderer = await renderSheet();
  const input = renderer.root.findByProps({
    accessibilityLabel: 'Workspace name',
  });
  await act(async () => {
    input.props.onChangeText('  Scratch  ');
  });
  await act(async () => {
    actionByLabel(renderer.root, 'New workspace').props.onPress();
  });

  expect(mockNativeLocalWorkspaces.create).toHaveBeenCalledWith({
    schema_version: 1,
    display_name: 'Scratch',
    operation_id: expect.any(String),
  });
  expect(mockNativeLocalWorkspaces.list).toHaveBeenCalledTimes(2);
  expect(actionByLabel(renderer.root, 'Use Scratch')).toBeDefined();
});

test('forgets a workspace by its opaque id and reloads', async () => {
  mockNativeLocalWorkspaces.list
    .mockResolvedValueOnce({
      schema_version: 1,
      workspaces: [descriptor('ws-alpha', 'Alpha')],
    })
    .mockResolvedValueOnce({ schema_version: 1, workspaces: [] });
  mockNativeLocalWorkspaces.forget.mockResolvedValue({ schema_version: 1 });

  const renderer = await renderSheet();
  await act(async () => {
    actionByLabel(renderer.root, 'Forget Alpha').props.onPress();
  });

  expect(mockNativeLocalWorkspaces.forget).toHaveBeenCalledWith({
    schema_version: 1,
    workspace_id: 'ws-alpha',
    expected_binding_revision: 1,
  });
  expect(mockNativeLocalWorkspaces.list).toHaveBeenCalledTimes(2);
});

test('surfaces revoked folders instead of hiding them', async () => {
  mockNativeLocalWorkspaces.list.mockResolvedValue({
    schema_version: 1,
    workspaces: [descriptor('ws-beta', 'Beta', 'revoked')],
  });

  const renderer = await renderSheet();

  expect(renderer.root.findByProps({ children: 'Access revoked' })).toBeDefined();
  expect(actionByLabel(renderer.root, 'Use Beta').props.disabled).toBe(true);
});
