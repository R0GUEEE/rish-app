/** Optional explicit marker; property reads also work on RN HostObjects. */
export function nativeImplementationAvailable(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  try { return Reflect.get(value, 'implemented') !== false; }
  catch { return false; }
}
