import {
  assertWorkspaceRootRefV1,
  isWorkspaceRootRefV1,
  workspaceRoot,
} from '../src/native/WorkspaceRoot';

const ID = '11111111-1111-4111-8111-111111111111';

test('constructs the sole opaque workspace root reference', () => {
  const root = workspaceRoot(ID, 3, null);
  expect(root).toEqual({
    schema_version: 1,
    workspace_id: ID,
    binding_revision: 3,
    project_id: null,
  });
  expect(isWorkspaceRootRefV1(root)).toBe(true);
});

test('rejects paths, aliases, noncanonical IDs, and negative zero', () => {
  expect(isWorkspaceRootRefV1({
    schema_version: 1,
    workspace_id: ID,
    binding_revision: 1,
    project_id: '/private/secret',
  })).toBe(false);
  expect(isWorkspaceRootRefV1({
    schema_version: 1,
    workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(),
    binding_revision: 1,
    project_id: null,
  })).toBe(false);
  expect(isWorkspaceRootRefV1({
    schema_version: 1,
    workspace_id: ID,
    binding_revision: -0,
    project_id: null,
  })).toBe(false);
  expect(() => assertWorkspaceRootRefV1({
    schema_version: 1,
    workspace_id: ID,
    binding_revision: 1,
    project_id: null,
    path: 'forbidden',
  })).toThrow(/root reference is invalid/);
});

test('snapshots a changing Proxy once and returns a fresh reference', () => {
  const target = {
    schema_version: 1 as const,
    workspace_id: ID,
    binding_revision: 2,
    project_id: null,
  };
  const changing = new Proxy(target, {
    get(_target, property) {
      if (property === 'workspace_id') return 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      return Reflect.get(target, property);
    },
  });
  const parsed = assertWorkspaceRootRefV1(changing);
  expect(parsed).toEqual(target);
  expect(parsed).not.toBe(target);
});
