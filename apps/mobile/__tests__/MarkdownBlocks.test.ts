import { parseMarkdownBlocks, type MarkdownBlock } from '../src/markdown/blocks';

const BS = String.fromCharCode(92);

function kinds(blocks: MarkdownBlock[]): string[] {
  return blocks.map(block => block.kind);
}

describe('parseMarkdownBlocks', () => {
  test('splits fenced code from text and keeps the language label', () => {
    const blocks = parseMarkdownBlocks(
      'before\n\u0060\u0060\u0060sh\nsha256sum note.md\n\u0060\u0060\u0060\nafter',
    );
    expect(kinds(blocks)).toEqual(['lines', 'code', 'lines']);
    const code = blocks[1];
    if (code.kind !== 'code') throw new Error('expected code');
    expect(code.language).toBe('sh');
    expect(code.value).toBe('sha256sum note.md');
  });

  test('parses a pipe table between paragraphs', () => {
    const blocks = parseMarkdownBlocks(
      'Intro\n\n| A | B |\n| --- | ---: |\n| 1 | 2 |\n\nOutro',
    );
    expect(kinds(blocks)).toEqual(['lines', 'table', 'lines']);
    const table = blocks[1];
    if (table.kind !== 'table') throw new Error('expected table');
    expect(table.table.headers).toEqual(['A', 'B']);
    expect(table.table.alignments).toEqual(['left', 'right']);
    expect(table.table.rows).toEqual([['1', '2']]);
  });

  test('parses tables with outer pipes', () => {
    const blocks = parseMarkdownBlocks('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(kinds(blocks)).toEqual(['table']);
  });

  test('treats a lone pipe line as a paragraph', () => {
    const blocks = parseMarkdownBlocks('| not a table');
    expect(kinds(blocks)).toEqual(['lines']);
  });

  test('stops the table at the first line without a pipe', () => {
    const blocks = parseMarkdownBlocks(
      '| a |\n| --- |\n| b |\nplain line\n| c |\n| --- |\n| d |',
    );
    expect(kinds(blocks)).toEqual(['table', 'lines', 'table']);
  });

  test('does not treat a bullet line with pipes as a table header', () => {
    const blocks = parseMarkdownBlocks('- item | x\n| --- | --- |');
    expect(kinds(blocks)).toEqual(['lines']);
  });

  test('fails a 10k-cell table closed into a verbatim block', () => {
    const header = '| ' + Array.from({ length: 100 }, (_, i) => 'c' + i).join(' | ') + ' |';
    const delimiter = '| ' + Array.from({ length: 100 }, () => '---').join(' | ') + ' |';
    const rows: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push('| ' + Array.from({ length: 100 }, (_, j) => 'r' + j).join(' | ') + ' |');
    }
    const blocks = parseMarkdownBlocks([header, delimiter, ...rows].join('\n'));
    expect(kinds(blocks)).toEqual(['verbatim']);
    const verbatim = blocks[0];
    if (verbatim.kind !== 'verbatim') throw new Error('expected verbatim');
    expect(verbatim.source.length).toBeLessThanOrEqual(4000);
    expect(verbatim.source).toContain('c0');
  });

  test('fails an over-row table closed into a verbatim block', () => {
    const lines = ['| h |', '| --- |'];
    for (let i = 0; i < 100; i += 1) lines.push('| r |');
    const blocks = parseMarkdownBlocks(lines.join('\n'));
    expect(kinds(blocks)).toEqual(['verbatim']);
  });

  test('parses single-line and multi-line dollar math blocks', () => {
    const single = parseMarkdownBlocks('\u0024\u0024x^2\u0024\u0024');
    expect(kinds(single)).toEqual(['math']);
    if (single[0].kind !== 'math') throw new Error('expected math');
    expect(single[0].source).toBe('x^2');

    const multi = parseMarkdownBlocks(
      '\u0024\u0024\n' + BS + 'int_0^1 x dx\n\u0024\u0024',
    );
    expect(kinds(multi)).toEqual(['math']);
    if (multi[0].kind !== 'math') throw new Error('expected math');
    expect(multi[0].source).toBe(BS + 'int_0^1 x dx');
  });

  test('parses bracket math blocks', () => {
    const blocks = parseMarkdownBlocks(BS + '[a+b' + BS + ']');
    expect(kinds(blocks)).toEqual(['math']);
    if (blocks[0].kind !== 'math') throw new Error('expected math');
    expect(blocks[0].source).toBe('a+b');
  });

  test('fails an unclosed math block closed to verbatim', () => {
    const blocks = parseMarkdownBlocks('\u0024\u0024\nalpha' + BS + ' unknown');
    expect(kinds(blocks)).toEqual(['verbatim']);
    const verbatim = blocks[0];
    if (verbatim.kind !== 'verbatim') throw new Error('expected verbatim');
    expect(verbatim.source).toContain('alpha');
  });

  test('keeps inline dollar math inside a paragraph', () => {
    const blocks = parseMarkdownBlocks('Price $x^2$ now');
    expect(kinds(blocks)).toEqual(['lines']);
    const lines = blocks[0];
    if (lines.kind !== 'lines') throw new Error('expected lines');
    expect(lines.lines).toEqual(['Price $x^2$ now']);
  });

  test('treats trailing text after a single-line math closer as a paragraph', () => {
    const blocks = parseMarkdownBlocks('\u0024\u0024x\u0024\u0024 tail');
    expect(kinds(blocks)).toEqual(['lines']);
  });

  test('caps a runaway math region without hanging', () => {
    const lines: string[] = ['\u0024\u0024'];
    for (let i = 0; i < 500; i += 1) lines.push('x'.repeat(200));
    const started = Date.now();
    const blocks = parseMarkdownBlocks(lines.join('\n'));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(kinds(blocks)).toEqual(['verbatim', 'lines']);
    if (blocks[0].kind !== 'verbatim') throw new Error('expected verbatim');
    expect(blocks[0].source.length).toBeLessThanOrEqual(4000);
  });

  test('keeps headings, bullets, quotes, and code spans as lines', () => {
    const blocks = parseMarkdownBlocks(
      '# H\n- bullet\n> quote\nUse \u0060rish\u0060.',
    );
    expect(kinds(blocks)).toEqual(['lines']);
    const lines = blocks[0];
    if (lines.kind !== 'lines') throw new Error('expected lines');
    expect(lines.lines).toEqual(['# H', '- bullet', '> quote', 'Use \u0060rish\u0060.']);
  });
});
