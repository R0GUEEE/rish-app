import { MATH_LIMITS } from './limits';

/**
 * A bounded LaTeX-subset parser. Anything outside the supported subset fails
 * closed: the caller renders the source as verbatim monospace text instead.
 */

export type MathNode =
  | { k: 'row'; items: MathNode[] }
  | { k: 'text'; text: string; style: 'italic' | 'upright' }
  | { k: 'space'; width: number }
  | { k: 'frac'; num: MathNode; den: MathNode }
  | { k: 'sqrt'; radicand: MathNode; index: MathNode | null }
  | {
      k: 'scripts';
      base: MathNode;
      sub: MathNode | null;
      sup: MathNode | null;
    }
  | {
      k: 'limits';
      op: MathNode;
      sub: MathNode | null;
      sup: MathNode | null;
      side: 'above' | 'right';
    }
  | { k: 'delimited'; left: string; right: string; inner: MathNode };

export type MathParseResult =
  | { ok: true; ast: MathNode }
  | {
      ok: false;
      reason:
        | 'too-long'
        | 'too-many-tokens'
        | 'too-deep'
        | 'too-many-nodes'
        | 'syntax'
        | 'unsupported';
      detail?: string;
    };

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ϵ',
  varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ',
  iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ',
  pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ',
  varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'ϕ', varphi: 'φ',
  chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ',
  Omega: 'Ω',
};

const SYMBOLS: Record<string, string> = {
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬',
  iiint: '∭', oint: '∮', infty: '∞', partial: '∂', nabla: '∇',
  pm: '±', mp: '∓', times: '×', div: '÷', cdot: '⋅', ast: '∗',
  star: '⋆', circ: '∘', bullet: '∙', leq: '≤', le: '≤',
  geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', sim: '∼',
  simeq: '≃', cong: '≅', equiv: '≡', propto: '∝', in: '∈',
  notin: '∉', ni: '∋', subset: '⊂', supset: '⊃', subseteq: '⊆',
  supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖',
  emptyset: '∅', varnothing: '∅', land: '∧', wedge: '∧',
  lor: '∨', vee: '∨', neg: '¬', lnot: '¬', forall: '∀',
  exists: '∃', to: '→', rightarrow: '→', leftarrow: '←',
  gets: '←', leftrightarrow: '↔', mapsto: '↦', Rightarrow: '⇒',
  Leftarrow: '⇐', Leftrightarrow: '⇔', uparrow: '↑',
  downarrow: '↓', ldots: '…', dots: '…', cdots: '⋯',
  vdots: '⋮', ddots: '⋱', prime: '′', degree: '°', hbar: 'ℏ',
  ell: 'ℓ', aleph: 'ℵ', angle: '∠', perp: '⊥', parallel: '∥',
  mid: '∣', top: '⊤', bot: '⊥', triangle: '△', therefore: '∴',
  because: '∵', vert: '|', Vert: '‖', lvert: '|', rvert: '|',
  lVert: '‖', rVert: '‖', langle: '⟨', rangle: '⟩',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', backslash: '\\',
};

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos',
  'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln', 'lg',
  'exp', 'deg', 'arg', 'det', 'gcd', 'dim', 'ker', 'hom', 'Pr',
]);

const LIMIT_OPS = new Set([
  'sum', 'prod', 'coprod', 'int', 'iint', 'iiint', 'oint', 'lim',
  'limsup', 'liminf', 'max', 'min', 'sup', 'inf',
]);

const STRUCTURAL = new Set([
  'frac', 'dfrac', 'tfrac', 'sqrt', 'left', 'right', 'limits',
  'nolimits', 'quad', 'qquad',
]);

const TEXT_COMMANDS = new Set([
  'text', 'mathrm', 'textrm', 'mbox', 'operatorname', 'mathbf',
  'mathit', 'texttt', 'textbf',
]);

const SPACE_WIDTHS: Record<string, number> = {
  ' ': 0.3333,
  ',': 0.1667,
  ';': 0.2778,
  '!': -0.1667,
  quad: 1,
  qquad: 2,
};

