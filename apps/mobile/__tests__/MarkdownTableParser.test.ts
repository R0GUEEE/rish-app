import {
  isDelimiterRow,
  parseTableBlock,
  splitTableRow,
} from '../src/markdown/table';

const BS = String.fromCharCode(92);

describe('splitTableRow', () => {
  test('splits on pipes and unescapes escaped pipes', () => {
    expect(splitTableRow('a | b | c')).toEqual(['a ', ' b ', ' c']);
    expect(splitTableRow('a ' + BS + '| b | c')).toEqual(['a | b ', ' c']);
  });

  test('keeps leading and trailing empty cells for the parser', () => {
    expect(splitTableRow('| a | b |')).toEqual(['', ' a ', ' b ', '']);
  });
});

describe('isDelimiterRow', () => {
  test.each([
    ['| --- | --- |', true],
    ['| :--- | ---: | :---: |', true],
    ['--- | ---', true],
    ['| a | b |', false],
    ['| --- | b |', false],
    ['plain text', false],
  ])('classifies %j as %s', (line, expected) => {
    expect(isDelimiterRow(line)).toBe(expected);
  });
});

describe('parseTableBlock', () => {
  test('parses a basic table with alignment and inline content', () => {
    const result = parseTableBlock([
      '| Name | Value | Score |',
      '| :--- | ---: | :---: |',
      '| **a** | ' + BS + '`1' + BS + '` | 9 |',
    ]);
    expect(result).not.toBeNull();
    if (result === null || !result.ok) throw new Error('expected table');
    expect(result.table.headers).toEqual(['Name', 'Value', 'Score']);
    expect(result.table.alignments).toEqual(['left', 'right', 'center']);
    expect(result.table.rows).toEqual([['**a**', BS + '`1' + BS + '`', '9']]);
  });

  test('pads and truncates body rows to the header width', () => {
    const result = parseTableBlock([
      '| a | b |',
      '| - | - |',
      '| only |',
      '| one | two | three |',
    ]);
    expect(result).not.toBeNull();
    if (result === null || !result.ok) throw new Error('expected table');
    expect(result.table.rows).toEqual([['only', ''], ['one', 'two']]);
  });

  test('returns null when the second line is not a delimiter row', () => {
    expect(parseTableBlock(['| a | b |', '| x | y |'])).toBeNull();
    expect(parseTableBlock(['| a | b |'])).toBeNull();
  });

  test('returns null when the delimiter width differs from the header', () => {
    expect(parseTableBlock(['| a | b |', '| --- |'])).toBeNull();
  });

  test.each([
    ['columns', 13, 2, 'columns'],
    ['rows', 2, 100, 'rows'],
    ['cell-too-long', 2, 2, 'cell-too-long'],
  ])('fails closed with %s when over limit', (_label, columns, bodyRows, reason) => {
    const header = Array.from({ length: columns }, (_, i) => 'c' + i).join(' | ');
    const delimiter = Array.from({ length: columns }, () => '---').join(' | ');
    const longCell = 'x'.repeat(300);
    const row =
      reason === 'cell-too-long'
        ? longCell + ' | 1'
        : Array.from({ length: columns }, (_, i) => 'r' + i).join(' | ');
    const lines = ['| ' + header + ' |', '| ' + delimiter + ' |'];
    for (let i = 0; i < bodyRows; i += 1) lines.push('| ' + row + ' |');
    const result = parseTableBlock(lines);
    expect(result).not.toBeNull();
    if (result === null || result.ok) throw new Error('expected failure');
    expect(result.reason).toBe(reason);
  });

  test('rejects a 10k-cell table', () => {
    const lines = ['| ' + Array.from({ length: 100 }, (_, i) => 'c' + i).join(' | ') + ' |'];
    lines.push('| ' + Array.from({ length: 100 }, () => '---').join(' | ') + ' |');
    for (let i = 0; i < 100; i += 1) {
      lines.push('| ' + Array.from({ length: 100 }, (_, j) => 'r' + j).join(' | ') + ' |');
    }
    const result = parseTableBlock(lines);
    expect(result).toEqual({ ok: false, reason: 'columns' });
  });

  test('keeps escaped pipes inside cells', () => {
    const result = parseTableBlock([
      '| a | b |',
      '| - | - |',
      '| x ' + BS + '| y | z |',
    ]);
    expect(result).not.toBeNull();
    if (result === null || !result.ok) throw new Error('expected table');
    expect(result.table.rows[0][0]).toBe('x | y');
  });
});
