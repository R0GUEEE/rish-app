import { MATH_LIMITS, VERBATIM_FALLBACK_CHARS } from './limits';
import {
  isDelimiterRow,
  normalizeTableRow,
  parseTableBlock,
  splitTableRow,
  type ParsedTable,
} from './table';

/**
 * Block-level markdown parser: fenced code, block math ($$/\[), GFM pipe
 * tables, and line groups. Everything that is not a supported construct
 * falls through to line groups, which keep the historical line renderer.
 * Constructs that exceed a bound fail closed to a verbatim block instead of
 * crashing or growing without limit.
 */

export type MarkdownBlock =
  | { kind: 'code'; language: string; value: string }
  | { kind: 'math'; source: string }
  | { kind: 'table'; table: ParsedTable }
  | { kind: 'verbatim'; source: string }
  | { kind: 'lines'; lines: string[] };

const FENCE_RE = /\u0060\u0060\u0060([^\n\u0060]*)\n([\s\S]*?)\u0060\u0060\u0060/gu;

const LIST_BLOCK_START = /^\s{0,3}(#{1,3}\s|[-*]\s|>)/u;
const MATH_BLOCK_START = /^\s{0,3}(\u0024\u0024|\\\[)/u;

function boundedVerbatim(source: string): string {
  if (source.length <= VERBATIM_FALLBACK_CHARS) return source;
  return source.slice(0, VERBATIM_FALLBACK_CHARS);
}

function blankAfter(source: string, index: number, width: number): boolean {
  return source.slice(index + width).trim() === '';
}

/**
 * Attempts to consume a block math region starting at lines[start]. Returns
 * the next line index and the emitted block (math or verbatim), or null when
 * the line is not a math opener at all.
 */
function takeMathBlock(
  lines: string[],
  start: number,
): { next: number; block: MarkdownBlock } | null {
  const line = lines[start];
  const opener = line.match(MATH_BLOCK_START);
  if (opener === null || opener.index === undefined) return null;
  if (line.startsWith('\u0024\u0024\u0024')) return null; // $$$ is literal
  const isDollar = opener[0].endsWith('\u0024\u0024');
  const openTag = isDollar ? '\u0024\u0024' : '\\[';
  const closeTag = isDollar ? '\u0024\u0024' : '\\]';
  const openEnd = opener.index + openTag.length;

  const firstClose = line.indexOf(closeTag, openEnd);
  if (firstClose !== -1) {
    if (blankAfter(line, firstClose, closeTag.length)) {
      const source = line.slice(openEnd, firstClose).trim();
      return { next: start + 1, block: { kind: 'math', source } };
    }
    // Trailing content after the closer: not a clean block; the line
    // renders inline instead.
    return null;
  }

  // Multi-line: collect until a closing line whose remainder is blank.
  let collected = line.slice(openEnd);
  let index = start + 1;
  while (index < lines.length) {
    const candidate = lines[index];
    const close = candidate.indexOf(closeTag);
    if (close !== -1 && blankAfter(candidate, close, closeTag.length)) {
      collected += '\n' + candidate.slice(0, close);
      return {
        next: index + 1,
        block: { kind: 'math', source: collected.trim() },
      };
    }
    if (collected.length + candidate.length + 1 > MATH_LIMITS.maxSourceChars + 8) {
      // Unbounded-looking region: fail closed to a bounded verbatim block.
      return {
        next: index + 1,
        block: {
          kind: 'verbatim',
          source: boundedVerbatim(collected + '\n' + candidate),
        },
      };
    }
    collected += '\n' + candidate;
    index += 1;
  }
  return {
    next: lines.length,
    block: { kind: 'verbatim', source: boundedVerbatim(collected) },
  };
}

/** True when the line cannot be a table header/body row. */
function startsListLike(line: string): boolean {
  return (
    LIST_BLOCK_START.test(line) ||
    line.startsWith('\u0060\u0060\u0060') ||
    line.startsWith('\u0024\u0024')
  );
}

/**
 * Attempts to consume a GFM table starting at lines[start]. Returns the next
 * line index and the table block, or null when the line is not a table.
 */
function takeTableBlock(
  lines: string[],
  start: number,
): { next: number; block: MarkdownBlock } | null {
  const header = lines[start];
  if (!header.includes('|') || startsListLike(header)) return null;
  const next = start + 1;
  if (next >= lines.length) return null;
  const delimiter = lines[next];
  if (!isDelimiterRow(delimiter)) return null;
  const headerCells = normalizeTableRow(splitTableRow(header));
  const delimiterCells = normalizeTableRow(splitTableRow(delimiter));
  if (
    headerCells.length === 0 ||
    delimiterCells.length === 0 ||
    delimiterCells.length !== headerCells.length
  ) {
    return null;
  }

  const candidate: string[] = [header, delimiter];
  let index = next + 1;
  while (index < lines.length) {
    const body = lines[index];
    if (!body.includes('|') || startsListLike(body)) break;
    candidate.push(body);
    index += 1;
  }

  const parsed = parseTableBlock(candidate);
  if (parsed !== null && parsed.ok) {
    return { next: index, block: { kind: 'table', table: parsed.table } };
  }
  if (parsed !== null) {
    // Real table, but beyond a rendering limit: fail closed to verbatim.
    return {
      next: index,
      block: { kind: 'verbatim', source: boundedVerbatim(candidate.join('\n')) },
    };
  }
  return null;
}

function pushTextBlocks(blocks: MarkdownBlock[], text: string): void {
  const lines = text.split('\n');
  let index = 0;
  let pending: string[] = [];
  const flushLines = () => {
    if (pending.length > 0) {
      blocks.push({ kind: 'lines', lines: pending });
      pending = [];
    }
  };
  while (index < lines.length) {
    const math = takeMathBlock(lines, index);
    if (math !== null) {
      flushLines();
      blocks.push(math.block);
      index = math.next;
      continue;
    }
    const table = takeTableBlock(lines, index);
    if (table !== null) {
      flushLines();
      blocks.push(table.block);
      index = table.next;
      continue;
    }
    pending.push(lines[index]);
    index += 1;
  }
  flushLines();
}

/** Parses markdown into renderable blocks. Never throws. */
export function parseMarkdownBlocks(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let cursor = 0;
  for (const match of markdown.matchAll(FENCE_RE)) {
    const index = match.index ?? 0;
    if (index > cursor) pushTextBlocks(blocks, markdown.slice(cursor, index));
    blocks.push({
      kind: 'code',
      language: (match[1] ?? '').trim(),
      value: (match[2] ?? '').replace(/\n$/u, ''),
    });
    cursor = index + match[0].length;
  }
  if (cursor < markdown.length) pushTextBlocks(blocks, markdown.slice(cursor));
  return blocks;
}
