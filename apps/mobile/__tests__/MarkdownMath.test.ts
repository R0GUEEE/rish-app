import { parseMath, type MathNode } from '../src/markdown/math';
import { mathToInlineUnicode } from '../src/markdown/mathInline';
import { layoutMath } from '../src/markdown/mathLayout';

const BS = String.fromCharCode(92);

function ok(source: string): MathNode {
  const result = parseMath(source);
  if (!result.ok) throw new Error('expected parse ok: ' + JSON.stringify(result));
  return result.ast;
}

describe('parseMath supported subset', () => {
  test('parses fractions', () => {
    const ast = ok(BS + 'frac{1}{2}');
    expect(ast.k).toBe('row');
    expect(mathToInlineUnicode(ast)).toBe('¹⁄₂');
  });

  test('parses square roots with and without an index', () => {
    expect(mathToInlineUnicode(ok(BS + 'sqrt{x+1}'))).toBe('√(x+1)');
    expect(mathToInlineUnicode(ok(BS + 'sqrt[3]{x}'))).toBeNull();
  });

  test('parses subscripts and superscripts', () => {
    const ast = ok('x_1^2');
    expect(ast).toEqual({
      k: 'row',
      items: [
        {
          k: 'scripts',
          base: { k: 'text', text: 'x', style: 'italic' },
          sub: { k: 'text', text: '1', style: 'italic' },
          sup: { k: 'text', text: '2', style: 'italic' },
        },
      ],
    });
    expect(mathToInlineUnicode(ast)).toBe('x₁²');
  });

  test('renders sum limits above the operator glyph', () => {
    const ast = ok(BS + 'sum_{i=1}^{n} i');
    const items = ast.k === 'row' ? ast.items : [];
    expect(items[0].k).toBe('limits');
    if (items[0].k !== 'limits') throw new Error('expected limits');
    expect(items[0].side).toBe('above');
    expect(mathToInlineUnicode(ast)).toBe('∑ᵢ₌₁ⁿ i');
  });

  test('renders integral limits to the right', () => {
    const ast = ok(BS + 'int_0^1 x dx');
    const items = ast.k === 'row' ? ast.items : [];
    expect(items[0].k).toBe('limits');
    if (items[0].k !== 'limits') throw new Error('expected limits');
    expect(items[0].side).toBe('right');
    expect(mathToInlineUnicode(ast)).toBe('∫₀¹ x dx');
  });

  test('renders lim with limits above', () => {
    const ast = ok(BS + 'lim_{x ' + BS + 'to 0} f(x)');
    const items = ast.k === 'row' ? ast.items : [];
    expect(items[0].k).toBe('limits');
    if (items[0].k !== 'limits') throw new Error('expected limits');
    expect(items[0].side).toBe('above');
    // The arrow has no Unicode subscript form, so the inline projection
    // fails closed (the UI then shows the verbatim source).
    expect(mathToInlineUnicode(ast)).toBeNull();
  });

  test('maps common Greek letters and operators', () => {
    expect(mathToInlineUnicode(ok(BS + 'alpha + ' + BS + 'beta'))).toBe('α + β');
    expect(mathToInlineUnicode(ok('a ' + BS + 'times b ' + BS + 'leq c'))).toBe(
      'a × b ≤ c',
    );
  });

  test('parses sized delimiters', () => {
    const ast = ok(BS + 'left( ' + BS + 'frac{1}{2} ' + BS + 'right)');
    const items = ast.k === 'row' ? ast.items : [];
    expect(items[0].k).toBe('delimited');
    if (items[0].k !== 'delimited') throw new Error('expected delimited');
    expect(items[0].left).toBe('(');
    expect(items[0].right).toBe(')');
    expect(mathToInlineUnicode(ast)).toBe('( ¹⁄₂ )');
    const bars = ok(BS + 'left| x ' + BS + 'right|');
    const barItems = bars.k === 'row' ? bars.items : [];
    if (barItems[0].k !== 'delimited') throw new Error('expected delimited');
    expect(barItems[0].left).toBe('|');
  });

  test('parses text commands as upright text', () => {
    const ast = ok(BS + 'text{if } x > 0');
    expect(mathToInlineUnicode(ast)).toBe('if  x > 0');
  });

  test('accepts escaped special characters', () => {
    expect(mathToInlineUnicode(ok('a ' + BS + '$ ' + BS + '% b'))).toBe(
      'a $ % b',
    );
  });
});

