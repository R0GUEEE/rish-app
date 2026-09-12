import {
  markTimingSync,
  sessionCandidateDigestSync,
} from '../native/SessionSnapshots';
import {
  parseStrictJSON,
  safeHydrateChatState,
  sessionCandidateIsValid,
} from '../state/persistence';
import type { CompletionVisibleMessageV2 } from './types';

export type SessionDurabilityStatus =
  | 'committed'
  | 'session_only'
  | 'not_committed'
  | 'unknown';

export type SessionDurabilityResult = {
  readonly status: SessionDurabilityStatus;
};

export type SessionSnapshotRefV1 = {
  readonly schema_version: 1;
  readonly generation: number;
  readonly session_sha256: string;
};

export type LegacySessionSnapshotRefV1 = {
  readonly schema_version: 1;
  readonly legacy_bytes_sha256: string;
};

export type SessionSnapshotAuthorityV1 =
  | { readonly schema_version: 1; readonly kind: 'missing' }
  | {
      readonly schema_version: 1;
      readonly kind: 'legacy_present';
      readonly legacy: LegacySessionSnapshotRefV1;
    }
  | {
      readonly schema_version: 1;
      readonly kind: 'present';
      readonly snapshot: SessionSnapshotRefV1;
    };

export type LoadSessionSnapshotResultV1 =
  | {
      readonly schema_version: 1;
      readonly status: 'missing';
      readonly snapshot: null;
      readonly session_json: null;
      readonly writer_launch_instance_id: null;
      readonly current_launch_instance_id: string;
    }
  | {
      readonly schema_version: 1;
      readonly status: 'legacy_present';
      readonly legacy: LegacySessionSnapshotRefV1;
      readonly session_json: string;
      readonly writer_launch_instance_id: string;
      readonly current_launch_instance_id: string;
    }
  | {
      readonly schema_version: 1;
      readonly status: 'present';
      readonly snapshot: SessionSnapshotRefV1;
      readonly session_json: string;
      readonly writer_launch_instance_id: string;
      readonly current_launch_instance_id: string;
    };

export type SessionCASPersistRequestV1 = {
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly expected: SessionSnapshotAuthorityV1;
  readonly candidate_json: string;
};

export type SessionCASPersistResultV1 =
  | {
      readonly schema_version: 1;
      readonly status: 'committed';
      readonly snapshot: SessionSnapshotRefV1;
    }
  | {
      readonly schema_version: 1;
      readonly status: 'conflict';
      readonly current: SessionSnapshotAuthorityV1;
    }
  | {
      readonly schema_version: 1;
      readonly status: 'not_committed' | 'session_only' | 'unknown';
      readonly current: SessionSnapshotAuthorityV1;
    };

export type SessionCommitQueryResultV1 =
  | { readonly schema_version: 1; readonly status: 'not_started' | 'unknown' }
  | {
      readonly schema_version: 1;
      readonly status: 'committed';
      readonly snapshot: SessionSnapshotRefV1;
    }
  | {
      readonly schema_version: 1;
      readonly status: 'conflict';
      readonly current: SessionSnapshotAuthorityV1;
    };

export type SessionPersistenceDependencies = {
  readonly persistSession?: (json: string) => Promise<unknown>;
  readonly loadSession?: () => Promise<unknown>;
  /** Versioned native CAS API.  When supplied, it is the schema-9 authority. */
  readonly casPersistSession?: (
    request: SessionCASPersistRequestV1,
  ) => Promise<unknown>;
  readonly querySessionCommit?: (
    request: { readonly schema_version: 1; readonly operation_id: string },
  ) => Promise<unknown>;
  readonly loadSessionSnapshot?: () => Promise<unknown>;
  readonly loadSessionAuthority?: () => Promise<unknown>;
};

export type SessionPersistenceCoordinator = {
  write(
    candidate: unknown,
    options?: {
      readonly operation_id?: string;
      readonly operationId?: string;
      readonly expected?: SessionSnapshotAuthorityV1;
    },
  ): Promise<SessionDurabilityResult>;
  loadAuthority(): Promise<SessionSnapshotAuthorityV1>;
  read(): Promise<SessionSnapshotAuthorityV1>;
  casPersist(
    request: SessionCASPersistRequestV1,
  ): Promise<SessionCASPersistResultV1 | null>;
  writeCAS(
    request: SessionCASPersistRequestV1,
  ): Promise<SessionCASPersistResultV1 | null>;
  queryCommit(
    operationId:
      | string
      | { readonly schema_version: 1; readonly operation_id: string },
  ): Promise<SessionCommitQueryResultV1 | null>;
  /** Explicit names mirror the versioned native bridge. */
  persistCAS(
    request: SessionCASPersistRequestV1,
  ): Promise<SessionCASPersistResultV1 | null>;
  casPersistSession(
    request: SessionCASPersistRequestV1,
  ): Promise<SessionCASPersistResultV1 | null>;
  persistSessionCAS(
    request: SessionCASPersistRequestV1,
  ): Promise<SessionCASPersistResultV1 | null>;
  querySessionCommit(
    operationId:
      | string
      | { readonly schema_version: 1; readonly operation_id: string },
  ): Promise<SessionCommitQueryResultV1 | null>;
  loadSessionSnapshot(): Promise<SessionSnapshotAuthorityV1>;
  loadSessionSnapshotResult(): Promise<LoadSessionSnapshotResultV1 | null>;
};

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 250_000;
const MAX_PENDING_WRITES = 16;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const RESULTS: Readonly<Record<SessionDurabilityStatus, SessionDurabilityResult>> =
  Object.freeze({
    committed: Object.freeze({ status: 'committed' }),
    session_only: Object.freeze({ status: 'session_only' }),
    not_committed: Object.freeze({ status: 'not_committed' }),
    unknown: Object.freeze({ status: 'unknown' }),
  });

