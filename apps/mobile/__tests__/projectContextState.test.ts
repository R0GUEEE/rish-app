import {
  createProjectContextState,
  hydrateProjectContextState,
  isProjectContextSendable,
  projectContextReducer,
  serializeProjectContextState,
  type ProjectContextConsentV1,
  type ProjectContextManifestV1,
  type ProjectContextState,
} from '../src/project-context';

const manifest: ProjectContextManifestV1 = {
  schema_version: 1,
  snapshot_id: 'snapshot-1',
  project_id: 'project-1',
  project_name: 'demo',
  branch: 'main',
  head_oid: '0123456789abcdef0123456789abcdef01234567',
  clean: false,
  conflicted: false,
  captured_at: '2026-08-26T00:00:00.000Z',
  policy_version: 'chat-read-v1.0.0',
  provider_host: 'api.deepseek.com',
  model: 'deepseek-v4-flash',
  included: [
    {
      path: 'README.md',
      source: 'tracked_file',
      bytes: 18,
      sha256: 'a'.repeat(64),
    },
  ],
  omitted: [],
  context_bytes: 512,
  estimated_tokens: 128,
  snapshot_sha256: 'b'.repeat(64),
  source_fingerprint: 'c'.repeat(64),
};

const consent: ProjectContextConsentV1 = {
  schema_version: 1,
  consent_receipt_id: 'consent-1',
  snapshot_id: 'snapshot-1',
  snapshot_sha256: 'b'.repeat(64),
  confirmed_at: '2026-08-26T00:00:01.000Z',
};

const PREPARATION_ID = 'preparation-1';

function prepareContext(
  preparedManifest: ProjectContextManifestV1 = manifest,
  state: ProjectContextState = createProjectContextState('project-1'),
  preparationId = PREPARATION_ID,
): ProjectContextState {
  const checking = projectContextReducer(state, {
    type: 'checking',
    preparationId,
  });
  return projectContextReducer(checking, {
    type: 'prepared',
    preparationId,
    manifest: preparedManifest,
  });
}

function confirmContext(
  confirmedManifest: ProjectContextManifestV1 = manifest,
  confirmedConsent: ProjectContextConsentV1 = consent,
  state: ProjectContextState = createProjectContextState('project-1'),
  preparationId = PREPARATION_ID,
): ProjectContextState {
  const prepared = prepareContext(confirmedManifest, state, preparationId);
  return projectContextReducer(prepared, {
    type: 'confirmed',
    preparationId,
    manifest: confirmedManifest,
    consent: confirmedConsent,
  });
}

