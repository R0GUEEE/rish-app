import {
  WORKSPACE_SELECTION_TTL_MS,
  WorkspacePickerController,
} from '../src/workspaces/WorkspacePickerController';

const WORKSPACE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEW_WORKSPACE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SELECTION_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OPERATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const CLEARANCE_RECEIPT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function workspace(
  workspaceId = WORKSPACE_ID,
  status: 'ok' | 'revoked' = 'ok',
  bindingRevision = 1,
) {
  return {
    schema_version: 2 as const,
    workspace_id: workspaceId,
    display_name: 'Scratch',
    origin: 'granted_folder' as const,
    status,
    binding_revision: bindingRevision,
    capabilities: {
      read: status === 'ok',
      write: false,
      git: false,
      project_context: false,
      files_visible: false,
    },
    created_at: '2026-08-27T01:00:00.000Z',
    last_opened_at: '2026-08-27T01:00:00.000Z',
  };
}

function nativeHarness() {
  return {
    presentFolderPicker: jest.fn(),
    importSelection: jest.fn(),
    cancelSelection: jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'cancelled',
    }),
    presentRegrantPicker: jest.fn(),
    completeRegrant: jest.fn(),
    forget: jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'forgotten',
    }),
    cancelPicker: jest.fn().mockResolvedValue({
      schema_version: 1,
      status: 'already_settled',
    }),
  };
}

function requiresImport(selectionId = SELECTION_ID, displayName = 'Scratch') {
  return {
    schema_version: 1 as const,
    status: 'requires_import' as const,
    selection_id: selectionId,
    display_name: displayName,
    location_class: 'unknown' as const,
  };
}

test('uses presentFolderPicker and imports only after explicit confirmation', async () => {
  const native = nativeHarness();
  native.presentFolderPicker.mockResolvedValue(requiresImport());
  native.importSelection.mockResolvedValue(workspace());
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await expect(
    controller.presentFolderPicker('import_only'),
  ).resolves.toMatchObject({
    status: 'requires_confirmation',
    selection: { selection_id: SELECTION_ID, operation_id: OPERATION_ID },
  });
  expect(native.presentFolderPicker).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: OPERATION_ID,
    mode: 'import_only',
  });
  expect(native.importSelection).not.toHaveBeenCalled();

  await expect(controller.confirmSelection()).resolves.toMatchObject({
    status: 'imported',
  });
  expect(native.importSelection).toHaveBeenCalledWith({
    schema_version: 1,
    selection_id: SELECTION_ID,
    operation_id: OPERATION_ID,
  });
});

test('cancels a pending selection once and never reuses it', async () => {
  const native = nativeHarness();
  native.presentFolderPicker.mockResolvedValue(requiresImport());
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await controller.presentFolderPicker('grant_or_import');
  await controller.cancelSelection();
  await controller.cancelSelection();

  expect(native.cancelSelection).toHaveBeenCalledTimes(1);
  expect(native.cancelSelection).toHaveBeenCalledWith({
    schema_version: 1,
    selection_id: SELECTION_ID,
  });
  expect(controller.selection).toBeNull();
});

test('expires a selection after the five-minute TTL and cancels native state', async () => {
  const native = nativeHarness();
  native.presentFolderPicker.mockResolvedValue(requiresImport());
  let now = 10_000;
  const timerRef: { current: (() => void) | null } = { current: null };
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
    now: () => now,
    setTimeout: handler => {
      timerRef.current = handler;
      return handler;
    },
    clearTimeout: () => undefined,
  });

  await controller.presentFolderPicker('import_only');
  now += WORKSPACE_SELECTION_TTL_MS;
  timerRef.current?.();
  await Promise.resolve();

  expect(controller.selection).toBeNull();
  expect(native.cancelSelection).toHaveBeenCalledTimes(1);
  await expect(controller.confirmSelection()).resolves.toEqual({
    status: 'stale',
  });
});

test('invalidates late picker results and settles their returned selection', async () => {
  const native = nativeHarness();
  const resolvePickerRef: {
    current: ((value: ReturnType<typeof requiresImport>) => void) | null;
  } = { current: null };
  native.presentFolderPicker.mockReturnValue(
    new Promise(resolve => {
      resolvePickerRef.current = resolve;
    }),
  );
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  const pending = controller.presentFolderPicker('grant_or_import');
  controller.invalidate();
  resolvePickerRef.current?.(requiresImport());

  await expect(pending).resolves.toEqual({ status: 'stale' });
  expect(native.cancelPicker).toHaveBeenCalledWith({
    schema_version: 1,
    operation_id: OPERATION_ID,
  });
  expect(native.cancelSelection).toHaveBeenCalledWith({
    schema_version: 1,
    selection_id: SELECTION_ID,
  });
  expect(controller.selection).toBeNull();
});

