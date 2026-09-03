import { IMAGE_LIMITS } from './limits';

/**
 * Classifies an image target from hostile model output. Only https/http
 * (user-consented tap-to-load), bounded data: image URIs, and local
 * attachment:// references are renderable. Everything else fails closed.
 */

export type BlockedReason =
  | 'scheme'
  | 'malformed'
  | 'too-long'
  | 'data-unsupported'
  | 'data-too-large';

export type ImageTarget =
  | { kind: 'remote'; url: string; host: string }
  | { kind: 'data'; uri: string }
  | { kind: 'attachment'; id: string }
  | { kind: 'blocked'; reason: BlockedReason };

const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|gif|webp);base64,/iu;
const ATTACHMENT_RE = /^attachment:\/\/([A-Za-z0-9_-]{1,64})$/u;
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9+.-]*):/u;

const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u;

/**
 * Extracts the hostname from an http(s) target without relying on a global
 * URL constructor (Hermes on device does not ship one). Credentials,
 * ports, IPv6 brackets, or malformed authority shapes fail closed.
 */
function remoteHost(target: string, scheme: string): string | null {
  const authority = target.slice(scheme.length + 3);
  const hostPort = authority.split(/[/?#]/u, 1)[0];
  if (hostPort.length === 0 || hostPort.includes('@')) return null;
  const host = hostPort.includes(':') ? hostPort.split(':')[0] : hostPort;
  if (host.length === 0 || host.length > 253) return null;
  if (!HOST_RE.test(host)) return null;
  return host;
}

export function classifyImageTarget(target: string): ImageTarget {
  const match = SCHEME_RE.exec(target);
  const scheme = match?.[1].toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    if (target.length > IMAGE_LIMITS.maxUrlChars)
      return { kind: 'blocked', reason: 'too-long' };
    const host = remoteHost(target, scheme);
    if (host === null) return { kind: 'blocked', reason: 'malformed' };
    return { kind: 'remote', url: target, host };
  }
  if (scheme === 'data') {
    if (target.length > IMAGE_LIMITS.maxDataUriChars)
      return { kind: 'blocked', reason: 'data-too-large' };
    if (!DATA_IMAGE_RE.test(target))
      return { kind: 'blocked', reason: 'data-unsupported' };
    return { kind: 'data', uri: target };
  }
  if (scheme === 'attachment') {
    if (target.length > IMAGE_LIMITS.maxUrlChars)
      return { kind: 'blocked', reason: 'too-long' };
    const attachment = ATTACHMENT_RE.exec(target);
    if (attachment === null) return { kind: 'blocked', reason: 'malformed' };
    return { kind: 'attachment', id: attachment[1] };
  }
  if (scheme === undefined) return { kind: 'blocked', reason: 'malformed' };
  return { kind: 'blocked', reason: 'scheme' };
}

/** Display label for a blocked target, for accessibility and UI text. */
export function blockedReasonLabel(reason: BlockedReason): string {
  switch (reason) {
    case 'scheme':
      return 'scheme not allowed';
    case 'malformed':
      return 'malformed URL';
    case 'too-long':
      return 'URL too long';
    case 'data-unsupported':
      return 'unsupported data URI';
    case 'data-too-large':
      return 'data URI too large';
  }
}
