import type { MathNode } from './math';
import { MATH_LIMITS } from './limits';

/**
 * Renders a parsed expression as a plain Unicode string for inline use
 * (superscripts/subscripts via Unicode characters, fractions as ⁿ⁄ₘ).
 * Returns null when any part cannot be mapped, in which case the caller
 * shows the verbatim source instead.
 */

const SUPER: Record<string, string> = {
  '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶',
  '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽',
  ')': '⁾', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ',
  h: 'ʰ', i: 'ⁱ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', n: 'ⁿ', o: 'ᵒ',
  p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ',
  y: 'ʸ', z: 'ᶻ', α: 'ᵅ', β: 'ᵝ', γ: 'ᵞ', δ: 'ᵟ', ε: 'ᵋ', θ: 'ᶿ',
  φ: 'ᵠ', χ: 'ᵡ', ι: 'ᶥ', '\u2032': 'ᐟ',
};

const SUB: Record<string, string> = {
  '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆',
  '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍',
  ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ',
  m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ',
  v: 'ᵥ', x: 'ₓ',
};

function toSuper(text: string): string | null {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') continue;
    const mapped = SUPER[ch];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

function toSub(text: string): string | null {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') continue;
    const mapped = SUB[ch];
    if (mapped === undefined) return null;
    out += mapped;
  }
  return out;
}

function flatten(node: MathNode): string | null {
  switch (node.k) {
    case 'text':
      return node.text;
    case 'space':
      return ' ';
    case 'row': {
      let out = '';
      for (const item of node.items) {
        const part = flatten(item);
        if (part === null) return null;
        out += part;
      }
      return out;
    }
    case 'frac': {
      const num = flatten(node.num);
      const den = flatten(node.den);
      if (num === null || den === null) return null;
      const up = toSuper(num);
      const down = toSub(den);
      if (up === null || down === null) return null;
      return up + '⁄' + down;
    }
    case 'sqrt': {
      if (node.index !== null) return null;
      const rad = flatten(node.radicand);
      if (rad === null) return null;
      return '√(' + rad + ')';
    }
    case 'scripts': {
      const base = flatten(node.base);
      if (base === null) return null;
      let out = base;
      if (node.sub !== null) {
        const part = flatten(node.sub);
        if (part === null) return null;
        const mapped = toSub(part);
        if (mapped === null) return null;
        out += mapped;
      }
      if (node.sup !== null) {
        const part = flatten(node.sup);
        if (part === null) return null;
        const mapped = toSuper(part);
        if (mapped === null) return null;
        out += mapped;
      }
      return out;
    }
    case 'limits': {
      const op = flatten(node.op);
      if (op === null) return null;
      let out = op;
      if (node.sub !== null) {
        const part = flatten(node.sub);
        if (part === null) return null;
        const mapped = toSub(part);
        if (mapped === null) return null;
        out += mapped;
      }
      if (node.sup !== null) {
        const part = flatten(node.sup);
        if (part === null) return null;
        const mapped = toSuper(part);
        if (mapped === null) return null;
        out += mapped;
      }
      return out;
    }
    case 'delimited': {
      const inner = flatten(node.inner);
      if (inner === null) return null;
      return node.left + inner + node.right;
    }
  }
}

/**
 * Converts a parsed expression to inline Unicode text. Returns null when the
 * expression uses constructs without a Unicode inline form (caller falls back
 * to verbatim source).
 */
export function mathToInlineUnicode(node: MathNode): string | null {
  const text = flatten(node);
  if (text === null || text.length === 0) return null;
  if (text.length > MATH_LIMITS.maxInlineUnicodeChars) return null;
  return text;
}
