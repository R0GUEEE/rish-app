import { NativeModules, TurboModuleRegistry } from 'react-native';
import { nativeImplementationAvailable } from './NativeImplementation';

export type AgentPolicyFailureCode =
  | 'E_AGENT_BAD_ARGUMENTS'
  | 'E_AGENT_ROOT_STALE'
  | 'E_AGENT_NATIVE';
export type AgentPolicyCapability =
  | 'file_read' | 'file_write' | 'git_status' | 'git_commit' | 'git_push' | 'guest_service';
export type AgentPolicyToolName =
  | 'list_dir' | 'read_file' | 'write_file' | 'git_status' | 'git_commit' | 'git_push'
  | 'start_guest_cgi' | 'stop_guest_cgi'
  | 'list_runtime_environments' | 'install_runtime_environment' | 'run_program'
  | 'start_runtime_service' | 'stop_runtime_service';
export type AgentPolicyAccess = 'auto' | 'conversation_confirm' | 'confirm_once' | 'durable_deny';
export type AgentPolicyRequest = {
  readonly schema_version: 1;
  readonly workspace_id: string;
  readonly workspace_binding_revision: number;
  readonly project_id: string | null;
};
export type AgentPolicyDescriptor = AgentPolicyRequest & {
  readonly root_fingerprint_sha256: string;
  readonly registry_version: 1 | 2 | 3;
  readonly policy_version: 'agent-v1';
  readonly capabilities: readonly AgentPolicyCapability[];
  readonly tools: readonly {
    readonly name: AgentPolicyToolName;
    readonly access: AgentPolicyAccess;
  }[];
  readonly budget: {
    readonly max_single_write_bytes: number;
    readonly max_batch_write_bytes: number;
    readonly max_attempt_write_bytes: number;
  };
};

export class AgentPolicyError extends Error {
  constructor(readonly code: AgentPolicyFailureCode) {
    super(code);
    this.name = 'AgentPolicyError';
  }
}

function fail(code: AgentPolicyFailureCode): never {
  throw new AgentPolicyError(code);
}

function record(value: unknown, keys: readonly string[], code: AgentPolicyFailureCode): Record<string, unknown> {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value) ||
        (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0) fail(code);
    const names = Object.getOwnPropertyNames(value);
    if (names.length !== keys.length || names.some(name => !keys.includes(name))) fail(code);
    const copy: Record<string, unknown> = {};
    for (const name of names) {
      const property = Object.getOwnPropertyDescriptor(value, name);
      if (!property || !('value' in property) || !property.enumerable) fail(code);
      copy[name] = property.value;
    }
    return copy;
  } catch {
    return fail(code);
  }
}

function array(value: unknown, maximum: number): unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype ||
        value.length > maximum || Object.getOwnPropertySymbols(value).length !== 0 ||
        Object.getOwnPropertyNames(value).length !== value.length + 1) fail('E_AGENT_NATIVE');
    const copy: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const property = Object.getOwnPropertyDescriptor(value, String(index));
      if (!property || !('value' in property) || !property.enumerable) fail('E_AGENT_NATIVE');
      copy.push(property.value);
    }
    return copy;
  } catch {
    return fail('E_AGENT_NATIVE');
  }
}

const uuid = (value: unknown): value is string => typeof value === 'string' &&
  value.length === 36 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const identityKeys = ['schema_version', 'workspace_id', 'workspace_binding_revision', 'project_id'] as const;

function validateRequest(value: unknown): AgentPolicyRequest {
  const request = record(value, identityKeys, 'E_AGENT_BAD_ARGUMENTS');
  if (request.schema_version !== 1 || !uuid(request.workspace_id) ||
      !positiveInteger(request.workspace_binding_revision) ||
      (request.project_id !== null && !uuid(request.project_id))) fail('E_AGENT_BAD_ARGUMENTS');
  return Object.freeze({
    schema_version: 1, workspace_id: request.workspace_id,
    workspace_binding_revision: request.workspace_binding_revision, project_id: request.project_id,
  });
}

const capabilityNames: readonly AgentPolicyCapability[] = [
  'file_read', 'file_write', 'git_status', 'git_commit', 'git_push', 'guest_service',
];
const legacyToolNames: readonly AgentPolicyToolName[] = [
  'list_dir', 'read_file', 'write_file', 'git_status', 'git_commit', 'git_push',
  'start_guest_cgi', 'stop_guest_cgi',
];
const toolNames: readonly AgentPolicyToolName[] = [
  ...legacyToolNames, 'list_runtime_environments', 'install_runtime_environment',
  'run_program', 'start_runtime_service', 'stop_runtime_service',
];
const accessNames: readonly AgentPolicyAccess[] = ['auto', 'conversation_confirm', 'confirm_once', 'durable_deny'];

