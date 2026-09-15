import { NativeModules, TurboModuleRegistry } from 'react-native';
import { AgentPolicy, AgentPolicyError, type AgentPolicyRequest } from '../src/native/agent-policy';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const request: AgentPolicyRequest = {
  schema_version: 1, workspace_id: workspaceId, workspace_binding_revision: 2, project_id: null,
};
const policy = () => ({
  ...request, root_fingerprint_sha256: 'a'.repeat(64), registry_version: 2, policy_version: 'agent-v1',
  capabilities: ['file_read', 'file_write', 'guest_service'],
  tools: [
    { name: 'read_file', access: 'auto' }, { name: 'write_file', access: 'conversation_confirm' },
    { name: 'start_guest_cgi', access: 'confirm_once' }, { name: 'git_push', access: 'durable_deny' },
  ],
  budget: { max_single_write_bytes: 32768, max_batch_write_bytes: 524288, max_attempt_write_bytes: 4194304 },
});
const native = { describe: jest.fn() };
const turboGet = jest.spyOn(TurboModuleRegistry, 'get');
beforeEach(() => {
  native.describe.mockReset().mockResolvedValue(policy());
  turboGet.mockReturnValue(null);
  (NativeModules as Record<string, unknown>).AgentPolicy = native;
});
afterAll(() => { turboGet.mockRestore(); delete (NativeModules as Record<string, unknown>).AgentPolicy; });

test('reads a copied, frozen descriptor without retaining native objects', async () => {
  const raw = policy();
  native.describe.mockResolvedValue(raw);
  expect(AgentPolicy.isAvailable()).toBe(true);
  const result = await AgentPolicy.describe(request);
  expect(result).toEqual(raw);
  expect(native.describe).toHaveBeenCalledWith(request);
  expect(native.describe.mock.calls[0][0]).not.toBe(request);
  raw.capabilities.push('git_push');
  raw.tools[0].access = 'durable_deny';
  raw.budget.max_single_write_bytes = 1;
  expect(result.capabilities).toEqual(['file_read', 'file_write', 'guest_service']);
  expect(result.tools[0].access).toBe('auto');
  expect(result.budget.max_single_write_bytes).toBe(32768);
  expect(Object.isFrozen(result.tools[0])).toBe(true);
});

test('uses TurboModule when legacy is absent or unimplemented and preserves method receiver', async () => {
  const turbo = { getConstants: () => ({}), describe: jest.fn(function (this: object) {
    expect(this).toBe(turbo);
    return Promise.resolve(policy());
  }) };
  (NativeModules as Record<string, unknown>).AgentPolicy = { implemented: false, describe: jest.fn() };
  turboGet.mockReturnValue(turbo);
  expect(AgentPolicy.isAvailable()).toBe(true);
  await expect(AgentPolicy.describe(request)).resolves.toMatchObject({ workspace_id: workspaceId });
  expect(turbo.describe).toHaveBeenCalledTimes(1);
  expect(native.describe).not.toHaveBeenCalled();
});

test('an older native app without this module is unavailable', async () => {
  delete (NativeModules as Record<string, unknown>).AgentPolicy;
  expect(AgentPolicy.isAvailable()).toBe(false);
  await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: 'E_AGENT_NATIVE', message: 'E_AGENT_NATIVE' });
});

test.each([
  { ...request, schema_version: 2 }, { ...request, workspace_id: workspaceId.toUpperCase().replace('1', 'A') },
  { ...request, workspace_id: `${workspaceId}\n` }, { ...request, project_id: 'private/path' },
  { ...request, workspace_binding_revision: 0 }, { ...request, workspace_binding_revision: 1.5 },
  { ...request, workspace_binding_revision: Number.MAX_SAFE_INTEGER + 1 },
  { ...request, workspace_binding_revision: NaN }, { ...request, extra: 'private' },
])('rejects invalid requests before invoking native %#', async value => {
  await expect(AgentPolicy.describe(value as AgentPolicyRequest)).rejects.toMatchObject({ code: 'E_AGENT_BAD_ARGUMENTS' });
  expect(native.describe).not.toHaveBeenCalled();
});

test.each([
  { workspace_id: projectId }, { workspace_binding_revision: 3 }, { project_id: projectId },
])('rejects a descriptor for a different root identity %#', async patch => {
  native.describe.mockResolvedValue({ ...policy(), ...patch });
  await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: 'E_AGENT_ROOT_STALE' });
});

