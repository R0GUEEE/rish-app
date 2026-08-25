import type { DeepSeekModelId } from '../native/LocalRuntime';

export const PROJECT_CONTEXT_SCHEMA_VERSION = 1 as const;

export const PROJECT_CONTEXT_STATUSES = [
  'setup_required',
  'checking',
  'ready',
  'stale',
  'partial',
  'error',
  'unavailable',
] as const;

export const PROJECT_CONTEXT_STALE_REASONS = [
  'project_changed',
  'selection_changed',
  'model_changed',
  'provider_changed',
  'policy_changed',
  'snapshot_missing',
] as const;

export const PROJECT_CONTEXT_ERROR_CODES = [
  'E_PROJECT_ID_INVALID',
  'E_PROJECT_NOT_FOUND',
  'E_PROJECT_STORAGE_UNSAFE',
  'E_REPOSITORY_UNSUPPORTED',
  'E_CONTEXT_CHANGED',
  'E_CONTEXT_BUDGET',
  'E_CONTEXT_SECRET',
  'E_CONTEXT_ENCODING',
  'E_CONTEXT_TIMEOUT',
  'E_CONTEXT_CANCELLED',
  'E_CONTEXT_CONSENT_INVALID',
  'E_CONTEXT_SNAPSHOT_MISSING',
] as const;

export const PROJECT_CONTEXT_OMISSION_REASONS = [
  'secret_path',
  'generated',
  'lockfile',
  'suspected_secret',
  'binary',
  'invalid_encoding',
  'not_tracked',
  'budget_exceeded',
  'policy',
] as const;

export type ProjectContextStatus =
  (typeof PROJECT_CONTEXT_STATUSES)[number];
export type ProjectContextStaleReason =
  (typeof PROJECT_CONTEXT_STALE_REASONS)[number];
export type ProjectContextErrorCode =
  (typeof PROJECT_CONTEXT_ERROR_CODES)[number];
export type ProjectContextOmissionReason =
  (typeof PROJECT_CONTEXT_OMISSION_REASONS)[number];

export type ProjectContextIncludedItemV1 = {
  readonly path: string;
  readonly source: 'tracked_file' | 'staged_diff' | 'worktree_diff';
  readonly bytes: number;
  readonly sha256: string;
};

export type ProjectContextManifestV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly snapshot_id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly branch: string | null;
  readonly head_oid: string | null;
  readonly clean: boolean;
  readonly conflicted: boolean;
  readonly captured_at: string;
  readonly policy_version: string;
  readonly provider_host: 'api.deepseek.com';
  readonly model: DeepSeekModelId;
  readonly included: readonly ProjectContextIncludedItemV1[];
  readonly omitted: readonly {
    readonly path: string;
    readonly reason: ProjectContextOmissionReason;
  }[];
  readonly context_bytes: number;
  readonly estimated_tokens: number;
  readonly snapshot_sha256: string;
  readonly source_fingerprint: string;
};

export type ProjectContextConsentV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly consent_receipt_id: string;
  readonly snapshot_id: string;
  readonly snapshot_sha256: string;
  readonly confirmed_at: string;
};

export type ProjectContextSendReceiptV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly turn_id: string;
  readonly project_id: string;
  readonly project_name: string;
  readonly branch: string | null;
  readonly head_oid: string | null;
  readonly captured_at: string;
  readonly included_count: number;
  readonly context_bytes: number;
  readonly snapshot_sha256: string;
  readonly read_only: true;
};

export type ProjectContextCandidatePageV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly project_id: string;
  readonly candidates: readonly {
    readonly path: string;
    readonly size: number;
    readonly revision: string;
    readonly git_state:
      | 'unchanged'
      | 'staged'
      | 'unstaged'
      | 'conflicted';
    readonly eligible: boolean;
    readonly omission_reason: ProjectContextOmissionReason | null;
  }[];
  readonly next_cursor: string | null;
};

export type ProjectContextState = {
  readonly schemaVersion: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly projectId: string;
  readonly status: ProjectContextStatus;
  readonly selectedPaths: readonly string[];
  readonly activePreparationId: string | null;
  readonly snapshot: ProjectContextManifestV1 | null;
  readonly consent: ProjectContextConsentV1 | null;
  readonly staleReason: ProjectContextStaleReason | null;
  readonly errorCode: ProjectContextErrorCode | null;
};

export type PersistedProjectContextStateV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly project_id: string;
  readonly status: ProjectContextStatus;
  readonly selected_paths: readonly string[];
  readonly active_preparation_id: string | null;
  readonly manifest: ProjectContextManifestV1 | null;
  readonly consent: ProjectContextConsentV1 | null;
  readonly stale_reason: ProjectContextStaleReason | null;
  readonly error_code: ProjectContextErrorCode | null;
};

export class ProjectContextValidationError extends Error {
  readonly path: string;

  constructor(path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = 'ProjectContextValidationError';
    this.path = path;
  }
}

export type ProjectContextAction =
  | { readonly type: 'checking'; readonly preparationId: string }
  | {
      readonly type: 'prepared';
      readonly preparationId: string;
      readonly manifest: ProjectContextManifestV1;
    }
  | {
      readonly type: 'confirmed';
      readonly preparationId: string;
      readonly manifest: ProjectContextManifestV1;
      readonly consent: ProjectContextConsentV1;
    }
  | { readonly type: 'project_changed' }
  | { readonly type: 'model_changed'; readonly model: DeepSeekModelId }
  | { readonly type: 'provider_changed'; readonly providerHost: string }
  | { readonly type: 'policy_changed'; readonly policyVersion: string }
  | {
      readonly type: 'selection_changed';
      readonly selectedPaths: readonly string[];
    }
  | { readonly type: 'snapshot_missing' }
  | {
      readonly type: 'failed';
      readonly preparationId: string;
      readonly errorCode: ProjectContextErrorCode;
    }
  | { readonly type: 'unavailable' }
  | { readonly type: 'disabled' };
