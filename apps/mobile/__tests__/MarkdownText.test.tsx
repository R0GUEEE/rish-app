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