test.each([
  { schema_version: 2 }, { workspace_binding_revision: -1 }, { project_id: 'not-a-uuid' },
  { root_fingerprint_sha256: 'A'.repeat(64) }, { root_fingerprint_sha256: `${'a'.repeat(64)}\n` },
  { registry_version: 4 }, { policy_version: 'agent-v2' }, { extra: 'secret' },
  { capabilities: ['shell'] }, { capabilities: ['file_read', 'file_read'] },
  { tools: [{ name: 'shell', access: 'auto' }] },
  { tools: [{ name: 'read_file', access: 'unverified' }] },
  { tools: [{ name: 'read_file', access: 'auto', arguments: 'secret' }] },
  { tools: [{ name: 'read_file', access: 'auto' }, { name: 'read_file', access: 'auto' }] },
  { budget: { max_single_write_bytes: 0, max_batch_write_bytes: 1, max_attempt_write_bytes: 1 } },
  { budget: { max_single_write_bytes: 2, max_batch_write_bytes: 1, max_attempt_write_bytes: 1 } },
  { budget: { max_single_write_bytes: 1, max_batch_write_bytes: 3, max_attempt_write_bytes: 2 } },
  { budget: { max_single_write_bytes: 1, max_batch_write_bytes: 2, max_attempt_write_bytes: Infinity } },
  { budget: { max_single_write_bytes: 1, max_batch_write_bytes: 2, max_attempt_write_bytes: 2.5 } },
  { budget: { max_single_write_bytes: 1, max_batch_write_bytes: 2, max_attempt_write_bytes: Number.MAX_SAFE_INTEGER + 1 } },
])('rejects malformed, duplicate or unknown native descriptor fields %#', async patch => {
  native.describe.mockResolvedValue({ ...policy(), ...patch });
  await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: 'E_AGENT_NATIVE', message: 'E_AGENT_NATIVE' });
});

test('never evaluates request/result accessors or sparse array entries', async () => {
  const getter = jest.fn(() => 'private');
  const unsafeRequest = Object.defineProperty({ ...request }, 'project_id', { get: getter });
  await expect(AgentPolicy.describe(unsafeRequest)).rejects.toBeInstanceOf(AgentPolicyError);
  const unsafeResult = Object.defineProperty(policy(), 'tools', { get: getter });
  native.describe.mockResolvedValueOnce(unsafeResult);
  await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: 'E_AGENT_NATIVE' });
  native.describe.mockResolvedValueOnce({ ...policy(), tools: new Array(1) });
  await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: 'E_AGENT_NATIVE' });
  expect(getter).not.toHaveBeenCalled();
});

test.each(['E_AGENT_ROOT_STALE', 'E_AGENT_BAD_ARGUMENTS', 'E_AGENT_NATIVE', 'UNKNOWN'])(
  'preserves only a closed native error code %s', async code => {
    native.describe.mockRejectedValue({ code, message: 'private filesystem path and provider key' });
    const expected = code === 'UNKNOWN' ? 'E_AGENT_NATIVE' : code;
    await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: expected, message: expected });
  },
);


const runtimeTools = [
  { name: 'list_runtime_environments', access: 'auto' },
  { name: 'install_runtime_environment', access: 'conversation_confirm' },
  { name: 'run_program', access: 'conversation_confirm' },
  { name: 'start_runtime_service', access: 'conversation_confirm' },
  { name: 'stop_runtime_service', access: 'conversation_confirm' },
];

test('accepts the complete thirteen-tool registry v3 descriptor', async () => {
  const raw = {
    ...policy(), registry_version: 3,
    capabilities: ['file_read', 'file_write', 'git_status', 'git_commit', 'git_push', 'guest_service'],
    tools: [
      { name: 'list_dir', access: 'auto' }, { name: 'read_file', access: 'auto' },
      { name: 'write_file', access: 'conversation_confirm' },
      { name: 'git_status', access: 'auto' }, { name: 'git_commit', access: 'conversation_confirm' },
      { name: 'git_push', access: 'conversation_confirm' },
      { name: 'start_guest_cgi', access: 'conversation_confirm' },
      { name: 'stop_guest_cgi', access: 'conversation_confirm' }, ...runtimeTools,
    ],
  };
  native.describe.mockResolvedValue(raw);
  const result = await AgentPolicy.describe(request);
  expect(result).toEqual(raw);
  expect(result.tools).toHaveLength(13);
  expect(result.tools.slice(-5)).toEqual(runtimeTools);
  expect(result.tools.every(Object.isFrozen)).toBe(true);
  native.describe.mockResolvedValue({ ...raw, tools: [...raw.tools, runtimeTools[0]] });
  await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: 'E_AGENT_NATIVE' });
});

test.each([1, 2])('preserves registry v%i and rejects every new runtime tool in it', async registry_version => {
  native.describe.mockResolvedValue({ ...policy(), registry_version });
  await expect(AgentPolicy.describe(request)).resolves.toMatchObject({ registry_version });
  for (const tool of runtimeTools) {
    native.describe.mockResolvedValue({ ...policy(), registry_version, tools: [tool] });
    await expect(AgentPolicy.describe(request)).rejects.toMatchObject({ code: 'E_AGENT_NATIVE' });
  }
});
