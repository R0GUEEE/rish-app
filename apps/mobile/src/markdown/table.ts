import { TABLE_LIMITS } from './limits';

export type TableAlignment = 'left' | 'center' | 'right';

export type ParsedTable = {
  kind: 'table';
  headers: string[];
  alignments: TableAlignment[];
  /** Body rows; each row has exactly headers.length cells. */
  rows: string[][];
  /** Original block source, kept for diagnostics. */
  source: string;
};

export type TableParseResult =
  | { ok: true; table: ParsedTable }
  | { ok: false; reason: 'columns' | 'rows' | 'cells' | 'cell-too-long' };

/** True when every cell of the row matches the GFM delimiter pattern. */
export function isDelimiterRow(line: string): boolean {
  if (!line.includes('|') || !line.includes('-')) return false;
  const cells = normalizeTableRow(splitTableRow(line));
  if (cells.length === 0) return false;
  return cells.every(cell => /^:?-+:?$/u.test(cell.trim()));
}

function delimiterAlignment(cell: string): TableAlignment {
  const hasLeft = cell.startsWith(':');
  const hasRight = cell.endsWith(':');
  if (hasLeft && hasRight) return 'center';
  if (hasLeft) return 'left';
  if (hasRight) return 'right';
  return 'left';
}

/**
 * Splits a pipe row on unescaped pipes and unescapes \| into |.
 * Runs of other backslash escapes are left untouched.
 */
export function splitTableRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      current += '|';
      i += 2;
      continue;
    }
    if (ch === '|') {
      cells.push(current);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  cells.push(current);
  return cells;
}

export function normalizeTableRow(cells: string[]): string[] {
  let list = cells;
  if (list.length > 0 && list[0].trim() === '') list = list.slice(1);
  if (list.length > 0 && list[list.length - 1].trim() === '')
    list = list.slice(0, -1);
  return list.map(cell => cell.trim());
}

/**
 * Parses a GFM pipe table block. lines[0] is the header row and lines[1] the
 * delimiter row; the rest are body rows. Returns null when the block is not a
 * table at all (caller treats the lines as paragraphs) and { ok: false } when
 * it is a table but exceeds a rendering limit (caller fails closed to a
 * verbatim code block).
 */
export function parseTableBlock(lines: string[]): TableParseResult | null {
  if (lines.length < 2) return null;
  const headerCells = normalizeTableRow(splitTableRow(lines[0]));
  if (headerCells.length === 0) return null;
  const delimiterCells = normalizeTableRow(splitTableRow(lines[1]));
  if (delimiterCells.length === 0) return null;
  if (delimiterCells.length !== headerCells.length) return null;
  if (!delimiterCells.every(cell => /^:?-+:?$/u.test(cell.trim()))) return null;

  const columns = headerCells.length;
  if (columns > TABLE_LIMITS.maxColumns) return { ok: false, reason: 'columns' };

  const alignments = delimiterCells.map(delimiterAlignment);
  const rows: string[][] = [];
  for (const line of lines.slice(2)) {
    const cells = normalizeTableRow(splitTableRow(line));
    while (cells.length < columns) cells.push('');
    if (cells.length > columns) cells.length = columns;
    rows.push(cells);
  }

  const totalRows = rows.length + 1;
  if (totalRows > TABLE_LIMITS.maxRows) return { ok: false, reason: 'rows' };
  if (columns * totalRows > TABLE_LIMITS.maxTotalCells)
    return { ok: false, reason: 'cells' };

  for (const cell of [...headerCells, ...rows.flat()]) {
    if (cell.length > TABLE_LIMITS.maxCellChars)
      return { ok: false, reason: 'cell-too-long' };
  }

  return {
    ok: true,
    table: {
      kind: 'table',
      headers: headerCells,
      alignments,
      rows,
      source: lines.join('\n'),
    },
  };
}
