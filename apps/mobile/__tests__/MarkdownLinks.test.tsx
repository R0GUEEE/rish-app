/* eslint-disable no-script-url -- unsafe target regression */
import React from 'react';
import { Alert, Linking, NativeModules, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { MarkdownText } from '../src/components/MarkdownText';
import {
  flattenInlineTokens,
  isSafeLinkTarget,
  tokenizeInline,
  tokenizePlainLinks,
} from '../src/markdown/inline';

const originalRuntime = NativeModules.LocalRuntime;
beforeEach(() => {
  jest.clearAllMocks();
  NativeModules.LocalRuntime = undefined;
});
afterEach(() => {
  NativeModules.LocalRuntime = originalRuntime;
  jest.restoreAllMocks();
});
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
test.each([
  'http://localhost:8000/index.html',
  'http://127.0.0.1:65016/index.html?mode=preview#checklist',
  'https://example.com/a-long-path/page.html',
])('opens the complete web URL %s inside the iOS app only when pressed', async target => {
  const open = jest.fn().mockResolvedValue({ schema_version: 1, status: 'opened' });
  NativeModules.LocalRuntime = { openConversationURL: open };
  const external = jest.spyOn(Linking, 'openURL');
  const link = await renderLink('[打开页面](' + target + ')');
  expect(link).toBeDefined();
  expect(open).not.toHaveBeenCalled();
  await act(async () => { await link.props.onPress(); });
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith({ schema_version: 1, url: target });
  expect(external).not.toHaveBeenCalled();
});
test.each([
  '`http://localhost:8000/index.html`',
  '`https://example.com`',
  '`curl https://example.com`',
  '`javascript:alert(1)`',
  '`file:///tmp/index.html`',
  '`https://user:password@example.com`',
  '```sh\nhttps://example.com\n```',
])('keeps inline code and fenced code noninteractive: %s', async markdown => {
  expect(await renderLink(markdown)).toBeUndefined();
});
test('reports an in-app browser presentation failure without silently opening another app', async () => {
  NativeModules.LocalRuntime = { openConversationURL: jest.fn().mockRejectedValue(new Error('busy')) };
  const external = jest.spyOn(Linking, 'openURL');
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const link = await renderLink('[preview](http://localhost:8000/index.html)');
  await act(async () => { await link.props.onPress(); });
  expect(external).not.toHaveBeenCalled();
  expect(alert).toHaveBeenCalledWith('Unable to open link', 'Please check the address and try again.');
});
test('an explicit link owns a nested code label without a second URL action', async () => {
  const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined);
  const link = await renderLink('[**`https://label.example`**](https://destination.example)');
  const actions = link.findAllByType(Text).filter(node => node.props.onPress !== undefined);
  expect(actions).toHaveLength(1);
  await act(async () => { await link.props.onPress(); });
  expect(open).toHaveBeenCalledWith('https://destination.example');
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
test('code retains literal tokens and unsafe schemes are not parsed as links', () => {
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
