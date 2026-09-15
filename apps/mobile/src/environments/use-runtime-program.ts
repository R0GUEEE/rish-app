import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { LocalEnvironments, runtimeEnvironmentErrorCode, type RuntimeEnvironment } from '../native/runtime-environments';
import { LocalPrograms, programActive, runtimeProgramErrorCode, type RuntimeProgramReceipt, validProgramEntry } from '../native/runtime-programs';
import { LocalWorkspaces } from '../native/LocalWorkspaces';
import { createCompletionRequestId } from '../native/LocalRuntime';
import { assertWorkspaceRootRefV1, type WorkspaceRootRefV1 } from '../native/WorkspaceRoot';
import { RuntimeBridgeError } from './runtime-validation';

type Input = { visible: boolean; root: WorkspaceRootRefV1 | null; blocked?: boolean; ownerKey?: string };
type Phase = 'idle' | 'downloading' | 'preparing' | 'starting' | 'active' | 'finished';
type Operation = { owner: object; cancelled: boolean; downloading: boolean; installId: string | null; run: RuntimeProgramReceipt | null };
type State = { owner: object; phase: Phase; receipt: RuntimeProgramReceipt | null; error: string | null };
const rootKey = (root: WorkspaceRootRefV1 | null) => root === null ? '' :
  `${root.workspace_id}:${root.binding_revision}:${root.project_id ?? ''}`;
