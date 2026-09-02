const MAX_GIT_HTTPS_PROXY_URL_LENGTH = 2048;
const PROXY_URL = /^(https?):\/\/(\[[^\]]+\]|[^@:/?#]+):([0-9]+)\/?$/iu;

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates and canonicalizes the explicit HTTP(S) proxy endpoint used by Git.
 *
 * A port is intentionally required, including for ports 80 and 443. Building
 * the canonical value ourselves preserves those explicit default ports, which
 * WHATWG URL serialization would otherwise remove.
 */
export function normalizeGitHttpsProxyUrl(value: unknown): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_GIT_HTTPS_PROXY_URL_LENGTH ||
    value !== value.trim() ||
    containsControlCharacter(value)
  ) {
    return null;
  }

  const match = PROXY_URL.exec(value);
  if (match === null) {
    return null;
  }

  const port = Number(match[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.pathname !== '/'
    ) {
      return null;
    }

    const normalized = `${parsed.protocol}//${parsed.hostname}:${port}/`;
    return normalized.length <= MAX_GIT_HTTPS_PROXY_URL_LENGTH
      ? normalized
      : null;
  } catch {
    return null;
  }
}

export function isGitHttpsProxyUrl(value: unknown): value is string {
  return normalizeGitHttpsProxyUrl(value) !== null;
}
