import type { PluginCapability } from '../plugins/plugins';

/**
 * The translator key for each capability, in one place so the manager and the
 * editor cannot label the same capability differently.
 *
 * `as const`, not `Record<..., string>`: the translator is typed by its key
 * union, so a widened string would not be accepted as one of them.
 */
export const CAPABILITY_LABELS = {
  file_read: 'plugins.capability.fileRead',
  file_write: 'plugins.capability.fileWrite',
  git_status: 'plugins.capability.gitStatus',
  git_commit: 'plugins.capability.gitCommit',
  git_push: 'plugins.capability.gitPush',
  guest_service: 'plugins.capability.guestService',
} as const satisfies Record<PluginCapability, string>;
