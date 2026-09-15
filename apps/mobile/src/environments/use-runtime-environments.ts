import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { LocalEnvironments, runtimeEnvironmentErrorCode, type RuntimeEnvironmentList } from '../native/runtime-environments';

type Input = { visible: boolean; workspaceId: string | null };
type State = { key: object; status: 'loading' | 'ready' | 'unavailable' | 'error'; list: RuntimeEnvironmentList | null; error: string | null };
/** Only explicit actions download packages. Opening the sheet just reads metadata. */
export function useRuntimeEnvironments({ visible, workspaceId }: Input) {
  const owner = useRef({ visible, workspaceId, identity: {} });
  if (owner.current.visible !== visible || owner.current.workspaceId !== workspaceId) owner.current = { visible, workspaceId, identity: {} };
  const identity = owner.current.identity;
  const mounted = useRef(true), request = useRef(0);
  const operation = useRef<{ identity: object; download: boolean } | null>(null);
  const [busy, setBusy] = useState<object | null>(null);
  const [state, setState] = useState<State>({ key: identity, status: 'loading', list: null, error: null });
  const current = useCallback((key: object) => mounted.current && owner.current.visible && owner.current.identity === key, []);
  const refresh = useCallback(async () => {
    const key = owner.current.identity, serial = ++request.current;
    if (!owner.current.visible) return;
    if (!LocalEnvironments.isAvailable()) {
      if (current(key)) setState({ key, status: 'unavailable', list: null, error: null });
      return;
    }
    try {
      const list = await LocalEnvironments.listEnvironments({ schema_version: 1, workspace_id: owner.current.workspaceId });
      if (current(key) && serial === request.current) setState(previous => ({ key, status: 'ready', list,
        error: previous.key === key ? previous.error : null }));
    } catch (error) {
      if (current(key) && serial === request.current) setState(previous => ({ key, status: 'error',
        list: previous.key === key ? previous.list : null, error: runtimeEnvironmentErrorCode(error) }));
    }
  }, [current]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!visible) return;
    refresh();
    const timer = setInterval(() => { refresh(); }, 1000);
    const listener = AppState.addEventListener('change', stateName => { if (stateName === 'active') refresh(); });
    return () => {
      clearInterval(timer); listener.remove();
      const pending = operation.current;
      if (pending?.identity === identity && pending.download) {
        operation.current = null;
        LocalEnvironments.cancelInstall({ schema_version: 1 }).catch(() => undefined);
      }
    };
  }, [identity, refresh, visible]);
  const perform = useCallback(async (action: () => Promise<unknown>, download = false): Promise<boolean> => {
    const key = owner.current.identity;
    if (!current(key) || operation.current) return false;
    const pending = { identity: key, download };
    operation.current = pending; setBusy(key);
    setState(previous => ({ ...previous, error: null }));
    try {
      await action();
      if (!current(key) || operation.current !== pending) return false;
      await refresh();
      return current(key);
    } catch (error) {
      if (current(key) && operation.current === pending) setState(previous => ({ ...previous, key, error: runtimeEnvironmentErrorCode(error) }));
      return false;
    } finally {
      if (operation.current === pending) operation.current = null;
      if (current(key)) setBusy(null);
    }
  }, [current, refresh]);
  const cancel = useCallback(async () => {
    const pending = operation.current;
    if (!pending?.download) return;
    operation.current = null;
    try { await LocalEnvironments.cancelInstall({ schema_version: 1 }); }
    catch (error) {
      if (current(pending.identity)) setState(previous => ({ ...previous, error: runtimeEnvironmentErrorCode(error) }));
    }
    if (current(pending.identity)) { setBusy(null); await refresh(); }
  }, [current, refresh]);
  return {
    status: state.key === identity ? state.status : 'loading' as const,
    list: state.key === identity ? state.list : null,
    error: state.key === identity ? state.error : null,
    busy: busy === identity, cancellable: busy === identity && operation.current?.download === true,
    refresh: async () => { setState(previous => ({ ...previous, error: null })); await refresh(); }, cancel,
    install: (environment_id: string) => perform(() => LocalEnvironments.installEnvironment({ schema_version: 1, environment_id }), true),
    importFile: () => perform(() => LocalEnvironments.importEnvironment(), true),
    download: (url: string) => perform(() => LocalEnvironments.downloadEnvironment({ schema_version: 1, url }), true),
    remove: (environment_id: string) => perform(() => LocalEnvironments.removeEnvironment({ schema_version: 1, environment_id })),
    select: (environment_id: string) => {
      const selectedWorkspace = owner.current.workspaceId;
      return selectedWorkspace === null ? Promise.resolve(false) : perform(() => LocalEnvironments.selectEnvironment({
        schema_version: 1, workspace_id: selectedWorkspace, environment_id,
      }));
    },
  };
}
