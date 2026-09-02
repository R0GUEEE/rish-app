/**
 * The sole public V2 authority reference shared by Files, Git, and Project
 * Context. It deliberately contains no path, URL, bookmark, descriptor, or
 * provider identity.
 */
export type WorkspaceRootRefV1 = {
  schema_version: 1;
  workspace_id: string;
  binding_revision: number;
  project_id: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function snapshotObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const descriptorKeys = Reflect.ownKeys(descriptors);
    if (descriptorKeys.some(name => typeof name === 'symbol')) return null;
    const names = descriptorKeys as string[];
    const result: Record<string, unknown> = {};
    for (const name of names) {
      const descriptor = descriptors[name];
      if (descriptor === undefined || !descriptor.enumerable ||
          descriptor.get !== undefined || descriptor.set !== undefined) {
        return null;
      }
      result[name] = descriptor.value;
    }
    return result;
  } catch {
    return null;
  }
}

function snapshotExact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  const snapshot = snapshotObject(value);
  if (snapshot === null) return null;
  const names = Object.keys(snapshot);
  return names.length === keys.length && keys.every(key => names.includes(key))
    ? snapshot
    : null;
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

function isRevision(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    !Object.is(value, -0)
  );
}

export function isWorkspaceRootRefV1(value: unknown): value is WorkspaceRootRefV1 {
  const captured = snapshotExact(value, [
    'schema_version',
    'workspace_id',
    'binding_revision',
    'project_id',
  ]);
  return captured !== null &&
    captured.schema_version === 1 &&
    typeof captured.schema_version === 'number' &&
    isCanonicalUuid(captured.workspace_id) &&
    isRevision(captured.binding_revision) &&
    (captured.project_id === null || isCanonicalUuid(captured.project_id));
}

export function assertWorkspaceRootRefV1(value: unknown): WorkspaceRootRefV1 {
  const captured = snapshotExact(value, [
    'schema_version',
    'workspace_id',
    'binding_revision',
    'project_id',
  ]);
  if (captured === null ||
      captured.schema_version !== 1 ||
      typeof captured.schema_version !== 'number' ||
      !isCanonicalUuid(captured.workspace_id) ||
      !isRevision(captured.binding_revision) ||
      (captured.project_id !== null && !isCanonicalUuid(captured.project_id))) {
    throw Object.assign(new Error('Workspace root reference is invalid.'), {
      code: 'E_WORKSPACE_INVALID',
    });
  }
  return {
    schema_version: 1,
    workspace_id: captured.workspace_id as string,
    binding_revision: captured.binding_revision as number,
    project_id: captured.project_id as string | null,
  };
}

export function workspaceRoot(
  workspace_id: string,
  binding_revision: number,
  project_id: string | null = null,
): WorkspaceRootRefV1 {
  return assertWorkspaceRootRefV1({
    schema_version: 1,
    workspace_id,
    binding_revision,
    project_id,
  });
}
