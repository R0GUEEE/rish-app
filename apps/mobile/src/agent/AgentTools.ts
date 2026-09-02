import { LocalProjects } from '../native/LocalProjects';
import { LocalWorkspace } from '../native/LocalWorkspace';
import {
  assertWorkspaceRootRefV1,
  type WorkspaceRootRefV1,
} from '../native/WorkspaceRoot';

/**
 * The old AgentTools adapter is retained as a reference/legacy driver. It is
 * deliberately not the authority for an agent attempt (the durable agent
 * round path owns that contract), but it must still speak the same opaque-root
 * bridge protocol when exercised by focused tests or legacy callers.
 */

export type AgentToolPermission =
  | 'read-only'
  | 'workspace-write'
  /** Alias accepted by legacy callers that did not use the preference label. */
  | 'read-write';

export type AgentToolContext = {
  /** A caller-provided, exact WorkspaceRootRefV1. It never contains a path. */
  root: WorkspaceRootRefV1;
  /** Kept on the context for the existing Git transport integration. */
  gitHttpsProxyUrl: string | null;
  /** Defaults to read-only so an omitted policy can never grant mutation. */
  toolPermission?: AgentToolPermission;
  /** Compatibility aliases for older reference callers. */
  mode?: AgentToolPermission;
  access?: AgentToolPermission;
  readOnly?: boolean;
  /** V2 Git operation correlation id. */
  operationId?: string;
  /** Opaque Keychain reference required by the V2 push contract. */
  credentialReference?: string | null;
};

export type AgentToolExecution = {
  ok: boolean;
  outputDigest: string;
  detail?: string;
};

const MAX_PATH_BYTES = 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 1000;
const MAX_AGENT_WRITE_BYTES = 262_144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;
const OID = /^[0-9a-f]{40}$/u;

const MUTATING_TOOLS = new Set(['write_file', 'git_commit', 'git_push']);
const KNOWN_TOOLS = new Set([
  'list_dir',
  'read_file',
  'write_file',
  'git_status',
  'git_commit',
  'git_push',
  'ask_user',
]);

function failure(detail: string): AgentToolExecution {
  return { ok: false, outputDigest: '', detail };
}