test('regrant uses the exact captured workspace and revision, including a new root', async () => {
  const native = nativeHarness();
  native.presentRegrantPicker.mockResolvedValue({
    schema_version: 1,
    status: 'different_root',
    selection_id: SELECTION_ID,
    display_name: 'Another root',
  });
  native.completeRegrant.mockResolvedValue({
    schema_version: 1,
    status: 'different_root',
    new_workspace: workspace(NEW_WORKSPACE_ID, 'ok', 1),
  });
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await controller.presentRegrantPicker({
    workspace_id: WORKSPACE_ID,
    binding_revision: 7,
  });
  await expect(controller.confirmSelection()).resolves.toMatchObject({
    status: 'different_root',
    workspace: { workspace_id: NEW_WORKSPACE_ID },
  });
  expect(native.presentRegrantPicker).toHaveBeenCalledWith({
    schema_version: 1,
    workspace_id: WORKSPACE_ID,
    expected_binding_revision: 7,
    operation_id: OPERATION_ID,
  });
  expect(native.completeRegrant).toHaveBeenCalledWith({
    schema_version: 1,
    workspace_id: WORKSPACE_ID,
    expected_binding_revision: 7,
    selection_id: SELECTION_ID,
    operation_id: OPERATION_ID,
  });
});

test('accepts same-root regrant only when the workspace is unchanged and revision advances', async () => {
  const native = nativeHarness();
  native.presentRegrantPicker.mockResolvedValue({
    schema_version: 1,
    status: 'same_root_selected',
    selection_id: SELECTION_ID,
    display_name: 'Scratch',
  });
  native.completeRegrant.mockResolvedValue({
    schema_version: 1,
    status: 'regranted',
    workspace: workspace(WORKSPACE_ID, 'ok', 3),
  });
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await controller.presentRegrantPicker({
    workspace_id: WORKSPACE_ID,
    binding_revision: 2,
  });
  await expect(controller.confirmSelection()).resolves.toMatchObject({
    status: 'regranted',
    workspace: { workspace_id: WORKSPACE_ID, binding_revision: 3 },
  });
});

test.each([
  [
    'same-root rejects a different-root result',
    'same_root_selected' as const,
    {
      schema_version: 1 as const,
      status: 'different_root' as const,
      new_workspace: workspace(NEW_WORKSPACE_ID),
    },
  ],
  [
    'same-root rejects a changed workspace ID',
    'same_root_selected' as const,
    {
      schema_version: 1 as const,
      status: 'regranted' as const,
      workspace: workspace(NEW_WORKSPACE_ID, 'ok', 3),
    },
  ],
  [
    'same-root rejects a non-incremented revision',
    'same_root_selected' as const,
    {
      schema_version: 1 as const,
      status: 'regranted' as const,
      workspace: workspace(WORKSPACE_ID, 'ok', 2),
    },
  ],
  [
    'same-root rejects a skipped revision',
    'same_root_selected' as const,
    {
      schema_version: 1 as const,
      status: 'regranted' as const,
      workspace: workspace(WORKSPACE_ID, 'ok', 4),
    },
  ],
  [
    'different-root rejects a regranted result',
    'different_root_selected' as const,
    {
      schema_version: 1 as const,
      status: 'regranted' as const,
      workspace: workspace(WORKSPACE_ID, 'ok', 3),
    },
  ],
  [
    'different-root rejects reusing the old workspace ID',
    'different_root_selected' as const,
    {
      schema_version: 1 as const,
      status: 'different_root' as const,
      new_workspace: workspace(WORKSPACE_ID),
    },
  ],
])('%s', async (_name, selectedStatus, contradictoryResult) => {
  const native = nativeHarness();
  native.presentRegrantPicker.mockResolvedValue({
    schema_version: 1,
    status: selectedStatus,
    selection_id: SELECTION_ID,
    display_name: 'Scratch',
  });
  native.completeRegrant.mockResolvedValue(contradictoryResult);
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await controller.presentRegrantPicker({
    workspace_id: WORKSPACE_ID,
    binding_revision: 2,
  });
  await expect(controller.confirmSelection()).resolves.toEqual({
    status: 'stale',
  });
});

