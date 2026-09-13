import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';

import {
  StructuredContent,
  type StructuredBlock,
} from '../src/components/StructuredContent';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import { createPreferencesStore } from '../src/preferences';

const blocks: StructuredBlock[] = [
  {
    id: 'reasoning',
    type: 'reasoning',
    text: 'Inspect the local workspace first.',
    durationMs: 1250,
  },
  {
    id: 'call',
    type: 'tool-call',
    name: 'workspace.read',
    arguments: '{"path":"notes.md"}',
    status: 'success',
  },
  {
    id: 'result',
    type: 'tool-result',
    name: 'workspace.read',
    output: 'hello from mobile',
    durationMs: 18,
  },
  { id: 'text', type: 'text', text: 'The file contains a mobile note.' },
];

test('keeps reasoning and tools collapsed until requested', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(<StructuredContent blocks={blocks} />);
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const root = renderer.root;

  expect(
    root.findAllByProps({ children: 'Inspect the local workspace first.' }),
  ).toHaveLength(0);
  expect(root.findAllByProps({ children: '{"path":"notes.md"}' })).toHaveLength(
    0,
  );
  expect(JSON.stringify(renderer.toJSON())).toContain(
    'The file contains a mobile note.',
  );

  await act(async () => {
    root.findByProps({ accessibilityLabel: 'Show reasoning' }).props.onPress();
    root
      .findByProps({
        accessibilityLabel: 'Expand tool call details for workspace.read',
      })
      .props.onPress();
  });

  expect(
    root.findByProps({ children: 'Inspect the local workspace first.' }),
  ).toBeDefined();
  expect(root.findByProps({ children: '{"path":"notes.md"}' })).toBeDefined();
  expect(
    root.findByProps({ accessibilityLabel: 'Hide reasoning' }).props
      .accessibilityState,
  ).toEqual({ expanded: true });
  expect(
    root.findByProps({
      accessibilityLabel: 'Collapse tool call details for workspace.read',
    }).props.accessibilityState,
  ).toEqual({ busy: false, expanded: true });
});

test('supports hidden reasoning and automatically expanded tool results', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <StructuredContent
        autoExpandTools
        blocks={blocks}
        showReasoning={false}
      />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const root = renderer.root;

  expect(
    root.findAllByProps({ accessibilityLabel: 'Show reasoning' }),
  ).toHaveLength(0);
  expect(root.findByProps({ children: 'hello from mobile' })).toBeDefined();
});

test('reacts when auto expansion changes without overriding later content updates', async () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <StructuredContent autoExpandTools={false} blocks={blocks} />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');

  expect(
    renderer.root.findAllByProps({ children: 'hello from mobile' }),
  ).toHaveLength(0);
  await act(async () => {
    renderer?.update(<StructuredContent autoExpandTools blocks={blocks} />);
  });
  expect(
    renderer.root.findByProps({ children: 'hello from mobile' }),
  ).toBeDefined();

  await act(async () => {
    renderer?.root
      .findByProps({
        accessibilityLabel: 'Collapse tool result details for workspace.read',
      })
      .props.onPress();
    renderer?.update(
      <StructuredContent autoExpandTools blocks={[...blocks]} />,
    );
  });
  expect(
    renderer.root.findAllByProps({ children: 'hello from mobile' }),
  ).toHaveLength(0);

  await act(async () => {
    renderer?.update(
      <StructuredContent autoExpandTools={false} blocks={blocks} />,
    );
  });
  expect(
    renderer.root.findAllByProps({ children: 'hello from mobile' }),
  ).toHaveLength(0);
});