async function safeRun(
  run: () => Promise<AgentToolExecution>,
): Promise<AgentToolExecution> {
  try {
    return await run();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error ?? 'unknown');
    return failure(message.slice(0, 256) || 'E_TOOL_RUNTIME');
  }
}

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return Number.POSITIVE_INFINITY;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return Number.POSITIVE_INFINITY;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** Workspace-relative, no traversal, no absolute paths. */
function safeRelativePath(path: unknown, allowRoot = false): string | null {
  if (typeof path !== 'string') return null;
  if (path.length === 0) return allowRoot ? '' : null;
  if (utf8Bytes(path) > MAX_PATH_BYTES) return null;
  if (path.startsWith('/') || path.includes('\\')) return null;
  if (
    [...path].some(character => {
      const point = character.codePointAt(0);
      return point !== undefined && point <= 0x1f;
    })
  ) {
    return null;
  }
  const components = path.split('/');
  if (
    components.some(
      component =>
        component.length === 0 ||
        component === '.' ||
        component === '..' ||
        component.toLowerCase() === '.git' ||
        component.toLowerCase() === '.trash' ||
        component.toLowerCase().startsWith('.staging-') ||
        component.toLowerCase().startsWith('.rish-write-') ||
        utf8Bytes(component) > 255,
    )
  ) {
    return null;
  }
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseArguments(argumentsJson: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function exactRoot(value: unknown): WorkspaceRootRefV1 | null {
  try {
    return assertWorkspaceRootRefV1(value);
  } catch {
    return null;
  }
}

/**
 * LocalWorkspace's Files bridge intentionally accepts a workspace root only;
 * Git's bridge accepts the project-bound tuple. A project root therefore
 * yields this detached, metadata-only workspace root for file operations.
 */
function filesRoot(root: WorkspaceRootRefV1): WorkspaceRootRefV1 {
  return {
    schema_version: 1,
    workspace_id: root.workspace_id,
    binding_revision: root.binding_revision,
    project_id: null,
  };
}

function isProjectRoot(root: WorkspaceRootRefV1): boolean {
  return root.project_id !== null;
}

function permissionOf(context: AgentToolContext): AgentToolPermission {
  const candidate = context.toolPermission ?? context.mode ?? context.access;
  if (candidate === 'workspace-write' || candidate === 'read-write') {
    return candidate;
  }
  if (candidate !== undefined) {
    return 'read-only';
  }
  return context.readOnly === false ? 'workspace-write' : 'read-only';
}

function allowsMutation(permission: AgentToolPermission): boolean {
  return permission === 'workspace-write' || permission === 'read-write';
}

function operationIdOf(
  context: AgentToolContext,
  args: Record<string, unknown>,
): string | null {
  const hasArgument = Object.prototype.hasOwnProperty.call(
    args,
    'operation_id',
  );
  const candidate = hasArgument ? args.operation_id : context.operationId;
  if (candidate === undefined) return randomOperationId();
  return typeof candidate === 'string' && UUID.test(candidate)
    ? candidate
    : null;
}

function credentialReferenceOf(
  context: AgentToolContext,
  args: Record<string, unknown>,
): string | null {
  const candidate = args.credential_reference ?? context.credentialReference;
  return typeof candidate === 'string' &&
    candidate.length > 0 &&
    candidate.length <= 256
    ? candidate
    : null;
}

function randomOperationId(): string {
  const randomHex = (length: number): string =>
    Array.from({ length }, () =>
      Math.floor(Math.random() * 16).toString(16),
    ).join('');
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-8${randomHex(
    3,
  )}-${randomHex(12)}`;
}

function expectedOidOf(
  args: Record<string, unknown>,
  current: string | null,
): string | null {
  if (!Object.prototype.hasOwnProperty.call(args, 'expected_head_oid')) {
    return current;
  }
  const candidate = args.expected_head_oid;
  return candidate === null ||
    (typeof candidate === 'string' && OID.test(candidate))
    ? candidate
    : null;
}

function expectedRevisionOf(
  args: Record<string, unknown>,
): { ok: true; value: string | null } | { ok: false; detail: string } {
  // Absence and an explicitly absent file are different protocol states. Do
  // not guess `null` when the model omitted the precondition.
  if (!Object.prototype.hasOwnProperty.call(args, 'expected_revision')) {
    return { ok: false, detail: 'E_AGENT_EXPECTED_REVISION_REQUIRED' };
  }
  const candidate = args.expected_revision;
  if (candidate === null) return { ok: true, value: null };
  if (typeof candidate === 'string' && DIGEST.test(candidate)) {
    return { ok: true, value: candidate };
  }
  return { ok: false, detail: 'E_AGENT_BAD_REVISION' };
}

/**
 * FNV-1a for stable short content fingerprints; enough to correlate
 * identical tool outputs without carrying their bytes anywhere.
 */
export function digestForText(text: string): string {
  /* eslint-disable no-bitwise -- FNV-1a is defined by XOR and unsigned 32-bit normalization. */
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; ++i) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const digest = `sha1:${(hash >>> 0).toString(16).padStart(8, '0')}`;
  /* eslint-enable no-bitwise */
  return digest;
}

function toolName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== 'string') return null;
  return value.name;
}

/**
 * Filters a caller-supplied tool registry before it is advertised to a model.
 * The execution guard below remains mandatory because model/tool input is
 * untrusted and may bypass the advertised registry.
 */
export function filterAgentToolDefinitions(
  tools: readonly unknown[],
  permission: AgentToolPermission = 'read-only',
  root?: WorkspaceRootRefV1,
): readonly unknown[] {
  const validatedRoot = root === undefined ? undefined : exactRoot(root);
  if (root !== undefined && validatedRoot === null) return [];
  return tools.filter(tool => {
    const name = toolName(tool);
    if (name === null || !KNOWN_TOOLS.has(name)) return false;
    if (!allowsMutation(permission) && MUTATING_TOOLS.has(name)) return false;
    if (
      validatedRoot !== undefined &&
      validatedRoot !== null &&
      !isProjectRoot(validatedRoot) &&
      name.startsWith('git_')
    ) {
      return false;
    }
    return true;
  });
}

export function executeAgentTool(
  context: AgentToolContext,
  name: string,
  argumentsJson: string,
): Promise<AgentToolExecution> {
  const root = exactRoot(context.root);
  if (root === null) return Promise.resolve(failure('E_AGENT_BAD_ROOT'));
  const args = parseArguments(argumentsJson);
  if (args === null) return Promise.resolve(failure('E_AGENT_BAD_ARGUMENTS'));
  if (!allowsMutation(permissionOf(context)) && MUTATING_TOOLS.has(name)) {
    return Promise.resolve(failure('E_AGENT_READ_ONLY'));
  }

  switch (name) {
    case 'list_dir': {
      const requestedPath =
        args.path === undefined ? '' : safeRelativePath(args.path, true);
      if (requestedPath === null)
        return Promise.resolve(failure('E_AGENT_BAD_PATH'));
      return safeRun(async () => {
        const listing = await LocalWorkspace.listV2({
          schema_version: 1,
          root: filesRoot(root),
          path: requestedPath,
          max_entries: MAX_LIST_ENTRIES,
        });
        return {
          ok: true,
          outputDigest: `${listing.entries.length} entries:${digestForText(
            listing.entries.map(entry => entry.name).join(','),
          )}`,
        };
      });
    }

    case 'read_file': {
      const relative = safeRelativePath(args.path);
      if (relative === null)
        return Promise.resolve(failure('E_AGENT_BAD_PATH'));
      return safeRun(async () => {
        const file = await LocalWorkspace.readV2({
          schema_version: 1,
          root: filesRoot(root),
          path: relative,
          max_bytes: MAX_TEXT_BYTES,
        });
        // Bytes only: the loop never relays file contents back.
        return {
          ok: true,
          outputDigest: `bytes:${utf8Bytes(file.content)}:${digestForText(
            file.content,
          )}`,
        };
      });
    }

    case 'write_file': {
      const relative = safeRelativePath(args.path);
      if (relative === null)
        return Promise.resolve(failure('E_AGENT_BAD_PATH'));
      const content = typeof args.content === 'string' ? args.content : null;
      if (content === null || utf8Bytes(content) > MAX_AGENT_WRITE_BYTES) {
        return Promise.resolve(failure('E_AGENT_BAD_CONTENT'));
      }
      const expected = expectedRevisionOf(args);
      if (!expected.ok) return Promise.resolve(failure(expected.detail));
      return safeRun(async () => {
        await LocalWorkspace.writeV2({
          schema_version: 1,
          root: filesRoot(root),
          path: relative,
          content,
          expected_revision: expected.value,
          // An explicit absent revision is a create-only write. A known
          // revision is an atomic replacement guarded by that digest.
          create_only: expected.value === null,
        });
        return { ok: true, outputDigest: `bytes:${utf8Bytes(content)}` };
      });
    }

    case 'git_status': {
      if (!isProjectRoot(root))
        return Promise.resolve(failure('E_AGENT_NO_PROJECT'));
      return safeRun(async () => {
        const status = await LocalProjects.statusV2({
          schema_version: 1,
          root,
        });
        const head = (status.head_oid ?? '').slice(0, 7);
        return {
          ok: true,
          outputDigest:
            `${status.branch ?? 'detached'}@${head}` +
            `${status.clean ? ' clean' : ' dirty'}${
              status.has_conflicts ? '+conflicts' : ''
            }`,
        };
      });
    }

    case 'git_commit': {
      if (!isProjectRoot(root))
        return Promise.resolve(failure('E_AGENT_NO_PROJECT'));
      const message = typeof args.message === 'string' ? args.message : '';
      if (message.trim().length === 0 || utf8Bytes(message) > 500) {
        return Promise.resolve(failure('E_AGENT_BAD_COMMIT_MESSAGE'));
      }
      const operationId = operationIdOf(context, args);
      if (operationId === null) {
        return Promise.resolve(failure('E_AGENT_OPERATION_ID_REQUIRED'));
      }
      return safeRun(async () => {
        const status = await LocalProjects.statusV2({
          schema_version: 1,
          root,
        });
        const expectedHead = expectedOidOf(args, status.head_oid);
        if (
          expectedHead === null &&
          Object.prototype.hasOwnProperty.call(args, 'expected_head_oid') &&
          args.expected_head_oid !== null
        ) {
          return failure('E_AGENT_BAD_HEAD');
        }
        await LocalProjects.stageAllV2({ schema_version: 1, root });
        const commit = await LocalProjects.commitV2({
          schema_version: 1,
          root,
          operation_id: operationId,
          message,
          author_name: 'Rish Agent',
          author_email: 'agent@rish.local',
          expected_head_oid: expectedHead,
        });
        return {
          ok: true,
          outputDigest: `commit:${commit.oid.slice(0, 12)}`,
        };
      });
    }

    case 'git_push': {
      if (!isProjectRoot(root))
        return Promise.resolve(failure('E_AGENT_NO_PROJECT'));
      const operationId = operationIdOf(context, args);
      if (operationId === null) {
        return Promise.resolve(failure('E_AGENT_OPERATION_ID_REQUIRED'));
      }
      const credentialReference = credentialReferenceOf(context, args);
      if (credentialReference === null) {
        return Promise.resolve(failure('E_AGENT_CREDENTIAL_REQUIRED'));
      }
      // Carry the frozen proxy policy in the exact V2 request envelope. The
      // native bridge validates it again; no ambient process proxy is used.
      return safeRun(async () => {
        const status = await LocalProjects.statusV2({
          schema_version: 1,
          root,
        });
        if (status.head_oid === null) return failure('E_AGENT_NO_HEAD');
        const pushed = await LocalProjects.pushV2({
          schema_version: 1,
          root,
          operation_id: operationId,
          remote: 'origin',
          expected_local_oid: status.head_oid,
          credential_reference: credentialReference,
          https_proxy_url: context.gitHttpsProxyUrl ?? null,
        });
        return {
          ok: true,
          outputDigest: `pushed ${pushed.branch}@${pushed.oid.slice(0, 12)}`,
        };
      });
    }

    case 'ask_user':
      return Promise.resolve(failure('E_AGENT_UNKNOWN_TOOL'));

    default:
      return Promise.resolve(failure('E_AGENT_UNKNOWN_TOOL'));
  }
}

/** Guard retained for older callers that pre-validate repository prefixes. */
export function isProjectRepoPath(workspacePath: string): boolean {
  return /^projects\/[^/]+\/repo(?:\/|$)/u.test(workspacePath);
}
