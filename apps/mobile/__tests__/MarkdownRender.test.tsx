/* eslint-disable no-script-url -- javascript: scheme security cases */
import React from 'react';
import { Image } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { MarkdownText } from '../src/components/MarkdownText';
import type { AttachmentDescriptor } from '../src/native/LocalAttachments';

const BS = String.fromCharCode(92);
const DOLLAR = String.fromCharCode(36);
const BACKTICK = String.fromCharCode(96);

function render(markdown: string, attachments?: readonly AttachmentDescriptor[]) {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  act(() => {
    renderer = ReactTestRenderer.create(
      <MarkdownText attachments={attachments} markdown={markdown} />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  return renderer;
}

function textOf(renderer: ReactTestRenderer.ReactTestRenderer): string {
  let text = '';
  const walk = (node: ReactTestRenderer.ReactTestInstance): void => {
    for (const child of node.children) {
      if (typeof child === 'string') text += child;
      else walk(child);
    }
  };
  walk(renderer.root);
  return text;
}

describe('MarkdownText tables', () => {
  test('renders cells and a flattened accessibility label', () => {
    const renderer = render(
      '| A | B |\n| --- | ---: |\n| **1** | ' + BACKTICK + '2' + BACKTICK + ' |',
    );
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('A');
    expect(json).toContain('B');
    expect(json).toContain('1');
    expect(json).toContain('2');
    expect(textOf(renderer)).toContain('A');
    const tables = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Table, 2 rows, 2 columns'),
    );
    expect(tables.length).toBeGreaterThan(0);
    expect(tables[0].props.accessibilityLabel).toContain('Header: A, B');
    expect(tables[0].props.accessibilityLabel).toContain('Row 1: 1, 2');
  });

  test('renders inline formatting inside cells', () => {
    const renderer = render('| a | b |\n| - | - |\n| **bold** | \\| x |');
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('bold');
    expect(json).not.toContain('**bold**');
  });

  test('falls back to a verbatim block for oversized tables', () => {
    const header = '| ' + Array.from({ length: 100 }, (_, i) => 'c' + i).join(' | ') + ' |';
    const delimiter = '| ' + Array.from({ length: 100 }, () => '---').join(' | ') + ' |';
    const rows: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      rows.push('| ' + Array.from({ length: 100 }, (_, j) => 'r' + j).join(' | ') + ' |');
    }
    const renderer = render([header, delimiter, ...rows].join('\n'));
    const fallbacks = renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Markdown source block',
    );
    expect(fallbacks.length).toBeGreaterThan(0);
  });
});

describe('MarkdownText math', () => {
  test('renders block math glyphs and a math accessibility label', () => {
    const renderer = render(
      DOLLAR + DOLLAR + '\n' + BS + 'frac{1}{2} + ' + BS + 'sqrt{x}\n' + DOLLAR + DOLLAR,
    );
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('1');
    expect(json).toContain('2');
    expect(json).toContain('√');
    expect(json).toContain('x');
    const labels = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.startsWith('Math:'),
    );
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0].props.accessibilityLabel).toContain(BS + 'frac{1}{2}');
  });

  test('renders inline math as Unicode where possible', () => {
    const renderer = render('Price ' + DOLLAR + 'x^2' + DOLLAR + ' now');
    expect(textOf(renderer)).toContain('x²');
  });

  test('renders unsupported inline math as verbatim monospace source', () => {
    const renderer = render('see ' + DOLLAR + BS + 'unknowncmd' + DOLLAR + ' here');
    expect(textOf(renderer)).toContain(BS + 'unknowncmd');
  });

  test('fails unclosed block math closed to a verbatim block', () => {
    const renderer = render(
      DOLLAR + DOLLAR + '\n' + BS + 'unknown{',
    );
    const fallbacks = renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Markdown source block',
    );
    expect(fallbacks.length).toBeGreaterThan(0);
  });

  test('a 1 MB math block falls back without hanging', () => {
    const started = Date.now();
    const renderer = render(
      DOLLAR + DOLLAR + '\n' + 'a'.repeat(1024 * 1024) + '\n' + DOLLAR + DOLLAR,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    const fallbacks = renderer.root.findAll(
      node => node.props.accessibilityLabel === 'Markdown source block',
    );
    expect(fallbacks.length).toBeGreaterThan(0);
  });
});

