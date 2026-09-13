import { DeviceEventEmitter, NativeModules } from 'react-native';

import { nativeAgentRoundPreviewSource } from '../src/agent/AgentRoundPreviewSource';

const body = {
  schema_version: 1,
  kind: 'delta',
  task_id: 'task-1',
  attempt_id: 'attempt-1',
  round_id: 'round-1',
  round_index: 0,
  operation_id: 'op-1',
  provider_request_id: 'req-1',
  harness_id: 'dsh',
  seq: 1,
  text: 'Hello',
};

describe('nativeAgentRoundPreviewSource', () => {
  const modules = NativeModules as Record<string, unknown>;
  afterEach(() => {
    delete modules.AgentRuntime;
  });

  test('yields nothing without the native module', () => {
    delete modules.AgentRuntime;
    const listener = jest.fn();
    const unsubscribe = nativeAgentRoundPreviewSource(listener);
    DeviceEventEmitter.emit('agentRoundPreview', body);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  test('delivers parsed events, drops malformed ones, and stops after unsubscribe', () => {
    modules.AgentRuntime = { addListener: jest.fn(), removeListeners: jest.fn() };
    const listener = jest.fn();
    const unsubscribe = nativeAgentRoundPreviewSource(listener);
    DeviceEventEmitter.emit('agentRoundPreview', { ...body, seq: 0 });
    DeviceEventEmitter.emit('agentRoundPreview', 'not an object');
    expect(listener).not.toHaveBeenCalled();
    DeviceEventEmitter.emit('agentRoundPreview', body);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toMatchObject({
      kind: 'delta',
      attemptId: 'attempt-1',
      roundId: 'round-1',
      operationId: 'op-1',
      seq: 1,
      text: 'Hello',
    });
    unsubscribe();
    DeviceEventEmitter.emit('agentRoundPreview', { ...body, seq: 2 });
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
