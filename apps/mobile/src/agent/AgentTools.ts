import { LocalProjects } from '../native/LocalProjects';
import { LocalWorkspace } from '../native/LocalWorkspace';

/**
 * Agent tool executor — maps a model tool call to exactly one native
 * operation and reduces the outcome to the small shape the agent loop
 * carries in its traces and feedback rows. Content never travels through
 * here: outputs are reduced to digests and structured codes.
 */

export type AgentToolContext = {
  projectId: string;
};

export type AgentToolExecution = {
  ok: boolean;
  outputDigest: string;
  detail?: string;
};

const REPO_PREFIX_PATTERN = /^projects\/[^/]+\/repo/;

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

/** Workspace-relative, no traversal, no absolute paths. */
function safeRelativePath(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  if (path.length === 0 || path.length > 512) return null;
  if (path.startsWith('/') || path.includes('\\')) return null;
  if (path.split('/').includes('..')) return null;
  return path.replace(/\/+$/, '');
}

/**
 * FNV-1a for stable short content fingerprints; enough to correlate
 * identical tool outputs without carrying their bytes anywhere.
 */
export function digestForText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; ++i) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `sha1:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export async function executeAgentTool(
  context: AgentToolContext,
  name: string,
  argumentsJson: string,
): Promise<AgentToolExecution> {
  if (context.projectId.length === 0) {
    return failure('E_AGENT_NO_PROJECT');
  }
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(argumentsJson) as Record<string, unknown>;
  } catch {
    return failure('E_AGENT_BAD_ARGUMENTS');
  }

  switch (name) {
    case 'list_dir': {
      const relative = safeRelativePath(args.path ?? '');
      if (relative === null) return failure('E_AGENT_BAD_PATH');
      return safeRun(async () => {
        const listing = await LocalWorkspace.listDirectory(
          `projects/${context.projectId}/repo${relative.length > 0 ? `/${relative}` : ''}`,
        );
        return {
          ok: true,
          outputDigest: `${listing.entries.length} entries:${digestForText(
            listing.entries.map(e => e.name).join(','),
          )}`,
        };
      });
    }

    case 'read_file': {
      const relative = safeRelativePath(args.path);
      if (relative === null) return failure('E_AGENT_BAD_PATH');
      return safeRun(async () => {
        const file = await LocalWorkspace.readText(
          `projects/${context.projectId}/repo/${relative}`,
        );
        // Bytes only: the loop never relays file contents back.
        return {
          ok: true,
          outputDigest: `bytes:${file.content.length}:${digestForText(file.content)}`,
        };
      });
    }

    case 'write_file': {
      const relative = safeRelativePath(args.path);
      if (relative === null) return failure('E_AGENT_BAD_PATH');
      const content = typeof args.content === 'string' ? args.content : null;
      if (content === null || content.length > 262_144) {
        return failure('E_AGENT_BAD_CONTENT');
      }
      return safeRun(async () => {
        await LocalWorkspace.writeText(
          `projects/${context.projectId}/repo/${relative}`,
          content,
          {
            createOnly: false,
          },
        );
        return { ok: true, outputDigest: `bytes:${content.length}` };
      });
    }

    case 'git_status': {
      return safeRun(async () => {
        const status = await LocalProjects.status(context.projectId);
        const head = (status.head_oid ?? '').slice(0, 7) ?? '';
        return {
          ok: true,
          outputDigest:
            `${status.branch ?? 'detached'}@${head}` +
            `${status.clean ? ' clean' : ' dirty'}${status.has_conflicts ? '+conflicts' : ''}`,
        };
      });
    }

    case 'git_commit': {
      const message = typeof args.message === 'string' ? args.message : '';
      if (message.trim().length === 0 || message.length > 500) {
        return failure('E_AGENT_BAD_COMMIT_MESSAGE');
      }
      return safeRun(async () => {
        await LocalProjects.stageAll(context.projectId);
        const commit = await LocalProjects.commit(context.projectId, {
          message,
          authorName: 'Rish Agent',
          authorEmail: 'agent@rish.local',
        });
        return {
          ok: true,
          outputDigest: `commit:${commit.oid.slice(0, 12)}`,
        };
      });
    }

    case 'git_push': {
      return safeRun(async () => {
        const pushed = await LocalProjects.push(context.projectId);
        return {
          ok: true,
          outputDigest: `pushed ${pushed.branch}@${pushed.oid.slice(0, 12)}`,
        };
      });
    }

    default:
      return failure('E_AGENT_UNKNOWN_TOOL');
  }
}

/** Guard reused by callers that pre-validate repo prefixes elsewhere. */
export function isProjectRepoPath(workspacePath: string): boolean {
  return REPO_PREFIX_PATTERN.test(workspacePath);
}