describe('project context state', () => {
  test('requires setup before a bound project can be ready', () => {
    expect(createProjectContextState('project-1')).toEqual({
      schemaVersion: 1,
      projectId: 'project-1',
      status: 'setup_required',
      selectedPaths: [],
      activePreparationId: null,
      snapshot: null,
      consent: null,
      staleReason: null,
      errorCode: null,
    });
  });

  test('moves to checking and clears transient failure state', () => {
    const failed = {
      ...createProjectContextState('project-1'),
      status: 'error' as const,
      staleReason: 'project_changed' as const,
      errorCode: 'E_CONTEXT_CHANGED' as const,
    };

    expect(
      projectContextReducer(failed, {
        type: 'checking',
        preparationId: PREPARATION_ID,
      }),
    ).toEqual({
      ...failed,
      status: 'checking',
      activePreparationId: PREPARATION_ID,
      staleReason: null,
      errorCode: null,
    });
  });

  test('stores a prepared manifest without making it sendable', () => {
    const prepared = prepareContext();

    expect(prepared).toMatchObject({
      status: 'setup_required',
      activePreparationId: PREPARATION_ID,
      snapshot: manifest,
      consent: null,
      staleReason: null,
      errorCode: null,
    });
  });

  test('confirms an exact manifest and consent pair as ready', () => {
    const ready = confirmContext();

    expect(ready).toMatchObject({
      status: 'ready',
      activePreparationId: null,
      snapshot: manifest,
      consent,
      staleReason: null,
      errorCode: null,
    });
    expect(isProjectContextSendable(ready)).toBe(true);
  });

  test('ignores confirmation that does not match the prepared manifest', () => {
    const prepared = prepareContext();
    const mismatch = projectContextReducer(prepared, {
      type: 'confirmed',
      preparationId: PREPARATION_ID,
      manifest,
      consent: { ...consent, snapshot_sha256: 'd'.repeat(64) },
    });

    expect(mismatch).toBe(prepared);
    expect(isProjectContextSendable(mismatch)).toBe(false);
  });

  test('ignores direct confirmation that belongs to another project', () => {
    const initial = createProjectContextState('project-1');
    const crossProject = projectContextReducer(
      initial,
      {
        type: 'confirmed',
        preparationId: PREPARATION_ID,
        manifest: { ...manifest, project_id: 'project-2' },
        consent,
      },
    );

    expect(crossProject).toBe(initial);
    expect(isProjectContextSendable(crossProject)).toBe(false);
    expect(() => serializeProjectContextState(crossProject)).not.toThrow();
    expect(
      isProjectContextSendable({
        ...createProjectContextState('project-1'),
        status: 'ready',
        snapshot: { ...manifest, project_id: 'project-2' },
        consent,
      }),
    ).toBe(false);
  });

  test('keeps manifests with omissions partial across confirmation', () => {
    const partialManifest = {
      ...manifest,
      omitted: [{ path: '.env', reason: 'secret_path' as const }],
    };
    const prepared = prepareContext(partialManifest);
    const confirmed = projectContextReducer(prepared, {
      type: 'confirmed',
      preparationId: PREPARATION_ID,
      manifest: partialManifest,
      consent,
    });

    expect(prepared.status).toBe('partial');
    expect(isProjectContextSendable(prepared)).toBe(false);
    expect(confirmed.status).toBe('partial');
    expect(isProjectContextSendable(confirmed)).toBe(true);
  });

  test('marks confirmed context stale when the project changes', () => {
    const ready = confirmContext();
    const stale = projectContextReducer(ready, { type: 'project_changed' });

    expect(stale.status).toBe('stale');
    expect(stale.staleReason).toBe('project_changed');
    expect(stale.errorCode).toBeNull();
    expect(isProjectContextSendable(stale)).toBe(false);
  });

  test('invalidates confirmed context only when the model differs', () => {
    const ready = confirmContext();

    expect(
      projectContextReducer(ready, {
        type: 'model_changed',
        model: 'deepseek-v4-flash',
      }),
    ).toBe(ready);

    const stale = projectContextReducer(ready, {
      type: 'model_changed',
      model: 'deepseek-v4-pro',
    });
    expect(stale.status).toBe('stale');
    expect(stale.staleReason).toBe('model_changed');
  });

  test('invalidates confirmed context only when the provider differs', () => {
    const ready = confirmContext();

    expect(
      projectContextReducer(ready, {
        type: 'provider_changed',
        providerHost: 'api.deepseek.com',
      }),
    ).toBe(ready);

    const stale = projectContextReducer(ready, {
      type: 'provider_changed',
      providerHost: 'proxy.example.com',
    });
    expect(stale.status).toBe('stale');
    expect(stale.staleReason).toBe('provider_changed');
  });

  test('invalidates confirmed context only when the policy differs', () => {
    const ready = confirmContext();

    expect(
      projectContextReducer(ready, {
        type: 'policy_changed',
        policyVersion: 'chat-read-v1.0.0',
      }),
    ).toBe(ready);

    const stale = projectContextReducer(ready, {
      type: 'policy_changed',
      policyVersion: 'chat-read-v1.0.1',
    });
    expect(stale.status).toBe('stale');
    expect(stale.staleReason).toBe('policy_changed');
  });

  test('normalizes selections and invalidates only a changed confirmed set', () => {
    const selected = projectContextReducer(
      createProjectContextState('project-1'),
      {
        type: 'selection_changed',
        selectedPaths: ['src/z.ts', 'README.md', 'src/z.ts'],
      },
    );
    expect(selected.status).toBe('setup_required');
    expect(selected.selectedPaths).toEqual(['README.md', 'src/z.ts']);

    const ready = confirmContext(manifest, consent, selected);
    expect(
      projectContextReducer(ready, {
        type: 'selection_changed',
        selectedPaths: ['src/z.ts', 'README.md', 'README.md'],
      }),
    ).toBe(ready);

    const stale = projectContextReducer(ready, {
      type: 'selection_changed',
      selectedPaths: ['src/other.ts'],
    });
    expect(stale.status).toBe('stale');
    expect(stale.staleReason).toBe('selection_changed');
    expect(stale.selectedPaths).toEqual(['src/other.ts']);
    expect(stale.consent).toBeNull();
  });

  test('marks a missing native snapshot stale and clears consent', () => {
    const ready = confirmContext();
    const stale = projectContextReducer(ready, { type: 'snapshot_missing' });

    expect(stale).toMatchObject({
      status: 'stale',
      snapshot: manifest,
      consent: null,
      staleReason: 'snapshot_missing',
      errorCode: null,
    });
  });

  test('records a stable native failure code', () => {
    const checking = projectContextReducer(
      createProjectContextState('project-1'),
      { type: 'checking', preparationId: PREPARATION_ID },
    );
    const failed = projectContextReducer(
      checking,
      {
        type: 'failed',
        preparationId: PREPARATION_ID,
        errorCode: 'E_CONTEXT_TIMEOUT',
      },
    );

    expect(failed).toEqual({
      ...createProjectContextState('project-1'),
      status: 'error',
      errorCode: 'E_CONTEXT_TIMEOUT',
    });
  });

  test('represents an unavailable native context service', () => {
    const checking = projectContextReducer(
      createProjectContextState('project-1'),
      { type: 'checking', preparationId: PREPARATION_ID },
    );
    const failed = projectContextReducer(
      checking,
      {
        type: 'failed',
        preparationId: PREPARATION_ID,
        errorCode: 'E_PROJECT_NOT_FOUND',
      },
    );
    const unavailable = projectContextReducer(failed, {
      type: 'unavailable',
    });

    expect(unavailable).toEqual({
      ...createProjectContextState('project-1'),
      status: 'unavailable',
    });
  });

  test('disables context by clearing all persisted references', () => {
    let state = projectContextReducer(
      createProjectContextState('project-1'),
      { type: 'selection_changed', selectedPaths: ['README.md'] },
    );
    state = confirmContext(manifest, consent, state);

    expect(projectContextReducer(state, { type: 'disabled' })).toEqual(
      createProjectContextState('project-1'),
    );
  });

  test('ignores obsolete preparation responses after invalidation or replacement', () => {
    const initial = createProjectContextState('project-1');
    const checkingA = projectContextReducer(initial, {
      type: 'checking',
      preparationId: 'preparation-a',
    });
    const invalidated = projectContextReducer(checkingA, {
      type: 'project_changed',
    });
    expect(invalidated).toMatchObject({
      status: 'stale',
      activePreparationId: null,
      staleReason: 'project_changed',
    });
    expect(
      projectContextReducer(invalidated, {
        type: 'prepared',
        preparationId: 'preparation-a',
        manifest,
      }),
    ).toBe(invalidated);
    expect(
      projectContextReducer(invalidated, {
        type: 'confirmed',
        preparationId: 'preparation-a',
        manifest,
        consent,
      }),
    ).toBe(invalidated);

    const checkingB = projectContextReducer(checkingA, {
      type: 'checking',
      preparationId: 'preparation-b',
    });
    expect(
      projectContextReducer(checkingB, {
        type: 'prepared',
        preparationId: 'preparation-a',
        manifest,
      }),
    ).toBe(checkingB);

    const preparedA = projectContextReducer(checkingA, {
      type: 'prepared',
      preparationId: 'preparation-a',
      manifest,
    });
    const modelChanged = projectContextReducer(preparedA, {
      type: 'model_changed',
      model: 'deepseek-v4-pro',
    });
    expect(modelChanged).toMatchObject({
      status: 'stale',
      activePreparationId: null,
      staleReason: 'model_changed',
    });
    expect(
      projectContextReducer(modelChanged, {
        type: 'confirmed',
        preparationId: 'preparation-a',
        manifest,
        consent,
      }),
    ).toBe(modelChanged);
  });

  test('applies failures only to the active preparation', () => {
    const checkingA = projectContextReducer(
      createProjectContextState('project-1'),
      { type: 'checking', preparationId: 'preparation-a' },
    );
    const checkingB = projectContextReducer(checkingA, {
      type: 'checking',
      preparationId: 'preparation-b',
    });
    const afterLateFailure = projectContextReducer(checkingB, {
      type: 'failed',
      preparationId: 'preparation-a',
      errorCode: 'E_CONTEXT_TIMEOUT',
    });
    expect(afterLateFailure).toBe(checkingB);

    const preparedB = projectContextReducer(afterLateFailure, {
      type: 'prepared',
      preparationId: 'preparation-b',
      manifest,
    });
    expect(preparedB.snapshot).toBe(manifest);
    const matchingFailure = projectContextReducer(preparedB, {
      type: 'failed',
      preparationId: 'preparation-b',
      errorCode: 'E_CONTEXT_TIMEOUT',
    });
    expect(matchingFailure).toMatchObject({
      status: 'error',
      activePreparationId: null,
      snapshot: manifest,
      consent: null,
      staleReason: null,
      errorCode: 'E_CONTEXT_TIMEOUT',
    });

    const ready = confirmContext();
    expect(
      projectContextReducer(ready, {
        type: 'failed',
        preparationId: PREPARATION_ID,
        errorCode: 'E_CONTEXT_TIMEOUT',
      }),
    ).toBe(ready);
    const stale = projectContextReducer(ready, { type: 'project_changed' });
    expect(
      projectContextReducer(stale, {
        type: 'failed',
        preparationId: PREPARATION_ID,
        errorCode: 'E_CONTEXT_TIMEOUT',
      }),
    ).toBe(stale);
  });
});