type ParsedJSON =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false };

/* eslint-disable no-bitwise -- SHA-256's compression function is bitwise by definition. */
function digestBytes(bytes: readonly number[]): string {
  // Small dependency-free SHA-256 implementation for the native session
  // snapshot digest. It is intentionally local to this module; proof
  // generation and tool digests must use their own frozen contracts.
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ]);
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b,
    0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
    0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7,
    0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
    0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152,
    0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
    0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
    0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f,
    0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const padded = [...bytes, 0x80];
  while ((padded.length + 8) % 64 !== 0) padded.push(0);
  const bitLength = bytes.length * 8;
  for (let shift = 7; shift >= 0; shift -= 1) {
    padded.push(Math.floor(bitLength / 2 ** (shift * 8)) & 0xff);
  }
  const rotr = (value: number, amount: number) =>
    (value >>> amount) | (value << (32 - amount));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const at = offset + index * 4;
      words[index] =
        ((padded[at]! << 24) |
          (padded[at + 1]! << 16) |
          (padded[at + 2]! << 8) |
          padded[at + 3]!) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const smallSigma0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const smallSigma1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      words[index] =
        (words[index - 16]! + smallSigma0 + words[index - 7]! + smallSigma1) >>>
        0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const bigSigma1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const temp1 = (h + bigSigma1 + choice + constants[index]! + words[index]!) >>> 0;
      const bigSigma0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (bigSigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return Array.from(hash, value => value.toString(16).padStart(8, '0')).join('');
}

function utf8(value: string): number[] | null {
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) result.push(unit);
    else if (unit <= 0x7ff) {
      result.push(0xc0 | (unit >>> 6), 0x80 | (unit & 0x3f));
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (!Number.isFinite(low) || low < 0xdc00 || low > 0xdfff) return null;
      const codePoint = 0x10000 + ((unit - 0xd800) << 10) + low - 0xdc00;
      result.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return null;
    else result.push(0xe0 | (unit >>> 12), 0x80 | ((unit >>> 6) & 0x3f), 0x80 | (unit & 0x3f));
  }
  return result;
}

/* eslint-enable no-bitwise */

function jcsHash(tag: string, bytes: readonly number[]): string {
  const prefix = utf8(`rish.${tag}.v1\0`) ?? [];
  return digestBytes([...prefix, ...bytes]);
}

function canonicalJSONValue(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0) ? JSON.stringify(value) : null;
  }
  if (Array.isArray(value)) {
    const values = value.map(canonicalJSONValue);
    return values.every(item => item !== null) ? `[${values.join(',')}]` : null;
  }
  const record = plainRecord(value);
  if (record === null) return null;
  const names = Object.keys(record).sort();
  const pairs: string[] = [];
  for (const name of names) {
    const child = canonicalJSONValue(record[name]);
    if (child === null) return null;
    pairs.push(`${JSON.stringify(name)}:${child}`);
  }
  return `{${pairs.join(',')}}`;
}


// Whole-text scans over a megabyte session (byte bounds, lexical budget,
// schema probe, status match) repeat several times per checkpoint on the same
// string. Remember the last few answers by value; Hermes compares equal-length
// strings with a memcmp, far cheaper than any scan.
class TextMemo<T> {
  private readonly entries: Array<{ readonly value: string; readonly result: T }> = [];

  constructor(private readonly capacity: number = 4) {}

  get(value: string): T | undefined {
    for (let index = 0; index < this.entries.length; index += 1) {
      const entry = this.entries[index]!;
      if (entry.value === value) return entry.result;
    }
    return undefined;
  }

  set(value: string, result: T): T {
    if (this.entries.length >= this.capacity) this.entries.shift();
    this.entries.push({ value, result });
    return result;
  }
}

const boundedUtf8Memo = new TextMemo<boolean>();
const lexicalBudgetMemo = new TextMemo<boolean>();
const schema9Memo = new TextMemo<boolean>();
const loadedStatusMemo = new TextMemo<boolean>();

function boundedUtf8(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SESSION_BYTES) return false;
  const remembered = boundedUtf8Memo.get(value);
  if (remembered !== undefined) return remembered;
  return boundedUtf8Memo.set(value, scanBoundedUtf8(value));
}

function scanBoundedUtf8(value: string): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(index + 1);
      if (low < 0xdc00 || low > 0xdfff) return false;
      bytes += 4;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    } else {
      bytes += 3;
    }
    if (bytes > MAX_SESSION_BYTES) return false;
  }
  return true;
}

function isJSONWhitespace(character: string): boolean {
  return (
    character === ' ' ||
    character === '\n' ||
    character === '\r' ||
    character === '\t'
  );
}

function lexicalJSONBudget(value: string): boolean {
  const remembered = lexicalBudgetMemo.get(value);
  if (remembered !== undefined) return remembered;
  return lexicalBudgetMemo.set(value, scanLexicalJSONBudget(value));
}

