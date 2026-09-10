/* eslint-disable no-script-url -- unsafe target regression */
import React from 'react';
import { Alert, Linking, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { MarkdownText } from '../src/components/MarkdownText';
import {
  flattenInlineTokens,
  isSafeLinkTarget,
  tokenizeInline,
  tokenizePlainLinks,
} from '../src/markdown/inline';

afterEach(() => jest.restoreAllMocks());
async function renderLink(markdown: string) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(<MarkdownText markdown={markdown} />);
  });
  return renderer.root
    .findAllByType(Text)
    .find(node => node.props.accessibilityRole === 'link')!;
}
test('only explicit press opens a bold local URL', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const link = await renderLink('Real URL: **http://127.0.0.1:65016/**');
  expect(open).not.toHaveBeenCalled();
  await act(async () => {
    link.props.onPress();
  });
  expect(open).toHaveBeenCalledWith('http://127.0.0.1:65016/');
});
test('failed native opening produces a visible alert', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('unavailable'));
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const link = await renderLink('[docs](https://example.com)');
  await act(async () => {
    link.props.onPress();
  });
  expect(alert).toHaveBeenCalledWith(
    'Unable to open link',
    'Please check the address and try again.',
  );
});
test('plain user messages keep punctuation and code literal', () => {
  const input = '**visit** https://example.com, `https://code.example`';
  const tokens = tokenizePlainLinks(input);
  expect(flattenInlineTokens(tokens)).toBe(input);
  expect(tokens.filter(token => token.type === 'link')).toEqual([
    {
      type: 'link',
      label: 'https://example.com',
      target: 'https://example.com',
    },
  ]);
});
test('punctuation, balanced parentheses, autolinks and nested strong labels', () => {
  const tokens = tokenizeInline(
    '(https://example.com/a(b)). <https://example.com?q=1> [**docs**](https://example.com/a(b))',
  );
  expect(
    tokens.filter(token => token.type === 'link').map(token => token.target),
  ).toEqual([
    'https://example.com/a(b)',
    'https://example.com?q=1',
    'https://example.com/a(b)',
  ]);
  expect(tokens[tokens.length - 1]).toMatchObject({
    children: [{ type: 'strong', children: [{ type: 'text', value: 'docs' }] }],
  });
});
test('code and unsafe schemes are not actionable', () => {
  expect(
    tokenizeInline(
      '`https://example.com` [bad](javascript:evil) [bad](file:///tmp/x)',
    ).some(token => token.type === 'link'),
  ).toBe(false);
});
test.each([
  'javascript:alert(1)',
  'file:///tmp/a',
  'data:text/html,x',
  'https://',
  'https://u:p@example.com',
  'http://example.com\\evil',
])('rejects unsafe target %s', target => {
  expect(isSafeLinkTarget(target)).toBe(false);
});
test('preserves explicit mail links', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const link = await renderLink('[email](mailto:hello@example.com)');
  await act(async () => {
    link.props.onPress();
  });
  expect(open).toHaveBeenCalledWith('mailto:hello@example.com');
});
