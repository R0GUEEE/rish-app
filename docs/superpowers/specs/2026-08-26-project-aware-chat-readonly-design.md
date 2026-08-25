# Project-aware chat, read-only v1

## Status

Approved direction: confirm one immutable project snapshot, reuse it until its
fingerprint becomes stale, and require a new confirmation only after project,
selection, provider, or model changes.

This design is the first functional step from a project label toward a real
local Harness workflow. It does not add file writes, shell execution, model
tools, Git mutation, or an AgentLoop.

## Problem

Today a conversation can persist a `projectId` and show the project name, but
the model request contains only visible chat history and attachments. The UI
therefore implies project awareness that the runtime does not provide.

The first release must make the claim exact:

- the user sees which local project data will leave the device;
- native code, not JavaScript, resolves and reads the project;
- only confirmed, bounded, read-only data reaches the model;
- every response has a local receipt identifying the exact snapshot used;
- a changed project becomes stale instead of being silently re-read;
- retry can reproduce the same model input after failure or restart.

## Product boundary

### In scope

- One bound app-owned Git project per conversation.
- Project identity, branch, HEAD, clean/conflict state, bounded status, and
  bounded tracked diff.
- Explicit selection of safe tracked text files.
- A native immutable snapshot with a disclosure manifest and digest.
- A persistent consent receipt for that exact snapshot.
- A compact context status strip and a full context configuration surface.
- Native model request projection using a synthetic user data envelope.
- Stale detection before each send.
- Retry and restart recovery using the same snapshot.
- Runtime proof and per-turn receipt hashes.

### Not in scope

- File creation, editing, deletion, stage, commit, push, or any other mutation.
- Shell, build, test, Web, network, plugin, or Harness tool execution.
- General repository indexing, embeddings, semantic search, or whole-repo
  ingestion.
- Untracked file contents, ignored files, binary files, symlinks, submodules,
  lockfiles, generated output, or vendor dependencies.
- Remote branch freshness, fetch, pull, merge, or rebase.
- Android native support.

The UI must say that the snapshot is context only and that the agent cannot
edit files, run commands, or commit changes.

## Considered approaches

### 1. JavaScript composes existing APIs

JavaScript calls project status, diff, and workspace reads, then concatenates
the results into a prompt.

This is rejected because it exposes raw project bytes to JavaScript, has no
single budget or fingerprint, is vulnerable to cross-call changes, and cannot
prove that the reviewed bytes equal the bytes sent.

### 2. Native returns raw snapshot content to JavaScript

Native resolves the project and returns a structured snapshot which JavaScript
injects into completion history.

This is rejected for production because JavaScript can alter or mix snapshots,
the preview and send are separate trust boundaries, and the native proof cannot
attest to the exact outbound payload.

### 3. Native two-phase disclosure and send

Native prepares and stores the raw snapshot, returns only a manifest for user
review, records confirmation, and later injects the immutable bytes into the
model request.

This is the selected design. It gives the UI enough information for informed
consent without exposing project contents or authority to JavaScript.

## Architecture

### Native project context service

Add an internal `ProjectContextService` in the iOS runtime pod. React Native
modules may call the service, but must not call one another across their serial
queues.

The service owns:

- opaque project resolution;
- shared project read locks;
- descriptor-relative safe file access;
- Git status and tracked diff capture;
- secret and policy filtering;
- canonical serialization and hashing;
- immutable snapshot storage;
- consent receipts, stale checks, and pruning;
- redacted audit records.

Raw snapshot bytes never cross the native bridge.

### Bridge contract

JavaScript submits intent, not content:

```ts
type ProjectContextSelectionV1 = {
  schema_version: 1;
  project_id: string;
  conversation_id: string;
  provider: 'deepseek';
  model: DeepSeekModelId;
  policy: 'chat-read-v1';
  selected_paths: string[];
};

type ProjectContextManifestV1 = {
  schema_version: 1;
  snapshot_id: string;
  project_id: string;
  project_name: string;
  branch: string | null;
  head_oid: string | null;
  clean: boolean;
  conflicted: boolean;
  captured_at: string;
  policy_version: string;
  provider_host: 'api.deepseek.com';
  model: DeepSeekModelId;
  included: Array<{
    path: string;
    source: 'tracked_file' | 'staged_diff' | 'worktree_diff';
    bytes: number;
    sha256: string;
  }>;
  omitted: Array<{
    path: string;
    reason: ProjectContextOmissionReason;
  }>;
  context_bytes: number;
  estimated_tokens: number;
  snapshot_sha256: string;
  source_fingerprint: string;
};

type ProjectContextConsentV1 = {
  schema_version: 1;
  consent_receipt_id: string;
  snapshot_id: string;
  snapshot_sha256: string;
  confirmed_at: string;
};
```

