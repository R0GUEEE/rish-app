/* eslint-disable no-control-regex -- URL actions reject control characters */
import { INLINE_LIMITS, MATH_LIMITS } from './limits';

/**
 * Inline tokenizer for markdown lines: text, strong (**), inline code spans,
 * inline math ($...$, $$...$$, \(...\)), images (![alt](url)), and links
 * ([label](url)). Everything not matched stays literal text, and every scan
 * is bounded so hostile output cannot cause unbounded work.
 */

export type InlineToken =
  | { type: 'text'; value: string }
  | { type: 'strong'; children: InlineToken[] }
  | { type: 'code'; value: string }
  | { type: 'math'; source: string }
  | { type: 'image'; alt: string; target: string }
  | { type: 'link'; label: string; target: string; children?: InlineToken[] };

type TokenizeOptions = { parseStrong: boolean; parseImages: boolean };

/** Only browser and email targets may cross the native URL boundary. */
export function isSafeLinkTarget(target: string): boolean {
  if (target.length > 2048 || /[\s\u0000-\u001f\u007f\\]/u.test(target))
    return false;
  if (/^mailto:[^@/?#]+@[^/?#]+(?:[?][^#]*)?$/iu.test(target)) return true;
  return /^https?:\/\/(?:\[[0-9a-f:]+\]|[^/:?#@]+)(?::[0-9]{1,5})?(?:[/?#].*)?$/iu.test(
    target,
  );
}

function bareLinkAt(value: string, start: number): string | undefined {
  if (start > 0 && /[\p{L}\p{N}_/@]/u.test(value[start - 1])) return undefined;
  const match = /^(?:https?:\/\/|mailto:)[^\s<>"'`*\u0000-\u001f]+/iu.exec(
    value.slice(start),
  );
  if (match === null) return undefined;
  let target = match[0].replace(/[.,;:!?。，；：！？、]+$/u, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ]) {
    while (
      target.endsWith(close) &&
      target.split(close).length > target.split(open).length
    ) {
      target = target.slice(0, -1);
    }
  }
  return isSafeLinkTarget(target) ? target : undefined;
}

/** User text keeps all formatting literally, with only URLs gaining actions. */
export function tokenizePlainLinks(value: string): InlineToken[] {
  if (value.length > INLINE_LIMITS.maxLineChars)
    return [{ type: 'text', value }];
  const tokens: InlineToken[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === '`') {
      const run = /^`+/u.exec(value.slice(i))![0];
      const close = value.indexOf(run, i + run.length);
      if (close !== -1) {
        i = close + run.length - 1;
        continue;
      }
    }
    const target = bareLinkAt(value, i);
    if (target === undefined) continue;
    if (i > start) tokens.push({ type: 'text', value: value.slice(start, i) });
    tokens.push({ type: 'link', label: target, target });
    i += target.length - 1;
    start = i + 1;
  }
  if (start < value.length)
    tokens.push({ type: 'text', value: value.slice(start) });
  return tokens;
}

export function tokenizeInline(
  value: string,
  options: TokenizeOptions = { parseStrong: true, parseImages: true },
): InlineToken[] {
  if (value.length > INLINE_LIMITS.maxLineChars)
    return [{ type: 'text', value }];
  const tokens: InlineToken[] = [];
  let buffer = '';
  const flush = () => {
    if (buffer.length > 0) {
      tokens.push({ type: 'text', value: buffer });
      buffer = '';
    }
  };
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (value.startsWith('![', i)) {
      const rest = value.slice(i);
      const match =
        /^!\[([^\]]{0,200})\]\(\s*([^\s()]{1,8192})\s*(?:["'][^"']*["'])?\s*\)/u.exec(
          rest,
        );
      if (match !== null) {
        if (options.parseImages) {
          flush();
          tokens.push({ type: 'image', alt: match[1], target: match[2] });
        } else {
          // Inside strong spans images stay literal so the run never
          // re-parses the URL part as a link.
          buffer += match[0];
        }
        i += match[0].length;
        continue;
      }
    }
    if (ch === '$') {
      const doubled = value[i + 1] === '$';
      const openLength = doubled ? 2 : 1;
      const contentStart = i + openLength;
      if (
        value[contentStart] !== undefined &&
        value[contentStart] !== ' ' &&
        value[contentStart] !== '\n'
      ) {
        let close = contentStart;
        let found = false;
        while (close < value.length) {
          if (doubled) {
            if (value[close] === '$' && value[close + 1] === '$') {
              found = true;
              break;
            }
            close += 1;
          } else if (value[close] === '$' && value[close - 1] !== '\\') {
            found = true;
            break;
          } else {
            close += 1;
          }
        }
        if (found) {
          const source = value.slice(contentStart, close);
          const end = close + openLength;
          if (
            source.length > 0 &&
            source.length <= MATH_LIMITS.maxInlineSourceChars &&
            !source.includes('\n') &&
            source[0] !== ' ' &&
            source[source.length - 1] !== ' '
          ) {
            flush();
            tokens.push({ type: 'math', source });
            i = end;
            continue;
          }
        }
      }
    }
    if (value.startsWith('\\(', i)) {
      const close = value.indexOf('\\)', i + 2);
      if (close > i + 2 && close - i <= MATH_LIMITS.maxInlineSourceChars + 4) {
        const source = value.slice(i + 2, close);
        if (source.length > 0 && !source.includes('\n')) {
          flush();
          tokens.push({ type: 'math', source });
          i = close + 2;
          continue;
        }
      }
    }
    if (ch === '\u0060') {
      const end = value.indexOf('\u0060', i + 1);
      if (end > i + 1 && end - i <= INLINE_LIMITS.maxCodeSpanChars) {
        flush();
        tokens.push({ type: 'code', value: value.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (options.parseStrong && value.startsWith('**', i)) {
      // CommonMark spacing rule: the delimiter run may not be followed or
      // preceded by a space, otherwise it stays literal (CJK-safe).
      const opensCleanly = value[i + 2] !== undefined && value[i + 2] !== ' ';
      let end = opensCleanly ? value.indexOf('**', i + 2) : -1;
      if (end !== -1 && (end === i + 2 || value[end - 1] === ' ')) end = -1;
      if (end !== -1 && end - i <= INLINE_LIMITS.maxStrongSpanChars) {
        flush();
        const inner = value.slice(i + 2, end);
        tokens.push({
          type: 'strong',
          children: tokenizeInline(inner, {
            parseStrong: false,
            parseImages: false,
          }),
        });
        i = end + 2;
        continue;
      }
    }
    if (ch === '[' && !value.startsWith('![', i)) {
      const closeBracket = value.indexOf(']', i + 1);
      if (
        closeBracket > i + 1 &&
        closeBracket - i <= INLINE_LIMITS.maxStrongSpanChars &&
        value[closeBracket + 1] === '('
      ) {
        const match = /^\(([^\s()]*(?:\([^\s()]*\)[^\s()]*)*)\)/u.exec(
          value.slice(closeBracket + 1),
        );
        if (match !== null && isSafeLinkTarget(match[1])) {
          flush();
          tokens.push({
            type: 'link',
            label: value.slice(i + 1, closeBracket),
            target: match[1],
            ...(value.slice(i + 1, closeBracket).includes('**')
              ? {
                  children: tokenizeInline(value.slice(i + 1, closeBracket), {
                    parseStrong: true,
                    parseImages: false,
                  }),
                }
              : {}),
          });
          i = closeBracket + 1 + match[0].length;
          continue;
        }
      }
    }
    if (ch === '<') {
      const end = value.indexOf('>', i + 1);
      const target = end === -1 ? '' : value.slice(i + 1, end);
      if (isSafeLinkTarget(target)) {
        flush();
        tokens.push({ type: 'link', label: target, target });
        i = end + 1;
        continue;
      }
    }
    const target = bareLinkAt(value, i);
    if (target !== undefined) {
      flush();
      tokens.push({ type: 'link', label: target, target });
      i += target.length;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return tokens;
}

/** Plain-text projection used for accessibility labels. */
export function flattenInlineTokens(tokens: InlineToken[]): string {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        out += token.value;
        break;
      case 'code':
        out += token.value;
        break;
      case 'strong':
        out += flattenInlineTokens(token.children);
        break;
      case 'math':
        out += token.source;
        break;
      case 'link':
        out += token.label;
        break;
      case 'image':
        out += token.alt.length > 0 ? token.alt : token.target;
        break;
    }
  }
  return out;
}
