const mockNativeLocalAttachments = {
  present: jest.fn(),
  discard: jest.fn(),
  prune: jest.fn(),
  preview: jest.fn(),
  presentPreview: jest.fn(),
};

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalAttachments =
  mockNativeLocalAttachments;
const { LocalAttachments } = jest.requireActual(
  '../src/native/LocalAttachments',
) as typeof import('../src/native/LocalAttachments');

beforeEach(() => {
  jest.clearAllMocks();
});

test('links only when the complete attachment API exists', () => {
  expect(LocalAttachments.isAvailable()).toBe(true);
});

test.each(['camera', 'photos', 'files'] as const)(
  'passes the %s source to native',
  async source => {
    mockNativeLocalAttachments.present.mockResolvedValue({
      schema_version: 1,
      status: 'cancelled',
      attachments: [],
    });

    await LocalAttachments.present(source);

    expect(mockNativeLocalAttachments.present).toHaveBeenCalledWith(source);
  },
);

test('passes only opaque identifiers to lifecycle methods', async () => {
  mockNativeLocalAttachments.discard.mockResolvedValue({
    schema_version: 1,
    discarded_count: 2,
  });
  mockNativeLocalAttachments.prune.mockResolvedValue({
    schema_version: 1,
    removed_count: 1,
  });
  mockNativeLocalAttachments.preview.mockResolvedValue({
    schema_version: 1,
    id: 'a5a4fabc-e00e-42c9-984a-d11178526586',
    thumbnail_data_url: null,
  });
  mockNativeLocalAttachments.presentPreview.mockResolvedValue({
    schema_version: 1,
    status: 'closed',
  });

  const ids = [
    'a5a4fabc-e00e-42c9-984a-d11178526586',
    '6b8d46bc-4f2d-43cc-bf24-5f8ad227f4c2',
  ];
  await LocalAttachments.discard(ids);
  await LocalAttachments.prune(ids.slice(0, 1));
  await LocalAttachments.preview(ids[0]);
  await LocalAttachments.presentPreview(ids[0]);

  expect(mockNativeLocalAttachments.discard).toHaveBeenCalledWith(ids);
  expect(mockNativeLocalAttachments.prune).toHaveBeenCalledWith(
    ids.slice(0, 1),
  );
  expect(mockNativeLocalAttachments.preview).toHaveBeenCalledWith(ids[0]);
  expect(mockNativeLocalAttachments.presentPreview).toHaveBeenCalledWith(
    ids[0],
  );
});