export function useRuntimeProgram({ visible, root, blocked = false, ownerKey = '' }: Input) {
  const key = `${visible}:${blocked}:${rootKey(root)}:${ownerKey}`;
  const owner = useRef({ key, identity: {}, visible, root, blocked });
  if (owner.current.key !== key) owner.current = { key, identity: {}, visible, root, blocked };
  const identity = owner.current.identity, mounted = useRef(true);
  const pending = useRef<Operation | null>(null);
  const [state, setState] = useState<State>({ owner: identity, phase: 'idle', receipt: null, error: null });
  const current = useCallback((operation: Operation) => mounted.current && !operation.cancelled &&
    pending.current === operation && owner.current.identity === operation.owner && owner.current.visible && !owner.current.blocked, []);
  const stopOperation = useCallback(async (operation: Operation) => {
    operation.cancelled = true;
    if (operation.downloading && operation.installId) {
      try { await LocalEnvironments.cancelOwnedInstall({ schema_version: 1, operation_id: operation.installId }); } catch { /* Start continuation remains cancelled. */ }
    }
    if (operation.run && programActive(operation.run)) {
      try {
        const result = await LocalPrograms.stopProgram({ schema_version: 1, run_id: operation.run.run_id });
        operation.run = result;
        if (mounted.current && owner.current.identity === operation.owner) setState(previous => ({ ...previous,
          receipt: result, phase: programActive(result) ? 'active' : 'finished', error: result.error_code }));
      } catch (error) {
        if (mounted.current && owner.current.identity === operation.owner) setState(previous => ({ ...previous, error: runtimeProgramErrorCode(error) }));
      }
    } else if (mounted.current && owner.current.identity === operation.owner) {
      setState(previous => ({ ...previous, phase: 'finished', error: 'E_ENV_CANCELLED' }));
    }
    if (!operation.run || !programActive(operation.run)) {
      if (pending.current === operation) pending.current = null;
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; const operation = pending.current; if (operation) stopOperation(operation); };
  }, [stopOperation]);
  useEffect(() => {
    const listener = AppState.addEventListener('change', next => {
      if (next !== 'active' && pending.current) stopOperation(pending.current);
    });
    return () => {
      listener.remove();
      const operation = pending.current;
      if (operation?.owner === identity) stopOperation(operation);
    };
  }, [identity, stopOperation]);
  useEffect(() => {
    let reading = false;
    const timer = setInterval(() => {
      const operation = pending.current;
      if (reading || !operation?.run || !programActive(operation.run)) return;
      reading = true;
      LocalPrograms.programStatus({ schema_version: 1, run_id: operation.run.run_id }).then(result => {
        if (!mounted.current || pending.current !== operation) return;
        if (result.workspace_id !== operation.run!.workspace_id || result.environment_id !== operation.run!.environment_id) throw new RuntimeBridgeError('E_PROGRAM_NATIVE');
        operation.run = result;
        if (owner.current.identity === operation.owner) setState({ owner: operation.owner, phase: programActive(result) ? 'active' : 'finished', receipt: result, error: result.error_code });
        if (!programActive(result)) pending.current = null;
      }).catch(error => {
        if (mounted.current && owner.current.identity === identity) setState(previous => ({ ...previous, error: runtimeProgramErrorCode(error) }));
      }).finally(() => { reading = false; });
    }, 500);
    return () => clearInterval(timer);
  }, [identity, visible]);
  const start = useCallback(async (environment: RuntimeEnvironment, entry: string, args: readonly string[]) => {
    if (!owner.current.visible || owner.current.blocked || !owner.current.root || pending.current || !validProgramEntry(entry)) return;
    if (!LocalPrograms.isAvailable() || !LocalEnvironments.isAvailable()) {
      setState({ owner: owner.current.identity, phase: 'finished', receipt: null, error: 'E_PROGRAM_UNAVAILABLE' }); return;
    }
    const operation: Operation = { owner: owner.current.identity, cancelled: false, downloading: false, installId: null, run: null };
    pending.current = operation;
    const update = (phase: Phase) => { if (current(operation)) setState({ owner: operation.owner, phase, receipt: null, error: null }); };
    let workspace: WorkspaceRootRefV1;
    try { workspace = assertWorkspaceRootRefV1(owner.current.root); }
    catch { pending.current = null; setState({ owner: operation.owner, phase: 'finished', receipt: null, error: 'E_PROGRAM_ROOT_STALE' }); return; }
    try {
      if (environment.state !== 'installed') {
        operation.downloading = true; update('downloading');
        if (!LocalEnvironments.supportsOwnedInstall()) throw new RuntimeBridgeError('E_ENV_UNAVAILABLE');
        operation.installId = createCompletionRequestId();
        await LocalEnvironments.installEnvironmentOwned({ schema_version: 1, operation_id: operation.installId, environment_id: environment.environment_id });
        operation.downloading = false;
        if (!current(operation)) return;
      }
      update('preparing');
      const resolved = await LocalWorkspaces.resolve({ schema_version: 1, workspace_id: workspace.workspace_id,
        expected_binding_revision: workspace.binding_revision, required_capabilities: ['read'] });
      if (!current(operation)) return;
      if (resolved.disposition !== 'direct' || resolved.workspace.status !== 'ok' ||
          resolved.workspace.workspace_id !== workspace.workspace_id || resolved.workspace.binding_revision !== workspace.binding_revision) {
        throw new RuntimeBridgeError('E_PROGRAM_ROOT_STALE');
      }
      update('starting');
      const result = await LocalPrograms.startProgram({ schema_version: 1, operation_id: createCompletionRequestId(),
        root: workspace, environment_id: environment.environment_id, entry_path: entry, args });
      operation.run = result;
      if (!current(operation)) { await stopOperation(operation); return; }
      setState({ owner: operation.owner, phase: programActive(result) ? 'active' : 'finished', receipt: result, error: result.error_code });
      if (!programActive(result)) pending.current = null;
    } catch (error) {
      if (current(operation)) setState({ owner: operation.owner, phase: 'finished', receipt: null,
        error: operation.downloading ? runtimeEnvironmentErrorCode(error) : runtimeProgramErrorCode(error) });
      if (pending.current === operation) pending.current = null;
    } finally {
      if (!current(operation) && !operation.run && pending.current === operation) pending.current = null;
    }
  }, [current, stopOperation]);
  const display = state.owner === identity ? state : { owner: identity, phase: 'idle' as const, receipt: null, error: null };
  return { ...display, available: LocalPrograms.isAvailable() && LocalEnvironments.isAvailable(),
    busy: ['downloading', 'preparing', 'starting', 'active'].includes(display.phase), start,
    stop: async () => { if (pending.current) await stopOperation(pending.current); } };
}
