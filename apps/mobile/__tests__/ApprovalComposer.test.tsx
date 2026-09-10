import React from 'react';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { ApprovalComposer } from '../src/components/ApprovalComposer';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import type { ApprovalRequestSpec } from '../src/agent/AgentApprovals';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function presentation(children: React.ReactNode) {
  const store = createPreferencesStore({
    initialPreferences: {
      ...createDefaultPreferences(),
      locale: 'en-US',
    },
  });
  return (
    <AppPresentationProvider store={store}>{children}</AppPresentationProvider>
  );
}

const request: ApprovalRequestSpec = {
  approvalId: 'ap-1',
  toolCallId: 'c1',
  toolName: 'write_file',
  argumentsJson: '{"path":"notes.md","content":"hi"}',
  preview: {
    schema_version: 1,
    kind: 'write_file',
    paths: ['notes.md'],
    content_bytes: 12,
    prior: { schema_version: 1, kind: 'absent', bytes: null },
    diff_preview: '@@ -1,0 +1,1 @@\n+hello',
    diff_truncated: false,
  },
  scopes: ['once', 'conversation'],
  expiresAtMs: Date.now() + 120_000,
};

const secondRequest: ApprovalRequestSpec = {
  ...request,
  approvalId: 'ap-2',
  toolCallId: 'c2',
  toolName: 'git_commit',
  preview: {
    schema_version: 1,
    kind: 'git_commit',
    paths: [],
    content_bytes: null,
    prior: null,
    diff_preview: null,
    diff_truncated: false,
  },
};

function byTestId(root: ReactTestInstance, testID: string) {
  const node = root.findByProps({ testID });
  if (node === undefined) throw new Error('missing ' + testID);
  return node;
}

async function renderComposer(
  requests: readonly ApprovalRequestSpec[] = [request],
): Promise<{
  renderer: Renderer;
  onDecide: jest.Mock;
}> {
  const onDecide = jest.fn();
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      presentation(
        <ApprovalComposer requests={requests} onDecide={onDecide} />,
      ),
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return { renderer, onDecide };
}

