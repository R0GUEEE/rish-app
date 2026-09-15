import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { Alert, Dimensions, Keyboard, NativeModules, ScrollView, Text, TurboModuleRegistry } from 'react-native';
import { RuntimeEnvironmentSheet } from '../src/components/runtime-environment-sheet';
import { RuntimeProgramSheet } from '../src/components/runtime-program-sheet';
import { LocalWorkspaces } from '../src/native/LocalWorkspaces';
import { environment, environmentNative, programNative, receipt, root, workspaceId } from '../test-fixtures/runtime-environments';

jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 59, bottom: 34, left: 0, right: 0 }) }));
jest.mock('../src/native/LocalWorkspaces', () => ({ LocalWorkspaces: { resolve: jest.fn() } }));
const renderers: ReactTestRenderer[] = [];
const turbo = jest.spyOn(TurboModuleRegistry, 'get'), dismiss = jest.spyOn(Keyboard, 'dismiss');
let env: ReturnType<typeof environmentNative>, program: ReturnType<typeof programNative>;
const originalSize = Dimensions.get('window');
beforeEach(() => {
  jest.useFakeTimers(); env = environmentNative(); program = programNative();
  NativeModules.LocalEnvironments = env; NativeModules.LocalPrograms = program; turbo.mockReturnValue(null);
  dismiss.mockImplementation(() => undefined);
  (LocalWorkspaces.resolve as jest.Mock).mockResolvedValue({ schema_version: 1, disposition: 'direct', workspace: {
    workspace_id: workspaceId, binding_revision: 1, status: 'ok',
  } });
  Dimensions.set({ window: { width: 375, height: 667, scale: 2, fontScale: 1 } });
});
afterEach(async () => {
  await act(async () => { renderers.splice(0).forEach(renderer => renderer.unmount()); });
  jest.useRealTimers(); Dimensions.set({ window: originalSize });
});
afterAll(() => { turbo.mockRestore(); dismiss.mockRestore(); delete NativeModules.LocalEnvironments; delete NativeModules.LocalPrograms; });
async function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer; await act(async () => { renderer = create(element); });
  renderers.push(renderer); return renderer;
}
const allText = (renderer: ReactTestRenderer) => renderer.root.findAllByType(Text).map(node => node.props.children).flat(Infinity).join(' ');
const testNode = (renderer: ReactTestRenderer, testID: string) => renderer.root.findAllByProps({ testID })[0];
async function press(renderer: ReactTestRenderer, testID: string) {
  await act(async () => { testNode(renderer, testID).props.onPress(); });
}
test('manager shows all six languages with honest unpublished states, no implicit downloads', async () => {
  const renderer = await render(<RuntimeEnvironmentSheet visible onClose={jest.fn()} workspaceId={null} />);
  for (const label of ['Python', 'Java', 'Go', 'Rust', 'Bun', 'Node.js']) expect(allText(renderer)).toContain(label);
  expect(allText(renderer)).toContain('No package is published');
  expect(testNode(renderer, 'runtime-cancel')).toBeUndefined();
  expect(env.installEnvironment).not.toHaveBeenCalled(); expect(env.downloadEnvironment).not.toHaveBeenCalled();
});
test('safe-area modal has full backdrop, scroll and bounded card, with reachable close', async () => {
  const close = jest.fn();
  const renderer = await render(<RuntimeEnvironmentSheet visible onClose={close} workspaceId={workspaceId} />);
  expect(dismiss).toHaveBeenCalled(); expect(renderer.root.findAllByType(ScrollView).length).toBe(1);
  const card = renderer.root.findAllByProps({ testID: 'runtime-environment-sheet' }).find(node => node.props.style !== undefined)!;
  expect(card.props.style).toContainEqual(expect.objectContaining({ maxHeight: (667 - 59 - 34) * 0.9 }));
  await press(renderer, 'runtime-environment-sheet-backdrop'); await press(renderer, 'runtime-environment-sheet-close');
  expect(close).toHaveBeenCalledTimes(2);
});
test('choose an uninstalled package records only preference; explicit Install starts download', async () => {
  env.listEnvironments.mockResolvedValue({ schema_version: 1, environments: [environment()], selected_environment_id: null });
  const renderer = await render(<RuntimeEnvironmentSheet visible onClose={jest.fn()} workspaceId={workspaceId} />);
  await press(renderer, 'runtime-select-python-3-13');
  expect(env.selectEnvironment).toHaveBeenCalledWith({ schema_version: 1, workspace_id: workspaceId, environment_id: 'python-3-13' });
  expect(env.installEnvironment).not.toHaveBeenCalled();
  await press(renderer, 'runtime-install-python-3-13'); expect(env.installEnvironment).toHaveBeenCalledTimes(1);
});
test('manager exposes explicit cancellation for an Agent download even when this sheet started no operation', async () => {
  env.listEnvironments.mockResolvedValue({ schema_version: 1,
    environments: [environment({ state: 'downloading', downloaded_bytes: 100 })], selected_environment_id: null });
  const close = jest.fn();
  const renderer = await render(<RuntimeEnvironmentSheet visible onClose={close} workspaceId={workspaceId} />);
  expect(testNode(renderer, 'runtime-cancel')).toBeDefined();
  expect(env.installEnvironment).not.toHaveBeenCalled();
  await press(renderer, 'runtime-environment-sheet-close');
  await act(async () => { renderer.update(<RuntimeEnvironmentSheet visible={false} onClose={close} workspaceId={workspaceId} />); });
  expect(close).toHaveBeenCalledTimes(1); expect(env.cancelInstall).not.toHaveBeenCalled();
  await act(async () => { renderer.update(<RuntimeEnvironmentSheet visible onClose={close} workspaceId={workspaceId} />); });
  env.listEnvironments.mockResolvedValue({ schema_version: 1,
    environments: [environment({ state: 'failed', error_code: 'E_ENV_CANCELLED' })], selected_environment_id: null });
  await press(renderer, 'runtime-cancel');
  expect(env.cancelInstall).toHaveBeenCalledWith({ schema_version: 1 });
  expect(testNode(renderer, 'runtime-cancel')).toBeUndefined();
  expect(testNode(renderer, 'runtime-install-python-3-13').props.disabled).toBe(false);
  env.listEnvironments.mockResolvedValue({ schema_version: 1,
    environments: [environment({ state: 'installed' })], selected_environment_id: null });
  await press(renderer, 'runtime-install-python-3-13');
  expect(env.installEnvironment).toHaveBeenCalledTimes(1);
  expect(allText(renderer)).toContain('Installed');
  expect(testNode(renderer, 'runtime-cancel')).toBeUndefined();
});
test('rejects credential-bearing URL locally and imports only when clicked', async () => {
  const renderer = await render(<RuntimeEnvironmentSheet visible onClose={jest.fn()} workspaceId={workspaceId} />);
  await act(async () => { testNode(renderer, 'runtime-url').props.onChangeText('https://user:password@example.test/a.rishenv'); });
  await press(renderer, 'runtime-download-url'); expect(env.downloadEnvironment).not.toHaveBeenCalled();
  expect(allText(renderer)).toContain('without credentials');
  await press(renderer, 'runtime-import'); expect(env.importEnvironment).toHaveBeenCalledTimes(1);
});
test('Delete names selected package and requires destructive alert button before native delete', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
  env.listEnvironments.mockResolvedValue({ schema_version: 1, environments: [environment({ state: 'installed' })], selected_environment_id: null });
  const renderer = await render(<RuntimeEnvironmentSheet visible onClose={jest.fn()} workspaceId={workspaceId} />);
  await press(renderer, 'runtime-delete-python-3-13'); expect(env.removeEnvironment).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[0][2]!; expect(buttons[1]).toMatchObject({ style: 'destructive' });
  await act(async () => { buttons[1].onPress!(); });
  expect(env.removeEnvironment).toHaveBeenCalledWith({ schema_version: 1, environment_id: 'python-3-13' }); alert.mockRestore();
});
test('Run is usable without API key and reports literal arguments, stdout, stderr and exit', async () => {
  const renderer = await render(<RuntimeProgramSheet visible onClose={jest.fn()} root={root} />);
  expect(allText(renderer)).toContain('No model API key is required');
  expect(testNode(renderer, 'runtime-run').props.disabled).toBe(false);
  expect(allText(renderer)).toContain('not written back to your project');
  await act(async () => {
    testNode(renderer, 'runtime-entry').props.onChangeText('src/main.py');
    testNode(renderer, 'runtime-args').props.onChangeText('["hello world", "$(ignored)"]');
  });
  await press(renderer, 'runtime-run');
  expect(program.startProgram).toHaveBeenCalledWith(expect.objectContaining({ entry_path: 'src/main.py', args: ['hello world', '$(ignored)'] }));
  program.programStatus.mockResolvedValue(receipt({ status: 'completed', stdout: 'hello world', stderr: 'diagnostic', exit_code: 4 }));
  await act(async () => { jest.advanceTimersByTime(500); });
  expect(allText(renderer)).toContain('hello world'); expect(allText(renderer)).toContain('diagnostic'); expect(allText(renderer)).toContain('Exit code: 4');
});
test('invalid entry and argument JSON prevent any selected environment download', async () => {
  const renderer = await render(<RuntimeProgramSheet visible onClose={jest.fn()} root={root} />);
  await act(async () => { testNode(renderer, 'runtime-entry').props.onChangeText('../main.py'); });
  await press(renderer, 'runtime-run'); expect(allText(renderer)).toContain('Use a relative file path');
  await act(async () => { testNode(renderer, 'runtime-entry').props.onChangeText('main.py'); testNode(renderer, 'runtime-args').props.onChangeText('[true]'); });
  await press(renderer, 'runtime-run'); expect(allText(renderer)).toContain('JSON array of up to 64 strings');
  expect(env.installEnvironment).not.toHaveBeenCalled(); expect(program.startProgram).not.toHaveBeenCalled();
});
test('native unavailable disables Run and does not pretend language support exists', async () => {
  delete NativeModules.LocalPrograms; delete NativeModules.LocalEnvironments;
  const renderer = await render(<RuntimeProgramSheet visible onClose={jest.fn()} root={root} />);
  expect(testNode(renderer, 'runtime-run').props.disabled).toBe(true);
  expect(allText(renderer)).toContain('not available in this version');
});
test.each([
  { root: { ...root, workspace_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, ownerKey: 'chat-a', visible: true },
  { root: { ...root, binding_revision: 2 }, ownerKey: 'chat-a', visible: true },
  { root: { ...root, project_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, ownerKey: 'chat-a', visible: true },
  { root, ownerKey: 'chat-b', visible: true },
  { root, ownerKey: 'chat-a', visible: false },
])('clears source and arguments when program form ownership changes: %j', async next => {
  const close = jest.fn();
  const renderer = await render(<RuntimeProgramSheet visible onClose={close} root={root} ownerKey="chat-a" />);
  await act(async () => {
    testNode(renderer, 'runtime-entry').props.onChangeText('previous-workspace.py');
    testNode(renderer, 'runtime-args').props.onChangeText('["previous argument"]');
  });
  await act(async () => { renderer.update(<RuntimeProgramSheet {...next} onClose={close} />); });
  if (!next.visible) {
    await act(async () => { renderer.update(<RuntimeProgramSheet {...next} visible onClose={close} />); });
  }
  expect(testNode(renderer, 'runtime-entry').props.value).toBe('');
  expect(testNode(renderer, 'runtime-args').props.value).toBe('[]');
  expect(program.startProgram).not.toHaveBeenCalled();
});