describe('MarkdownText images', () => {
  test('shows a placeholder for remote images and loads only on tap', () => {
    const renderer = render('![cat](https://example.com/c.png)');
    const placeholder = renderer.root.findByProps({
      accessibilityLabel: 'Load image: cat (example.com)',
    });
    expect(placeholder).toBeDefined();
    expect(renderer.root.findAllByType(Image).length).toBe(0);

    act(() => {
      placeholder.props.onPress();
    });
    const images = renderer.root.findAllByType(Image);
    expect(images.length).toBe(1);
    expect(images[0].props.source).toEqual({
      uri: 'https://example.com/c.png',
    });
  });

  test('renders bounded data URIs directly without a tap', () => {
    const renderer = render('![d](data:image/png;base64,AAAA)');
    const images = renderer.root.findAllByType(Image);
    expect(images.length).toBe(1);
    expect(images[0].props.source).toEqual({
      uri: 'data:image/png;base64,AAAA',
    });
  });

  test('blocks javascript: scheme images without any button', () => {
    const renderer = render('![x](javascript:evil)');
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('scheme not allowed');
    expect(json).not.toContain('javascript:evil');
    expect(
      renderer.root.findAllByProps({ accessibilityRole: 'button' }).length,
    ).toBe(0);
  });

  test('keeps paren-bearing javascript URLs as literal text', () => {
    const renderer = render('![x](javascript:alert(1))');
    expect(textOf(renderer)).toContain('javascript:alert(1)');
    expect(renderer.root.findAllByType(Image).length).toBe(0);
  });

  test('reuses attachment thumbnails for attachment:// references', () => {
    const attachments: readonly AttachmentDescriptor[] = [
      {
        schema_version: 1,
        id: 'abc-123',
        kind: 'image',
        name: 'photo.png',
        mime_type: 'image/png',
        size: 10,
        thumbnail_data_url: 'data:image/png;base64,BBBB',
      },
    ];
    const renderer = render('![pic](attachment://abc-123)', attachments);
    const images = renderer.root.findAllByType(Image);
    expect(images.length).toBe(1);
    expect(images[0].props.source).toEqual({
      uri: 'data:image/png;base64,BBBB',
    });
  });

  test('shows an attachment chip when the id is unknown', () => {
    const renderer = render('![pic](attachment://missing-1)');
    expect(textOf(renderer)).toContain('attachment: missing-1');
    expect(renderer.root.findAllByType(Image).length).toBe(0);
  });
});

describe('MarkdownText regression surface', () => {
  test('keeps headings, bullets, quotes, inline code, and fenced code', () => {
    const renderer = render(
      '# Result\n- local file\n> verified\nUse ' + BACKTICK + 'rish' + BACKTICK + '.\n' +
        BACKTICK + BACKTICK + BACKTICK + 'sh\nsha256sum note.md\n' + BACKTICK + BACKTICK + BACKTICK,
    );
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Result');
    expect(json).toContain('local file');
    expect(json).toContain('verified');
    expect(json).toContain('rish');
    expect(json).toContain('SH');
    expect(json).toContain('sha256sum note.md');
  });

  test('renders a full conversation fragment with table, math, and image', () => {
    const markdown = [
      'Here is a table:',
      '',
      '| Metric | Value |',
      '| --- | ---: |',
      '| latency | **42ms** |',
      '',
      'Block math:',
      '',
      DOLLAR + DOLLAR,
      BS + 'sum_{i=1}^{n} i = ' + BS + 'frac{n(n+1)}{2}',
      DOLLAR + DOLLAR,
      '',
      'Inline ' + DOLLAR + 'x^2' + DOLLAR + ' and an image:',
      '',
      '![plot](https://example.com/plot.png)',
    ].join('\n');
    const renderer = render(markdown);
    const json = JSON.stringify(renderer.toJSON());
    expect(json).toContain('Metric');
    expect(json).toContain('42ms');
    expect(json).toContain('∑');
    expect(textOf(renderer)).toContain('x²');
    const imageButtons = renderer.root.findAll(
      node =>
        node.props.accessibilityLabel === 'Load image: plot (example.com)' &&
        node.props.accessibilityRole === 'button' &&
        typeof node.props.onPress === 'function',
    );
    expect(imageButtons.length).toBe(1);
    const tables = renderer.root.findAll(
      node =>
        typeof node.props.accessibilityLabel === 'string' &&
        node.props.accessibilityLabel.includes('Table, 2 rows, 2 columns'),
    );
    expect(tables.length).toBeGreaterThan(0);
  });
});