function member<T extends string>(value: unknown, names: readonly T[]): T {
  if (typeof value !== 'string' || !names.includes(value as T)) fail('E_AGENT_NATIVE');
  return value as T;
}

function validateDescriptor(value: unknown, request: AgentPolicyRequest): AgentPolicyDescriptor {
  const result = record(value, [...identityKeys, 'root_fingerprint_sha256', 'registry_version',
    'policy_version', 'capabilities', 'tools', 'budget'], 'E_AGENT_NATIVE');
  if (result.schema_version !== 1 || !uuid(result.workspace_id) ||
      !positiveInteger(result.workspace_binding_revision) ||
      (result.project_id !== null && !uuid(result.project_id))) fail('E_AGENT_NATIVE');
  if (result.workspace_id !== request.workspace_id ||
      result.workspace_binding_revision !== request.workspace_binding_revision ||
      result.project_id !== request.project_id) fail('E_AGENT_ROOT_STALE');
  if (typeof result.root_fingerprint_sha256 !== 'string' || result.root_fingerprint_sha256.length !== 64 ||
      !/^[0-9a-f]{64}$/u.test(result.root_fingerprint_sha256) ||
      (result.registry_version !== 1 && result.registry_version !== 2 && result.registry_version !== 3) ||
      result.policy_version !== 'agent-v1') fail('E_AGENT_NATIVE');
  const capabilities = array(result.capabilities, capabilityNames.length).map(candidate => member(candidate, capabilityNames));
  if (new Set(capabilities).size !== capabilities.length) fail('E_AGENT_NATIVE');
  const versionToolNames = result.registry_version === 3 ? toolNames : legacyToolNames;
  const tools = array(result.tools, versionToolNames.length).map(candidate => {
    const tool = record(candidate, ['name', 'access'], 'E_AGENT_NATIVE');
    return Object.freeze({ name: member(tool.name, versionToolNames), access: member(tool.access, accessNames) });
  });
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) fail('E_AGENT_NATIVE');
  const budget = record(result.budget, ['max_single_write_bytes', 'max_batch_write_bytes', 'max_attempt_write_bytes'], 'E_AGENT_NATIVE');
  if (!positiveInteger(budget.max_single_write_bytes) || !positiveInteger(budget.max_batch_write_bytes) ||
      !positiveInteger(budget.max_attempt_write_bytes) ||
      budget.max_single_write_bytes > budget.max_batch_write_bytes ||
      budget.max_batch_write_bytes > budget.max_attempt_write_bytes) fail('E_AGENT_NATIVE');
  return Object.freeze({
    ...request, root_fingerprint_sha256: result.root_fingerprint_sha256,
    registry_version: result.registry_version, policy_version: 'agent-v1',
    capabilities: Object.freeze(capabilities), tools: Object.freeze(tools),
    budget: Object.freeze({
      max_single_write_bytes: budget.max_single_write_bytes,
      max_batch_write_bytes: budget.max_batch_write_bytes,
      max_attempt_write_bytes: budget.max_attempt_write_bytes,
    }),
  });
}

type Describe = (request: AgentPolicyRequest) => Promise<unknown>;
function describeMethod(value: unknown): Describe | null {
  if (!nativeImplementationAvailable(value)) return null;
  try {
    const method: unknown = Reflect.get(value as object, 'describe');
    return typeof method === 'function' ? method.bind(value) as Describe : null;
  } catch { return null; }
}
function resolveNative(): Describe | null {
  try {
    const method = describeMethod(NativeModules.AgentPolicy);
    if (method !== null) return method;
  } catch { /* The optional legacy module may be absent. */ }
  try { return describeMethod(TurboModuleRegistry.get('AgentPolicy')); }
  catch { return null; }
}

export function agentPolicyFailureCode(error: unknown): AgentPolicyFailureCode {
  try {
    if (typeof error === 'object' && error !== null) {
      const property = Object.getOwnPropertyDescriptor(error, 'code');
      const code: unknown = property && 'value' in property ? property.value : null;
      if (code === 'E_AGENT_BAD_ARGUMENTS' || code === 'E_AGENT_ROOT_STALE' || code === 'E_AGENT_NATIVE') return code;
    }
  } catch { /* Never expose native messages or evaluate accessors. */ }
  return 'E_AGENT_NATIVE';
}

export const AgentPolicy = Object.freeze({
  isAvailable: (): boolean => resolveNative() !== null,
  describe: async (request: AgentPolicyRequest): Promise<AgentPolicyDescriptor> => {
    const safeRequest = validateRequest(request);
    const describe = resolveNative();
    if (describe === null) fail('E_AGENT_NATIVE');
    let raw: unknown;
    try { raw = await describe(safeRequest); }
    catch (error) { throw new AgentPolicyError(agentPolicyFailureCode(error)); }
    return validateDescriptor(raw, safeRequest);
  },
});
