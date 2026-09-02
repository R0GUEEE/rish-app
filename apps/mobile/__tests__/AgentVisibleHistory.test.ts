import {
  buildAgentVisibleHistory,
  projectAgentVisibleHistory,
} from '../src/agent/AgentVisibleHistory';

const T0 = '2026-08-31T00:00:00.000Z';
const ATTACHMENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
  attachments: readonly Record<string, unknown>[] = [],
): Record<string, unknown> {
  return {
    id,
    role,
    text,
    createdAt: T0,
    attachments,
  };
}

const noteAttachment = {
  schema_version: 1,
  id: ATTACHMENT_ID,
  kind: 'text' as const,
  name: 'notes.txt',
  mime_type: 'text/plain',
  size: 5,
  thumbnail_data_url: 'ignored-by-projection',
};

function conversation() {
  return {
    messages: [
      message('message-1', 'user', 'hello'),
      message('message-2', 'assistant', 'world'),
      message('message-3', 'user', 'notes', [noteAttachment]),
    ],
  };
}

describe('AgentVisibleHistory', () => {
  test('projects frozen IDs in order, strips non-wire attachment fields, and returns the fixed HJ digest', () => {
    const result = projectAgentVisibleHistory(conversation(), {
      visibleMessageIds: ['message-1', 'message-2', 'message-3'],
    });
    expect(result).toEqual({
      history: [
        { role: 'user', content: 'hello', attachments: [] },
        { role: 'assistant', content: 'world', attachments: [] },
        {
          role: 'user',
          content: 'notes',
          attachments: [
            {
              schema_version: 1,
              id: ATTACHMENT_ID,
              kind: 'text',
              name: 'notes.txt',
              mime_type: 'text/plain',
              size: 5,
            },
          ],
        },
      ],
      digest: 'e37f828d8f7bc4ead9ddba93aad21d78792bb67fbed2774d164458c9083ad41a',
      count: 3,
    });
    expect(result).not.toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result!.history)).toBe(true);
    expect(Object.isFrozen(result!.history[2]!.attachments)).toBe(true);
    expect(Object.isFrozen(result!.history[2]!.attachments[0])).toBe(true);
  });

  test('uses attempt order as the digest input and does not alias source values', () => {
    const source = conversation();
    const result = buildAgentVisibleHistory(source, {
      visibleMessageIds: ['message-3', 'message-1'],
    });
    expect(result?.history.map(item => item.content)).toEqual(['notes', 'hello']);
    expect(result?.count).toBe(2);
    expect(result?.digest).not.toBe(
      'e37f828d8f7bc4ead9ddba93aad21d78792bb67fbed2774d164458c9083ad41a',
    );
    (source.messages[0] as Record<string, unknown>).text = 'mutated';
    expect(result?.history[1]?.content).toBe('hello');
  });

  test.each([
    ['missing ID', ['message-1', 'missing']],
    ['duplicate ID', ['message-1', 'message-1']],
    ['empty visible history', []],
  ])('rejects %s', (_label, visibleMessageIds) => {
    expect(
      projectAgentVisibleHistory(conversation(), { visibleMessageIds }),
    ).toBeNull();
  });

  test('rejects duplicate source message and attachment IDs', () => {
    const duplicateMessage = conversation();
    duplicateMessage.messages.push(message('message-1', 'user', 'again'));
    expect(
      projectAgentVisibleHistory(duplicateMessage, {
        visibleMessageIds: ['message-1'],
      }),
    ).toBeNull();

    const duplicateAttachment = conversation();
    duplicateAttachment.messages.push(
      message('message-4', 'user', 'again', [noteAttachment]),
    );
    expect(
      projectAgentVisibleHistory(duplicateAttachment, {
        visibleMessageIds: ['message-1'],
      }),
    ).toBeNull();
  });

  test('rejects accessors, sparse/extended arrays, invalid timestamps, and raw message fields', () => {
    const hostile = conversation();
    let getterCalled = false;
    Object.defineProperty(hostile.messages[0], 'text', {
      enumerable: true,
      get: () => {
        getterCalled = true;
        throw new Error('must not read getter');
      },
    });
    expect(
      projectAgentVisibleHistory(hostile, { visibleMessageIds: ['message-1'] }),
    ).toBeNull();
    expect(getterCalled).toBe(false);

    const extended = conversation();
    (extended.messages as unknown[] & { extra?: string }).extra = 'raw';
    expect(
      projectAgentVisibleHistory(extended, {
        visibleMessageIds: ['message-1'],
      }),
    ).toBeNull();

    const invalidTimestamp = conversation();
    (invalidTimestamp.messages[0] as Record<string, unknown>).createdAt = 'yesterday';
    expect(
      projectAgentVisibleHistory(invalidTimestamp, {
        visibleMessageIds: ['message-1'],
      }),
    ).toBeNull();

    const rawField = conversation();
    (rawField.messages[0] as Record<string, unknown>).raw_content = 'secret';
    expect(
      projectAgentVisibleHistory(rawField, { visibleMessageIds: ['message-1'] }),
    ).toBeNull();
  });
});