test('accepts the MAX safe revision as a valid descriptor and forget binding', async () => {
  const native = nativeHarness();
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });
  const maxWorkspace = workspace(WORKSPACE_ID, 'ok', Number.MAX_SAFE_INTEGER);

  await expect(
    controller.forgetWorkspace(maxWorkspace, {
      operation_id: OPERATION_ID,
      clearance_receipt_id: CLEARANCE_RECEIPT_ID,
    }),
  ).resolves.toEqual({ status: 'forgotten' });
  expect(native.forget).toHaveBeenCalledWith({
    schema_version: 1,
    workspace_id: WORKSPACE_ID,
    expected_binding_revision: Number.MAX_SAFE_INTEGER,
    operation_id: OPERATION_ID,
    clearance_receipt_id: CLEARANCE_RECEIPT_ID,
  });
});

test('accepts exactly MAX as the increment from MAX minus one', async () => {
  const native = nativeHarness();
  native.presentRegrantPicker.mockResolvedValue({
    schema_version: 1,
    status: 'same_root_selected',
    selection_id: SELECTION_ID,
    display_name: 'Scratch',
  });
  native.completeRegrant.mockResolvedValue({
    schema_version: 1,
    status: 'regranted',
    workspace: workspace(WORKSPACE_ID, 'ok', Number.MAX_SAFE_INTEGER),
  });
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await controller.presentRegrantPicker({
    workspace_id: WORKSPACE_ID,
    binding_revision: Number.MAX_SAFE_INTEGER - 1,
  });
  await expect(controller.confirmSelection()).resolves.toMatchObject({
    status: 'regranted',
    workspace: { binding_revision: Number.MAX_SAFE_INTEGER },
  });
});

test('fails closed when a same-root regrant would increment past MAX', async () => {
  const native = nativeHarness();
  native.presentRegrantPicker.mockResolvedValue({
    schema_version: 1,
    status: 'same_root_selected',
    selection_id: SELECTION_ID,
    display_name: 'Scratch',
  });
  native.completeRegrant.mockResolvedValue({
    schema_version: 1,
    status: 'regranted',
    workspace: workspace(WORKSPACE_ID, 'ok', Number.MAX_SAFE_INTEGER),
  });
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await controller.presentRegrantPicker({
    workspace_id: WORKSPACE_ID,
    binding_revision: Number.MAX_SAFE_INTEGER,
  });
  await expect(controller.confirmSelection()).resolves.toEqual({
    status: 'stale',
  });
});

test('fails closed for forget without native-issued operation and clearance IDs', async () => {
  const native = nativeHarness();
  const createOperationId = jest.fn(() => OPERATION_ID);
  const controller = new WorkspacePickerController({
    native,
    createOperationId,
  });

  await expect(controller.forgetWorkspace(workspace(), null)).resolves.toEqual({
    status: 'not_authorized',
  });
  await expect(
    controller.forgetWorkspace(workspace(), {
      operation_id: OPERATION_ID,
      clearance_receipt_id: 'not-a-uuid',
    }),
  ).resolves.toEqual({ status: 'not_authorized' });
  expect(native.forget).not.toHaveBeenCalled();
  expect(createOperationId).not.toHaveBeenCalled();

  await controller.forgetWorkspace(workspace(), {
    operation_id: OPERATION_ID,
    clearance_receipt_id: CLEARANCE_RECEIPT_ID,
  });
  expect(native.forget).toHaveBeenCalledWith({
    schema_version: 1,
    workspace_id: WORKSPACE_ID,
    expected_binding_revision: 1,
    operation_id: OPERATION_ID,
    clearance_receipt_id: CLEARANCE_RECEIPT_ID,
  });
});

test('does not surface a late import result after generation changes', async () => {
  const native = nativeHarness();
  native.presentFolderPicker.mockResolvedValue(requiresImport());
  const resolveImportRef: {
    current: ((value: ReturnType<typeof workspace>) => void) | null;
  } = { current: null };
  native.importSelection.mockReturnValue(
    new Promise(resolve => {
      resolveImportRef.current = resolve;
    }),
  );
  const controller = new WorkspacePickerController({
    native,
    createOperationId: () => OPERATION_ID,
  });

  await controller.presentFolderPicker('import_only');
  const confirmation = controller.confirmSelection();
  controller.invalidate();
  resolveImportRef.current?.(workspace());

  await expect(confirmation).resolves.toEqual({ status: 'stale' });
});
