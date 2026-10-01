import { canonicalJson, sha256Hex, sha256HexOfText } from '../src/sha256';

// The published vectors for SHA-256 (FIPS 180-4 / RFC 6234 examples).
describe('sha256', () => {
  test('the empty string', () => {
    expect(sha256HexOfText('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  test('abc', () => {
    expect(sha256HexOfText('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  test('the 448-bit message from the specification', () => {
    expect(
      sha256HexOfText(
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      ),
    ).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  test('a message that crosses several blocks', () => {
    expect(sha256HexOfText('a'.repeat(1000))).toBe(
      '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
    );
  });

  test('text is hashed as its UTF-8 bytes, not its code units', () => {
    // 'é' is U+00E9, two bytes in UTF-8; its code unit is one value.
    expect(sha256HexOfText('é')).toBe(sha256Hex([0xc3, 0xa9]));
    expect(sha256HexOfText('🙂')).toBe(
      sha256Hex([0xf0, 0x9f, 0x99, 0x82]),
    );
    expect(sha256HexOfText('🙂')).not.toBe(sha256HexOfText('?'));
  });
});

describe('canonical json', () => {
  test('object keys are sorted and whitespace is absent', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      '{"a":[2,{"c":3,"d":4}],"b":1}',
    );
  });

  test('the same value written in another order digests the same', () => {
    const first = canonicalJson({ a: 1, b: 'two' })!;
    const second = canonicalJson({ b: 'two', a: 1 })!;
    expect(sha256HexOfText(first)).toBe(sha256HexOfText(second));
  });

  test('what cannot be written canonically is refused rather than guessed', () => {
    expect(canonicalJson({ a: undefined })).toBeNull();
    expect(canonicalJson({ a: Number.NaN })).toBeNull();
    expect(canonicalJson({ a: -0 })).toBeNull();
    expect(canonicalJson({ a: () => undefined })).toBeNull();
    expect(canonicalJson(new Date(0))).toBeNull();
  });
});