describe('strict project context persistence', () => {
  test('serializes deterministically and round-trips metadata references', () => {
    const ready = confirmContext(
      manifest,
      consent,
      {
        ...createProjectContextState('project-1'),
        selectedPaths: ['src/z.ts', 'README.md'],
      },
    );

    const first = serializeProjectContextState(ready);
    const second = serializeProjectContextState(ready);
    expect(first).toBe(second);
    expect(JSON.parse(first)).toEqual({
      schema_version: 1,
      project_id: 'project-1',
      status: 'ready',
      selected_paths: ['README.md', 'src/z.ts'],
      active_preparation_id: null,
      manifest,
      consent,
      stale_reason: null,
      error_code: null,
    });
    expect(hydrateProjectContextState(first)).toEqual({
      ...ready,
      selectedPaths: ['README.md', 'src/z.ts'],
    });
  });

  test('rejects every contradictory persisted status combination', () => {
    const initial = createProjectContextState('project-1');
    const ready = confirmContext();
    const partialManifest: ProjectContextManifestV1 = {
      ...manifest,
      omitted: [{ path: '.env', reason: 'secret_path' }],
    };
    const partialPrepared = prepareContext(partialManifest);
    const initialPayload = JSON.parse(
      serializeProjectContextState(initial),
    ) as Record<string, unknown>;
    const readyPayload = JSON.parse(
      serializeProjectContextState(ready),
    ) as Record<string, unknown>;
    const partialPreparedPayload = JSON.parse(
      serializeProjectContextState(partialPrepared),
    ) as Record<string, unknown>;

    expect(() =>
      serializeProjectContextState({ ...initial, status: 'ready' }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({
        ...readyPayload,
        stale_reason: 'project_changed',
      }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({
        ...readyPayload,
        error_code: 'E_CONTEXT_CHANGED',
      }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({ ...initialPayload, status: 'error' }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({ ...initialPayload, status: 'stale' }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({
        ...readyPayload,
        status: 'unavailable',
        consent: null,
      }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({ ...readyPayload, status: 'partial' }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({
        ...partialPreparedPayload,
        status: 'setup_required',
      }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({
        ...readyPayload,
        consent: { ...consent, snapshot_id: 'snapshot-2' },
      }),
    ).toThrow(/snapshot_id/);
  });

  test('requires the exact persisted top-level key set', () => {
    const ready = confirmContext();
    const payload = JSON.parse(serializeProjectContextState(ready)) as Record<
      string,
      unknown
    >;
    const missing = { ...payload };
    delete missing.status;

    expect(() =>
      hydrateProjectContextState({ ...payload, raw_content: 'secret' }),
    ).toThrow(/raw_content/);
    expect(() => hydrateProjectContextState(missing)).toThrow(/status/);
  });

  test('accepts schema 1 only', () => {
    const payload = JSON.parse(
      serializeProjectContextState(createProjectContextState('project-1')),
    ) as Record<string, unknown>;

    expect(() =>
      hydrateProjectContextState({ ...payload, schema_version: 2 }),
    ).toThrow(/schema_version/);
  });

  test('rejects unknown state enum values', () => {
    const payload = JSON.parse(
      serializeProjectContextState(createProjectContextState('project-1')),
    ) as Record<string, unknown>;

    expect(() =>
      hydrateProjectContextState({ ...payload, status: 'prepared' }),
    ).toThrow(/status/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        stale_reason: 'thinking_changed',
      }),
    ).toThrow(/stale_reason/);
    expect(() =>
      hydrateProjectContextState({ ...payload, error_code: 'E_RAW_SECRET' }),
    ).toThrow(/error_code/);
  });

  test('rejects duplicate persisted selected paths', () => {
    const payload = JSON.parse(
      serializeProjectContextState(createProjectContextState('project-1')),
    ) as Record<string, unknown>;

    expect(() =>
      hydrateProjectContextState({
        ...payload,
        selected_paths: ['README.md', 'README.md'],
      }),
    ).toThrow(/selected_paths/);
  });

  test('rejects raw content fields in manifest metadata', () => {
    const ready = confirmContext();
    const payload = JSON.parse(serializeProjectContextState(ready)) as {
      manifest: Record<string, unknown> & {
        included: Array<Record<string, unknown>>;
      };
    };

    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: {
          ...payload.manifest,
          raw_content: 'UNIQUE_PROJECT_SECRET',
        },
      }),
    ).toThrow(/raw_content/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: {
          ...payload.manifest,
          included: [
            { ...payload.manifest.included[0], content: 'file bytes' },
          ],
        },
      }),
    ).toThrow(/content/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: {
          ...payload.manifest,
          omitted: [
            {
              path: '.env',
              reason: 'secret_path',
              content: 'secret bytes',
            },
          ],
        },
      }),
    ).toThrow(/content/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        consent: { ...consent, raw_content: 'UNIQUE_PROJECT_SECRET' },
      }),
    ).toThrow(/raw_content/);
  });

  test('requires lowercase SHA-256 digests throughout', () => {
    const ready = confirmContext();
    const payload = JSON.parse(serializeProjectContextState(ready)) as {
      manifest: typeof manifest;
      consent: typeof consent;
    };

    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: { ...payload.manifest, snapshot_sha256: 'B'.repeat(64) },
      }),
    ).toThrow(/snapshot_sha256/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: {
          ...payload.manifest,
          included: [
            { ...payload.manifest.included[0], sha256: 'g'.repeat(64) },
          ],
        },
      }),
    ).toThrow(/sha256/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: {
          ...payload.manifest,
          source_fingerprint: 'c'.repeat(63),
        },
      }),
    ).toThrow(/source_fingerprint/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        consent: { ...payload.consent, snapshot_sha256: 'B'.repeat(64) },
      }),
    ).toThrow(/snapshot_sha256/);
  });

  test('validates manifest and consent timestamps and enums', () => {
    const ready = confirmContext();
    const payload = JSON.parse(serializeProjectContextState(ready)) as {
      manifest: typeof manifest;
      consent: typeof consent;
    };

    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: { ...payload.manifest, captured_at: 'yesterday' },
      }),
    ).toThrow(/captured_at/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        consent: { ...payload.consent, confirmed_at: 'later' },
      }),
    ).toThrow(/confirmed_at/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: { ...payload.manifest, model: 'deepseek-v3' },
      }),
    ).toThrow(/model/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: {
          ...payload.manifest,
          included: [
            { ...payload.manifest.included[0], source: 'raw_file' },
          ],
        },
      }),
    ).toThrow(/source/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: {
          ...payload.manifest,
          omitted: [{ path: '.env', reason: 'unknown_reason' }],
        },
      }),
    ).toThrow(/reason/);
    const noFraction = hydrateProjectContextState({
      ...payload,
      manifest: {
        ...payload.manifest,
        captured_at: '2026-08-26T00:00:00Z',
      },
    });
    expect(noFraction.snapshot?.captured_at).toBe('2026-08-26T00:00:00Z');
  });

  test('rejects duplicate included manifest paths', () => {
    const ready = confirmContext();
    const payload = JSON.parse(serializeProjectContextState(ready)) as {
      manifest: typeof manifest;
    };
    const included = payload.manifest.included[0]!;

    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: { ...payload.manifest, included: [included, included] },
      }),
    ).toThrow(/included/);
  });

  test('rejects mismatched project, snapshot, and consent references', () => {
    const ready = confirmContext();
    const payload = JSON.parse(serializeProjectContextState(ready)) as {
      manifest: typeof manifest;
      consent: typeof consent;
    };

    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: { ...payload.manifest, project_id: 'project-2' },
      }),
    ).toThrow(/project_id/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        consent: { ...payload.consent, snapshot_id: 'snapshot-2' },
      }),
    ).toThrow(/snapshot_id/);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        consent: { ...payload.consent, snapshot_sha256: 'd'.repeat(64) },
      }),
    ).toThrow(/snapshot_sha256/);
  });

  test('refuses to serialize raw project content from an unsafe state', () => {
    const unsafeManifest = {
      ...manifest,
      raw_content: 'UNIQUE_PROJECT_SECRET',
    } as unknown as typeof manifest;
    const unsafe = confirmContext(unsafeManifest);

    expect(() => serializeProjectContextState(unsafe)).toThrow(/raw_content/);
  });

  test('rejects a non-enumerable unsafe toJSON before serialization', () => {
    const unsafeManifest = { ...manifest };
    Object.defineProperty(unsafeManifest, 'toJSON', {
      enumerable: false,
      value: () => ({ raw_content: 'UNIQUE_PROJECT_SECRET' }),
    });
    const unsafe = confirmContext(unsafeManifest);

    expect(() => serializeProjectContextState(unsafe)).toThrow(/toJSON/);
  });

  test('rejects hostile array shapes without invoking caller methods', () => {
    const ready = confirmContext();
    const payload = JSON.parse(serializeProjectContextState(ready)) as {
      selected_paths: string[];
      manifest: typeof manifest;
    };

    let mapCalls = 0;
    const maliciousIncluded = [...payload.manifest.included];
    Object.defineProperty(maliciousIncluded, 'map', {
      enumerable: false,
      value: () => {
        mapCalls += 1;
        const result: unknown[] = [];
        Object.defineProperty(result, 'toJSON', {
          value: () => [{ raw_content: 'UNIQUE_PROJECT_SECRET' }],
        });
        return result;
      },
    });
    expect(() =>
      serializeProjectContextState({
        ...ready,
        snapshot: { ...manifest, included: maliciousIncluded },
      }),
    ).toThrow(/included/);
    expect(mapCalls).toBe(0);

    const sparseOmitted = new Array(2) as Array<
      (typeof manifest.omitted)[number]
    >;
    sparseOmitted[0] = { path: '.env', reason: 'secret_path' };
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        status: 'partial',
        consent: null,
        manifest: { ...payload.manifest, omitted: sparseOmitted },
      }),
    ).toThrow(/omitted/);

    let getterCalls = 0;
    const accessorSelection = ['README.md'];
    Object.defineProperty(accessorSelection, '0', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return 'README.md';
      },
    });
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        selected_paths: accessorSelection,
      }),
    ).toThrow(/selected_paths/);
    expect(getterCalls).toBe(0);

    const extraProperty = [...payload.manifest.included] as Array<
      (typeof manifest.included)[number]
    > & { raw_content?: string };
    extraProperty.raw_content = 'UNIQUE_PROJECT_SECRET';
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: { ...payload.manifest, included: extraProperty },
      }),
    ).toThrow(/included/);

    const inheritedOverride = [...payload.manifest.included];
    const hostilePrototype = Object.create(Array.prototype) as {
      map?: unknown;
    };
    hostilePrototype.map = () => [];
    Object.setPrototypeOf(inheritedOverride, hostilePrototype);
    expect(() =>
      hydrateProjectContextState({
        ...payload,
        manifest: { ...payload.manifest, included: inheritedOverride },
      }),
    ).toThrow(/included/);

    const originalToJSON = Object.getOwnPropertyDescriptor(
      Object.prototype,
      'toJSON',
    );
    try {
      // eslint-disable-next-line no-extend-native -- verifies inherited pollution is rejected
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => ({ raw_content: 'UNIQUE_PROJECT_SECRET' }),
      });
      expect(() => serializeProjectContextState(ready)).toThrow(
        /array semantics|serialization/,
      );
    } finally {
      if (originalToJSON === undefined) {
        Reflect.deleteProperty(Object.prototype, 'toJSON');
      } else {
        // eslint-disable-next-line no-extend-native -- restores a pre-existing descriptor exactly
        Object.defineProperty(Object.prototype, 'toJSON', originalToJSON);
      }
    }
  });

  test('rejects hostile record descriptors without invoking accessors or mutable sort', () => {
    const ready = confirmContext(
      manifest,
      consent,
      {
        ...createProjectContextState('project-1'),
        selectedPaths: ['src/z.ts', 'README.md'],
      },
    );
    const payload = JSON.parse(serializeProjectContextState(ready)) as {
      manifest: Record<PropertyKey, unknown>;
    };
    const originalSort = Object.getOwnPropertyDescriptor(
      Array.prototype,
      'sort',
    )!;
    let getterCalls = 0;
    const accessorManifest = { ...payload.manifest };
    Object.defineProperty(accessorManifest, 'snapshot_id', {
      configurable: true,
      enumerable: true,
      get: () => {
        getterCalls += 1;
        // eslint-disable-next-line no-extend-native -- adversarial accessor mutation
        Object.defineProperty(Array.prototype, 'sort', {
          configurable: true,
          writable: true,
          value: function hostileSort() {
            return this;
          },
        });
        return 'snapshot-1';
      },
    });
    try {
      expect(() =>
        hydrateProjectContextState({
          ...payload,
          manifest: accessorManifest,
        }),
      ).toThrow(/snapshot_id/);
      expect(getterCalls).toBe(0);
    } finally {
      // eslint-disable-next-line no-extend-native -- restores native descriptor exactly
      Object.defineProperty(Array.prototype, 'sort', originalSort);
    }

    for (const hiddenKey of ['raw_content', 'toJSON']) {
      const hiddenManifest = { ...payload.manifest };
      Object.defineProperty(hiddenManifest, hiddenKey, {
        configurable: true,
        enumerable: false,
        value: 'UNIQUE_PROJECT_SECRET',
      });
      expect(() =>
        hydrateProjectContextState({
          ...payload,
          manifest: hiddenManifest,
        }),
      ).toThrow(new RegExp(hiddenKey));
    }

    const symbolManifest = { ...payload.manifest };
    const rawSymbol = Symbol('raw_content');
    symbolManifest[rawSymbol] = 'UNIQUE_PROJECT_SECRET';
    expect(() =>
      hydrateProjectContextState({ ...payload, manifest: symbolManifest }),
    ).toThrow(/symbol/);

    let sortCalls = 0;
    try {
      // eslint-disable-next-line no-extend-native -- verifies mutable global sort is not called
      Object.defineProperty(Array.prototype, 'sort', {
        configurable: true,
        writable: true,
        value: function hostileSort() {
          sortCalls += 1;
          return this;
        },
      });
      const serialized = serializeProjectContextState(ready);
      expect(serialized).not.toContain('UNIQUE_PROJECT_SECRET');
      expect(sortCalls).toBe(0);
    } finally {
      // eslint-disable-next-line no-extend-native -- restores native descriptor exactly
      Object.defineProperty(Array.prototype, 'sort', originalSort);
    }
  });
});