test('shows the tool call, the preview, the offered scopes, and allow/deny actions', async () => {
  const { renderer } = await renderComposer();
  const root = renderer.root;
  expect(root.findByProps({ testID: 'approval-composer-card' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-scope-once' })).toBeDefined();
  expect(
    root.findByProps({ testID: 'approval-scope-conversation' }),
  ).toBeDefined();
  expect(root.findByProps({ testID: 'approval-allow' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-deny' })).toBeDefined();
  // The gated tool and its native-computed preview are visible.
  expect(
    root.findAllByProps({ children: 'write_file' }).length,
  ).toBeGreaterThan(0);
  expect(
    root.findByProps({ testID: 'approval-preview-path' }).props.children,
  ).toBe('notes.md');
  expect(root.findByProps({ testID: 'approval-diff' })).toBeDefined();
});

test('allow submits the selected scope (once by default)', async () => {
  const { renderer, onDecide } = await renderComposer();
  const allow = byTestId(renderer.root, 'approval-allow');
  await act(async () => {
    allow.props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith([
    { approvalId: 'ap-1', decision: { status: 'approved', scope: 'once' } },
  ]);
});

test('allow submits the conversation scope after selection', async () => {
  const { renderer, onDecide } = await renderComposer();
  const conversation = byTestId(renderer.root, 'approval-scope-conversation');
  await act(async () => {
    conversation.props.onPress();
  });
  const allow = byTestId(renderer.root, 'approval-allow');
  await act(async () => {
    allow.props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith([
    {
      approvalId: 'ap-1',
      decision: { status: 'approved', scope: 'conversation' },
    },
  ]);
});

test('deny submits a denial and modal dismissal denies too', async () => {
  const { renderer, onDecide } = await renderComposer();
  const deny = byTestId(renderer.root, 'approval-deny');
  await act(async () => {
    deny.props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith([
    { approvalId: 'ap-1', decision: { status: 'denied' } },
  ]);
  const modal = byTestId(renderer.root, 'approval-composer-modal');
  await act(async () => {
    modal.props.onRequestClose();
  });
  expect(onDecide).toHaveBeenCalledTimes(2);
  expect(onDecide).toHaveBeenLastCalledWith([
    { approvalId: 'ap-1', decision: { status: 'denied' } },
  ]);
});

test('a deny message is carried into the denial', async () => {
  const { renderer, onDecide } = await renderComposer();
  const input = byTestId(renderer.root, 'approval-deny-message');
  await act(async () => {
    input.props.onChangeText('do not touch prod.txt');
  });
  const deny = byTestId(renderer.root, 'approval-deny');
  await act(async () => {
    deny.props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith([
    {
      approvalId: 'ap-1',
      decision: { status: 'denied', message: 'do not touch prod.txt' },
    },
  ]);
});

test('a batch presents every call with per-item decisions and one commit', async () => {
  const { renderer, onDecide } = await renderComposer([request, secondRequest]);
  const root = renderer.root;
  expect(root.findByProps({ testID: 'approval-batch-list' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-batch-item-0' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-batch-item-1' })).toBeDefined();
  expect(root.findByProps({ testID: 'approval-batch-footer' })).toBeDefined();
  // Per-item decisions: allow the first, deny the second with a message.
  await act(async () => {
    byTestId(root, 'approval-item-0-once').props.onPress();
  });
  await act(async () => {
    byTestId(root, 'approval-item-1-deny').props.onPress();
  });
  await act(async () => {
    byTestId(root, 'approval-item-1-deny-message').props.onChangeText(
      'no commits right now',
    );
  });
  await act(async () => {
    byTestId(root, 'approval-batch-commit').props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith([
    { approvalId: 'ap-1', decision: { status: 'approved', scope: 'once' } },
    {
      approvalId: 'ap-2',
      decision: { status: 'denied', message: 'no commits right now' },
    },
  ]);
});

test('batch items default to denial until explicitly approved', async () => {
  const { renderer, onDecide } = await renderComposer([request, secondRequest]);
  const root = renderer.root;
  await act(async () => {
    byTestId(root, 'approval-batch-commit').props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith([
    { approvalId: 'ap-1', decision: { status: 'denied' } },
    { approvalId: 'ap-2', decision: { status: 'denied' } },
  ]);
});

test('batch approve all sends one once decision for every visible request', async () => {
  const { renderer, onDecide } = await renderComposer([request, secondRequest]);
  await act(async () => {
    byTestId(renderer.root, 'approval-batch-approve-all-once').props.onPress();
  });
  expect(onDecide).toHaveBeenCalledWith([
    { approvalId: request.approvalId, decision: { status: 'approved', scope: 'once' } },
    { approvalId: secondRequest.approvalId, decision: { status: 'approved', scope: 'once' } },
  ]);
});

test('batch approve all ignores a stale callback after the request key changes', async () => {
  const { renderer, onDecide } = await renderComposer([request, secondRequest]);
  const staleApproveAll = byTestId(renderer.root, 'approval-batch-approve-all-once').props.onPress;
  await act(async () => {
    renderer.update(
      presentation(
        <ApprovalComposer requests={[secondRequest, request]} onDecide={onDecide} />,
      ),
    );
  });
  await act(async () => staleApproveAll());
  expect(onDecide).not.toHaveBeenCalled();
});

test('a new-file write says it creates the file even though its prior is present', async () => {
  // Native previews a new file as prior {kind: 'absent', bytes: null}; only a
  // known prior replaces an existing file.
  const { renderer } = await renderComposer();
  const meta = byTestId(renderer.root, 'approval-preview-bytes');
  const text = ([] as unknown[]).concat(meta.props.children).join('');
  expect(text).toContain('Creates a new file');
  expect(text).not.toContain('Replaces existing file');
});

test('an absent-prior write with no diff preview shows the new-file text, not binary', async () => {
  // Native sends diff_preview null for a new plain-text file; that must not
  // be labelled binary.
  const newFile: ApprovalRequestSpec = {
    ...request,
    approvalId: 'ap-4',
    toolCallId: 'c4',
    preview: {
      schema_version: 1,
      kind: 'write_file',
      paths: ['notes.md'],
      content_bytes: 12,
      prior: { schema_version: 1, kind: 'absent', bytes: null },
      diff_preview: null,
      diff_truncated: false,
    },
  };
  const { renderer } = await renderComposer([newFile]);
  const root = renderer.root;
  const diff = byTestId(root, 'approval-diff-new-file');
  const text = ([] as unknown[]).concat(diff.props.children).join('');
  expect(text).toContain('New file: no diff to show');
  expect(root.findAllByProps({ testID: 'approval-diff-binary' })).toHaveLength(
    0,
  );
  expect(
    root.findAllByProps({ children: 'Binary content: no text preview' }),
  ).toHaveLength(0);
});

test('a known prior with no diff preview still shows the binary text', async () => {
  const binary: ApprovalRequestSpec = {
    ...request,
    approvalId: 'ap-5',
    toolCallId: 'c5',
    preview: {
      schema_version: 1,
      kind: 'write_file',
      paths: ['logo.png'],
      content_bytes: 512,
      prior: { schema_version: 1, kind: 'known', bytes: 512 },
      diff_preview: null,
      diff_truncated: false,
    },
  };
  const { renderer } = await renderComposer([binary]);
  const binaryText = byTestId(renderer.root, 'approval-diff-binary');
  const text = ([] as unknown[]).concat(binaryText.props.children).join('');
  expect(text).toContain('Binary content');
  expect(text).not.toContain('New file');
});

test('listing the workspace root names the root rather than an empty path', async () => {
  const rootListing: ApprovalRequestSpec = {
    ...request,
    approvalId: 'ap-3',
    toolCallId: 'c3',
    toolName: 'list_dir',
    argumentsJson: '{"path":""}',
    preview: {
      schema_version: 1,
      kind: 'list_dir',
      paths: [],
      content_bytes: null,
      prior: null,
      diff_preview: null,
      diff_truncated: false,
    },
  };
  const { renderer } = await renderComposer([rootListing]);
  expect(byTestId(renderer.root, 'approval-preview-path').props.children).toBe(
    'Workspace root',
  );
});

test('single Chinese overflow is preserved and cannot submit, including a queued old button', async () => {
  const { renderer, onDecide } = await renderComposer();
  const oldDeny = byTestId(renderer.root, 'approval-deny').props.onPress;
  const message = '拒'.repeat(667);
  await act(async () => {
    byTestId(renderer.root, 'approval-deny-message').props.onChangeText(
      message,
    );
    oldDeny();
  });
  expect(byTestId(renderer.root, 'approval-deny-message').props.value).toBe(
    message,
  );
  expect(
    byTestId(renderer.root, 'approval-deny-message').props.maxLength,
  ).toBeUndefined();
  expect(byTestId(renderer.root, 'approval-deny').props.disabled).toBe(true);
  expect(
    renderer.root.findByProps({ children: '2001/2000 UTF-8 bytes' }),
  ).toBeDefined();
  expect(onDecide).not.toHaveBeenCalled();
  const valid = '拒'.repeat(666) + 'ab';
  await act(async () =>
    byTestId(renderer.root, 'approval-deny-message').props.onChangeText(valid),
  );
  await act(async () =>
    byTestId(renderer.root, 'approval-deny').props.onPress(),
  );
  expect(onDecide).toHaveBeenCalledWith([
    {
      approvalId: request.approvalId,
      decision: { status: 'denied', message: valid },
    },
  ]);
});

test('batch overflow blocks the entire submission without clipping the draft', async () => {
  const { renderer, onDecide } = await renderComposer([request, secondRequest]);
  const oldCommit = byTestId(renderer.root, 'approval-batch-commit').props
    .onPress;
  await act(async () =>
    byTestId(renderer.root, 'approval-item-0-once').props.onPress(),
  );
  const message = '😀'.repeat(501);
  await act(async () => {
    byTestId(renderer.root, 'approval-item-1-deny-message').props.onChangeText(
      message,
    );
    oldCommit();
  });
  expect(
    byTestId(renderer.root, 'approval-item-1-deny-message').props.value,
  ).toBe(message);
  expect(byTestId(renderer.root, 'approval-batch-commit').props.disabled).toBe(
    true,
  );
  expect(renderer.root.findByProps({
    children: 'Review rejection reasons for calls 2. Each must be valid UTF-8 and at most 2000 bytes.',
  })).toBeDefined();
  expect(onDecide).not.toHaveBeenCalled();
  const valid = ' 😀 '.repeat(333); // 1998 bytes, whitespace must stay exact.
  await act(async () =>
    byTestId(renderer.root, 'approval-item-1-deny-message').props.onChangeText(
      valid,
    ),
  );
  await act(async () =>
    byTestId(renderer.root, 'approval-batch-commit').props.onPress(),
  );
  expect(onDecide.mock.calls[0][0][1].decision.message).toBe(valid);
});

test('invalid Unicode displays an error and keeps the reason editable', async () => {
  const { renderer, onDecide } = await renderComposer();
  await act(async () =>
    byTestId(renderer.root, 'approval-deny-message').props.onChangeText(
      '\ud800',
    ),
  );
  expect(byTestId(renderer.root, 'approval-deny').props.disabled).toBe(true);
  expect(
    renderer.root.findByProps({
      children:
        'Reason contains an invalid Unicode character. Edit it before submitting.',
    }),
  ).toBeDefined();
  await act(async () =>
    byTestId(renderer.root, 'approval-deny').props.onPress(),
  );
  expect(onDecide).not.toHaveBeenCalled();
});

test('callbacks from a replaced single request cannot discard the new draft', async () => {
  const { renderer, onDecide } = await renderComposer();
  const oldDeny = byTestId(renderer.root, 'approval-deny').props.onPress;
  const oldClose = byTestId(renderer.root, 'approval-composer-modal').props
    .onRequestClose;
  await act(async () =>
    renderer.update(
      presentation(
        <ApprovalComposer requests={[secondRequest]} onDecide={onDecide} />,
      ),
    ),
  );
  await act(async () =>
    byTestId(renderer.root, 'approval-deny-message').props.onChangeText(
      'keep this reason',
    ),
  );
  await act(async () => {
    oldDeny();
    oldClose();
  });
  expect(onDecide).not.toHaveBeenCalled();
  expect(byTestId(renderer.root, 'approval-deny-message').props.value).toBe(
    'keep this reason',
  );
  await act(async () =>
    byTestId(renderer.root, 'approval-deny').props.onPress(),
  );
  expect(onDecide).toHaveBeenCalledWith([
    {
      approvalId: secondRequest.approvalId,
      decision: { status: 'denied', message: 'keep this reason' },
    },
  ]);
});
