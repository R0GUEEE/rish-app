import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import { MarkdownText } from '../src/components/MarkdownText';

test('renders headings, bullets, quotes, inline code, and fenced code', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <MarkdownText
        markdown={
          '# Result\n- local file\n> verified\nUse `rish`.\n```sh\nsha256sum note.md\n```'
        }
      />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const output = JSON.stringify(renderer.toJSON());
  expect(output).toContain('Result');
  expect(output).toContain('local file');
  expect(output).toContain('verified');
  expect(output).toContain('rish');
  expect(output).toContain('SH');
  expect(output).toContain('sha256sum note.md');
});

function collectTextAndWeights(
  renderer: ReactTestRenderer.ReactTestRenderer,
): { text: string; weights: Set<string> } {
  let text = '';
  const weights = new Set<string>();
  const walk = (node: ReactTestRenderer.ReactTestInstance): void => {
    const style = node.props.style;
    if (style !== undefined && style !== null) {
      const flat = Array.isArray(style) ? style.flat(Infinity) : [style];
      for (const entry of flat as Array<Record<string, unknown>>) {
        if (entry !== null && entry !== undefined && typeof entry.fontWeight === 'string') {
          weights.add(entry.fontWeight);
        }
      }
    }
    for (const child of node.children) {
      if (typeof child === 'string') text += child;
      else walk(child);
    }
  };
  walk(renderer.root);
  return { text, weights };
}

test('renders bold spans with heavy weight and no asterisks', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <MarkdownText markdown="**1. write_file** — done" />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const { text, weights } = collectTextAndWeights(renderer);
  expect(text).toContain('1. write_file — done');
  expect(text).not.toContain('**');
  expect(weights.has('700')).toBe(true);
});

test('keeps unpaired asterisks verbatim', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(<MarkdownText markdown="a ** b ** c" />);
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const { text } = collectTextAndWeights(renderer);
  expect(text).toContain('a ** b ** c');
});

test('renders bold and inline code in the same line', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <MarkdownText markdown="run `git_status` with **care**" />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const { text, weights } = collectTextAndWeights(renderer);
  expect(text).toContain('care');
  expect(weights.has('700')).toBe(true);
});

test('renders bold inside bullet rows', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <MarkdownText markdown="- **keep** this" />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const { text, weights } = collectTextAndWeights(renderer);
  expect(text).toContain('keep this');
  expect(weights.has('700')).toBe(true);
});

test('renders bold wrapping inline code (cross-token pairing)', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <MarkdownText markdown="**1. `write_file`** — Created `NOTES.md`" />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const { text, weights } = collectTextAndWeights(renderer);
  expect(text).not.toContain('**');
  expect(text).toContain('1. ');
  expect(text).toContain('write_file');
  expect(text).toContain('— Created');
  expect(text).toContain('NOTES.md');
  expect(weights.has('700')).toBe(true);
});
