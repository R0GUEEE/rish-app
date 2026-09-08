/** Non-secret model catalog. Retired identities preserve existing conversations. */
export type DshModelEntry = {
  id: string;
  name: string;
  supports_images: boolean;
};
export type DshCatalog = {
  schema_version: 1;
  models: DshModelEntry[];
  retired_models: DshModelEntry[];
};
export const DEFAULT_DSH_MODELS: readonly DshModelEntry[] = [
  { id: 'deepseek-v4-flash', name: 'V4 Flash', supports_images: false },
  { id: 'deepseek-v4-pro', name: 'V4 Pro', supports_images: false },
  {
    id: 'deepseek-v4-flash-vision-exp',
    name: 'Flash Exp',
    supports_images: true,
  },
];
const reserved = new Set([
  'claude-sonnet-5',
  'claude-opus-5',
  'claude-haiku-4-5-20251001',
  'claude-fable-5-1',
  'gpt-5.6',
  'gpt-5.6-mini',
  'gpt-5.6-nano',
  'GLM-5.3',
  'GLM-5.3-Flash',
]);
export function validateDshModels(value: unknown): DshModelEntry[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32)
    throw new Error('E_MODEL_CATALOG');
  const seen = new Set<string>();
  return value.map(row => {
    if (
      !row ||
      typeof row !== 'object' ||
      Object.keys(row).sort().join(',') !== 'id,name,supports_images' ||
      typeof row.id !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(row.id) ||
      reserved.has(row.id) ||
      seen.has(row.id) ||
      typeof row.name !== 'string' ||
      !row.name.trim() ||
      row.name.length > 80 ||
      /[\x00-\x1f\x7f]/.test(row.name) ||
      typeof row.supports_images !== 'boolean'
    )
      throw new Error('E_MODEL_CATALOG');
    seen.add(row.id);
    return {
      id: row.id,
      name: row.name.trim(),
      supports_images: row.supports_images,
    };
  });
}
let catalog: DshCatalog = {
  schema_version: 1,
  models: DEFAULT_DSH_MODELS.map(row => ({ ...row })),
  retired_models: [],
};
const listeners = new Set<() => void>();
export const getDshCatalog = () => catalog;
export const subscribeDshCatalog = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export function installDshCatalog(value: DshCatalog): void {
  if (
    value?.schema_version !== 1 ||
    !Array.isArray(value.retired_models) ||
    value.retired_models.length > 256
  )
    throw new Error('E_MODEL_CATALOG');
  const models = validateDshModels(value.models);
  const retired = value.retired_models.map(row => validateDshModels([row])[0]);
  if (
    new Set([...models, ...retired].map(row => row.id)).size !==
    models.length + retired.length
  )
    throw new Error('E_MODEL_CATALOG');
  catalog = { schema_version: 1, models, retired_models: retired };
  listeners.forEach(listener => listener());
}
export function dshModelEntry(id: string): DshModelEntry | undefined {
  return [
    ...catalog.models,
    ...catalog.retired_models,
    ...DEFAULT_DSH_MODELS,
  ].find(row => row.id === id);
}
export const isRegisteredDshModel = (value: unknown): value is string =>
  typeof value === 'string' && dshModelEntry(value) !== undefined;
export const dshModelSupportsImages = (id: string): boolean =>
  dshModelEntry(id)?.supports_images === true;
