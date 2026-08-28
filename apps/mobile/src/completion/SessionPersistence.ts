export type SessionDurabilityStatus =
  | 'committed'
  | 'session_only'
  | 'not_committed'
  | 'unknown';

export type SessionDurabilityResult = {
  readonly status: SessionDurabilityStatus;
};

export type SessionPersistenceDependencies = {
  readonly persistSession: (json: string) => Promise<unknown>;
  readonly loadSession: () => Promise<unknown>;
};

export type SessionPersistenceCoordinator = {
  write(candidate: unknown): Promise<SessionDurabilityResult>;
};

const MAX_SESSION_BYTES = 16 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 250_000;
const MAX_PENDING_WRITES = 16;

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

function boundedUtf8(value: string): boolean {
  if (value.length === 0 || value.length > MAX_SESSION_BYTES) return false;
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

function parseBoundedJSON(value: unknown): ParsedJSON {
  if (!preflightJSON(value)) return { ok: false };
  return parsePreflightedJSON(value);
}

function parsePreflightedJSON(value: string): ParsedJSON {
  try {
    const parsed = JSON.parse(value) as unknown;
    return validateJSONTree(parsed)
      ? { ok: true, value: parsed }
      : { ok: false };
  } catch {
    return { ok: false };
  }
}

function equivalentJSON(left: unknown, right: unknown): boolean | null {
  const stack: Array<{
    readonly left: unknown;
    readonly right: unknown;
    readonly depth: number;
  }> = [{ left, right, depth: 0 }];
  let nodes = 0;
  while (stack.length > 0) {
    const pair = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_JSON_NODES || pair.depth > MAX_JSON_DEPTH) return null;
    if (Object.is(pair.left, pair.right)) continue;
    if (
      typeof pair.left !== 'object' ||
      pair.left === null ||
      typeof pair.right !== 'object' ||
      pair.right === null
    ) {
      return false;
    }
    const leftArray = Array.isArray(pair.left);
    if (leftArray !== Array.isArray(pair.right)) return false;
    if (leftArray) {
      const leftValues = pair.left as unknown[];
      const rightValues = pair.right as unknown[];
      if (leftValues.length !== rightValues.length) return false;
      if (nodes + stack.length + leftValues.length > MAX_JSON_NODES) return null;
      for (let index = 0; index < leftValues.length; index += 1) {
        stack.push({
          left: leftValues[index],
          right: rightValues[index],
          depth: pair.depth + 1,
        });
      }
      continue;
    }
    const leftRecord = ownDataValues(pair.left);
    const rightRecord = ownDataValues(pair.right);
    if (leftRecord === null || rightRecord === null) return null;
    if (leftRecord.names.length !== rightRecord.names.length) return false;
    const rightIndexes = new Map<string, number>();
    rightRecord.names.forEach((name, index) => rightIndexes.set(name, index));
    if (nodes + stack.length + leftRecord.names.length > MAX_JSON_NODES) {
      return null;
    }
    for (let index = 0; index < leftRecord.names.length; index += 1) {
      const rightIndex = rightIndexes.get(leftRecord.names[index]!);
      if (rightIndex === undefined) return false;
      stack.push({
        left: leftRecord.values[index],
        right: rightRecord.values[rightIndex],
        depth: pair.depth + 1,
      });
    }
  }
  return true;
}

export function createSessionPersistenceCoordinator(
  dependencies: SessionPersistenceDependencies,
): SessionPersistenceCoordinator {
  let tail: Promise<void> = Promise.resolve();
  let pendingWrites = 0;

  const perform = async (
    candidate: string,
  ): Promise<SessionDurabilityResult> => {
    const parsedCandidate = parsePreflightedJSON(candidate);
    if (!parsedCandidate.ok) {
      return RESULTS.unknown;
    }
    try {
      if ((await dependencies.persistSession(candidate)) === true) {
        return RESULTS.committed;
      }
    } catch {
      // A proof write can fail after the session was atomically committed.
    }
    let stored: unknown;
    try {
      stored = await dependencies.loadSession();
    } catch {
      return RESULTS.unknown;
    }
    if (stored === null) return RESULTS.not_committed;
    const parsedStored = parseBoundedJSON(stored);
    if (!parsedStored.ok) return RESULTS.unknown;
    const equivalent = equivalentJSON(parsedCandidate.value, parsedStored.value);
    return equivalent === true
      ? RESULTS.session_only
      : equivalent === false
        ? RESULTS.not_committed
        : RESULTS.unknown;
  };

  return {
    write: candidate => {
      if (pendingWrites >= MAX_PENDING_WRITES || !preflightJSON(candidate)) {
        return Promise.resolve(RESULTS.unknown);
      }
      pendingWrites += 1;
      const operation = tail.then(
        () => perform(candidate),
        () => perform(candidate),
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
  };
}
