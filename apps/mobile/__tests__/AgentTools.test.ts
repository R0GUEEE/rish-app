const stubWorkspace = {
  isAvailable: jest.fn(),
  listDirectory: jest.fn(),
  readText: jest.fn(),
  writeText: jest.fn(),
  capabilities: jest.fn(),
  createDirectory: jest.fn(),
  renameEntry: jest.fn(),
  trashEntry: jest.fn(),
  listTrash: jest.fn(),
  restoreFromTrash: jest.fn(),
  executePortableTool: jest.fn(),
};

const stubProjects = {
  isAvailable: jest.fn(),
  list: jest.fn(),
  create: jest.fn(),
  clone: jest.fn(),
  status: jest.fn(),
  diff: jest.fn(),
  stageAll: jest.fn(),
  commit: jest.fn(),
  setRemote: jest.fn(),
  credentialStatus: jest.fn(),
  presentCredentialPrompt: jest.fn(),
  clearCredential: jest.fn(),
  push: jest.fn(),
};

import { NativeModules } from 'react-native';

(NativeModules as Record<string, unknown>).LocalWorkspace = stubWorkspace;
(NativeModules as Record<string, unknown>).LocalProjects = stubProjects;

const { executeAgentTool } = jest.requireActual(
  '../src/agent/AgentTools',
) as typeof import('../src/agent/AgentTools');

const CTX = { projectId: 'proj-1' };

beforeEach(() => {
  jest.clearAllMocks();
});

test('unbound conversations refuse every tool', async () => {
  const outcome = await executeAgentTool(
    { projectId: '' },
    'read_file',
    '{"path":"README.md"}',
  );
  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toBe('E_AGENT_NO_PROJECT');
});

test('unknown tool names fail safe', async () => {
  const outcome = await executeAgentTool(CTX, 'deploy_prod', '{}');
  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toBe('E_AGENT_UNKNOWN_TOOL');
});

test('malformed argument JSON fails with a structured code', async () => {
  const outcome = await executeAgentTool(CTX, 'read_file', '{broken');
  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toBe('E_AGENT_BAD_ARGUMENTS');
});

test.each([
  ['/etc/passwd'],
  ['../../secrets'],
  ['a/../b'],
])('refuses unsafe path %s', async badPath => {
  const outcome = await executeAgentTool(
    CTX,
    'read_file',
    JSON.stringify({ path: badPath }),
  );
  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toBe('E_AGENT_BAD_PATH');
});

test('list_dir scopes the listing under the bound project repository', async () => {
  stubWorkspace.listDirectory.mockResolvedValue({
    entries: [{ name: 'README.md' }, { name: 'src' }],
  });

  const outcome = await executeAgentTool(
    CTX,
    'list_dir',
    JSON.stringify({ path: 'src' }),
  );

  expect(outcome.ok).toBe(true);
  expect(outcome.outputDigest).toContain('2');
});

test('read_file returns a byte-count digest without leaking content', async () => {
  stubWorkspace.readText.mockResolvedValue({
    file: { name: 'README.md' },
    content: 'Hello Rish',
  });

  const outcome = await executeAgentTool(
    CTX,
    'read_file',
    JSON.stringify({ path: 'README.md' }),
  );

  expect(outcome.ok).toBe(true);
  expect(outcome.outputDigest).toMatch(/^bytes:10:sha1:[0-9a-f]{8}$/);
  expect(JSON.stringify(outcome)).not.toContain('Hello Rish');
  expect(stubWorkspace.readText).toHaveBeenCalledWith(
    'projects/proj-1/repo/README.md',
  );
});

test('write_file passes bounded content through and reports byte count', async () => {
  stubWorkspace.writeText.mockResolvedValue({
    entry: { name: 'NOTES.md' },
    revision: 'rev-1',
  });

  const outcome = await executeAgentTool(
    CTX,
    'write_file',
    JSON.stringify({ path: 'NOTES.md', content: 'Rulof' }),
  );

  expect(outcome.ok).toBe(true);
  expect(outcome.outputDigest).toBe('bytes:5');
  expect(stubWorkspace.writeText).toHaveBeenCalledWith(
    'projects/proj-1/repo/NOTES.md',
    'Rulof',
    false,
    null,
  );
});

test('git_status digests branch head and cleanliness only', async () => {
  stubProjects.status.mockResolvedValue({
    branch: 'main',
    head_oid: '0123456789abcdef',
    clean: true,
    has_conflicts: false,
    entries: [],
  });

  const outcome = await executeAgentTool(CTX, 'git_status', '{}');

  expect(outcome.ok).toBe(true);
  expect(outcome.outputDigest).toBe('main@0123456 clean');
});

test('git_commit uses the fixed agent identity and reports the short oid', async () => {
  stubProjects.stageAll.mockResolvedValue({ entries: [] });
  stubProjects.commit.mockResolvedValue({
    oid: 'feedfacecafebabe',
    summary: 'Add X',
  });

  const outcome = await executeAgentTool(
    CTX,
    'git_commit',
    JSON.stringify({ message: 'Add X' }),
  );

  expect(outcome.ok).toBe(true);
  expect(outcome.outputDigest).toBe('commit:feedfacecafe');
  // The facade expands {message,name,email} into the native positional form.
  expect(stubProjects.commit).toHaveBeenCalledWith(
    'proj-1',
    'Add X',
    'Rish Agent',
    'agent@rish.local',
  );
});

test('git_push surfaces the pushed branch and oid', async () => {
  stubProjects.push.mockResolvedValue({
    branch: 'main',
    oid: 'beefcafef00d',
  });

  const outcome = await executeAgentTool(CTX, 'git_push', '{}');

  expect(outcome.ok).toBe(true);
  expect(outcome.outputDigest).toBe('pushed main@beefcafef00d');
});

test('native rejections map to the transport error text', async () => {
  stubProjects.push.mockRejectedValue(
    new Error('credential missing for github.com'),
  );

  const outcome = await executeAgentTool(CTX, 'git_push', '{}');

  expect(outcome.ok).toBe(false);
  expect(outcome.detail).toBe('credential missing for github.com');
});
