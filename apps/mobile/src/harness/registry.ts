import type { HarnessManifest, HarnessRegistry } from './types';

const HARNESS_ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;

export function validateHarnessManifest(manifest: HarnessManifest): void {
  if (!HARNESS_ID.test(manifest.id)) {
    throw new Error(`invalid harness id: ${manifest.id}`);
  }
  if (
    manifest.schemaVersion !== 1 ||
    manifest.name.trim().length === 0 ||
    manifest.version.trim().length === 0 ||
    manifest.runtime.entrypoint.trim().length === 0
  ) {
    throw new Error(`invalid harness manifest: ${manifest.id}`);
  }
  const models = new Set<string>();
  for (const model of manifest.models) {
    if (model.id.trim().length === 0 || models.has(model.id)) {
      throw new Error(`invalid harness model catalog: ${manifest.id}`);
    }
    models.add(model.id);
  }
}

export function createHarnessRegistry(
  manifests: readonly HarnessManifest[],
): HarnessRegistry {
  const byId = new Map<string, HarnessManifest>();
  manifests.forEach(manifest => {
    validateHarnessManifest(manifest);
    if (byId.has(manifest.id)) {
      throw new Error(`duplicate harness id: ${manifest.id}`);
    }
    byId.set(manifest.id, manifest);
  });
  const ordered = [...byId.values()];
  return {
    list: () => ordered,
    get: id => byId.get(id),
    has: id => byId.has(id),
  };
}
