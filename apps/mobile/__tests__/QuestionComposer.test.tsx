import React from 'react';
import ReactTestRenderer, {
  act,
  type ReactTestInstance,
  type ReactTestRenderer as Renderer,
} from 'react-test-renderer';

import { QuestionComposer } from '../src/components/QuestionComposer';
import { AppPresentationProvider } from '../src/presentation/AppPresentation';
import {
  createDefaultPreferences,
  createPreferencesStore,
} from '../src/preferences';
import type { QuestionSpec } from '../src/agent/AgentQuestions';

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

const optionsQuestion: QuestionSpec = {
  questionId: 'q-1',
  text: 'Which file?',
  inputMode: 'options',
  options: [
    { id: 'a', label: 'notes.md' },
    { id: 'b', label: 'todo.md' },
  ],
  required: false,
};

const freeTextQuestion: QuestionSpec = {
  questionId: 'q-2',
  text: 'What should it be called?',
  inputMode: 'free_text',
  options: [],
  required: true,
};

function byTestId(root: ReactTestInstance, testID: string) {
  const node = root.findByProps({ testID });
  if (node === undefined) throw new Error('missing ' + testID);
  return node;
}

async function renderComposer(
  question: QuestionSpec,
): Promise<{
  renderer: Renderer;
  onAnswer: jest.Mock;
  onCancel: jest.Mock;
}> {
  const onAnswer = jest.fn();
  const onCancel = jest.fn();
  let renderer: Renderer | undefined;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      presentation(
        <QuestionComposer
          question={question}
          onAnswer={onAnswer}
          onCancel={onCancel}
        />,
      ),
    );
  });
  if (renderer === undefined) throw new Error('renderer was not created');
  return { renderer, onAnswer, onCancel };
}

test('options mode requires a choice before submit', async () => {
  const { renderer, onAnswer } = await renderComposer(optionsQuestion);
  const submit = byTestId(renderer.root, 'question-submit');
  await act(async () => {
    submit.props.onPress();
  });
  expect(onAnswer).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ testID: 'question-error' })).toBeDefined();
});

test('options mode submits the selected option id', async () => {
  const { renderer, onAnswer } = await renderComposer(optionsQuestion);
  const option = byTestId(renderer.root, 'question-option-b');
  await act(async () => {
    option.props.onPress();
  });
  const submit = byTestId(renderer.root, 'question-submit');
  await act(async () => {
    submit.props.onPress();
  });
  expect(onAnswer).toHaveBeenCalledWith('q-1', 'b');
});

test('free-text mode validates and submits a trimmed answer', async () => {
  const { renderer, onAnswer } = await renderComposer(freeTextQuestion);
  const input = byTestId(renderer.root, 'question-free-text-input');
  // Empty input is rejected with a visible error.
  await act(async () => {
    input.props.onChangeText('   ');
  });
  const submit = byTestId(renderer.root, 'question-submit');
  await act(async () => {
    submit.props.onPress();
  });
  expect(onAnswer).not.toHaveBeenCalled();
  expect(renderer.root.findByProps({ testID: 'question-error' })).toBeDefined();
  // A real answer clears the error and submits.
  await act(async () => {
    input.props.onChangeText('  my notes  ');
  });
  await act(async () => {
    submit.props.onPress();
  });
  expect(onAnswer).toHaveBeenCalledWith('q-2', 'my notes');
});

test('optional questions offer cancel; required questions do not', async () => {
  const optional = await renderComposer(optionsQuestion);
  expect(
    optional.renderer.root.findByProps({ testID: 'question-cancel' }),
  ).toBeDefined();
  await act(async () => {
    byTestId(optional.renderer.root, 'question-cancel').props.onPress();
  });
  expect(optional.onCancel).toHaveBeenCalledWith('q-1');

  const required = await renderComposer(freeTextQuestion);
  expect(
    required.renderer.root.findAllByProps({ testID: 'question-cancel' }),
  ).toHaveLength(0);
  expect(required.onCancel).not.toHaveBeenCalled();
});