describe('parseMath fails closed', () => {
  test.each([
    ['unclosed group', '{x', 'syntax'],
    ['stray closing brace', '}', 'syntax'],
    ['empty source', '', 'syntax'],
    ['unknown command', BS + 'unknowncmd', 'unsupported'],
    ['matrix environment', BS + 'begin{matrix}', 'unsupported'],
    ['unknown escape', 'a ' + BS + 'q b', 'unsupported'],
  ])('%s', (_label, source, reason) => {
    const result = parseMath(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe(reason);
  });

  test('rejects source over the character limit', () => {
    expect(parseMath('a'.repeat(9000))).toEqual({
      ok: false,
      reason: 'too-long',
    });
  });

  test('rejects a 1 MB math block immediately', () => {
    const started = Date.now();
    const result = parseMath('a'.repeat(1024 * 1024));
    expect(result).toEqual({ ok: false, reason: 'too-long' });
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test('rejects deeply nested fractions', () => {
    const source = BS + 'frac{'.repeat(50) + '1' + '}{2}'.repeat(50);
    const result = parseMath(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('too-deep');
  });

  test('rejects deeply nested superscripts', () => {
    const source = 'x^{'.repeat(40) + '1' + '}'.repeat(40);
    const result = parseMath(source);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
  });

  test('rejects too many tokens', () => {
    const result = parseMath('a+b'.repeat(1500));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('too-many-tokens');
  });

  test('rejects too many nodes', () => {
    const result = parseMath('a'.repeat(3000));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('too-many-nodes');
  });
});

describe('mathToInlineUnicode', () => {
  test('returns null for nested fractions without a Unicode form', () => {
    const ast = ok(BS + 'frac{a}{' + BS + 'frac{b}{c}}');
    expect(mathToInlineUnicode(ast)).toBeNull();
  });

  test('returns null for constructs with an unsupported projection', () => {
    const ast = ok('a ' + BS + 'hbar b');
    expect(mathToInlineUnicode(ast)).toBe('a ℏ b');
  });
});

describe('layoutMath', () => {
  test('lays out a fraction with a rule and glyphs', () => {
    const layout = layoutMath(ok(BS + 'frac{a}{b}'), 18);
    expect(layout).not.toBeNull();
    if (layout === null) throw new Error('expected layout');
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
    const glyphs = layout.items.filter(item => item.k === 'glyph');
    const rules = layout.items.filter(item => item.k === 'rule');
    expect(glyphs.map(item => (item.k === 'glyph' ? item.text : ''))).toEqual(
      expect.arrayContaining(['a', 'b']),
    );
    expect(rules.length).toBe(1);
  });

  test('lays out a sum with limits', () => {
    const layout = layoutMath(ok(BS + 'sum_{i=1}^{n} x_i'), 18);
    expect(layout).not.toBeNull();
    if (layout === null) throw new Error('expected layout');
    const texts = layout.items
      .filter(item => item.k === 'glyph')
      .map(item => (item.k === 'glyph' ? item.text : ''));
    expect(texts).toContain('∑');
    expect(texts).toContain('i');
  });

  test('keeps every item inside non-negative coordinates', () => {
    const layout = layoutMath(ok(BS + 'left( ' + BS + 'frac{1}{x+1} ' + BS + 'right)^2'), 18);
    expect(layout).not.toBeNull();
    if (layout === null) throw new Error('expected layout');
    for (const item of layout.items) {
      expect(item.x).toBeGreaterThanOrEqual(0);
      expect(item.y).toBeGreaterThanOrEqual(0);
    }
  });
});
