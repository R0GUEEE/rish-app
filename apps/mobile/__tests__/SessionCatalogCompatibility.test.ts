import {
  createSessionPersistenceCoordinator,
  sessionSnapshotSHA256,
} from '../src/completion/SessionPersistence';
import {
  DEFAULT_DSH_MODELS,
  installDshCatalog,
} from '../src/models/catalog';
import { createChatStore, safeHydrateChatState } from '../src/state';

const customModel = {
  id: 'cold-start-model-vNext',
  name: 'Custom model',
  supports_images: false,
};

function installCatalog(custom: boolean): void {
  installDshCatalog({
    schema_version: 1,
    models: DEFAULT_DSH_MODELS.map(model => ({ ...model })),
    retired_models: custom ? [customModel] : [],
  });
}

function savedCustomSession() {
  installCatalog(true);
  const store = createChatStore({
    now: () => '2026-09-14T09:52:00.000Z',
    createId: () => 'custom-model-conversation',
  });
  store.createConversation({ modelId: customModel.id });
  const sessionJSON = store.serialize();
  const loaded = {
    schema_version: 1 as const,
    status: 'present' as const,
    snapshot: {
      schema_version: 1 as const,
      generation: 2,
      session_sha256: sessionSnapshotSHA256(sessionJSON)!,
    },
    session_json: sessionJSON,
    writer_launch_instance_id: '11111111-1111-4111-8111-111111111111',
    current_launch_instance_id: '22222222-2222-4222-8222-222222222222',
  };
  const coordinator = createSessionPersistenceCoordinator({
    loadSessionSnapshot: async () => loaded,
  });
  return { coordinator, loaded, sessionJSON };
}

afterEach(() => installCatalog(false));

test('reloads a stored custom model after catalog refresh following an early rejection', async () => {
  const { coordinator, loaded, sessionJSON } = savedCustomSession();
  installCatalog(false);
  expect(safeHydrateChatState(sessionJSON).ok).toBe(false);
  expect(await coordinator.loadSessionSnapshotResult()).toBeNull();

  installCatalog(true);
  expect(safeHydrateChatState(sessionJSON).ok).toBe(true);
  expect(await coordinator.loadSessionSnapshotResult()).toEqual(loaded);
});

test('does not reuse a successful load after its model catalog changes', async () => {
  const { coordinator, loaded } = savedCustomSession();
  expect(await coordinator.loadSessionSnapshotResult()).toEqual(loaded);

  installCatalog(false);
  expect(await coordinator.loadSessionSnapshotResult()).toBeNull();
});
