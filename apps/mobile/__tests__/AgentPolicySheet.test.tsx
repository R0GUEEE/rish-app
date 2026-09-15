import React from 'react';
import * as ReactNative from 'react-native';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { AgentPolicySheet, AGENT_POLICY_DEFAULT_BUDGET } from '../src/components/AgentPolicySheet';
import { darkColors } from '../src/theme';

let mockInsets = { top: 59, right: 0, bottom: 34, left: 0 };
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const props: React.ComponentProps<typeof AgentPolicySheet> = {
  visible: true,
  workspaceName: 'Preview',
  capabilities: ['file_read', 'file_write'],
  budget: AGENT_POLICY_DEFAULT_BUDGET,
  policyStatus: 'ready',
  onRetryPolicy: jest.fn(),
  toolAccess: {
    list_dir: 'auto', read_file: 'auto', write_file: 'conversation_confirm',
    git_status: 'not_enabled', git_commit: 'not_enabled', git_push: 'not_enabled',
    start_guest_cgi: 'conversation_confirm', stop_guest_cgi: 'conversation_confirm',
    list_runtime_environments: 'auto', install_runtime_environment: 'conversation_confirm',
    run_program: 'conversation_confirm', start_runtime_service: 'conversation_confirm',
    stop_runtime_service: 'conversation_confirm',
  },
  grants: [],
  revokeBusy: false,
  revokeFailed: null,
  onClose: jest.fn(),
  onRevoke: jest.fn(),
};
const renderers: ReactTestRenderer[] = [];
let dismiss: jest.SpyInstance;
const originalDimensions = ReactNative.Dimensions.get('window');

beforeEach(() => {
  mockInsets = { top: 59, right: 0, bottom: 34, left: 0 };
  ReactNative.Dimensions.set({ window: { width: 390, height: 844, scale: 3, fontScale: 1 } });
  dismiss = jest.spyOn(ReactNative.Keyboard, 'dismiss').mockImplementation(() => undefined);
});
afterEach(() => {
  act(() => { renderers.splice(0).forEach(renderer => renderer.unmount()); });
  ReactNative.Dimensions.set({ window: originalDimensions });
  jest.restoreAllMocks();
});

async function render(overrides: Partial<typeof props> = {}) {
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(<AgentPolicySheet {...props} {...overrides} />);
  });
  renderers.push(renderer);
  return renderer;
}

test.each([
  { width: 390, height: 844, top: 59, bottom: 34, side: 0 },
  { width: 320, height: 568, top: 20, bottom: 0, side: 0 },
  { width: 844, height: 390, top: 0, bottom: 21, side: 59 },
  { width: 1024, height: 1366, top: 24, bottom: 20, side: 0 },
])('bounds the entire card within safe space at $width × $height', async screen => {
  ReactNative.Dimensions.set({ window: { width: screen.width, height: screen.height, scale: 3, fontScale: 1 } });
  mockInsets = { top: screen.top, bottom: screen.bottom, left: screen.side, right: screen.side };
  const renderer = await render();
  const viewport = renderer.root.findByProps({ testID: 'agent-policy-viewport' });
  const viewportStyle = ReactNative.StyleSheet.flatten(viewport.props.style);
  const card = renderer.root.findByProps({ testID: 'agent-policy-card' });
  const cardStyle = ReactNative.StyleSheet.flatten(card.props.style);
  const safeHeight = screen.height - Math.max(screen.top, 12) - Math.max(screen.bottom, 12);
  expect(viewportStyle.paddingTop).toBeGreaterThanOrEqual(screen.top);
  expect(viewportStyle.paddingBottom).toBeGreaterThanOrEqual(screen.bottom);
  expect(viewportStyle.paddingLeft).toBeGreaterThanOrEqual(screen.side);
  expect(viewportStyle.paddingRight).toBeGreaterThanOrEqual(screen.side);
  expect(viewportStyle.justifyContent).toBe('center');
  expect(cardStyle.maxHeight).toBeGreaterThan(0);
  expect(cardStyle.maxHeight).toBeLessThan(safeHeight);
  expect(cardStyle.maxWidth).toBeLessThanOrEqual(640);
  expect(cardStyle.flexShrink).toBe(1);
  const scroller = card.findByProps({ testID: 'agent-policy-scroll' });
  expect(ReactNative.StyleSheet.flatten(scroller.props.style).flexShrink).toBe(1);
  expect(scroller.findAllByProps({ testID: 'agent-policy-close' })).toHaveLength(0);
  expect(scroller.findByProps({ testID: 'agent-policy-budget' })).toBeDefined();
  expect(scroller.findByProps({ testID: 'agent-policy-grants' })).toBeDefined();
});

