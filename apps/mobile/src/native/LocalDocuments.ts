import { NativeModules } from 'react-native';

export type ImportedDocumentEntry = {
  path: string;
  kind: 'file' | 'directory';
  size: number;
};

export type DocumentImportResult = {
  schema_version: 1;
  status: 'imported' | 'cancelled';
  destination_root: string;
  entries: ImportedDocumentEntry[];
};

export type DocumentExportResult = {
  schema_version: 1;
  status: 'exported' | 'cancelled';
  item_count: number;
};

type NativeLocalDocuments = {
  presentImportPicker(destinationRoot: string): Promise<DocumentImportResult>;
  presentExportPicker(sourcePaths: string[]): Promise<DocumentExportResult>;
};

const native = NativeModules.LocalDocuments as unknown;

function hasNativeCapabilities(value: unknown): value is NativeLocalDocuments {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<
    Record<keyof NativeLocalDocuments, unknown>
  >;
  return (
    typeof candidate.presentImportPicker === 'function' &&
    typeof candidate.presentExportPicker === 'function'
  );
}

function required(): NativeLocalDocuments {
  if (!hasNativeCapabilities(native)) {
    throw new Error('LocalDocuments native module is not linked');
  }
  return native;
}

export const LocalDocuments = {
  isAvailable: () => hasNativeCapabilities(native),
  presentImportPicker: (destinationRoot: string) =>
    required().presentImportPicker(destinationRoot),
  presentExportPicker: (sourcePaths: string[]) =>
    required().presentExportPicker(sourcePaths),
};