function scanLexicalJSONBudget(value: string): boolean {
  const containers: string[] = [];
  let tokens = 0;
  let inString = false;
  let escaped = false;
  const addToken = () => {
    tokens += 1;
    return tokens <= MAX_JSON_NODES;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (isJSONWhitespace(character)) continue;
    if (character === '"') {
      if (!addToken()) return false;
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') {
      if (!addToken()) return false;
      containers.push(character);
      if (containers.length > MAX_JSON_DEPTH) return false;
      continue;
    }
    if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (containers.pop() !== expected) return false;
      continue;
    }
    if (character === ',' || character === ':') continue;

    if (!addToken()) return false;
    let end = index + 1;
    while (end < value.length) {
      const next = value[end]!;
      if (
        isJSONWhitespace(next) ||
        next === ',' ||
        next === ':' ||
        next === ']' ||
        next === '}' ||
        next === '[' ||
        next === '{' ||
        next === '"'
      ) {
        break;
      }
      end += 1;
    }
    index = end - 1;
  }
  return (
    !inString &&
    !escaped &&
    containers.length === 0 &&
    tokens > 0
  );
}

function preflightJSON(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    boundedUtf8(value) &&
    lexicalJSONBudget(value)
  );
}

function ownDataValues(
  value: object,
): { readonly names: readonly string[]; readonly values: readonly unknown[] } | null {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const names = Object.getOwnPropertyNames(value);
  const values: unknown[] = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index]!;
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) {
      return null;
    }
    values[index] = descriptor.value;
  }
  return { names, values };
}

function validateJSONTree(root: unknown): boolean {
  const stack: Array<{ readonly value: unknown; readonly depth: number }> = [
    { value: root, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const item = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || item.depth > MAX_JSON_DEPTH) return false;
    const value = item.value;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean'
    ) {
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== 'object') return false;
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) return false;
      const length = value.length;
      if (nodes + stack.length + length > MAX_JSON_NODES) return false;
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (
          descriptor === undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
          descriptor.enumerable !== true
        ) {
          return false;
        }
        stack.push({ value: descriptor.value, depth: item.depth + 1 });
      }
      if (
        Object.getOwnPropertyNames(value).some(
          name => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(name),
        ) ||
        Object.getOwnPropertySymbols(value).length > 0
      ) {
        return false;
      }
      continue;
    }
    const record = ownDataValues(value);
    if (record === null) return false;
    if (nodes + stack.length + record.values.length > MAX_JSON_NODES) {
      return false;
    }
    record.values.forEach(child =>
      stack.push({ value: child, depth: item.depth + 1 }),
    );
  }
  return true;
}