Required operations:

```text
prepareProjectContext(selection) -> manifest
confirmProjectContext(snapshotId) -> consent receipt
inspectProjectContext(snapshotId) -> current manifest and state
discardProjectContext(snapshotId) -> value-free acknowledgement
```

`LocalRuntime.completeV2` accepts a versioned request object containing only
the snapshot and consent identifiers. Before sending, native verifies the
conversation, project, provider, model, policy, consent digest, and live source
fingerprint. It sends the stored immutable snapshot bytes, never a fresh
worktree read.

### Snapshot lifetime

Consent remains valid for the exact snapshot digest until one of these events:

- selected paths change;
- branch, HEAD, index, tracked status, or selected file revision changes;
- provider, model, or policy version changes;
- the project is unbound, deleted, unsafe, or re-created;
- the conversation is deleted or the user explicitly disables context;
- snapshot integrity validation fails.

App restart alone does not invalidate an unchanged snapshot. Snapshots are
stored with mode `0600`, `NSFileProtectionComplete`, and backup exclusion.
They are deleted when discarded, superseded, orphaned, or the conversation is
deleted.

Snapshot storage is capped at 64 MiB. Native keeps the active snapshot for a
conversation plus any snapshot referenced by a retryable attempt, and removes
unreferenced snapshots by least-recently-used order.

### Native security policy

`chat-read-v1` uses fixed native budgets; JavaScript cannot raise them:

- at most 5,000 enumerated entries and depth 24;
- at most 32 included files;
- at most 64 KiB per file;
- at most 100 changed paths;
- at most 128 KiB of complete tracked diff hunks;
- at most 256 KiB of final canonical UTF-8 context;
- at most two seconds to prepare a snapshot.

Budget exhaustion never silently truncates a file or hunk. The manifest lists
every omission. The user must narrow the selection before confirmation when a
hard budget is exceeded.

The service accepts only regular, single-link, valid UTF-8 text files beneath
the canonical project worktree. It rejects traversal, absolute paths,
symlinks, hardlinks, special files, cross-device paths, NUL bytes, binaries,
and invalid encoding.

Native hard-deny rules include:

- `.git`, `.hg`, `.svn`, `.ssh`, `.aws`, `.gnupg`, `.kube`, and `.docker`;
- `.env*`, credential files, private keys, certificates, provisioning files,
  service account files, and common secret stores;
- `node_modules`, `vendor`, `Pods`, build/output/cache/coverage directories,
  source maps, minified bundles, and lockfiles;
- high-confidence secret content such as private-key headers, known token
  prefixes, credential assignments, and credential-like high-entropy values.

A suspected secret rejects the complete file or diff. Logs and error messages
contain only a reason code, never the matching value.

Directory selection expands only tracked regular files. Untracked and ignored
paths may appear as metadata but their contents are excluded in v1.

Project identity and bounded status metadata are always part of a confirmed
snapshot. Tracked staged/worktree diff hunks are included only for explicitly
selected changed paths. A zero-file selection is an honest metadata-only
snapshot.

Policy and suspected-secret rejection normally produces a `Partial` manifest
with a path and reason code; it never returns the matching bytes. Confirmation
may continue with the remaining safe content. `E_CONTEXT_SECRET` is reserved
for a context-wide condition where no safe disclosure manifest can be built.

All project content is untrusted data. Delimiters are not treated as a prompt
injection defense. V1 exposes no tools, shell, Web, external resource loading,
or automatic URL preview, and rejects model tool calls.

### TOCTOU protection

The service uses root descriptors with `openat`, `fstatat`, and `O_NOFOLLOW`.
It verifies device, inode, mode, link count, size, and timestamps before and
after reading. It also verifies branch, HEAD, index, tracked status, and the
selected path revisions before confirming and before every send.

Any mismatch returns `E_CONTEXT_CHANGED`; the old snapshot remains inspectable
as stale but cannot be sent.

