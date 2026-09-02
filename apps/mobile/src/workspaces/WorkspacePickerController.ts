import type {
  LocalWorkspacesNativeV1,
  WorkspaceDescriptorV2,
  WorkspaceFolderPickerResultV1,
  WorkspaceRegrantPickerResultV1,
  WorkspaceSelectionCancelResultV1,
} from '../native/LocalWorkspaces';

/** The native picker keeps a selection alive for at most five minutes. */
export const WORKSPACE_SELECTION_TTL_MS = 5 * 60 * 1000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PickerNative = Pick<
  LocalWorkspacesNativeV1,
  | 'presentFolderPicker'
  | 'importSelection'
  | 'cancelSelection'
  | 'presentRegrantPicker'
  | 'completeRegrant'
  | 'forget'
  | 'cancelPicker'
>;

export type WorkspaceForgetAuthorization = {
  /** Issued by the native session-clearance operation. Never generated here. */
  readonly operation_id: string;
  /** Issued by the native session-clearance operation. Never generated here. */
  readonly clearance_receipt_id: string;
};

export type WorkspacePickerSelection = {
  readonly kind: 'import' | 'regrant';
  readonly generation: number;
  readonly selection_id: string;
  readonly operation_id: string;
  readonly display_name: string;
  readonly expires_at: number;
  readonly workspace_id?: string;
  readonly expected_binding_revision?: number;
  readonly regrant_status?: 'same_root_selected' | 'different_root_selected';
};

export type WorkspacePickerStartResult =
  | { readonly status: 'selected'; readonly workspace: WorkspaceDescriptorV2 }
  | {
      readonly status: 'requires_confirmation';
      readonly selection: WorkspacePickerSelection;
    }
  | { readonly status: 'cancelled' }
  | { readonly status: 'stale' };

export type WorkspacePickerConfirmResult =
  | { readonly status: 'imported'; readonly workspace: WorkspaceDescriptorV2 }
  | { readonly status: 'regranted'; readonly workspace: WorkspaceDescriptorV2 }
  | {
      readonly status: 'different_root';
      readonly workspace: WorkspaceDescriptorV2;
    }
  | { readonly status: 'cancelled' | 'stale' };

export type WorkspacePickerForgetResult =
  | { readonly status: 'forgotten' }
  | { readonly status: 'not_authorized' }
  | { readonly status: 'stale' };

