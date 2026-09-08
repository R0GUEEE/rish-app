import { NativeModules } from 'react-native';
import {
  installDshCatalog,
  validateDshModels,
  type DshCatalog,
  type DshModelEntry,
} from './catalog';
const native = () => NativeModules.LocalRuntime;
export const DshModelCatalog = {
  isAvailable: () => {
    try {
      return (
        typeof native()?.dshModelCatalog === 'function' &&
        typeof native()?.saveDshModelCatalog === 'function'
      );
    } catch {
      return false;
    }
  },
  async refresh(): Promise<void> {
    if (!this.isAvailable()) return;
    installDshCatalog(await native().dshModelCatalog());
  },
  async save(models: DshModelEntry[]): Promise<void> {
    const value: DshCatalog = await native().saveDshModelCatalog({
      schema_version: 1,
      models: validateDshModels(models),
    });
    installDshCatalog(value);
  },
};
