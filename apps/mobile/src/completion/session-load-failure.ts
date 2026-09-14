/** Stable, value-free diagnostics: never display native paths or stored text. */
const codes = new Set([
  'E_SESSION_INVALID',
  'E_SESSION_CORRUPT',
  'E_SESSION_STORAGE',
  'E_SESSION_PROTECTION',
  'E_SESSION_BOUNDS',
  'E_SESSION_CONFLICT',
  'E_SESSION_NATIVE',
  'E_SESSION_PERSISTENCE',
  'E_WORKSPACE_INVALID',
  'E_WORKSPACE_NOT_FOUND',
  'E_WORKSPACE_BUSY',
  'E_WORKSPACE_CONFLICT',
  'E_WORKSPACE_PERSISTENCE',
]);

export function sessionLoadFailureCode(error: unknown): string {
  if (typeof error !== 'object' || error === null)
    return 'E_SESSION_PERSISTENCE';
  try {
    const code = (error as { code?: unknown }).code;
    return typeof code === 'string' && codes.has(code)
      ? code
      : 'E_SESSION_PERSISTENCE';
  } catch {
    return 'E_SESSION_PERSISTENCE';
  }
}