export type WorkspacePickerControllerOptions = {
  readonly native: PickerNative;
  readonly createOperationId: () => string;
  readonly now?: () => number;
  readonly setTimeout?: (handler: () => void, timeout: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly onSelectionChanged?: (
    selection: WorkspacePickerSelection | null,
  ) => void;
};

type PendingPicker = {
  readonly generation: number;
  readonly operation_id: string;
};

/**
 * Owns the JS side of the native picker handshake.
 *
 * It deliberately stores only opaque IDs and bounded display metadata. A
 * generation invalidates every outstanding callback, while a selection is
 * one-shot and expires locally even if native cancellation is delayed.
 */
export class WorkspacePickerController {
  private readonly native: PickerNative;
  private readonly createOperationId: () => string;
  private readonly now: () => number;
  private readonly scheduleTimeout: (
    handler: () => void,
    timeout: number,
  ) => unknown;
  private readonly cancelTimeout: (handle: unknown) => void;
  private readonly onSelectionChanged?: (
    selection: WorkspacePickerSelection | null,
  ) => void;
  private generationValue = 0;
  private pendingPicker: PendingPicker | null = null;
  private pendingSelection: WorkspacePickerSelection | null = null;
  private inFlightSelection: WorkspacePickerSelection | null = null;
  private selectionTimer: unknown = null;
  private disposed = false;

  constructor(options: WorkspacePickerControllerOptions) {
    this.native = options.native;
    this.createOperationId = options.createOperationId;
    this.now = options.now ?? Date.now;
    this.scheduleTimeout =
      options.setTimeout ??
      ((handler, timeout) => setTimeout(handler, timeout));
    this.cancelTimeout =
      options.clearTimeout ??
      (handle => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.onSelectionChanged = options.onSelectionChanged;
  }

  get generation(): number {
    return this.generationValue;
  }

  get selection(): WorkspacePickerSelection | null {
    return this.pendingSelection;
  }

  /** Invalidate the surface and asynchronously settle any native picker. */
  invalidate(): void {
    if (this.disposed) return;
    this.generationValue += 1;
    const pendingPicker = this.pendingPicker;
    const pendingSelection = this.pendingSelection;
    this.pendingPicker = null;
    this.clearSelection(true);
    this.inFlightSelection = null;
    if (pendingSelection !== null) this.cancelNativeSelection(pendingSelection);
    if (pendingPicker !== null) {
      try {
        Promise.resolve(
          this.native.cancelPicker({
            schema_version: 1,
            operation_id: pendingPicker.operation_id,
          }),
        ).catch(() => undefined);
      } catch {
        // A native cancellation failure cannot restore an invalidated token.
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
  }

  async presentFolderPicker(
    mode: 'grant_or_import' | 'import_only',
  ): Promise<WorkspacePickerStartResult> {
    const token = this.beginPicker();
    let result: WorkspaceFolderPickerResultV1;
    try {
      result = await this.native.presentFolderPicker({
        schema_version: 1,
        operation_id: token.operation_id,
        mode,
      });
    } catch (error) {
      if (this.isCurrentPicker(token)) this.pendingPicker = null;
      throw error;
    }

    if (!this.isCurrentPicker(token)) {
      await this.cancelReturnedSelection(result);
      return { status: 'stale' };
    }
    this.pendingPicker = null;

    if (result.status === 'cancelled') return { status: 'cancelled' };
    if (result.status === 'selected') {
      if (result.workspace.status !== 'ok') return { status: 'stale' };
      return { status: 'selected', workspace: result.workspace };
    }

    const selection = this.rememberSelection({
      kind: 'import',
      generation: token.generation,
      selection_id: result.selection_id,
      operation_id: token.operation_id,
      display_name: result.display_name,
    });
    return { status: 'requires_confirmation', selection };
  }

  async presentRegrantPicker(
    workspace: Pick<WorkspaceDescriptorV2, 'workspace_id' | 'binding_revision'>,
  ): Promise<WorkspacePickerStartResult> {
    if (
      !isCanonicalUuid(workspace.workspace_id) ||
      !isPositiveSafeInteger(workspace.binding_revision)
    ) {
      return { status: 'stale' };
    }
    const token = this.beginPicker();
    let result: WorkspaceRegrantPickerResultV1;
    try {
      result = await this.native.presentRegrantPicker({
        schema_version: 1,
        workspace_id: workspace.workspace_id,
        expected_binding_revision: workspace.binding_revision,
        operation_id: token.operation_id,
      });
    } catch (error) {
      if (this.isCurrentPicker(token)) this.pendingPicker = null;
      throw error;
    }

    if (!this.isCurrentPicker(token)) {
      await this.cancelReturnedSelection(result);
      return { status: 'stale' };
    }
    this.pendingPicker = null;
    if (result.status === 'cancelled') return { status: 'cancelled' };

    const selection = this.rememberSelection({
      kind: 'regrant',
      generation: token.generation,
      selection_id: result.selection_id,
      operation_id: token.operation_id,
      display_name: result.display_name,
      workspace_id: workspace.workspace_id,
      expected_binding_revision: workspace.binding_revision,
      regrant_status: result.status,
    });
    return { status: 'requires_confirmation', selection };
  }

  async confirmSelection(): Promise<WorkspacePickerConfirmResult> {
    const selection = this.takeLiveSelection();
    if (selection === null) return { status: 'stale' };

    if (selection.kind === 'import') {
      try {
        const workspace = await this.native.importSelection({
          schema_version: 1,
          selection_id: selection.selection_id,
          operation_id: selection.operation_id,
        });
        if (!this.isCurrentSelection(selection)) return { status: 'stale' };
        return workspace.status === 'ok'
          ? { status: 'imported', workspace }
          : { status: 'stale' };
      } finally {
        if (this.inFlightSelection === selection) this.inFlightSelection = null;
      }
    }

    const workspaceId = selection.workspace_id;
    const revision = selection.expected_binding_revision;
    if (
      workspaceId === undefined ||
      revision === undefined ||
      selection.regrant_status === undefined
    ) {
      return { status: 'stale' };
    }
    try {
      const result = await this.native.completeRegrant({
        schema_version: 1,
        workspace_id: workspaceId,
        expected_binding_revision: revision,
        selection_id: selection.selection_id,
        operation_id: selection.operation_id,
      });
      if (!this.isCurrentSelection(selection)) return { status: 'stale' };
      if (!isConsistentRegrantResult(selection, result)) {
        return { status: 'stale' };
      }
      if (result.status === 'regranted') {
        return result.workspace.status === 'ok'
          ? { status: 'regranted', workspace: result.workspace }
          : { status: 'stale' };
      }
      return result.new_workspace.status === 'ok'
        ? { status: 'different_root', workspace: result.new_workspace }
        : { status: 'stale' };
    } finally {
      if (this.inFlightSelection === selection) this.inFlightSelection = null;
    }
  }

  async cancelSelection(): Promise<WorkspaceSelectionCancelResultV1 | null> {
    const selection = this.takeLiveSelection();
    if (selection === null) return null;
    try {
      return await this.native.cancelSelection({
        schema_version: 1,
        selection_id: selection.selection_id,
      });
    } finally {
      if (this.inFlightSelection === selection) this.inFlightSelection = null;
    }
  }

  /**
   * Forget is intentionally inert without both native-issued IDs. In
   * particular, this method never generates an operation or receipt ID.
   */
  async forgetWorkspace(
    workspace: Pick<WorkspaceDescriptorV2, 'workspace_id' | 'binding_revision'>,
    authorization: WorkspaceForgetAuthorization | null | undefined,
  ): Promise<WorkspacePickerForgetResult> {
    if (
      !isCanonicalUuid(workspace.workspace_id) ||
      !isPositiveSafeInteger(workspace.binding_revision) ||
      !hasForgetAuthorization(authorization)
    ) {
      return { status: 'not_authorized' };
    }
    const operationGeneration = this.beginMutation();
    await this.native.forget({
      schema_version: 1,
      workspace_id: workspace.workspace_id,
      expected_binding_revision: workspace.binding_revision,
      operation_id: authorization.operation_id,
      clearance_receipt_id: authorization.clearance_receipt_id,
    });
    return this.generationValue === operationGeneration
      ? { status: 'forgotten' }
      : { status: 'stale' };
  }

  private beginPicker(): PendingPicker {
    this.ensureLive();
    this.invalidate();
    const token: PendingPicker = {
      generation: this.generationValue,
      operation_id: this.createOperationId(),
    };
    this.pendingPicker = token;
    return token;
  }

  private beginMutation(): number {
    this.ensureLive();
    this.invalidate();
    return this.generationValue;
  }

  private isCurrentPicker(token: PendingPicker): boolean {
    return (
      !this.disposed &&
      this.pendingPicker === token &&
      this.generationValue === token.generation
    );
  }

  private isCurrentSelection(selection: WorkspacePickerSelection): boolean {
    return (
      !this.disposed &&
      (this.pendingSelection === selection ||
        this.inFlightSelection === selection) &&
      this.generationValue === selection.generation &&
      this.now() < selection.expires_at
    );
  }

  private rememberSelection(
    input: Omit<WorkspacePickerSelection, 'expires_at'>,
  ): WorkspacePickerSelection {
    this.clearSelection(true);
    const selection: WorkspacePickerSelection = {
      ...input,
      expires_at: this.now() + WORKSPACE_SELECTION_TTL_MS,
    };
    this.pendingSelection = selection;
    this.selectionTimer = this.scheduleTimeout(() => {
      if (this.pendingSelection !== selection) return;
      this.clearSelection(true);
      this.cancelNativeSelection(selection);
    }, WORKSPACE_SELECTION_TTL_MS);
    this.onSelectionChanged?.(selection);
    return selection;
  }

  private takeLiveSelection(): WorkspacePickerSelection | null {
    const selection = this.pendingSelection;
    if (selection === null) return null;
    if (!this.isCurrentSelection(selection)) {
      if (this.pendingSelection === selection) {
        this.clearSelection(true);
        this.cancelNativeSelection(selection);
      }
      return null;
    }
    this.clearSelection(true);
    this.inFlightSelection = selection;
    return selection;
  }

  private clearSelection(notify: boolean): void {
    if (this.selectionTimer !== null) {
      this.cancelTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }
    if (this.pendingSelection === null) return;
    this.pendingSelection = null;
    if (notify) this.onSelectionChanged?.(null);
  }

  private cancelNativeSelection(selection: WorkspacePickerSelection): void {
    try {
      Promise.resolve(
        this.native.cancelSelection({
          schema_version: 1,
          selection_id: selection.selection_id,
        }),
      ).catch(() => undefined);
    } catch {
      // The token is already invalid locally; native cleanup is best effort.
    }
  }

  private async cancelReturnedSelection(
    result: WorkspaceFolderPickerResultV1 | WorkspaceRegrantPickerResultV1,
  ): Promise<void> {
    if (
      result.status === 'requires_import' ||
      result.status === 'same_root_selected' ||
      result.status === 'different_root_selected'
    ) {
      try {
        await Promise.resolve(
          this.native.cancelSelection({
            schema_version: 1,
            selection_id: result.selection_id,
          }),
        ).catch(() => undefined);
      } catch {
        // A stale callback must remain a no-op even if cleanup rejects.
      }
    }
  }

  private ensureLive(): void {
    if (this.disposed) throw new Error('Workspace picker controller disposed');
  }
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= Number.MAX_SAFE_INTEGER &&
    !Object.is(value, -0)
  );
}

function hasForgetAuthorization(
  value: WorkspaceForgetAuthorization | null | undefined,
): value is WorkspaceForgetAuthorization {
  return (
    value !== null &&
    value !== undefined &&
    isCanonicalUuid(value.operation_id) &&
    isCanonicalUuid(value.clearance_receipt_id)
  );
}

function isConsistentRegrantResult(
  selection: WorkspacePickerSelection,
  result: Awaited<ReturnType<PickerNative['completeRegrant']>>,
): boolean {
  const workspaceId = selection.workspace_id;
  const expectedRevision = selection.expected_binding_revision;
  if (
    selection.kind !== 'regrant' ||
    !isCanonicalUuid(workspaceId) ||
    !isPositiveSafeInteger(expectedRevision) ||
    selection.regrant_status === undefined
  ) {
    return false;
  }

  if (selection.regrant_status === 'same_root_selected') {
    if (
      typeof result !== 'object' ||
      result === null ||
      result.status !== 'regranted' ||
      typeof result.workspace !== 'object' ||
      result.workspace === null
    ) {
      return false;
    }
    return (
      result.workspace.status === 'ok' &&
      result.workspace.workspace_id === workspaceId &&
      isPositiveSafeInteger(result.workspace.binding_revision) &&
      expectedRevision < Number.MAX_SAFE_INTEGER &&
      result.workspace.binding_revision === expectedRevision + 1
    );
  }

  if (
    typeof result !== 'object' ||
    result === null ||
    result.status !== 'different_root' ||
    typeof result.new_workspace !== 'object' ||
    result.new_workspace === null
  ) {
    return false;
  }
  return (
    result.new_workspace.status === 'ok' &&
    isCanonicalUuid(result.new_workspace.workspace_id) &&
    result.new_workspace.workspace_id !== workspaceId
  );
}