function parsePreflightedJSON(value: string): ParsedJSON {
  try {
    const parsed = parseStrictJSON(value);
    return validateJSONTree(parsed)
      ? { ok: true, value: parsed }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

// A candidate the serializer has already validated (by exact text) needs no
// further JS preflight: hydration subsumes the schema probe, and the byte and
// node budgets are enforced natively before anything is written. Unknown text
// still goes through every check.
function candidateAcceptable(candidate: string): boolean {
  if (sessionCandidateIsValid(candidate)) return true;
  return (
    preflightJSON(candidate) &&
    parsePreflightedJSON(candidate).ok &&
    candidateIsSchema9(candidate) &&
    sessionCandidateIsValid(candidate)
  );
}

function candidateIsSchema9(value: string): boolean {
  const remembered = schema9Memo.get(value);
  if (remembered !== undefined) return remembered;
  return schema9Memo.set(value, probeCandidateIsSchema9(value));
}

function probeCandidateIsSchema9(value: string): boolean {
  try {
    const parsed = parseStrictJSON(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false;
    const schema = Object.getOwnPropertyDescriptor(parsed, 'schema_version');
    return schema !== undefined && schema.value === 9;
  } catch {
    return false;
  }
}

// One checkpoint digests the same candidate string several times (the write
// path, the post-commit check and the store transaction all re-derive it), so
// remember the last few results by value. The digest is a pure function of
// the string, and Hermes compares equal-length strings with a memcmp, which is
// far cheaper than any digest.
const DIGEST_MEMO_ENTRIES = 4;
const digestMemo: Array<{ readonly value: string; readonly digest: string }> = [];

function rememberedDigest(value: string): string | null {
  for (let index = 0; index < digestMemo.length; index += 1) {
    const entry = digestMemo[index]!;
    if (entry.value === value) return entry.digest;
  }
  return null;
}

function rememberDigest(value: string, digest: string): void {
  if (digestMemo.length >= DIGEST_MEMO_ENTRIES) digestMemo.shift();
  digestMemo.push({ value, digest });
}

function candidateSessionDigest(value: string): string | null {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_SESSION_BYTES
  ) {
    return null;
  }
  const remembered = rememberedDigest(value);
  if (remembered !== null) return remembered;
  const digest = computeCandidateSessionDigest(value);
  if (digest !== null) rememberDigest(value, digest);
  return digest;
}

function computeCandidateSessionDigest(value: string): string | null {
  try {
    // The bridge module may be mocked or absent; a missing fast path is the
    // pure-JS path, never a failure.
    const native = sessionCandidateDigestSync(value);
    if (typeof native === 'string') return native;
  } catch {}
  try {
    const parsed = parseStrictJSON(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) return null;
    const raw = plainRecord(parsed);
    if (raw === null || raw.schema_version !== 9) return null;
    const canonical = canonicalJSONValue(parsed);
    if (canonical === null) return null;
    const bytes = utf8(canonical);
    return bytes === null || bytes.length === 0 || bytes.length > MAX_SESSION_BYTES
      ? null
      : jcsHash('chat-session', bytes);
  } catch {
    return null;
  }
}

export function sessionSnapshotSHA256(candidateJSON: string): string | null {
  return candidateSessionDigest(candidateJSON);
}

export const chatSessionSHA256 = sessionSnapshotSHA256;

/**
 * Computes the raw Runtime Proof SHA-256 for one recovered assistant field.
 * This is purpose-specific: it intentionally does not expose the canonical
 * JSON or generic digest primitives used by session persistence.
 */
export function agentTextSHA256(text: string): string | null {
  try {
    if (typeof text !== 'string' || text.length > MAX_SESSION_BYTES) return null;
    const bytes = utf8(text);
    return bytes === null || bytes.length > MAX_SESSION_BYTES ? null : digestBytes(bytes);
  } catch {
    return null;
  }
}

const VISIBLE_HISTORY_MAX_MESSAGES = 96;
const VISIBLE_HISTORY_MAX_MESSAGE_BYTES = 256 * 1024;
const VISIBLE_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const VISIBLE_HISTORY_MAX_ATTACHMENTS_PER_MESSAGE = 6;
const VISIBLE_HISTORY_MAX_ATTACHMENTS = 24;
const VISIBLE_HISTORY_MAX_ATTACHMENT_BYTES = 24 * 1024 * 1024;
const VISIBLE_HISTORY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function exactVisibleRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  const record = plainRecord(value);
  if (record === null) return null;
  const names = Object.keys(record);
  return names.length === keys.length && names.every(key => keys.includes(key))
    ? record
    : null;
}

function strictVisibleHistory(
  value: unknown,
): readonly CompletionVisibleMessageV2[] | null {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    Object.getOwnPropertySymbols(value).length > 0 ||
    value.length < 1 ||
    value.length > VISIBLE_HISTORY_MAX_MESSAGES
  ) return null;
  const messageLength = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    messageLength === undefined ||
    !Object.prototype.hasOwnProperty.call(messageLength, 'value') ||
    !Number.isSafeInteger(messageLength.value) ||
    Object.is(messageLength.value, -0) ||
    messageLength.value !== value.length
  ) return null;
  if (
    Object.getOwnPropertyNames(value).some(
      key => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key),
    )
  ) return null;
  let totalMessageBytes = 0;
  let totalAttachmentBytes = 0;
  let totalAttachmentCount = 0;
  const messages: CompletionVisibleMessageV2[] = [];
  const attachmentIds = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const itemDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      itemDescriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(itemDescriptor, 'value') ||
      itemDescriptor.enumerable !== true
    ) return null;
    const message = exactVisibleRecord(itemDescriptor.value, [
      'role',
      'content',
      'attachments',
    ]);
    if (
      message === null ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      typeof message.content !== 'string' ||
      message.content.length === 0 ||
      message.content.length > VISIBLE_HISTORY_MAX_MESSAGE_BYTES
    ) return null;
    const contentBytes = utf8(message.content);
    if (contentBytes === null) return null;
    totalMessageBytes += contentBytes.length;
    if (totalMessageBytes > VISIBLE_HISTORY_MAX_BYTES) return null;
    const attachmentsValue = message.attachments;
    if (
      !Array.isArray(attachmentsValue) ||
      Object.getPrototypeOf(attachmentsValue) !== Array.prototype ||
      Object.getOwnPropertySymbols(attachmentsValue).length > 0 ||
      attachmentsValue.length > VISIBLE_HISTORY_MAX_ATTACHMENTS_PER_MESSAGE
    ) return null;
    if (
      Object.getOwnPropertyNames(attachmentsValue).some(
        key => key !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(key),
      )
    ) return null;
    const attachments: CompletionVisibleMessageV2['attachments'][number][] = [];
    for (let attachmentIndex = 0; attachmentIndex < attachmentsValue.length; attachmentIndex += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        attachmentsValue,
        String(attachmentIndex),
      );
      if (
        descriptor === undefined ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
        descriptor.enumerable !== true
      ) return null;
      const attachment = exactVisibleRecord(descriptor.value, [
        'schema_version',
        'id',
        'kind',
        'name',
        'mime_type',
        'size',
      ]);
      if (
        attachment === null ||
        attachment.schema_version !== 1 ||
        typeof attachment.id !== 'string' ||
        !VISIBLE_HISTORY_UUID.test(attachment.id) ||
        (attachment.kind !== 'image' &&
          attachment.kind !== 'text' &&
          attachment.kind !== 'pdf') ||
        typeof attachment.name !== 'string' ||
        attachment.name.length === 0 ||
        attachment.name.length > 512 ||
        typeof attachment.mime_type !== 'string' ||
        attachment.mime_type.length === 0 ||
        attachment.mime_type.length > 128 ||
        typeof attachment.size !== 'number' ||
        !Number.isSafeInteger(attachment.size) ||
        Object.is(attachment.size, -0) ||
        attachment.size < 1 ||
        attachment.size > VISIBLE_HISTORY_MAX_ATTACHMENT_BYTES ||
        attachmentIds.has(attachment.id)
      ) return null;
      attachmentIds.add(attachment.id);
      totalAttachmentCount += 1;
      totalAttachmentBytes += attachment.size;
      if (
        totalAttachmentCount > VISIBLE_HISTORY_MAX_ATTACHMENTS ||
        totalAttachmentBytes > VISIBLE_HISTORY_MAX_BYTES
      ) return null;
      attachments.push({
        schema_version: 1,
        id: attachment.id,
        kind: attachment.kind,
        name: attachment.name,
        mime_type: attachment.mime_type,
        size: attachment.size,
      });
    }
    if (message.role === 'assistant' && attachments.length > 0) return null;
    messages.push({
      role: message.role,
      content: message.content,
      attachments,
    });
  }
  if (messages.at(-1)?.role !== 'user') return null;
  return Object.freeze(
    messages.map(message =>
      Object.freeze({
        role: message.role,
        content: message.content,
        attachments: Object.freeze(
          message.attachments.map(attachment => Object.freeze({ ...attachment })),
        ),
      }),
    ),
  );
}

