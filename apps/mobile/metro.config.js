const fs = require('fs');
const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
function buildConfig() {
  const defaults = getDefaultConfig(__dirname);
  const config = {};

  // Feature worktrees share the checkout's node_modules through a symlink.
  // Metro walks ancestor directories without following that boundary when
  // resolving bare module names such as @babel/runtime helpers, so map every
  // name onto the physical folder explicitly. Checkouts whose node_modules
  // is already a real directory keep the plain default resolution.
  const link = path.join(__dirname, 'node_modules');
  let real = null;
  try {
    real = fs.realpathSync(link);
  } catch {
    real = null;
  }
  if (real !== null && real !== link && !link.startsWith(real + path.sep)) {
    return mergeConfig(defaults, {
      ...config,
      watchFolders: [...(config.watchFolders ?? []), real],
      resolver: {
        ...(config.resolver ?? {}),
        extraNodeModules: new Proxy(
          {},
          {
            get: (_target, moduleName) => {
              if (typeof moduleName !== 'string') {
                return undefined;
              }
              return path.join(real, moduleName);
            },
          },
        ),
      },
    });
  }

  return mergeConfig(defaults, config);
}

module.exports = buildConfig();
