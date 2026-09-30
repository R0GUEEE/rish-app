/**
 * A byte count as a person reads it.
 *
 * Shared rather than written twice: the export transcript sizes an attachment
 * and the usage sheet sizes a context with the same rule, and two copies would
 * eventually round differently. Anything that is not a real, non-negative
 * number reads as zero rather than as `NaN MB`.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KB`;
  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MB`;
}