type Token =
  | { t: 'char'; v: string }
  | { t: 'cmd'; v: string }
  | { t: 'lbrace' }
  | { t: 'rbrace' }
  | { t: 'sub' }
  | { t: 'sup' }
  | { t: 'text'; v: string; italic: boolean }
  | { t: 'space'; v: string };

type TokenizeResult =
  | { ok: true; tokens: Token[] }
  | { ok: false; reason: FailReason | 'too-long'; detail?: string };

type FailReason =
  | 'too-many-tokens'
  | 'too-many-nodes'
  | 'too-deep'
  | 'syntax'
  | 'unsupported';

class Fail extends Error {
  reason: FailReason;
  detail: string | undefined;
  constructor(reason: FailReason, detail?: string) {
    super(reason);
    this.reason = reason;
    this.detail = detail;
  }
}

const ALLOWED_CHAR = /^[A-Za-z0-9+\-=<>()[\].,;:!?*|'"/\u0370-\u03FF]$/u;

function tokenizeMath(source: string): TokenizeResult {
  if (source.length > MATH_LIMITS.maxSourceChars)
    return { ok: false, reason: 'too-long' };
  const tokens: Token[] = [];
  const push = (token: Token) => {
    tokens.push(token);
    if (tokens.length > MATH_LIMITS.maxTokens)
      throw new Fail('too-many-tokens');
  };
  try {
    let i = 0;
    const n = source.length;
    while (i < n) {
      const ch = source[i];
      if (ch === '\\') {
        if (i + 1 >= n) return { ok: false, reason: 'syntax' };
        const next = source[i + 1];
        if (/[A-Za-z]/u.test(next)) {
          let j = i + 1;
          while (j < n && /[A-Za-z]/u.test(source[j])) j += 1;
          const name = source.slice(i + 1, j);
          if (TEXT_COMMANDS.has(name)) {
            let k = j;
            while (k < n && (source[k] === ' ' || source[k] === '\t' || source[k] === '\n')) {
              k += 1;
            }
            if (source[k] !== '{') return { ok: false, reason: 'syntax' };
            let depth = 0;
            const start = k + 1;
            let p = k + 1;
            while (p < n) {
              if (source[p] === '\\') {
                p += 2;
                continue;
              }
              if (source[p] === '{') {
                depth += 1;
                p += 1;
                continue;
              }
              if (source[p] === '}') {
                if (depth === 0) break;
                depth -= 1;
                p += 1;
                continue;
              }
              p += 1;
            }
            if (p >= n) return { ok: false, reason: 'syntax' };
            const raw = source.slice(start, p).slice(0, 512);
            push({ t: 'text', v: raw, italic: name === 'mathit' });
            i = p + 1;
            continue;
          }
          if (
            STRUCTURAL.has(name) ||
            GREEK[name] !== undefined ||
            SYMBOLS[name] !== undefined ||
            FUNCTIONS.has(name) ||
            LIMIT_OPS.has(name)
          ) {
            push({ t: 'cmd', v: name });
            i = j;
            continue;
          }
          return { ok: false, reason: 'unsupported', detail: '\\' + name };
        }
        if ('{}%$&#_'.includes(next)) {
          push({ t: 'char', v: next });
          i += 2;
          continue;
        }
        if (next === '|') {
          push({ t: 'cmd', v: 'vert' });
          i += 2;
          continue;
        }
        if (next === '(' || next === ')' || next === ',' || next === ';' || next === '!' || next === ' ' || next === '.') {
          push({ t: 'space', v: next });
          i += 2;
          continue;
        }
        if (next === '[' || next === ']' || next === '/') {
          push({ t: 'char', v: next });
          i += 2;
          continue;
        }
        return { ok: false, reason: 'unsupported', detail: '\\' + next };
      }
      if (ch === '{') {
        push({ t: 'lbrace' });
        i += 1;
        continue;
      }
      if (ch === '}') {
        // Balanced braces are the parser's job: an unmatched closing
        // brace is rejected there (parsePrimary 'rbrace').
        push({ t: 'rbrace' });
        i += 1;
        continue;
      }
      if (ch === '_') {
        push({ t: 'sub' });
        i += 1;
        continue;
      }
      if (ch === '^') {
        push({ t: 'sup' });
        i += 1;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n') {
        push({ t: 'space', v: ' ' });
        i += 1;
        continue;
      }
      if (ALLOWED_CHAR.test(ch)) {
        push({ t: 'char', v: ch });
        i += 1;
        continue;
      }
      return { ok: false, reason: 'unsupported', detail: ch };
    }
    if (tokens.length === 0) return { ok: false, reason: 'syntax' };
    return { ok: true, tokens };
  } catch (error) {
    if (error instanceof Fail)
      return { ok: false, reason: error.reason, detail: error.detail };
    return { ok: false, reason: 'syntax' };
  }
}

class MathParser {
  private tokens: Token[];
  private pos = 0;
  private nodes = 0;
  private depth = 0;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  parse(): MathParseResult {
    try {
      const ast = this.parseRow(true, false);
      if (this.pos < this.tokens.length) return this.failSyntax();
      return { ok: true, ast };
    } catch (error) {
      if (error instanceof Fail)
        return { ok: false, reason: error.reason, detail: error.detail };
      return { ok: false, reason: 'syntax' };
    }
  }

  private failSyntax(): MathParseResult {
    return { ok: false, reason: 'syntax' };
  }

  private node<T extends MathNode>(node: T): T {
    this.nodes += 1;
    if (this.nodes > MATH_LIMITS.maxNodes) throw new Fail('too-many-nodes');
    return node;
  }

  private enterGroup(): void {
    this.depth += 1;
    if (this.depth > MATH_LIMITS.maxDepth) throw new Fail('too-deep');
  }

  private leaveGroup(): void {
    this.depth -= 1;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private parseRow(stopAtRbrace: boolean, stopAtRight: boolean): MathNode {
    const items: MathNode[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (stopAtRbrace && token.t === 'rbrace') break;
      if (stopAtRight && token.t === 'cmd' && token.v === 'right') break;
      items.push(this.parseAtom());
    }
    if (items.length === 0) throw new Fail('syntax');
    return this.node({ k: 'row', items });
  }

  private parseAtom(): MathNode {
    const base = this.parsePrimary();
    let sub: MathNode | null = null;
    let sup: MathNode | null = null;
    while (this.pos < this.tokens.length) {
      const token = this.tokens[this.pos];
      if (token.t === 'sub' || token.t === 'sup') {
        this.pos += 1;
        const argument = this.parseScriptArgument();
        if (token.t === 'sub') sub = argument;
        else sup = argument;
        continue;
      }
      if (token.t === 'cmd' && (token.v === 'limits' || token.v === 'nolimits')) {
        this.pos += 1;
        continue;
      }
      break;
    }
    if (sub === null && sup === null) return base;
    const opName = opText(base);
    if (opName !== null && LIMIT_OPS.has(opName)) {
      const side =
        opName === 'int' || opName === 'iint' || opName === 'iiint' ||
        opName === 'oint'
          ? 'right'
          : 'above';
      return this.node({ k: 'limits', op: base, sub, sup, side });
    }
    return this.node({ k: 'scripts', base, sub, sup });
  }

  private parseScriptArgument(): MathNode {
    const token = this.peek();
    if (token === undefined) throw new Fail('syntax');
    if (token.t === 'lbrace') {
      this.pos += 1;
      this.enterGroup();
      const row = this.parseRow(true, false);
      this.leaveGroup();
      if (this.peek()?.t !== 'rbrace') throw new Fail('syntax');
      this.pos += 1;
      return row;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): MathNode {
    const token = this.peek();
    if (token === undefined) throw new Fail('syntax');
    switch (token.t) {
      case 'char': {
        this.pos += 1;
        return this.node({ k: 'text', text: token.v, style: 'italic' });
      }
      case 'lbrace': {
        this.pos += 1;
        this.enterGroup();
        const row = this.parseRow(true, false);
        this.leaveGroup();
        if (this.peek()?.t !== 'rbrace') throw new Fail('syntax');
        this.pos += 1;
        return row;
      }
      case 'rbrace':
        throw new Fail('syntax');
      case 'text': {
        this.pos += 1;
        return this.node({
          k: 'text',
          text: token.v,
          style: token.italic ? 'italic' : 'upright',
        });
      }
      case 'space': {
        this.pos += 1;
        const width = SPACE_WIDTHS[token.v] ?? 0.3333;
        return this.node({ k: 'space', width });
      }
      case 'cmd':
        return this.parseCommand(token.v);
      default:
        throw new Fail('syntax');
    }
  }

  private parseCommand(name: string): MathNode {
    this.pos += 1;
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const num = this.parseScriptArgument();
      const den = this.parseScriptArgument();
      return this.node({ k: 'frac', num, den });
    }
    if (name === 'sqrt') {
      let index: MathNode | null = null;
      const peeked = this.peek();
      if (peeked !== undefined && peeked.t === 'char' && peeked.v === '[') {
        this.pos += 1;
        this.enterGroup();
        const items: MathNode[] = [];
        while (this.pos < this.tokens.length) {
          const token = this.tokens[this.pos];
          if (token.t === 'char' && token.v === ']') break;
          items.push(this.parseAtom());
        }
        this.leaveGroup();
        const closing = this.peek();
        if (closing === undefined || closing.t !== 'char' || closing.v !== ']') {
          throw new Fail('syntax');
        }
        this.pos += 1;
        index = this.node({ k: 'row', items });
      }
      const radicand = this.parseScriptArgument();
      return this.node({ k: 'sqrt', radicand, index });
    }
    if (name === 'left') {
      const left = this.parseDelimiter();
      const inner = this.parseRow(false, true);
      const rightToken = this.peek();
      if (rightToken === undefined || rightToken.t !== 'cmd' || rightToken.v !== 'right') {
        throw new Fail('syntax');
      }
      this.pos += 1;
      const right = this.parseDelimiter();
      return this.node({ k: 'delimited', left, right, inner });
    }
    if (name === 'quad' || name === 'qquad') {
      return this.node({ k: 'space', width: SPACE_WIDTHS[name] });
    }
    const greek = GREEK[name];
    if (greek !== undefined) {
      const uppercase = /^[A-Z]/u.test(name);
      return this.node({
        k: 'text',
        text: greek,
        style: uppercase ? 'upright' : 'italic',
      });
    }
    const symbol = SYMBOLS[name];
    if (symbol !== undefined) {
      return this.node({ k: 'text', text: symbol, style: 'upright' });
    }
    if (FUNCTIONS.has(name) || LIMIT_OPS.has(name)) {
      return this.node({ k: 'text', text: name, style: 'upright' });
    }
    throw new Fail('unsupported', '\\' + name);
  }

  private parseDelimiter(): string {
    const token = this.peek();
    if (token === undefined) throw new Fail('syntax');
    if (token.t === 'char' && '()[]{}|./'.includes(token.v)) {
      this.pos += 1;
      return token.v === '.' ? '' : token.v;
    }
    if (token.t === 'cmd' && (token.v === 'vert' || token.v === 'Vert')) {
      this.pos += 1;
      return token.v === 'vert' ? '|' : '‖';
    }
    throw new Fail('syntax');
  }
}

/**
 * Maps rendered operator glyphs back to their LaTeX command names so the
 * script parser can recognize limit-taking operators after symbol mapping.
 */
const GLYPH_OPERATORS: Record<string, string> = {
  '∑': 'sum',
  '∏': 'prod',
  '∐': 'coprod',
  '∫': 'int',
  '∬': 'iint',
  '∭': 'iiint',
  '∮': 'oint',
};

/** Returns the operator name when the node is a single upright text atom. */
function opText(node: MathNode): string | null {
  if (node.k === 'text' && node.style === 'upright') {
    return GLYPH_OPERATORS[node.text] ?? node.text;
  }
  if (node.k === 'row' && node.items.length === 1) return opText(node.items[0]);
  return null;
}

/** Parses LaTeX-subset source; fails closed on anything unsupported. */
export function parseMath(source: string): MathParseResult {
  const tokenized = tokenizeMath(source);
  if (!tokenized.ok) return tokenized;
  return new MathParser(tokenized.tokens).parse();
}
