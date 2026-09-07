import {
  PROJECT_CONTEXT_SCHEMA_VERSION,
  type ProjectContextAction,
  type ProjectContextManifestV1,
  type ProjectContextState,
  type ProjectContextStaleReason,
} from './types';

function orderSelectedPaths(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((path, index) => path === right[index])
  );
}

function sameManifest(
  left: ProjectContextManifestV1,
  right: ProjectContextManifestV1,
): boolean {
  if (
    left.schema_version !== right.schema_version ||
    left.snapshot_id !== right.snapshot_id ||
    left.project_id !== right.project_id ||
    left.project_name !== right.project_name ||
    left.branch !== right.branch ||
    left.head_oid !== right.head_oid ||
    left.clean !== right.clean ||
    left.conflicted !== right.conflicted ||
    left.captured_at !== right.captured_at ||
    left.policy_version !== right.policy_version ||
    left.provider_host !== right.provider_host ||
    left.provider_configuration?.profile_id !== right.provider_configuration?.profile_id ||
    left.model !== right.model ||
    left.context_bytes !== right.context_bytes ||
    left.estimated_tokens !== right.estimated_tokens ||
    left.snapshot_sha256 !== right.snapshot_sha256 ||
    left.source_fingerprint !== right.source_fingerprint ||
    left.included.length !== right.included.length ||
    left.omitted.length !== right.omitted.length
  ) {
    return false;
  }
  for (let index = 0; index < left.included.length; index += 1) {
    const leftItem = left.included[index];
    const rightItem = right.included[index];
    if (
      leftItem === undefined ||
      rightItem === undefined ||
      leftItem.path !== rightItem.path ||
      leftItem.source !== rightItem.source ||
      leftItem.bytes !== rightItem.bytes ||
      leftItem.sha256 !== rightItem.sha256
    ) {
      return false;
    }
  }
  for (let index = 0; index < left.omitted.length; index += 1) {
    const leftItem = left.omitted[index];
    const rightItem = right.omitted[index];
    if (
      leftItem === undefined ||
      rightItem === undefined ||
      leftItem.path !== rightItem.path ||
      leftItem.reason !== rightItem.reason
    ) {
      return false;
    }
  }
  return true;
}

function invalidate(
  state: ProjectContextState,
  staleReason: ProjectContextStaleReason,
): ProjectContextState {
  return {
    ...state,
    status: 'stale',
    activePreparationId: null,
    consent: null,
    staleReason,
    errorCode: null,
  };
}

function validPreparationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function createProjectContextState(
  projectId: string,
): ProjectContextState {
  return {
    schemaVersion: PROJECT_CONTEXT_SCHEMA_VERSION,
    projectId,
    status: 'setup_required',
    selectedPaths: [],
    activePreparationId: null,
    snapshot: null,
    consent: null,
    staleReason: null,
    errorCode: null,
  };
}

export function projectContextReducer(
  state: ProjectContextState,
  action: ProjectContextAction,
): ProjectContextState {
  switch (action.type) {
    case 'checking':
      if (!validPreparationId(action.preparationId)) {
        return state;
      }
      return {
        ...state,
        status: 'checking',
        activePreparationId: action.preparationId,
        snapshot: null,
        consent: null,
        staleReason: null,
        errorCode: null,
      };
    case 'prepared':
      if (
        state.status !== 'checking' ||
        state.activePreparationId !== action.preparationId ||
        action.manifest.project_id !== state.projectId
      ) {
        return state;
      }
      return {
        ...state,
        status:
          action.manifest.omitted.length > 0 ? 'partial' : 'setup_required',
        snapshot: action.manifest,
        consent: null,
        staleReason: null,
        errorCode: null,
      };
    case 'confirmed':
      if (
        state.activePreparationId !== action.preparationId ||
        state.snapshot === null ||
        state.consent !== null ||
        !(
          (state.status === 'setup_required' &&
            state.snapshot.omitted.length === 0) ||
          (state.status === 'partial' && state.snapshot.omitted.length > 0)
        ) ||
        !sameManifest(state.snapshot, action.manifest) ||
        action.manifest.project_id !== state.projectId ||
        action.consent.snapshot_id !== action.manifest.snapshot_id ||
        action.consent.snapshot_sha256 !== action.manifest.snapshot_sha256
      ) {
        return state;
      }
      return {
        ...state,
        status: action.manifest.omitted.length > 0 ? 'partial' : 'ready',
        activePreparationId: null,
        snapshot: state.snapshot,
        consent: action.consent,
        staleReason: null,
        errorCode: null,
      };
    case 'project_changed':
      return invalidate(state, 'project_changed');
    case 'model_changed':
      if (state.activePreparationId !== null) {
        return invalidate(state, 'model_changed');
      }
      if (
        !isProjectContextSendable(state) ||
        state.snapshot?.model === action.model
      ) {
        return state;
      }
      return invalidate(state, 'model_changed');
    case 'provider_configuration_changed':
      return invalidate(state, 'provider_changed');
    case 'provider_changed':
      if (state.activePreparationId !== null) {
        return invalidate(state, 'provider_changed');
      }
      if (
        !isProjectContextSendable(state) ||
        state.snapshot?.provider_host === action.providerHost
      ) {
        return state;
      }
      return invalidate(state, 'provider_changed');
    case 'policy_changed':
      if (state.activePreparationId !== null) {
        return invalidate(state, 'policy_changed');
      }
      if (
        !isProjectContextSendable(state) ||
        state.snapshot?.policy_version === action.policyVersion
      ) {
        return state;
      }
      return invalidate(state, 'policy_changed');
    case 'selection_changed': {
      const selectedPaths = orderSelectedPaths(action.selectedPaths);
      if (samePaths(state.selectedPaths, selectedPaths)) {
        return state;
      }
      const isInitialSetup =
        state.status === 'setup_required' &&
        state.activePreparationId === null &&
        state.snapshot === null &&
        state.consent === null;
      return {
        ...state,
        status: isInitialSetup ? 'setup_required' : 'stale',
        selectedPaths,
        activePreparationId: null,
        consent: null,
        staleReason: isInitialSetup ? null : 'selection_changed',
        errorCode: null,
      };
    }
    case 'snapshot_missing':
      return invalidate(state, 'snapshot_missing');
    case 'failed':
      if (state.activePreparationId !== action.preparationId) {
        return state;
      }
      return {
        ...state,
        status: 'error',
        activePreparationId: null,
        consent: null,
        staleReason: null,
        errorCode: action.errorCode,
      };
    case 'unavailable':
      return {
        ...state,
        status: 'unavailable',
        activePreparationId: null,
        snapshot: null,
        consent: null,
        staleReason: null,
        errorCode: null,
      };
    case 'disabled':
      return createProjectContextState(state.projectId);
  }
}

export function isProjectContextSendable(state: ProjectContextState): boolean {
  return (
    (state.status === 'ready' || state.status === 'partial') &&
    state.activePreparationId === null &&
    state.snapshot !== null &&
    state.consent !== null &&
    state.staleReason === null &&
    state.errorCode === null &&
    state.snapshot.project_id === state.projectId &&
    state.consent.snapshot_id === state.snapshot.snapshot_id &&
    state.consent.snapshot_sha256 === state.snapshot.snapshot_sha256
  );
}