/**
 * Computes the approved visible-history digest using the existing canonical
 * JSON and HJ primitives. The payload is exactly `{messages}` and the tag is
 * exactly `visible-history`; invalid/mutable input yields null.
 */
export function visibleHistorySHA256(
  messages: readonly CompletionVisibleMessageV2[],
): string | null {
  try {
    const projected = strictVisibleHistory(messages);
    if (projected === null) return null;
    const canonical = canonicalJSONValue({ messages: projected });
    if (canonical === null) return null;
    const bytes = utf8(canonical);
    return bytes === null || bytes.length === 0 || bytes.length > MAX_SESSION_BYTES
      ? null
      : jcsHash('visible-history', bytes);
  } catch {
    return null;
  }
}

function expectedNextGeneration(
  authority: SessionSnapshotAuthorityV1,
): number | null {
  if (authority.kind === 'missing' || authority.kind === 'legacy_present') return 1;
  if (authority.snapshot.generation >= Number.MAX_SAFE_INTEGER) return null;
  return authority.snapshot.generation + 1;
}

function sameAuthority(
  left: SessionSnapshotAuthorityV1,
  right: SessionSnapshotAuthorityV1,
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'missing' || right.kind === 'missing') return true;
  if (left.kind === 'legacy_present' && right.kind === 'legacy_present') {
    return left.legacy.legacy_bytes_sha256 === right.legacy.legacy_bytes_sha256;
  }
  if (left.kind === 'present' && right.kind === 'present') {
    return (
      left.snapshot.generation === right.snapshot.generation &&
      left.snapshot.session_sha256 === right.snapshot.session_sha256
    );
  }
  return false;
}

function committedRefMatches(
  response: SessionCASPersistResultV1 | SessionCommitQueryResultV1,
  digest: string,
  expectedGeneration: number,
): boolean {
  return (
    response.status === 'committed' &&
    response.snapshot.session_sha256 === digest &&
    response.snapshot.generation === expectedGeneration
  );
}

function sessionOnlyRefMatches(
  response: SessionCASPersistResultV1,
  digest: string,
  expectedGeneration: number,
): boolean {
  return (
    response.status === 'session_only' &&
    response.current.kind === 'present' &&
    response.current.snapshot.generation === expectedGeneration &&
    response.current.snapshot.session_sha256 === digest
  );
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const name of Object.getOwnPropertyNames(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, 'value') ||
      descriptor.enumerable !== true
    ) return null;
    result[name] = descriptor.value;
  }
  return result;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const names = Object.keys(value);
  return names.length === keys.length && names.every(name => keys.includes(name));
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function validSha256(value: unknown): value is string {
  return typeof value === 'string' && SHA256_PATTERN.test(value);
}

function loadedSessionJSONMatchesStatus(
  status: 'legacy_present' | 'present',
  value: unknown,
): value is string {
  if (typeof value !== 'string') return false;
  const remembered = loadedStatusMemo.get(status + '\u0000' + value);
  if (remembered !== undefined) return remembered;
  return loadedStatusMemo.set(status + '\u0000' + value, scanLoadedSessionJSONMatchesStatus(status, value));
}

function scanLoadedSessionJSONMatchesStatus(
  status: 'legacy_present' | 'present',
  value: string,
): boolean {
  if (!boundedUtf8(value)) return false;
  try {
    const parsed = parseStrictJSON(value);
    const raw = plainRecord(parsed);
    if (raw === null || typeof raw.schema_version !== 'number') return false;
    const schema = raw.schema_version;
    const legacy =
      Number.isSafeInteger(schema) &&
      !Object.is(schema, -0) &&
      schema >= 2 &&
      schema <= 8;
    if ((status === 'legacy_present') !== legacy) return false;
    if (status === 'present' && schema !== 9) return false;
    return safeHydrateChatState(value).ok;
  } catch {
    return false;
  }
}