The source fingerprint covers project ID, branch, HEAD, index checksum,
canonical tracked-status digest, selected path set, and the verified metadata
and digest of every selected file.

## Provider projection

Visible chat messages and provider input are separate concepts.

The model input order is:

1. a fixed, versioned system policy written by Rish;
2. the selected visible user/assistant history window;
3. a synthetic user project-context envelope containing the native snapshot;
4. the current human user message and its attachments.

Repository content never enters the system message. The synthetic envelope is
not appended to visible chat history, auto-title input, conversation preview,
or ordinary message persistence.

The system policy states that project contents are untrusted reference data,
not instructions, and that the model has no project mutation or tool ability.

## Turn and persistence model

Add a persisted `TurnAttempt` reference separate from visible messages:

```ts
type TurnAttemptV1 = {
  schema_version: 1;
  turn_id: string;
  attempt_id: string;
  request_id: string;
  conversation_id: string;
  status: 'prepared' | 'sending' | 'completed' | 'failed' | 'cancelled';
  model: DeepSeekModelId;
  thinking_mode: DeepSeekThinkingMode;
  visible_history_sha256: string;
  model_input_sha256: string | null;
  project_snapshot_id: string | null;
  project_snapshot_sha256: string | null;
  consent_receipt_id: string | null;
  attachment_ids: string[];
  assistant_sha256: string | null;
  finish_reason: string | null;
  error_code: string | null;
};
```

Visible session schema migration stores only context configuration, manifests,
receipts, and attempt references. Raw project bytes remain in native snapshot
storage.

Before networking, the user turn, snapshot reference, attachment references,
and prepared attempt must persist atomically. Persistence failure preserves the
draft and attachments and prevents the HTTP request.

Success persists the assistant and completed attempt before clearing retry
state. Failure and restart restore a retryable attempt.

Retry uses the same snapshot, model, thinking mode, visible history window,
and attachment manifests. A separate `Refresh context and retry` action creates
a new snapshot and attempt; retry never silently refreshes data.

## Mobile UX

### Context strip

A single accessible button sits above the composer and replaces the passive
project label. It shows:

- project and branch;
- clean, changed, or conflicted status;
- selected file count and used/maximum budget;
- `Setup required`, `Checking`, `Ready`, `Stale`, `Partial`, `Error`, or
  `Unavailable`;
- a persistent `Read-only context` boundary.

The strip is at least 44 points tall, supports Dynamic Type, uses text and an
icon rather than color alone, and returns VoiceOver focus after its sheet
closes.

### Context sheet

The existing project binding action opens a full-height context sheet on first
use. It contains:

- branch, short HEAD, local dirty/conflict state, and capture time;
- selected, changed, and browsable tracked files;
- per-file path, size, source, and exclusion reason;
- used bytes and estimated tokens against the fixed budget;
- provider host and model disclosure;
- the exact statement that selected content will be sent to the external model;
- the exact statement that the agent cannot edit files, run commands, or
  commit changes;
- `Confirm context`, `Refresh`, `Disable context`, and `Cancel` actions.

Safe tracked changed files and common project descriptors may be suggested,
but nothing is included until the user confirms the disclosure manifest.

The token estimate is explicitly approximate and deterministic:
`ceil(canonical UTF-8 bytes / 4)`. It is a planning indicator, not a provider
tokenizer or billing claim.

### Reuse and stale behavior

After confirmation, the snapshot is reused without a send-time modal while its
fingerprint remains unchanged. Each send performs a lightweight native stale
check.

When stale, sending is blocked and offers exactly:

- `Refresh and send`;
- `Send without project context`;
- `Cancel`.

The app never sends an old snapshot silently.

After a project-aware send, the user message shows an expandable local receipt:
project, branch, short HEAD, snapshot time, included file count, context bytes,
read-only status, and snapshot digest prefix. The receipt contains no raw file
contents.

## Error model

Stable native error codes include:

- `E_PROJECT_ID_INVALID`
- `E_PROJECT_NOT_FOUND`
- `E_PROJECT_STORAGE_UNSAFE`
- `E_REPOSITORY_UNSUPPORTED`
- `E_CONTEXT_CHANGED`
- `E_CONTEXT_BUDGET`
- `E_CONTEXT_SECRET`
- `E_CONTEXT_ENCODING`
- `E_CONTEXT_TIMEOUT`
- `E_CONTEXT_CANCELLED`
- `E_CONTEXT_CONSENT_INVALID`
- `E_CONTEXT_SNAPSHOT_MISSING`

