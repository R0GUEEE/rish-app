import type { DeepSeekModelId } from '../native/LocalRuntime';
import type { WorkspaceRootRefV1 } from '../native/WorkspaceRoot';

export const PROJECT_CONTEXT_SCHEMA_VERSION = 1 as const;
export const PROJECT_CONTEXT_V2_SCHEMA_VERSION = 2 as const;

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

export const PROJECT_CONTEXT_BRIDGE_ERROR_CODES = [
  'E_CONTEXT_REQUEST_INVALID',
  'E_CONTEXT_RESULT_INVALID',
  'E_CONTEXT_STORAGE',
  'E_CONTEXT_INTEGRITY',
  'E_CONTEXT_BUSY',
  'E_CONTEXT_NATIVE',
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
export type ProjectContextBridgeErrorCode =
  | ProjectContextErrorCode
  | (typeof PROJECT_CONTEXT_BRIDGE_ERROR_CODES)[number];
export type ProjectContextOmissionReason =
  (typeof PROJECT_CONTEXT_OMISSION_REASONS)[number];

/**
 * The only public authority reference accepted by Project Context V2.  The
 * native lease adds and verifies the private root fingerprint; JavaScript
 * never receives the fingerprint input or any path/descriptor material.
 */
export type ProjectContextWorkspaceRootRefV1 = WorkspaceRootRefV1;

export type ProjectContextProjectDescriptorV2 = {
  readonly schema_version: 2;
  readonly project_id: string;
  readonly workspace_id: string;
  readonly workspace_binding_revision: number;
  readonly display_name: string;
  readonly git_topology: 'legacy_embedded' | 'private_split_gitdir';
};

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

export type ProjectContextSelectionV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly project_id: string;
  readonly conversation_id: string;
  readonly provider: 'deepseek';
  readonly model: DeepSeekModelId;
  readonly policy: 'chat-read-v1';
  readonly selected_paths: readonly string[];
};

/** Candidate listing uses the root authority but remains metadata-only. */
export type ProjectContextCandidateListRequestV2 = {
  readonly schema_version: 1;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly query: string;
  readonly cursor: string | null;
};

export type ProjectContextCandidatePageV2 = {
  readonly schema_version: 2;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly project: ProjectContextProjectDescriptorV2;
  readonly candidates: ProjectContextCandidatePageV1['candidates'];
  readonly next_cursor: string | null;
};

export type ProjectContextSelectionV2 = {
  readonly schema_version: 2;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly conversation_id: string;
  readonly model_id: DeepSeekModelId;
  readonly policy: 'chat-read-v1';
  readonly selected_paths: readonly string[];
};

export type ProjectContextManifestV2 = {
  readonly schema_version: 2;
  readonly snapshot_id: string;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly project: ProjectContextProjectDescriptorV2;
  readonly project_id: string;
  readonly conversation_id: string;
  readonly model_id: DeepSeekModelId;
  readonly policy: 'chat-read-v1';
  readonly branch: string | null;
  readonly head_oid: string | null;
  readonly clean: boolean;
  readonly conflicted: boolean;
  readonly captured_at: string;
  readonly policy_version: string;
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

export type ProjectContextConfirmRequestV2 = {
  readonly schema_version: 2;
  readonly snapshot_id: string;
  readonly root: ProjectContextWorkspaceRootRefV1;
};

export type ProjectContextConsentV2 = {
  readonly schema_version: 2;
  readonly consent_receipt_id: string;
  readonly snapshot_id: string;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly workspace_id: string;
  readonly workspace_binding_revision: number;
  readonly snapshot_sha256: string;
  readonly confirmed_at: string;
};

export type ProjectContextInspectRequestV2 = {
  readonly schema_version: 2;
  readonly snapshot_id: string;
  readonly root: ProjectContextWorkspaceRootRefV1;
};

/** The native V2 service returns a flat manifest plus its current state. */
export type ProjectContextInspectionV2 = {
  readonly schema_version: 2;
  readonly state: 'prepared' | 'confirmed' | 'stale';
  readonly manifest: ProjectContextManifestV2;
};

export type ProjectContextDiscardRequestV2 = {
  readonly schema_version: 2;
  readonly snapshot_id: string;
  readonly root: ProjectContextWorkspaceRootRefV1;
};

export type ProjectContextDiscardResultV2 = {
  readonly schema_version: 2;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly status: 'discarded';
  readonly snapshot_id: string;
  readonly workspace_id: string;
  readonly workspace_binding_revision: number;
};

export type ProjectContextVerifiedSendRequestV2 = {
  readonly schema_version: 2;
  readonly snapshot_id: string;
  readonly consent_receipt_id: string;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly conversation_id: string;
  readonly model_id: DeepSeekModelId;
  readonly policy: 'chat-read-v1';
};

/** Metadata-only result. The native envelope bytes never cross the bridge. */
export type ProjectContextVerifiedSendReceiptV2 = {
  readonly schema_version: 2;
  readonly snapshot_id: string;
  readonly root: ProjectContextWorkspaceRootRefV1;
  readonly snapshot_sha256: string;
  readonly source_fingerprint: string;
  readonly context_bytes: number;
  readonly verified_at: string;
};

export type ProjectContextInspectionV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly state: 'prepared' | 'confirmed' | 'stale';
  readonly manifest: ProjectContextManifestV1;
};

export type ProjectContextDiscardResultV1 = {
  readonly schema_version: typeof PROJECT_CONTEXT_SCHEMA_VERSION;
  readonly status: 'discarded';
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