function parseAuthority(value: unknown): SessionSnapshotAuthorityV1 | null {
  const raw = plainRecord(value);
  if (raw === null || raw.schema_version !== 1 || typeof raw.kind !== 'string') return null;
  if (raw.kind === 'missing') {
    return exactKeys(raw, ['schema_version', 'kind'])
      ? { schema_version: 1, kind: 'missing' }
      : null;
  }
  if (raw.kind === 'legacy_present') {
    if (!exactKeys(raw, ['schema_version', 'kind', 'legacy'])) return null;
    const legacy = plainRecord(raw.legacy);
    if (
      legacy === null ||
      !exactKeys(legacy, ['schema_version', 'legacy_bytes_sha256']) ||
      legacy.schema_version !== 1 ||
      !validSha256(legacy.legacy_bytes_sha256)
    ) return null;
    return {
      schema_version: 1,
      kind: 'legacy_present',
      legacy: { schema_version: 1, legacy_bytes_sha256: legacy.legacy_bytes_sha256 },
    };
  }
  if (raw.kind === 'present') {
    if (!exactKeys(raw, ['schema_version', 'kind', 'snapshot'])) return null;
    const snapshot = plainRecord(raw.snapshot);
    if (
      snapshot === null ||
      !exactKeys(snapshot, ['schema_version', 'generation', 'session_sha256']) ||
      snapshot.schema_version !== 1 ||
      typeof snapshot.generation !== 'number' ||
      !Number.isSafeInteger(snapshot.generation) ||
      Object.is(snapshot.generation, -0) ||
      snapshot.generation < 1 ||
      !validSha256(snapshot.session_sha256)
    ) return null;
    return {
      schema_version: 1,
      kind: 'present',
      snapshot: {
        schema_version: 1,
        generation: snapshot.generation,
        session_sha256: snapshot.session_sha256,
      },
    };
  }
  return null;
}

const launchInstanceIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function isLaunchInstanceId(value: unknown): value is string {
  return typeof value === 'string' && launchInstanceIdPattern.test(value);
}

function parseLoadSnapshot(
  value: unknown,
  options: { readonly verifySessionText?: boolean } = {},
): LoadSessionSnapshotResultV1 | null {
  const verifySessionText = options.verifySessionText !== false;
  const raw = plainRecord(value);
  if (raw === null || raw.schema_version !== 1 || typeof raw.status !== 'string') return null;
  if (raw.status === 'missing') {
    if (
      !exactKeys(raw, [
        'schema_version',
        'status',
        'snapshot',
        'session_json',
        'writer_launch_instance_id',
        'current_launch_instance_id',
      ])
    ) return null;
    if (
      raw.snapshot !== null ||
      raw.session_json !== null ||
      raw.writer_launch_instance_id !== null ||
      !isLaunchInstanceId(raw.current_launch_instance_id)
    ) return null;
    return {
      schema_version: 1,
      status: 'missing',
      snapshot: null,
      session_json: null,
      writer_launch_instance_id: null,
      current_launch_instance_id: raw.current_launch_instance_id,
    };
  }
  if (raw.status === 'legacy_present' || raw.status === 'present') {
    if (
      !exactKeys(
        raw,
        raw.status === 'legacy_present'
          ? [
              'schema_version',
              'status',
              'legacy',
              'session_json',
              'writer_launch_instance_id',
              'current_launch_instance_id',
            ]
          : [
              'schema_version',
              'status',
              'snapshot',
              'session_json',
              'writer_launch_instance_id',
              'current_launch_instance_id',
            ],
      )
    ) return null;
    if (
      typeof raw.session_json !== 'string' ||
      !isLaunchInstanceId(raw.writer_launch_instance_id) ||
      !isLaunchInstanceId(raw.current_launch_instance_id)
    ) return null;
    if (
      verifySessionText &&
      !loadedSessionJSONMatchesStatus(
        raw.status,
        raw.session_json,
      )
    ) return null;
    if (raw.status === 'legacy_present') {
      const authority = parseAuthority({
        schema_version: 1,
        kind: 'legacy_present',
        legacy: raw.legacy,
      });
      if (authority === null || authority.kind !== 'legacy_present') return null;
      return {
        schema_version: 1,
        status: 'legacy_present',
        legacy: authority.legacy,
        session_json: raw.session_json,
        writer_launch_instance_id: raw.writer_launch_instance_id,
        current_launch_instance_id: raw.current_launch_instance_id,
      };
    }
    const authority = parseAuthority({
      schema_version: 1,
      kind: 'present',
      snapshot: raw.snapshot,
    });
    if (authority === null || authority.kind !== 'present') return null;
    const digest = candidateSessionDigest(raw.session_json);
    if (digest === null || digest !== authority.snapshot.session_sha256) return null;
    return {
      schema_version: 1,
      status: 'present',
      snapshot: authority.snapshot,
      session_json: raw.session_json,
      writer_launch_instance_id: raw.writer_launch_instance_id,
      current_launch_instance_id: raw.current_launch_instance_id,
    };
  }
  return null;
}

function parseCASResult(value: unknown): SessionCASPersistResultV1 | null {
  const raw = plainRecord(value);
  if (raw === null || raw.schema_version !== 1 || typeof raw.status !== 'string') return null;
  const status = raw.status;
  if (status === 'committed') {
    if (!exactKeys(raw, ['schema_version', 'status', 'snapshot'])) return null;
    const snapshot = plainRecord(raw.snapshot);
    if (
      snapshot === null || snapshot.schema_version !== 1 ||
      !exactKeys(snapshot, ['schema_version', 'generation', 'session_sha256']) ||
      typeof snapshot.generation !== 'number' ||
      !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
      Object.is(snapshot.generation, -0) ||
      !validSha256(snapshot.session_sha256)
    ) return null;
    return {
      schema_version: 1,
      status: 'committed',
      snapshot: {
        schema_version: 1,
        generation: snapshot.generation as number,
        session_sha256: snapshot.session_sha256 as string,
      },
    };
  }
  if (status === 'conflict') {
    if (!exactKeys(raw, ['schema_version', 'status', 'current'])) return null;
    const current = parseAuthority(raw.current);
    return current === null ? null : { schema_version: 1, status: 'conflict', current };
  }
  if (status === 'not_committed' || status === 'session_only' || status === 'unknown') {
    if (!exactKeys(raw, ['schema_version', 'status', 'current'])) return null;
    const current = parseAuthority(raw.current);
    return current === null ? null : { schema_version: 1, status, current };
  }
  return null;
}

