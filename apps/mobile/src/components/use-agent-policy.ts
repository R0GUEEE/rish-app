import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import {
  AgentPolicy, agentPolicyFailureCode,
  type AgentPolicyDescriptor, type AgentPolicyFailureCode,
} from '../native/agent-policy';

type Selection = {
  readonly visible: boolean;
  readonly workspaceId: string | null;
  readonly bindingRevision: number | null;
  readonly projectId: string | null;
};
export type AgentPolicyState = {
  readonly status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  readonly policy: AgentPolicyDescriptor | null;
  readonly errorCode: AgentPolicyFailureCode | null;
};
const IDLE: AgentPolicyState = { status: 'idle', policy: null, errorCode: null };
const LOADING: AgentPolicyState = { status: 'loading', policy: null, errorCode: null };
const UNAVAILABLE: AgentPolicyState = { status: 'unavailable', policy: null, errorCode: null };

export function useAgentPolicy({ visible, workspaceId, bindingRevision, projectId }: Selection):
    AgentPolicyState & { readonly retry: () => void } {
  const mounted = useRef(false);
  const [refresh, setRefresh] = useState(0);
  // A new identity for each opening/retry also hides old data during render,
  // before passive effect cleanup or the next native read can run.
  const selection = useMemo(() => ({ visible, workspaceId, bindingRevision, projectId, refresh }),
    [visible, workspaceId, bindingRevision, projectId, refresh]);
  const [snapshot, setSnapshot] = useState<{ selection: typeof selection; state: AgentPolicyState } | null>(null);
  const retry = useCallback(() => {
    if (mounted.current) setRefresh(value => value + 1);
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!selection.visible || selection.workspaceId === null || selection.bindingRevision === null) return;
    let current = true;
    setSnapshot({ selection, state: LOADING });
    if (!AgentPolicy.isAvailable()) {
      setSnapshot({ selection, state: UNAVAILABLE });
      return () => { current = false; };
    }
    const read = async () => {
      try {
        const policy = await AgentPolicy.describe({
          schema_version: 1, workspace_id: selection.workspaceId!,
          workspace_binding_revision: selection.bindingRevision!, project_id: selection.projectId,
        });
        if (current) setSnapshot({ selection, state: { status: 'ready', policy, errorCode: null } });
      } catch (error) {
        if (current) setSnapshot({ selection, state: {
          status: 'error', policy: null, errorCode: agentPolicyFailureCode(error),
        } });
      }
    };
    read().catch(() => undefined);
    return () => { current = false; };
  }, [selection]);

  useEffect(() => {
    if (!visible) return;
    let current = true;
    let previous = AppState.currentState;
    const subscription = AppState.addEventListener('change', next => {
      const foreground = next === 'active' && previous !== 'active';
      previous = next;
      if (current && foreground) retry();
    });
    return () => { current = false; subscription.remove(); };
  }, [visible, retry]);

  const state = !visible ? IDLE
    : workspaceId === null || bindingRevision === null ? UNAVAILABLE
    : snapshot?.selection === selection ? snapshot.state : LOADING;
  return { ...state, retry };
}
