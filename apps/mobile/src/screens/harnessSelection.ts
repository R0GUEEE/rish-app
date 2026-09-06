import {
  BUILTIN_HARNESSES,
  DSH_HARNESS,
  isHarnessModelId,
  type HarnessModelId,
} from '../harness';

/** A preference for another provider must not seed an incompatible new chat. */
export function defaultModelForHarness(
  harnessId: string,
  preferredModel: HarnessModelId,
): HarnessModelId {
  const harness = BUILTIN_HARNESSES.get(harnessId) ?? DSH_HARNESS;
  const models = harness.models.map(model => model.id).filter(isHarnessModelId);
  return models.includes(preferredModel)
    ? preferredModel
    : models[0] ?? 'deepseek-v4-flash';
}