function parseQueryResult(value: unknown): SessionCommitQueryResultV1 | null {
  const raw = plainRecord(value);
  if (raw === null || raw.schema_version !== 1 || typeof raw.status !== 'string') return null;
  if (raw.status === 'not_started' || raw.status === 'unknown') {
    if (!exactKeys(raw, ['schema_version', 'status'])) return null;
    return { schema_version: 1, status: raw.status };
  }
  if (raw.status === 'committed') {
    if (!exactKeys(raw, ['schema_version', 'status', 'snapshot'])) return null;
    const snapshot = plainRecord(raw.snapshot);
    if (snapshot === null || !exactKeys(snapshot, ['schema_version', 'generation', 'session_sha256']) || snapshot.schema_version !== 1 || typeof snapshot.generation !== 'number' || !Number.isSafeInteger(snapshot.generation) || Object.is(snapshot.generation, -0) || snapshot.generation < 1 || !validSha256(snapshot.session_sha256)) return null;
    return {
      schema_version: 1,
      status: 'committed',
      snapshot: {
        schema_version: 1,
        generation: snapshot.generation as number,
        session_sha256: snapshot.session_sha256 as string,
      },
    };
  }
  if (raw.status === 'conflict') {
    if (!exactKeys(raw, ['schema_version', 'status', 'current'])) return null;
    const current = parseAuthority(raw.current);
    return current === null ? null : { schema_version: 1, status: 'conflict', current };
  }
  return null;
}

