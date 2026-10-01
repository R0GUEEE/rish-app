/**
 * A dependency-free SHA-256, and the canonical JSON a marketplace digest is
 * taken over.
 *
 * `SessionPersistence` carries its own copy for the native session-snapshot
 * contract, which is deliberately frozen and local to that module. This one is
 * the market place's, and it is checked against the published vectors for the
 * algorithm rather than against the other copy: a standard digest is the same
 * everywhere, and a shared helper would tie two unrelated contracts together.
 */
/* eslint-disable no-bitwise -- SHA-256 is defined by 32-bit operations. */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** The digest of a byte sequence, as lowercase hexadecimal. */
export function sha256Hex(bytes: readonly number[]): string {
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  const length = bytes.length * 8;
  for (let shift = 56; shift >= 0; shift -= 8) {
    padded.push(Math.floor(length / 2 ** shift) & 0xff);
  }

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  // The sigma functions rotate; a plain shift would compute a different, and
  // silently wrong, digest for every message.
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
      const before = words[index - 15]!;
      const after = words[index - 2]!;
      const s0 = rotr(before, 7) ^ rotr(before, 18) ^ (before >>> 3);
      const s1 = rotr(after, 17) ^ rotr(after, 19) ^ (after >>> 10);
      words[index] =
        (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let index = 0; index < 64; index += 1) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + S1 + ch + K[index]! + words[index]!) >>> 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    hash[0] = (hash[0]! + a!) >>> 0;
    hash[1] = (hash[1]! + b!) >>> 0;
    hash[2] = (hash[2]! + c!) >>> 0;
    hash[3] = (hash[3]! + d!) >>> 0;
    hash[4] = (hash[4]! + e!) >>> 0;
    hash[5] = (hash[5]! + f!) >>> 0;
    hash[6] = (hash[6]! + g!) >>> 0;
    hash[7] = (hash[7]! + h!) >>> 0;
  }

  return [...hash].map(word => word.toString(16).padStart(8, '0')).join('');
}

/**
 * The UTF-8 bytes of a string.
 *
 * Written out rather than taken from `TextEncoder`, which React Native does
 * not promise: a digest that depends on a runtime global is a digest that
 * would come out differently on a runtime that lacks it.
 */
export function utf8Bytes(text: string): readonly number[] {
  const bytes: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes.push(unit);
    } else if (unit <= 0x7ff) {
      bytes.push(0xc0 | (unit >>> 6), 0x80 | (unit & 0x3f));
    } else if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        const point =
          0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00);
        bytes.push(
          0xf0 | (point >>> 18),
          0x80 | ((point >>> 12) & 0x3f),
          0x80 | ((point >>> 6) & 0x3f),
          0x80 | (point & 0x3f),
        );
        index += 1;
      } else {
        bytes.push(0xef, 0xbf, 0xbd);
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      bytes.push(0xef, 0xbf, 0xbd);
    } else {
      bytes.push(
        0xe0 | (unit >>> 12),
        0x80 | ((unit >>> 6) & 0x3f),
        0x80 | (unit & 0x3f),
      );
    }
  }
  return bytes;
}

/** The digest of a string's UTF-8 bytes, as lowercase hexadecimal. */
export function sha256HexOfText(text: string): string {
  return sha256Hex(utf8Bytes(text));
}

/**
 * A canonical form of a JSON value: object keys sorted, no whitespace, and
 * nothing that JSON itself would write differently on another device.
 *
 * Returns null for anything canonical JSON cannot represent -- a function, an
 * undefined member, a non-finite number -- so a digest is never taken over
 * something that would be written two ways.
 */
export function canonicalJson(value: unknown): string | null {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0)
      ? JSON.stringify(value)
      : null;
  }
  if (Array.isArray(value)) {
    const items = value.map(canonicalJson);
    return items.every(item => item !== null) ? `[${items.join(',')}]` : null;
  }
  if (typeof value !== 'object') return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Record<string, unknown>;
  const pairs: string[] = [];
  for (const name of Object.keys(record).sort()) {
    const child = canonicalJson(record[name]);
    if (child === null) return null;
    pairs.push(`${JSON.stringify(name)}:${child}`);
  }
  return `{${pairs.join(',')}}`;
}

/* eslint-enable no-bitwise */
