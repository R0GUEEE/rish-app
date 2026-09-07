import { NativeModules } from 'react-native';
import type {
  ConfigurableHarness,
  ProviderConfiguration,
} from './configuration';
const native = () => NativeModules.LocalRuntime;
export const ProviderConfigurations = {
  isAvailable: () => {
    try {
      return (
        typeof native()?.providerConfiguration === 'function' &&
        typeof native()?.saveProviderConfiguration === 'function' &&
        typeof native()?.resetProviderConfiguration === 'function'
      );
    } catch {
      return false;
    }
  },
  read: (harness: ConfigurableHarness): Promise<ProviderConfiguration> =>
    native().providerConfiguration(harness),
  save: (
    configuration: ProviderConfiguration,
  ): Promise<ProviderConfiguration> => {
    const request = { ...configuration };
    delete request.official;
    return native().saveProviderConfiguration(request);
  },
  reset: (harness: ConfigurableHarness): Promise<ProviderConfiguration> =>
    native().resetProviderConfiguration(harness),
};