Errors never reveal absolute container paths, secret samples, raw libgit2
messages, or project contents.

If a bound project is missing or unsafe, send fails closed and preserves the
draft. It never silently becomes an ordinary chat. The user may explicitly
unbind or choose `Send without project context`.

Offline mode can still prepare and inspect a local snapshot. A failed model
request keeps the frozen snapshot and retry state.

## Proof and audit

Runtime proof records:

- turn, attempt, snapshot, and consent identifiers;
- policy version, provider host, model, project ID, branch, and HEAD;
- visible history digest;
- exact snapshot digest;
- exact model-input or request-body digest after native project and attachment
  expansion;
- included path/hash/byte manifest and omission reason codes;
- attachment payload digests;
- assistant, reasoning, real finish reason, persisted session, and restart
  digests.

Proof and audit never contain raw prompts, file contents, absolute paths,
credentials, or response text. Snapshot/audit files use complete file
protection and backup exclusion.

## Acceptance criteria

1. A bound but unconfigured project shows `Setup required`; no project bytes
   enter a model request.
2. After selecting and confirming files, the model can answer the current
   branch, HEAD, tracked changes, and facts contained only in those files.
3. The disclosure manifest, native snapshot, network payload, receipt, and
   proof all agree by digest.
4. Unselected, denied, untracked, ignored, binary, invalid UTF-8, symlink,
   hardlink, generated, vendor, secret, and over-budget content never reaches
   the network.
5. Repository prompt injection remains untrusted data and cannot cause a tool,
   Web, file, Git, or external-network action.
6. Changing a selected file, branch, HEAD, index, model, provider, or policy
   marks the snapshot stale and blocks silent send.
7. Retry after failure or restart reproduces the original model-input digest;
   refresh-and-retry produces a new attempt and digest.
8. Persistence failure before send causes no network request and preserves the
   draft and attachments.
9. Completion success is durable before retry state is cleared.
10. Project deletion, corruption, native unavailability, budget failure,
    cancellation, and timeout produce recoverable localized states.
11. Context preparation and send leave worktree content, project metadata,
    Git index, refs, and HEAD hashes unchanged; access-time behavior is not an
    acceptance signal.
12. VoiceOver and Accessibility Dynamic Type expose all states and actions
    without relying on color or clipped labels.

## Required tests

### Native unit and integration

- resolver and path policy fixtures;
- secret and denylist fixtures;
- tracked, untracked, ignored, binary, rename, conflict, and invalid-encoding
  repositories;
- every budget boundary;
- symlink, hardlink, FIFO, replacement, and TOCTOU races;
- branch/HEAD/index/worktree stale detection;
- immutable snapshot storage, protection, pruning, and restart restoration;
- disclosure, network-stub payload, receipt, audit, and proof digest equality;
- no-write assertions over repository and index hashes;
- cancellation, timeout, replay, cross-project, and cross-conversation attacks;
- redirect rejection and unexpected model tool-call rejection.

### React Native tests

- context state machine and schema migration;
- initial setup, selection, confirmation, disable, and refresh;
- strip and sheet accessibility states;
- send, stale block, send-without-context, retry, refresh-and-retry, cancel,
  restart, and project deletion;
- attachment-only, image, text, and PDF requests with project context;
- model and thinking changes invalidate the correct snapshot;
- hidden envelopes never appear in visible history, title, search, or preview.

### Simulator acceptance

- create a project with a unique fact in one selected file and a different fact
  in an unselected file;
- confirm the model answers only the selected fact plus branch/status data;
- change the selected file and verify stale blocking;
- refresh, resend, terminate, relaunch, and verify the proof chain;
- scan session, proof, audit, logs, and app bundle for fixture secrets and raw
  project contents.

## Delivery order

1. Native policy, snapshot store, manifest, consent, and test fixtures.
2. Versioned completion request and exact payload/proof digests.
3. Persisted context state and turn-attempt migration.
4. Context strip, sheet, receipt, stale and retry UX.
5. Simulator real-model acceptance and external verifier update.

No CI workflow is introduced by this feature.