test('dims the chat behind the dialog and supports backdrop, button, and system closing', async () => {
  const onClose = jest.fn();
  const renderer = await render({ onClose });
  const backdrop = renderer.root.findByProps({ testID: 'agent-policy-backdrop' });
  expect(ReactNative.StyleSheet.flatten(backdrop.props.style)).toMatchObject({
    position: 'absolute', top: 0, bottom: 0, left: 0, right: 0,
    backgroundColor: darkColors.scrim,
  });
  const modal = renderer.root.findByType(ReactNative.Modal);
  expect(modal.props.presentationStyle).toBe('overFullScreen');
  await act(async () => { backdrop.props.onPress(); });
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => { renderer.root.findByProps({ testID: 'agent-policy-close' }).props.onPress(); });
  expect(onClose).toHaveBeenCalledTimes(2);
  await act(async () => { modal.props.onRequestClose(); });
  expect(onClose).toHaveBeenCalledTimes(3);
});

test('dismisses an inherited composer keyboard on each opening and keeps modal-local avoidance', async () => {
  const renderer = await render({ visible: false });
  expect(dismiss).not.toHaveBeenCalled();
  await act(async () => { renderer.update(<AgentPolicySheet {...props} />); });
  expect(dismiss).toHaveBeenCalledTimes(1);
  const avoider = renderer.root.findByType(ReactNative.KeyboardAvoidingView);
  expect(avoider.props.behavior).toBe(ReactNative.Platform.OS === 'ios' ? 'padding' : 'height');
  expect(avoider.props.pointerEvents).toBe('box-none');
  expect(avoider.findByProps({ testID: 'agent-policy-card' })).toBeDefined();
  await act(async () => { renderer.update(<AgentPolicySheet {...props} revokeFailed="persistence" />); });
  expect(dismiss).toHaveBeenCalledTimes(1);
  expect(renderer.root.findByProps({ testID: 'agent-policy-scroll' })
    .findByProps({ testID: 'agent-policy-revoke-error' })).toBeDefined();
  await act(async () => { renderer.update(<AgentPolicySheet {...props} visible={false} />); });
  await act(async () => { renderer.update(<AgentPolicySheet {...props} />); });
  expect(dismiss).toHaveBeenCalledTimes(2);
});


test('shows live access and enables Git only after writable permissions are known', async () => {
  const onEnableWorkspaceGit = jest.fn();
  const renderer = await render({ gitProjectRequired: true, gitActivationAvailable: true, onEnableWorkspaceGit });
  const button = renderer.root.findByProps({ testID: 'agent-policy-enable-git' });
  expect(button.props.disabled).toBe(false);
  await act(async () => { button.props.onPress(); });
  expect(onEnableWorkspaceGit).toHaveBeenCalledTimes(1);
  await act(async () => { renderer.update(<AgentPolicySheet {...props} gitProjectRequired gitActivationAvailable
      policyStatus="loading" budget={null} onEnableWorkspaceGit={onEnableWorkspaceGit} />); });
  expect(renderer.root.findByProps({ testID: 'agent-policy-enable-git' }).props.disabled).toBe(true);
  expect(renderer.root.findAllByProps({ testID: 'agent-policy-budget' })).toHaveLength(0);
  expect(renderer.root.findByProps({ testID: 'agent-policy-retry' }).props.disabled).toBe(true);
});

test('failed policy reads offer a retry and do not expose raw Git errors', async () => {
  const onRetryPolicy = jest.fn();
  const renderer = await render({ policyStatus: 'error', budget: null, onRetryPolicy,
    gitProjectRequired: true, gitActivationError: 'private filesystem path' });
  await act(async () => { renderer.root.findByProps({ testID: 'agent-policy-retry' }).props.onPress(); });
  expect(onRetryPolicy).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(renderer.toJSON())).not.toContain('private filesystem path');
});


test('shows all runtime tools with their effective access modes', async () => {
  const renderer = await render();
  const tools = [
    ['list_runtime_environments', 'List language environments', 'Automatic'],
    ['install_runtime_environment', 'Install a language environment', 'Approval required'],
    ['run_program', 'Run a program', 'Approval required'],
    ['start_runtime_service', 'Start a program server', 'Approval required'],
    ['stop_runtime_service', 'Stop the program server', 'Approval required'],
  ];
  for (const [name, label, access] of tools) {
    expect(renderer.root.findAllByProps({ children: label }).length).toBeGreaterThan(0);
    expect(renderer.root.findByProps({ testID: `agent-policy-access-${name}` }).props.children).toBe(access);
  }
});
