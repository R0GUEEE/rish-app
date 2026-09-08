import { NativeEventEmitter, NativeModules } from 'react-native';

export type TaskPreferences = {
  completed: boolean;
  failed: boolean;
  attention: boolean;
  liveActivity: boolean;
  background: boolean;
  muted: string[];
};
export type TaskSettings = {
  available: boolean;
  notifications: string;
  liveActivitiesAvailable: boolean;
  backgroundAvailable: boolean;
  preferences: TaskPreferences;
};
export const defaultTaskPreferences: TaskPreferences = {
  completed: false,
  failed: false,
  attention: false,
  liveActivity: true,
  background: false,
  muted: [],
};
const native = NativeModules.RishTaskExperience;
const fallback: TaskSettings = {
  available: false,
  notifications: 'unavailable',
  liveActivitiesAvailable: false,
  backgroundAvailable: false,
  preferences: defaultTaskPreferences,
};
export type TaskEvent = {
  action: 'open' | 'cancel';
  conversationId: string;
  runId: string;
};
export const taskExperience = {
  available: () => native != null,
  async call(op: string, payload: Record<string, unknown> = {}): Promise<any> {
    if (!native) return fallback;
    const response = JSON.parse(
      await native.handle(
        JSON.stringify({ schema_version: 1, op, ...payload }),
      ),
    );
    if (response.schema_version !== 1 || response.ok !== true)
      throw new Error('Task service unavailable');
    return response.value;
  },
  subscribe(listener: (event: TaskEvent) => void): () => void {
    if (!native) return () => {};
    const subscription = new NativeEventEmitter(native).addListener(
      'RishTaskAction',
      raw => {
        try {
          if (typeof raw !== 'string') return;
          const event = JSON.parse(raw);
          if (
            event.schema_version === 1 &&
            ['open', 'cancel'].includes(event.action) &&
            typeof event.conversationId === 'string' &&
            typeof event.runId === 'string'
          )
            listener(event);
        } catch {
          /* Reject malformed native events. */
        }
      },
    );
    return () => subscription.remove();
  },
};