test('localizes status and empty output through the presentation locale', async () => {
  const store = createPreferencesStore();
  store.setLocale('zh-CN');
  const localizedBlocks: StructuredBlock[] = [
    { id: 'thinking', type: 'reasoning', text: '检查工作区', durationMs: 2400 },
    {
      id: 'pending',
      type: 'tool-call',
      name: 'workspace.read',
      arguments: '{}',
      status: 'pending',
    },
    {
      id: 'empty',
      type: 'tool-result',
      name: 'workspace.read',
      output: '',
      durationMs: 18,
    },
  ];
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AppPresentationProvider store={store}>
        <StructuredContent autoExpandTools blocks={localizedBlocks} />
      </AppPresentationProvider>,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const root = renderer.root;

  expect(
    root.findByProps({ children: '思考了 2.4 秒' }).props.accessibilityRole,
  ).toBe('status');
  expect(
    root.findByProps({ children: '等待中' }).props.accessibilityLabel,
  ).toBe('workspace.read 正在等待');
  expect(
    root.findByProps({ children: '18 毫秒' }).props.accessibilityLabel,
  ).toBe('workspace.read 已完成');
  expect(root.findByProps({ children: '（无输出）' })).toBeDefined();
  expect(
    root.findByProps({
      accessibilityLabel: '收起 workspace.read 的工具结果详情',
    }).props.accessibilityState,
  ).toEqual({ busy: false, expanded: true });
});

test('renders failed tool results as assertive errors without a success icon', async () => {
  const failed: StructuredBlock[] = [
    {
      id: 'failed-result',
      type: 'tool-result',
      name: 'workspace.write',
      output: 'permission denied',
      isError: true,
    },
  ];
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <StructuredContent autoExpandTools blocks={failed} />,
    );
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const root = renderer.root;
  const alert = root.findByProps({ accessibilityRole: 'alert' });

  expect(alert.props.accessibilityLabel).toBe('workspace.write failed');
  expect(alert.props.accessibilityLiveRegion).toBe('assertive');
  expect(root.findByProps({ testID: 'tool-status-error' })).toBeDefined();
  expect(root.findAllByProps({ testID: 'tool-status-success' })).toHaveLength(
    0,
  );
  expect(root.findByProps({ children: 'permission denied' })).toBeDefined();
});

test('announces running tool calls as busy status updates', async () => {
  const running: StructuredBlock[] = [
    {
      id: 'running-call',
      type: 'tool-call',
      name: 'sha256sum',
      arguments: '{"path":"notes.md"}',
      status: 'running',
    },
  ];
  let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(<StructuredContent blocks={running} />);
  });
  if (renderer === undefined) throw new Error('renderer missing');
  const status = renderer.root.findByProps({ accessibilityRole: 'status' });
  const button = renderer.root.findByProps({
    accessibilityLabel: 'Expand tool call details for sha256sum',
  });

  expect(status.props.accessibilityLabel).toBe('Running sha256sum…');
  expect(status.props.accessibilityLiveRegion).toBe('polite');
  expect(button.props.accessibilityState).toEqual({
    busy: true,
    expanded: false,
  });
});

test('an activity line spins with its label and provisional text is revealed progressively', async () => {
  jest.useFakeTimers();
  try {
    let renderer: ReactTestRenderer.ReactTestRenderer | undefined;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <StructuredContent
          blocks={[
            { id: 'activity', type: 'activity', label: 'Thinking' },
            { id: 'live', type: 'text', text: 'abcdefghijklmnop', reveal: true },
            { id: 'final', type: 'text', text: 'Durable text renders whole.' },
          ]}
        />,
      );
    });
    if (renderer === undefined) throw new Error('renderer missing');
    const root = renderer.root;
    expect(root.findByProps({ testID: 'activity-block' }).props.accessibilityLabel).toBe('Thinking');
    expect(root.findAllByProps({ testID: 'activity-spinner' }).length).toBeGreaterThan(0);
    const rendered = () => JSON.stringify(renderer!.toJSON());
    expect(rendered()).toContain('Durable text renders whole.');
    expect(rendered()).not.toContain('abcdefghijklmnop');
    await act(async () => {
      jest.advanceTimersByTime(45);
    });
    expect(rendered()).toContain('abcdef');
    expect(rendered()).not.toContain('abcdefghijklmnop');
    // Each step schedules the next from an effect, so advance tick by tick.
    for (let step = 0; step < 12; step += 1) {
      await act(async () => {
        jest.advanceTimersByTime(40);
      });
    }
    expect(rendered()).toContain('abcdefghijklmnop');
  } finally {
    jest.useRealTimers();
  }
});
