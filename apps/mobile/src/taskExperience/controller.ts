import type {
  CompletionController,
  CompletionControllerOutcome,
  CompletionControllerState,
} from '../completion/CompletionController';
import { taskExperience } from './bridge';

const runs = new WeakMap<CompletionController, () => string | null>();
export async function cancelTaskExperienceRun(
  controller: CompletionController,
  runId: string,
) {
  if (runs.get(controller)?.() !== runId) return;
  await controller.cancel();
}

type Bridge = Pick<typeof taskExperience, 'call'>;
// Observe the existing durable controller. Never submit, resume or replay work
// from a notification, a saved native status, or an OS background launch.
export function withTaskExperience(
  controller: CompletionController,
  bridge: Bridge = taskExperience,
): CompletionController {
  let active: {
    runId: string;
    conversationId: string;
    lastPhase: string;
  } | null = null;
  let operation = 0;
  let pending = false;
  let serial = Promise.resolve();
  const publish = (op: string, payload: Record<string, unknown>) => {
    serial = serial
      .then(() => bridge.call(op, payload))
      .then(
        () => {},
        () => {},
      );
  };
  controller.subscribe((state: CompletionControllerState) => {
    if (!pending || !state.conversationId || !state.attemptId) return;
    if (!active) {
      active = {
        runId: `${state.attemptId}-${Date.now()}-${operation}`,
        conversationId: state.conversationId,
        lastPhase: '',
      };
      publish('begin', {
        runId: active.runId,
        conversationId: active.conversationId,
        phase: state.phase,
      });
    }
    // An idle transition can precede durable completion callback resolution.
    // Only the operation result below is allowed to announce success.
    if (state.phase !== 'idle' && active.lastPhase !== state.phase) {
      active.lastPhase = state.phase;
      publish('update', { runId: active.runId, phase: state.phase });
    }
  });
  async function run(work: () => Promise<CompletionControllerOutcome>) {
    if (pending) return work(); // Controller retains its existing admission gate.
    pending = true;
    operation += 1;
    try {
      const result = await work();
      if (active)
        publish('end', { runId: active.runId, status: result.status });
      return result;
    } catch (error) {
      if (active) publish('end', { runId: active.runId, status: 'blocked' });
      throw error;
    } finally {
      pending = false;
      active = null;
    }
  }
  const wrapped: CompletionController = {
    ...controller,
    send: (...args) => run(() => controller.send(...args)),
    retry: (...args) => run(() => controller.retry(...args)),
    resume: (...args) => run(() => controller.resume(...args)),
    abandonAndRetry: (...args) => run(() => controller.abandonAndRetry(...args)),
    retryPersistence: () => run(() => controller.retryPersistence()),
    retryCommit: () => run(() => controller.retryCommit()),
  };
  runs.set(wrapped, () => active?.runId ?? null);
  return wrapped;
}
