const mockNativeLocalDocuments = {
  presentImportPicker: jest.fn(),
  presentExportPicker: jest.fn(),
};

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalDocuments =
  mockNativeLocalDocuments;
const { LocalDocuments } = jest.requireActual(
  '../src/native/LocalDocuments',
) as typeof import('../src/native/LocalDocuments');

beforeEach(() => {
  jest.clearAllMocks();
  mockNativeLocalDocuments.presentImportPicker.mockResolvedValue({
    schema_version: 1,
    status: 'cancelled',
    destination_root: '',
    entries: [],
  });
  mockNativeLocalDocuments.presentExportPicker.mockResolvedValue({
    schema_version: 1,
    status: 'cancelled',
    item_count: 0,
  });
});

test('links only when both Files picker methods exist', () => {
  expect(LocalDocuments.isAvailable()).toBe(true);
});

test('passes only workspace-relative import and export paths to native', async () => {
  await LocalDocuments.presentImportPicker('projects/project-1/repo/src');
  await LocalDocuments.presentExportPicker([
    'projects/project-1/repo/README.md',
    'projects/project-1/repo/src',
  ]);

  expect(mockNativeLocalDocuments.presentImportPicker).toHaveBeenCalledWith(
    'projects/project-1/repo/src',
  );
  expect(mockNativeLocalDocuments.presentExportPicker).toHaveBeenCalledWith([
    'projects/project-1/repo/README.md',
    'projects/project-1/repo/src',
  ]);
});

test('preserves cancellation as a normal resolved result', async () => {
  await expect(LocalDocuments.presentImportPicker('')).resolves.toEqual({
    schema_version: 1,
    status: 'cancelled',
    destination_root: '',
    entries: [],
  });
  await expect(
    LocalDocuments.presentExportPicker(['note.md']),
  ).resolves.toEqual({
    schema_version: 1,
    status: 'cancelled',
    item_count: 0,
  });
});
