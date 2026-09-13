import { NativeEventEmitter, NativeModules } from 'react-native';

import {
  parseAgentRoundPreviewEvent,
  type AgentRoundPreviewEvent,
} from './AgentRoundPreview';

/** Delivers parsed preview events; returns the unsubscribe function. */
export type AgentRoundPreviewSource = (
  listener: (event: AgentRoundPreviewEvent) => void,
) => () => void;

const eventName = 'agentRoundPreview';

/**
 * Native `agentRoundPreview` events from the AgentRuntime module. Display
 * material only: malformed events are dropped, and a platform without the
 * module (or without the emitter contract) yields no events at all.
 */
export const nativeAgentRoundPreviewSource: AgentRoundPreviewSource = listener => {
  let module: unknown = null;
  try {
    module = Reflect.get(NativeModules, 'AgentRuntime') as unknown;
  } catch {
    module = null;
  }
  if (typeof module !== 'object' || module === null) return () => {};
  let subscription: { remove(): void } | null = null;
  try {
    const emitter = new NativeEventEmitter(module as never);
    subscription = emitter.addListener(eventName, (raw: unknown) => {
      const event = parseAgentRoundPreviewEvent(raw);
      if (event !== null) listener(event);
    });
  } catch {
    return () => {};
  }
  return () => {
    try {
      subscription?.remove();
    } catch {
      // A torn-down bridge has nothing left to remove.
    }
  };
};
