import { NativeModules } from 'react-native';

export type LocalProject = {
  schema_version: 1;
  id: string;
  name: string;
  workspace_path: `projects/${string}/repo`;
  created_at: string;
  updated_at: string;
  origin_url: string | null;
};

export type LocalProjectListing = {
  schema_version: 1;
  projects: LocalProject[];
};

export type ProjectFileStatus =
  | 'unmodified'
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'typechange'
  | 'unreadable';

export type ProjectStatusEntry = {
  path: string;
  index_status: ProjectFileStatus;
  worktree_status: ProjectFileStatus;
  conflicted: boolean;
};

export type ProjectGitStatus = {
  schema_version: 1;
  project_id: string;
  branch: string | null;
  head_oid: string | null;
  clean: boolean;
  has_conflicts: boolean;
  ahead: number;
  behind: number;
  entries: ProjectStatusEntry[];
};

export type ProjectDiffFile = {
  path: string;
  status: ProjectFileStatus;
  additions: number;
  deletions: number;
};

export type ProjectDiff = {
  schema_version: 1;
  project_id: string;
  staged: boolean;
  truncated: boolean;
  patch: string;
  files: ProjectDiffFile[];
};

export type ProjectDiffOptions = {
  staged?: boolean;
  contextLines?: number;
};

export type ProjectCommitInput = {
  message: string;
  authorName: string;
  authorEmail: string;
};

export type ProjectCommit = {
  schema_version: 1;
  project_id: string;
  oid: string;
  summary: string;
  committed_at: string;
};

export type ProjectRemote = {
  schema_version: 1;
  project_id: string;
  name: 'origin';
  url: string;
};

export type ProjectCredentialStatus = {
  schema_version: 1;
  project_id: string;
  host: string;
  configured: boolean;
};

export type ProjectPushResult = {
  schema_version: 1;
  project_id: string;
  remote: 'origin';
  branch: string;
  oid: string;
  pushed_at: string;
};

type NativeLocalProjects = {
  list(): Promise<LocalProjectListing>;
  create(name: string): Promise<LocalProject>;
  clone(url: string, name: string | null): Promise<LocalProject>;
  status(projectId: string): Promise<ProjectGitStatus>;
  diff(
    projectId: string,
    staged: boolean,
    contextLines: number,
  ): Promise<ProjectDiff>;
  stageAll(projectId: string): Promise<ProjectGitStatus>;
  commit(
    projectId: string,
    message: string,
    authorName: string,
    authorEmail: string,
  ): Promise<ProjectCommit>;
  setRemote(projectId: string, url: string): Promise<ProjectRemote>;
  credentialStatus(projectId: string): Promise<ProjectCredentialStatus>;
  presentCredentialPrompt(
    projectId: string,
    locale: string,
  ): Promise<ProjectCredentialStatus>;
  clearCredential(projectId: string): Promise<ProjectCredentialStatus>;
  push(projectId: string): Promise<ProjectPushResult>;
};

const native = NativeModules.LocalProjects as unknown;

function hasNativeCapabilities(value: unknown): value is NativeLocalProjects {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<
    Record<keyof NativeLocalProjects, unknown>
  >;
  return (
    typeof candidate.list === 'function' &&
    typeof candidate.create === 'function' &&
    typeof candidate.clone === 'function' &&
    typeof candidate.status === 'function' &&
    typeof candidate.diff === 'function' &&
    typeof candidate.stageAll === 'function' &&
    typeof candidate.commit === 'function' &&
    typeof candidate.setRemote === 'function' &&
    typeof candidate.credentialStatus === 'function' &&
    typeof candidate.presentCredentialPrompt === 'function' &&
    typeof candidate.clearCredential === 'function' &&
    typeof candidate.push === 'function'
  );
}

function required(): NativeLocalProjects {
  if (!hasNativeCapabilities(native)) {
    throw new Error('LocalProjects native module is not linked');
  }
  return native;
}

export const LocalProjects = {
  isAvailable: () => hasNativeCapabilities(native),
  list: () => required().list(),
  create: (name: string) => required().create(name),
  clone: (url: string, name?: string) => required().clone(url, name ?? null),
  status: (projectId: string) => required().status(projectId),
  diff: (projectId: string, options: ProjectDiffOptions = {}) =>
    required().diff(
      projectId,
      options.staged ?? false,
      options.contextLines ?? 3,
    ),
  stageAll: (projectId: string) => required().stageAll(projectId),
  commit: (projectId: string, input: ProjectCommitInput) =>
    required().commit(
      projectId,
      input.message,
      input.authorName,
      input.authorEmail,
    ),
  setRemote: (projectId: string, url: string) =>
    required().setRemote(projectId, url),
  credentialStatus: (projectId: string) =>
    required().credentialStatus(projectId),
  presentCredentialPrompt: (projectId: string, locale: 'zh-CN' | 'en' = 'en') =>
    required().presentCredentialPrompt(projectId, locale),
  clearCredential: (projectId: string) => required().clearCredential(projectId),
  push: (projectId: string) => required().push(projectId),
};