function newOperationId(): string | null {
  const cryptoObject = (globalThis as {
    crypto?: {
      getRandomValues?: (array: Uint8Array) => Uint8Array;
      randomUUID?: () => string;
    };
  }).crypto;
  if (typeof cryptoObject?.randomUUID === 'function') {
    try {
      const generated = cryptoObject.randomUUID();
      if (validUuid(generated)) return generated;
    } catch {
      // Fall through to the cryptographic byte generator when available.
    }
  }
  if (typeof cryptoObject?.getRandomValues !== 'function') return null;
  let bytes: Uint8Array;
  try {
    bytes = cryptoObject.getRandomValues(new Uint8Array(16));
  } catch {
    return null;
  }
  bytes[6] = (bytes[6]! % 16) + 0x40;
  bytes[8] = (bytes[8]! % 64) + 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createSessionPersistenceCoordinator(
  dependencies: SessionPersistenceDependencies,
): SessionPersistenceCoordinator {
  let tail: Promise<void> = Promise.resolve();
  let pendingWrites = 0;

  const loadAuthority = async (): Promise<SessionSnapshotAuthorityV1> => {
    try {
      const loadSnapshot =
        dependencies.loadSessionSnapshot;
      if (loadSnapshot === undefined) throw new Error('native authority unavailable');
      // Only the authority fields are consumed here; the session text itself
      // is verified by the paths that hydrate it, never by an authority read.
      const loaded = parseLoadSnapshot(await loadSnapshot(), { verifySessionText: false });
      if (loaded === null) throw new Error('invalid session snapshot');
      if (loaded.status === 'missing') return { schema_version: 1, kind: 'missing' };
      if (loaded.status === 'legacy_present') {
        return { schema_version: 1, kind: 'legacy_present', legacy: loaded.legacy };
      }
      return { schema_version: 1, kind: 'present', snapshot: loaded.snapshot };
    } catch {
      // Never turn malformed native state into a missing authority: callers
      // must receive an indeterminate durability result and avoid overwrite.
      throw new Error('session authority unavailable');
    }
  };

  const loadSessionSnapshotResult = async (): Promise<LoadSessionSnapshotResultV1 | null> => {
    const loadSnapshot =
      dependencies.loadSessionSnapshot;
    if (loadSnapshot === undefined) return null;
    try {
      return parseLoadSnapshot(await loadSnapshot());
    } catch {
      return null;
    }
  };

  const casPersist = async (
    request: SessionCASPersistRequestV1,
  ): Promise<SessionCASPersistResultV1 | null> => {
    const requestRecord = plainRecord(request);
    const expected =
      requestRecord === null ? null : parseAuthority(requestRecord.expected);
    const candidateJson =
      requestRecord === null ? undefined : requestRecord.candidate_json;
    const checksStarted = Date.now();
    if (
      dependencies.casPersistSession === undefined ||
      requestRecord === null ||
      !exactKeys(requestRecord, [
        'schema_version',
        'operation_id',
        'expected',
        'candidate_json',
      ]) ||
      requestRecord.schema_version !== 1 ||
      expected === null ||
      typeof candidateJson !== 'string' ||
      !candidateAcceptable(candidateJson) ||
      typeof requestRecord.operation_id !== 'string' ||
      !validUuid(requestRecord.operation_id)
    ) return null;
    try {
      markTimingSync('js.cas_request_checks', Date.now() - checksStarted);
    } catch {}
    try {
      const parsed = parseCASResult(
        await dependencies.casPersistSession({
          schema_version: 1,
          operation_id: requestRecord.operation_id,
          expected,
          candidate_json: candidateJson,
        }),
      );
      if (parsed === null) return null;
      if (parsed.status === 'committed') {
        const digest = candidateSessionDigest(candidateJson);
        const generation = expectedNextGeneration(expected);
        if (
          digest === null ||
          generation === null ||
          !committedRefMatches(parsed, digest, generation)
        ) return null;
      }
      if (parsed.status === 'session_only') {
        const digest = candidateSessionDigest(candidateJson);
        const generation = expectedNextGeneration(expected);
        if (
          digest === null ||
          generation === null ||
          !sessionOnlyRefMatches(parsed, digest, generation)
        ) return null;
      }
      return parsed;
    } catch {
      return null;
    }
  };

  const queryCommit = async (
    operationInput:
      | string
      | { readonly schema_version: 1; readonly operation_id: string },
  ): Promise<SessionCommitQueryResultV1 | null> => {
    let operationId: unknown;
    if (typeof operationInput === 'string') {
      operationId = operationInput;
    } else {
      const raw = plainRecord(operationInput);
      if (
        raw === null ||
        !exactKeys(raw, ['schema_version', 'operation_id']) ||
        raw.schema_version !== 1
      ) return null;
      operationId = raw.operation_id;
    }
    if (
      dependencies.querySessionCommit === undefined ||
      !validUuid(operationId)
    ) return null;
    try {
      return parseQueryResult(
        await dependencies.querySessionCommit({
          schema_version: 1,
          operation_id: operationId,
        }),
      );
    } catch {
      return null;
    }
  };

  const performCAS = async (
    candidate: string,
    options: {
      readonly operation_id?: string;
      readonly operationId?: string;
      readonly expected?: SessionSnapshotAuthorityV1;
    } | undefined,
  ): Promise<SessionDurabilityResult> => {
    if (!candidateAcceptable(candidate)) return RESULTS.unknown;
    const candidateDigest = candidateSessionDigest(candidate);
    if (candidateDigest === null) return RESULTS.unknown;
    if (
      options?.operation_id !== undefined &&
      options.operationId !== undefined &&
      options.operation_id !== options.operationId
    ) return RESULTS.unknown;
    const operationId =
      options?.operation_id ?? options?.operationId ?? newOperationId();
    if (operationId === null || !validUuid(operationId)) return RESULTS.unknown;
    let expected: SessionSnapshotAuthorityV1;
    try {
      // The native load is the sole authority.  A caller-supplied expected
      // value is only a stale-read guard and can never replace that load.
      expected = await loadAuthority();
    } catch {
      return RESULTS.unknown;
    }
    if (
      options?.expected !== undefined &&
      (parseAuthority(options.expected) === null ||
        !sameAuthority(options.expected, expected))
    ) return RESULTS.not_committed;
    const expectedGeneration = expectedNextGeneration(expected);
    if (expectedGeneration === null) return RESULTS.unknown;
    const request: SessionCASPersistRequestV1 = {
      schema_version: 1,
      operation_id: operationId,
      expected,
      candidate_json: candidate,
    };
    const response = await casPersist(request);
    if (response !== null) {
      if (
        response.status === 'committed' &&
        committedRefMatches(response, candidateDigest, expectedGeneration)
      ) return RESULTS.committed;
      if (response.status === 'committed') return RESULTS.unknown;
      if (response.status === 'conflict') return RESULTS.not_committed;
      if (response.status === 'not_committed') {
        return RESULTS.not_committed;
      }
      if (response.status === 'session_only') {
        return sessionOnlyRefMatches(response, candidateDigest, expectedGeneration)
          ? RESULTS.session_only
          : RESULTS.unknown;
      }
    }
    const query = await queryCommit(operationId);
    if (
      query?.status === 'committed' &&
      committedRefMatches(query, candidateDigest, expectedGeneration)
    ) return RESULTS.committed;
    if (query?.status === 'committed') return RESULTS.unknown;
    if (query?.status === 'conflict') return RESULTS.not_committed;
    if (query?.status === 'not_started') return RESULTS.not_committed;
    return RESULTS.unknown;
  };

  return {
    write: (candidate, options) => {
      if (pendingWrites >= MAX_PENDING_WRITES || !preflightJSON(candidate)) {
        return Promise.resolve(RESULTS.unknown);
      }
      pendingWrites += 1;
      const performWrite =
        dependencies.casPersistSession === undefined
          ? () => Promise.resolve(RESULTS.unknown)
          : () => performCAS(candidate, options);
      const operation = tail.then(
        performWrite,
        performWrite,
      );
      const tracked = operation.then(
        result => {
          pendingWrites -= 1;
          return result;
        },
        () => {
          pendingWrites -= 1;
          return RESULTS.unknown;
        },
      );
      tail = tracked.then(() => undefined);
      return tracked;
    },
    loadAuthority,
    read: loadAuthority,
    loadSessionSnapshot: loadAuthority,
    loadSessionSnapshotResult,
    casPersist,
    writeCAS: casPersist,
    queryCommit,
    persistCAS: casPersist,
    casPersistSession: casPersist,
    persistSessionCAS: casPersist,
    querySessionCommit: queryCommit,
  };
}
