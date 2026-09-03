import type { MathNode } from './math';
import { MATH_LIMITS } from './limits';

/**
 * Deterministic layout engine for the parsed LaTeX subset. Produces absolute
 * pixel coordinates for glyphs and rules so the renderer only needs plain
 * Views. Widths are heuristic fractions of the current font size; everything
 * is bounded by the parser limits and a hard layout-item cap.
 */

export type MathItem =
  | { k: 'glyph'; text: string; x: number; y: number; size: number; italic: boolean }
  | { k: 'rule'; x: number; y: number; w: number; h: number };

export type MathLayout = {
  items: MathItem[];
  width: number;
  height: number;
  baseline: number;
};

type Box = { width: number; height: number; depth: number };

const NARROW = new Set("ijlIJ.,;:!|()[]{}'\"′".split(''));
const DESCENDERS = new Set('gjpqy()[]{},;∫'.split(''));
const TALL = new Set('∑∏∐∫∬∭∮√'.split(''));

function charWidth(ch: string): number {
  if (ch === ' ') return 0.3;
  if (NARROW.has(ch)) return 0.3;
  if (/[0-9]/u.test(ch)) return 0.56;
  if (ch === 'm') return 0.82;
  if (ch === 'w') return 0.78;
  if ('ftr'.includes(ch)) return 0.36;
  if (/[a-z]/u.test(ch)) return 0.52;
  if (ch === 'M') return 0.9;
  if (ch === 'W') return 1.0;
  if (/[A-Z]/u.test(ch)) return 0.72;
  if ('∑∏∐∫∬∭∮'.includes(ch)) return 1.1;
  if (ch === '∞') return 0.82;
  if (ch === '√') return 0.8;
  if ('∂∇'.includes(ch)) return 0.62;
  if ('−+=<>'.includes(ch)) return 0.58;
  if ('×÷±∓'.includes(ch)) return 0.62;
  if (ch === '⋅') return 0.32;
  if ('…⋯⋱'.includes(ch)) return 0.7;
  if (ch === '⋮') return 0.5;
  if (ch === '°') return 0.42;
  if ('⟨⟩⌊⌋⌈⌉'.includes(ch)) return 0.56;
  if (ch === '∣') return 0.3;
  if ('∥‖'.includes(ch)) return 0.5;
  if ('αβγδεϵζηθϑικλμνξπϖρϱσςτυϕφχψω'.includes(ch)) return 0.56;
  if ('ΓΔΘΛΞΠΣΥΦΨΩ'.includes(ch)) return 0.7;
  return 0.6;
}

function glyphWidth(text: string, size: number): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch);
  if (text.length > 1) width += 0.02 * (text.length - 1);
  return width * size;
}

