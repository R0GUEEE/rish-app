import {
  createAgentTurnService,
  LEGACY_AGENT_TURN_DISABLED_CODE,
  type AgentTurnServiceDeps,
} from '../src/agent/AgentTurnService';
import { workspaceRoot } from '../src/native/WorkspaceRoot';

const ROOT = workspaceRoot(
  '11111111-1111-4111-8111-111111111111',
  1,
  '22222222-2222-4222-8222-222222222222',
);

function makeDeps() {
  const append = jest.fn();
  const requestApproval = jest.fn();
  const askQuestion = jest.fn();
  const cancelPending = jest.fn();
  const modelCalls = jest.fn();
  const getGitHttpsProxyUrl = jest.fn(() => 'http://127.0.0.1:7890/');
  const createApprovalId = jest.fn(() => 'approval-id');
  const createQuestionId = jest.fn(() => 'question-id');
  const deps = {
    journal: { append },
    interactions: { requestApproval, askQuestion, cancelPending },
    modelCalls,
    getGitHttpsProxyUrl,
    createApprovalId,
    createQuestionId,
  } as unknown as AgentTurnServiceDeps;
  return {
    deps,
    append,
    requestApproval,
    askQuestion,
    cancelPending,
    modelCalls,
    getGitHttpsProxyUrl,
    createApprovalId,
    createQuestionId,
  };
}

function input() {
  return {
    root: ROOT,
    model: 'deepseek-v4-flash',
    thinkingMode: 'high',
    history: [{ role: 'user' as const, content: 'write a file' }],
    tools: [{ name: 'write_file' }],
    requestId: 'attempt-1',
    toolPermission: 'workspace-write' as const,
    operationId: '33333333-3333-4333-8333-333333333333',
    credentialReference: 'credential-reference',
  };
}

test('start fails closed with a stable disabled result', async () => {
  const harness = makeDeps();
  const service = createAgentTurnService(harness.deps);

  await expect(service.start(input())).resolves.toEqual({
    status: 'failed',
    finalText: null,
    traces: [],
    exhausted: false,
    failure: { code: LEGACY_AGENT_TURN_DISABLED_CODE },
  });
  expect(service.isRunning()).toBe(false);

  await expect(service.start(input())).resolves.toMatchObject({
    status: 'failed',
    failure: { code: LEGACY_AGENT_TURN_DISABLED_CODE },
  });
  expect(service.isRunning()).toBe(false);
});

test('start never calls provider, journal, or interaction brokers', async () => {
  const harness = makeDeps();
  const service = createAgentTurnService(harness.deps);

  await service.start(input());

  expect(harness.modelCalls).not.toHaveBeenCalled();
  expect(harness.getGitHttpsProxyUrl).not.toHaveBeenCalled();
  expect(harness.createApprovalId).not.toHaveBeenCalled();
  expect(harness.createQuestionId).not.toHaveBeenCalled();
  expect(harness.append).not.toHaveBeenCalled();
  expect(harness.requestApproval).not.toHaveBeenCalled();
  expect(harness.askQuestion).not.toHaveBeenCalled();
  expect(harness.cancelPending).not.toHaveBeenCalled();
});

test('cancel only settles an already-open interaction wait', () => {
  const harness = makeDeps();
  const service = createAgentTurnService(harness.deps);

  service.cancel();

  expect(harness.cancelPending).toHaveBeenCalledTimes(1);
  expect(harness.modelCalls).not.toHaveBeenCalled();
  expect(harness.append).not.toHaveBeenCalled();
  expect(service.isRunning()).toBe(false);
});
