/* eslint-disable no-script-url -- javascript: scheme security cases */
import { flattenInlineTokens, tokenizeInline } from '../src/markdown/inline';
import {
  blockedReasonLabel,
  classifyImageTarget,
} from '../src/markdown/images';

const BS = String.fromCharCode(92);

describe('tokenizeInline', () => {
  test('tokenizes text, strong, and inline code', () => {
    const tokens = tokenizeInline('plain **bold** and `code`');
    expect(tokens).toEqual([
      { type: 'text', value: 'plain ' },
      {
        type: 'strong',
        children: [{ type: 'text', value: 'bold' }],
      },
      { type: 'text', value: ' and ' },
      { type: 'code', value: 'code' },
    ]);
  });

  test('keeps CJK strong emphasis intact', () => {
    const tokens = tokenizeInline('**强调**中文**加粗**');
    expect(tokens).toEqual([
      { type: 'strong', children: [{ type: 'text', value: '强调' }] },
      { type: 'text', value: '中文' },
      { type: 'strong', children: [{ type: 'text', value: '加粗' }] },
    ]);
  });

  test('keeps unpaired or space-adjacent asterisks verbatim', () => {
    expect(tokenizeInline('a ** b ** c')).toEqual([
      { type: 'text', value: 'a ** b ** c' },
    ]);
    expect(tokenizeInline('a **b c')).toEqual([
      { type: 'text', value: 'a **b c' },
    ]);
  });

  test('tokenizes inline math in dollar and paren forms', () => {
    const dollars = tokenizeInline('a $x^2$ b');
    expect(dollars).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'math', source: 'x^2' },
      { type: 'text', value: ' b' },
    ]);
    const parens = tokenizeInline('a ' + BS + '(y_1' + BS + ') b');
    expect(parens).toEqual([
      { type: 'text', value: 'a ' },
      { type: 'math', source: 'y_1' },
      { type: 'text', value: ' b' },
    ]);
  });

  test('keeps an unclosed dollar sign verbatim', () => {
    expect(tokenizeInline('cost $5 and')).toEqual([
      { type: 'text', value: 'cost $5 and' },
    ]);
    expect(tokenizeInline('$ x $')).toEqual([
      { type: 'text', value: '$ x $' },
    ]);
  });

  test('tokenizes images with alt text and target', () => {
    const tokens = tokenizeInline('before ![cat](https://example.com/c.png) after');
    expect(tokens).toEqual([
      { type: 'text', value: 'before ' },
      { type: 'image', alt: 'cat', target: 'https://example.com/c.png' },
      { type: 'text', value: ' after' },
    ]);
  });

  test('captures hostile image targets for the classifier', () => {
    const tokens = tokenizeInline('![x](javascript:evil)');
    expect(tokens).toEqual([
      { type: 'image', alt: 'x', target: 'javascript:evil' },
    ]);
    // URLs containing parens never tokenize as images: they stay literal.
    const withParens = tokenizeInline('![x](javascript:alert(1))');
    expect(withParens).toEqual([
      { type: 'text', value: '![x](javascript:alert(1))' },
    ]);
  });

  test('tokenizes http links only', () => {
    expect(tokenizeInline('[docs](https://example.com/x)')).toEqual([
      { type: 'link', label: 'docs', target: 'https://example.com/x' },
    ]);
    expect(tokenizeInline('[ftp](ftp://example.com/x)')).toEqual([
      { type: 'text', value: '[ftp](ftp://example.com/x)' },
    ]);
  });

  test('bounded scans: a huge line stays a single text token', () => {
    const long = 'x'.repeat(9000);
    expect(tokenizeInline(long)).toEqual([{ type: 'text', value: long }]);
  });

  test('strong children never parse images', () => {
    const tokens = tokenizeInline('**a ![b](https://e.com/b.png)**');
    expect(tokens).toEqual([
      {
        type: 'strong',
        children: [{ type: 'text', value: 'a ![b](https://e.com/b.png)' }],
      },
    ]);
  });
});

describe('flattenInlineTokens', () => {
  test('projects tokens to plain text for accessibility', () => {
    const tokens = tokenizeInline('**a** `b` $c$ ![d](https://e.com/d.png)');
    expect(flattenInlineTokens(tokens)).toBe('a b c d');
  });

  test('uses the alt text for images', () => {
    expect(flattenInlineTokens(tokenizeInline('![cat](https://e.com/c.png)'))).toBe(
      'cat',
    );
  });
});

describe('classifyImageTarget', () => {
  type Expected =
    | { kind: 'remote'; host: string }
    | { kind: 'data' }
    | { kind: 'attachment'; id: string };
  test.each<[string, Expected]>([
    ['https://example.com/c.png', { kind: 'remote', host: 'example.com' }],
    ['http://127.0.0.1:8080/a.png', { kind: 'remote', host: '127.0.0.1' }],
    ['data:image/png;base64,AAAA', { kind: 'data' }],
    ['data:image/jpeg;base64,AAAA', { kind: 'data' }],
    ['attachment://abc-123_9', { kind: 'attachment', id: 'abc-123_9' }],
  ])('accepts %s', (target, expected) => {
    const result = classifyImageTarget(target);
    expect(result.kind).toBe(expected.kind);
    if (expected.kind === 'remote' && result.kind === 'remote') {
      expect(result.host).toBe(expected.host);
    }
    if (expected.kind === 'attachment' && result.kind === 'attachment') {
      expect(result.id).toBe(expected.id);
    }
  });

  test.each([
    ['javascript:alert(1)', 'scheme'],
    ['ftp://example.com/x.png', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['https://user:pass@example.com/x.png', 'malformed'],
    ['https://[::1]:8080/x.png', 'malformed'],
    ['https://example.com./x.png', 'malformed'],
    ['plain.png', 'malformed'],
    ['http://', 'malformed'],
    ['data:text/html;base64,AAAA', 'data-unsupported'],
    ['data:image/svg+xml;base64,AAAA', 'data-unsupported'],
    ['attachment://bad$id', 'malformed'],
  ])('blocks %s with reason %s', (target, reason) => {
    const result = classifyImageTarget(target);
    expect(result).toEqual({ kind: 'blocked', reason });
  });

  test('bounded sizes fail closed', () => {
    const huge = 'data:image/png;base64,' + 'A'.repeat(300 * 1024);
    expect(classifyImageTarget(huge)).toEqual({
      kind: 'blocked',
      reason: 'data-too-large',
    });
    expect(classifyImageTarget('https://e.com/' + 'x'.repeat(3000))).toEqual({
      kind: 'blocked',
      reason: 'too-long',
    });
  });

  test('labels every blocked reason', () => {
    expect(blockedReasonLabel('scheme')).toBe('scheme not allowed');
    expect(blockedReasonLabel('malformed')).toBe('malformed URL');
    expect(blockedReasonLabel('too-long')).toBe('URL too long');
    expect(blockedReasonLabel('data-unsupported')).toBe('unsupported data URI');
    expect(blockedReasonLabel('data-too-large')).toBe('data URI too large');
  });
});