function textBox(text: string, size: number): Box {
  let height = 0.72;
  let depth = 0.22;
  for (const ch of text) {
    if (TALL.has(ch)) height = 0.82;
    if (DESCENDERS.has(ch)) depth = 0.26;
  }
  return { width: glyphWidth(text, size), height: height * size, depth: depth * size };
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

class Engine {
  private items: MathItem[] = [];

  measure(node: MathNode, size: number): Box {
    switch (node.k) {
      case 'text':
        return textBox(node.text, size);
      case 'space':
        return { width: node.width * size, height: 0, depth: 0 };
      case 'row': {
        let width = 0;
        let height = 0;
        let depth = 0;
        node.items.forEach((child, index) => {
          const box = this.measure(child, size);
          width += box.width;
          if (index > 0) width += 0.06 * size;
          height = Math.max(height, box.height);
          depth = Math.max(depth, box.depth);
        });
        return { width, height, depth };
      }
      case 'frac': {
        const childSize = 0.8 * size;
        const num = this.measure(node.num, childSize);
        const den = this.measure(node.den, childSize);
        const barT = Math.max(1, 0.045 * size);
        const gap = 0.12 * size;
        const pad = 0.14 * size;
        const width = Math.max(num.width, den.width) + 2 * pad;
        const height = num.height + gap + barT + gap + den.height;
        return { width, height, depth: den.depth };
      }
      case 'sqrt': {
        const rad = this.measure(node.radicand, size);
        const barT = Math.max(1, 0.035 * size);
        const gap = 0.1 * size;
        const glyphSize = (rad.height + gap) / 0.72;
        const glyphW = glyphWidth('√', glyphSize);
        const pad = 0.12 * size;
        const barW = rad.width + 0.28 * size;
        const barLeft = pad + glyphW + 0.03 * size;
        const width = barLeft + barW + 0.08 * size;
        let height = rad.height + gap + barT;
        const depth = rad.depth;
        if (node.index !== null) {
          const index = this.measure(node.index, 0.55 * size);
          height = Math.max(height, barT + index.height + index.depth);
        }
        return { width, height, depth };
      }
      case 'scripts': {
        const base = this.measure(node.base, size);
        const childSize = 0.66 * size;
        const sub = node.sub !== null ? this.measure(node.sub, childSize) : null;
        const sup = node.sup !== null ? this.measure(node.sup, childSize) : null;
        const width =
          base.width +
          0.06 * size +
          Math.max(sub?.width ?? 0, sup?.width ?? 0);
        const height = Math.max(base.height, 0.42 * size + (sup?.height ?? 0));
        const depth = Math.max(base.depth, 0.28 * size + (sub?.depth ?? 0));
        return { width, height, depth };
      }
      case 'delimited': {
        const inner = this.measure(node.inner, size);
        const padV = 0.08 * size;
        const dSize = (inner.height + inner.depth + 0.16 * size) / 0.72;
        const dWidth = (ch: string) =>
          ch === '|' || ch === '‖' ? 0.22 * dSize : 0.36 * dSize;
        let width = inner.width;
        if (node.left !== '') width += dWidth(node.left) + 0.03 * size;
        if (node.right !== '') width += 0.03 * size + dWidth(node.right);
        return {
          width,
          height: inner.height + padV,
          depth: inner.depth + padV,
        };
      }
      case 'limits': {
        if (node.side === 'right') {
          const opSizeR = 1.15 * size;
          const opR = this.measure(node.op, opSizeR);
          const subR = node.sub !== null ? this.measure(node.sub, 0.6 * size) : null;
          const supR = node.sup !== null ? this.measure(node.sup, 0.6 * size) : null;
          return {
            width:
              opR.width +
              0.08 * size +
              Math.max(subR?.width ?? 0, supR?.width ?? 0),
            height: Math.max(opR.height, 0.12 * size + (supR?.height ?? 0)),
            depth: Math.max(opR.depth, 0.24 * size + (subR?.depth ?? 0)),
          };
        }
        const opIsText =
          node.op.k === 'text' &&
          node.op.style === 'upright' &&
          /^[A-Za-z]{1,7}$/u.test(node.op.text);
        const opSize = opIsText ? size : 1.25 * size;
        const op = this.measure(node.op, opSize);
        const childSize = 0.62 * size;
        const sub = node.sub !== null ? this.measure(node.sub, childSize) : null;
        const sup = node.sup !== null ? this.measure(node.sup, childSize) : null;
        const width = Math.max(op.width, sub?.width ?? 0, sup?.width ?? 0);
        let height = op.height;
        const depth = Math.max(
          op.depth,
          sub !== null ? op.depth + 0.06 * size + sub.height + sub.depth : 0,
        );
        if (sup !== null) {
          height = Math.max(height, sup.height + sup.depth + 0.08 * size + op.height);
        }
        return { width, height, depth };
      }
    }
  }

  place(node: MathNode, x: number, baseline: number, size: number): void {
    if (this.items.length > MATH_LIMITS.maxLayoutItems) {
      throw new Error('layout item limit exceeded');
    }
    switch (node.k) {
      case 'text': {
        const box = textBox(node.text, size);
        this.items.push({
          k: 'glyph',
          text: node.text,
          x,
          y: baseline - box.height,
          size,
          italic: node.style === 'italic',
        });
        return;
      }
      case 'space':
        return;
      case 'row': {
        let cursor = x;
        node.items.forEach((child, index) => {
          if (index > 0) cursor += 0.06 * size;
          this.place(child, cursor, baseline, size);
          cursor += this.measure(child, size).width;
        });
        return;
      }
      case 'frac': {
        const childSize = 0.8 * size;
        const num = this.measure(node.num, childSize);
        const den = this.measure(node.den, childSize);
        const barT = Math.max(1, 0.045 * size);
        const gap = 0.12 * size;
        const pad = 0.14 * size;
        const contentW = Math.max(num.width, den.width);
        const barW = contentW + 0.3 * size;
        const contentLeft = x + pad;
        const barTop = num.height + gap;
        const denTop = barTop + barT + gap;
        const stackAbove = num.height + gap + barT;
        this.items.push({
          k: 'rule',
          x: contentLeft - 0.15 * size,
          y: baseline - stackAbove,
          w: barW,
          h: barT,
        });
        this.place(node.num, contentLeft + (contentW - num.width) / 2, baseline - stackAbove, childSize);
        this.place(node.den, contentLeft + (contentW - den.width) / 2, baseline - stackAbove + denTop, childSize);
        return;
      }
      case 'sqrt': {
        const rad = this.measure(node.radicand, size);
        const barT = Math.max(1, 0.035 * size);
        const gap = 0.1 * size;
        const glyphSize = (rad.height + gap) / 0.72;
        const glyphW = glyphWidth('√', glyphSize);
        const pad = 0.12 * size;
        const barW = rad.width + 0.28 * size;
        const barTopY = baseline - (rad.height + gap + barT);
        const glyphX = x + pad;
        const barLeft = glyphX + glyphW + 0.03 * size;
        this.items.push({
          k: 'glyph',
          text: '√',
          x: glyphX,
          y: barTopY,
          size: glyphSize,
          italic: false,
        });
        this.items.push({ k: 'rule', x: barLeft, y: barTopY, w: barW, h: barT });
        this.place(node.radicand, barLeft + 0.08 * size, baseline, size);
        if (node.index !== null) {
          const indexSize = 0.55 * size;
          const index = this.measure(node.index, indexSize);
          this.place(node.index, barLeft, barTopY - index.depth - 0.02 * size, indexSize);
        }
        return;
      }
      case 'scripts': {
        this.place(node.base, x, baseline, size);
        const baseW = this.measure(node.base, size).width;
        const childSize = 0.66 * size;
        const subX = x + baseW + 0.06 * size;
        if (node.sup !== null) this.place(node.sup, subX, baseline - 0.42 * size, childSize);
        if (node.sub !== null) this.place(node.sub, subX, baseline + 0.28 * size, childSize);
        return;
      }
      case 'delimited': {
        const inner = this.measure(node.inner, size);
        const dSize = (inner.height + inner.depth + 0.16 * size) / 0.72;
        const dWidth = (ch: string) =>
          ch === '|' || ch === '‖' ? 0.22 * dSize : 0.36 * dSize;
        let cursor = x;
        if (node.left !== '') {
          this.items.push({
            k: 'glyph',
            text: node.left,
            x: cursor,
            y: baseline + (inner.depth - inner.height) / 2 - 0.36 * dSize,
            size: dSize,
            italic: false,
          });
          cursor += dWidth(node.left) + 0.03 * size;
        }
        this.place(node.inner, cursor, baseline, size);
        cursor += inner.width;
        if (node.right !== '') {
          cursor += 0.03 * size;
          this.items.push({
            k: 'glyph',
            text: node.right,
            x: cursor,
            y: baseline + (inner.depth - inner.height) / 2 - 0.36 * dSize,
            size: dSize,
            italic: false,
          });
        }
        return;
      }
      case 'limits': {
        if (node.side === 'right') {
          const opSize = 1.15 * size;
          const op = this.measure(node.op, opSize);
          this.place(node.op, x, baseline, opSize);
          const childSize = 0.6 * size;
          const subX = x + op.width + 0.08 * size;
          if (node.sup !== null) this.place(node.sup, subX, baseline - 0.12 * size, childSize);
          if (node.sub !== null) this.place(node.sub, subX, baseline + 0.24 * size, childSize);
          return;
        }
        const opIsText =
          node.op.k === 'text' &&
          node.op.style === 'upright' &&
          /^[A-Za-z]{1,7}$/u.test(node.op.text);
        const opSize = opIsText ? size : 1.25 * size;
        const op = this.measure(node.op, opSize);
        const childSize = 0.62 * size;
        const subNode = node.sub;
        const supNode = node.sup;
        const sub = subNode !== null ? this.measure(subNode, childSize) : null;
        const sup = supNode !== null ? this.measure(supNode, childSize) : null;
        const totalW = this.measure(node, size).width;
        if (sup !== null && supNode !== null) {
          const supBaseline = baseline - op.height - 0.08 * size - sup.depth;
          this.place(supNode, x + (totalW - sup.width) / 2, supBaseline, childSize);
        }
        this.place(node.op, x + (totalW - op.width) / 2, baseline, opSize);
        if (sub !== null && subNode !== null) {
          const subBaseline = baseline + op.depth + 0.06 * size + sub.height;
          this.place(subNode, x + (totalW - sub.width) / 2, subBaseline, childSize);
        }
        return;
      }
    }
  }

  run(node: MathNode, baseSize: number): MathLayout | null {
    try {
      const box = this.measure(node, baseSize);
      this.items = [];
      this.place(node, 0, box.height, baseSize);
      if (this.items.length > MATH_LIMITS.maxLayoutItems) return null;
      const width = Math.max(1, box.width);
      const height = box.height + box.depth;
      if (!Number.isFinite(width) || !Number.isFinite(height) || height <= 0) {
        return null;
      }
      for (const item of this.items) {
        item.x = round2(item.x);
        item.y = round2(item.y);
        if (item.k === 'rule') {
          item.w = round2(item.w);
          item.h = round2(item.h);
        }
        if (item.x < -0.5 || item.y < -0.5) return null;
      }
      return {
        items: this.items,
        width: round2(width),
        height: round2(height),
        baseline: round2(box.height),
      };
    } catch {
      return null;
    }
  }
}

/** Lays out a parsed expression; returns null when bounds are exceeded. */
export function layoutMath(node: MathNode, baseSize = 18): MathLayout | null {
  return new Engine().run(node, baseSize);
}
