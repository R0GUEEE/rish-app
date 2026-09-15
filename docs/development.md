# Development and runtime reference

[Back to Rish](../README.md) · [中文说明](../README.zh.md)

This guide contains implementation detail, build commands, and validation
procedures. Run shell commands from the repository root unless stated otherwise.
For a capability overview, start with the README.

## iOS build prerequisites

The native preparation scripts currently require an Apple Silicon Mac, Xcode
26.6 (build 17F113), iOS and Simulator SDK 26.5, Rust toolchain `1.94` resolving
to rustc 1.94.1, and the `aarch64-apple-ios` and `aarch64-apple-ios-sim` targets.
These are enforced pins, not a claim of compatibility with arbitrary versions.
Node 22.11+, CocoaPods, CMake, Perl, make, Git, jq, and the script-checked tools
must be available. The first preparation downloads pinned sources and dependencies.

The project ships without a signing team. Simulator builds need none; device
builds need your own Apple Developer team, set in Xcode under Signing &
Capabilities or passed to `xcodebuild` as `DEVELOPMENT_TEAM=<team id>` with
`-allowProvisioningUpdates`. Developer scripts that read API keys
(`scripts/provision-simulator-key.rb`, `scripts/probe-deepseek-vision.rb`) take
`DSH_CREDENTIALS`, a 0600 YAML file you own; there is no default path, and
`--secure-stdin` reads the key from the terminal instead.

The app lives in `apps/mobile` and renders native React Native views with
Fabric and Hermes. DSH was the first built-in Harness target; Rish's scope
extends to multiple model providers and task types.

The original Swift/WebKit shell is retired and kept only for provenance in
[`legacy/web-proxy/`](../legacy/web-proxy/README.md). No target builds it.
`run-simulator.sh` builds and launches the React Native product; it never
starts or embeds that baseline.

## Product documentation

Rish App product designs, stable interface specs, plans, and evidence are
maintained separately from this source repository. This README is the public
implementation and runtime boundary; do not infer completed behavior from a
design document.

The current contribution and security policies are drafts: see
[CONTRIBUTING.md](../CONTRIBUTING.md) and [SECURITY.md](../SECURITY.md). The project
source is licensed under the [MIT License](../LICENSE), and the current status of
private vulnerability reporting is recorded in `SECURITY.md`.
The current limited dependency inventory is in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md); it is not a complete SBOM.
The planned `v0.1.0` source-preview scope and release checklist are in
[`docs/releases/v0.1.0.md`](releases/v0.1.0.md); no tag or release is
created by that document.

## Honest runtime boundary

| Mode              | What runs on the phone                                                                                                     | Current status             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `web_proxy`       | UI only; DSH runs elsewhere                                                                                                | Historical WebKit baseline |
| `local_substrate` | Native model transport, secure credential storage, local sessions, bounded workspace operations, and rish portable applets | Implemented on iOS         |
| `local_harness`   | One selected Harness runtime, agent loop, event log, registered tools, approvals, and persistence                          | Partially implemented; gate not closed |

The app must continue to identify itself as `local_substrate` until the selected
Harness has passed the complete local_harness gate. Existing AgentLoop,
controller, tool and approval code, or a local model request plus a few local
tools, is not by itself a complete local Harness runtime.

## Custom providers (iOS)

Select **Claude Code** or **Codex**, then open **Settings → Custom provider**.
Enter the service address, choose Messages, Responses, or Chat Completions, and
map the existing model slots to the service's model IDs. Empty mappings use the
original model ID. Full endpoint mode preserves a custom API path; otherwise
Rish fills in the selected protocol's standard path.

Save the settings, then use **Configure key** to save that service's API key in
the native Keychain prompt. Official and custom credentials remain separate.
Changing services requires project context to be confirmed again. Disable the
custom provider and save to return to the official configuration.

## Current mobile product

The following describes the iOS surface unless another platform is named.

- The Agent permissions panel reads current native workspace/project policy
  on opening, refresh and foreground return, without creating a task or using
  model credentials. It shows native tool modes and matching conversation grants.
  Local Documents-owned workspaces can enable Git from this panel: files stay
  in place, the private Git backend is attached, and a new Git-bound chat is
  opened while the original chat is retained. Active tasks and pending saves
  must finish before this binding transition.
- Multiple local conversations: create, search, switch, auto-title, rename,
  delete with confirmation, and restore after process restart.
- Per-conversation DeepSeek V4 Flash, V4 Pro, or multimodal Flash Vision Exp selection, complete multi-turn
  history, request-scoped Stop, retry, and rejection of late responses.
- Composer attachments from Camera, Photos, and iOS Files. Images use the
  native Flash Exp multimodal request path; UTF-8 text files are bounded and
  delimited, and PDFs use bounded PDFKit text extraction. Attachment-only
  messages, retry, history cards, restart recovery, and clickable native Quick
  Look previews are supported.
- Composer-level thinking modes (`off`, `high`, and `max`) persisted per conversation and sent through the native DeepSeek
  transport. Returned reasoning can be persisted, hidden, and expanded.
- A mobile Markdown subset for headings, bullets, block quotes, inline code,
  fenced code, bounded tables and math, and controlled image display. Plain
  URLs, bold URLs, and Markdown links open on an explicit tap; user messages
  also support plain URL links. Code spans stay literal, and unsupported URL
  schemes are not actionable.
- Agent round presentation places returned progress text and optional
  reasoning before that round's tool cards, followed by the final answer.
  The bounded, owner-checked iOS presentation archive survives transcript
  cleanup and process restart; it does not replay tools. Reasoning display
  follows the user's setting and depends on what the model returns. Text
  already discarded by older builds cannot be reconstructed.
- A right-side animated Settings drawer with system/light/dark appearance,
  system/Simplified Chinese/English locale, default model, thinking display,
  tool-card behavior, local workspace permission, destructive-action
  confirmation, credential management, package mirrors, and runtime evidence.
- Alpine APK, Python pip, and Node npm mirror settings support presets, custom
  HTTPS bases, bounded speed tests, persistence, and native staging for the
  rish guest. The UI explicitly reports that the persistent guest is not
  mounted yet.
- On-demand language environments install verified Python, Java, Go, Rust,
  Bun and Node.js disks independently. An explicit Run action executes a
  bounded workspace copy in the real guest, with stdout/stderr, exit state
  and interruptible cancellation. Environment packages are cached; execution
  disks are disposable. See [language environments](runtime-environments.md).
- A right-side local Files drawer with nested directory navigation, text-file
  create/read/edit, revision-protected atomic save, rename, recoverable trash,
  restore, and real `sha256sum`/`wc` rish receipts. Files and folders can be
  imported from and exported to the iOS Files app through the native document
  picker; security-scoped provider URLs never cross into JavaScript.
- App-owned Git Projects backed by pinned libgit2: create, public HTTPS clone,
  native SSH clone/fetch with pinned libssh2/OpenSSL and strict `known_hosts`,
  status, unified diff, stage all, commit, configure `origin`, native Keychain
  credentials, and non-force HTTPS push. SSH profile picker/restart UI and SSH
  push remain outside the verified surface. Each conversation can bind to one
  opaque project id, and project Files stay scoped to that worktree while `.git`
  remains hidden from the normal file API.
- A mobile-specific runtime evidence surface and a machine-verifiable proof
  record that correlates the DeepSeek response, optional reasoning, persisted
  session, process restart, rish execution, live Simulator PID, and a closed
  Mac DSH port.
- One Lucide-based functional icon system across chat, drawers, settings,
  projects, Git, Files, attachments, and tool states. Icons use per-icon imports
  and a shared 1.8-stroke wrapper; semantic text markers, data symbols, status
  dots, and the Rish brand mark remain intentionally separate.

The original app icon is stored in `brand/`. It intentionally uses the
geometric DSH mark without the whale or any plugin artwork. Lucide is used for
interface actions only and does not replace the product mark.

## Architecture

```text
React Native mobile UI (Fabric + Hermes)
  -> typed chat/preferences stores and mobile presentation layer
  -> bounded native modules
       LocalRuntime
         -> iOS Keychain (credential never crosses into JavaScript)
         -> native URLSession -> DeepSeek
         -> App Container sessions + runtime proof
         -> linked rish sha256sum proof probe
       LocalWorkspace
         -> app-owned workspace only
         -> descriptor-relative, no-symlink file operations
         -> atomic revision-checked text writes + recoverable trash
         -> allowlisted read-only rish portable applets
       LocalDocuments
         -> UIDocumentPicker import/export bridge to the iOS Files app
         -> bounded staged copies; no external provider URL reaches JavaScript
         -> reserved Git metadata and symlinks fail closed
       LocalAttachments
         -> Camera, PHPicker, and UIDocumentPicker acquisition
         -> opaque-id native store with normalized images and bounded previews
         -> SHA-256 manifests, lifecycle pruning, and no file paths in chat JSON
       LocalProjects
         -> app-private, isolated Git worktrees resolved from opaque ids
         -> pinned libgit2 XCFramework using iOS SecureTransport
         -> pinned libssh2/OpenSSL SSH transport
         -> native HTTPS credential prompt + device-only Keychain storage
```

These native modules currently use the legacy React Native bridge. A production
hardening step is to migrate the same narrow contracts to Codegen TurboModules;
it is not permission to expose arbitrary paths, provider URLs, credentials, or
a general shell to JavaScript.

## Security invariants

- API keys are never committed, bundled, logged, persisted in chat/session
  JSON, or returned to React Native. On iOS they are stored as
  `WhenUnlockedThisDeviceOnly` Keychain items and used only by native code.
- The Simulator provisioner uses a temporary `0600` staging file, waits for a
  value-free acknowledgement, and removes the staged value after Keychain
  import. Prefer `--secure-stdin` when not importing the managed DSH
  credential.
- Workspace paths are relative to the app-owned workspace. Absolute paths,
  traversal, `.trash`, symlinks, non-text/oversized reads, excessive listings,
  and non-allowlisted tools fail closed.
- iOS Files access is explicit import/export, not unrestricted filesystem
  access. Imports are bounded and staged before publication. Exports copy to a
  temporary sanitized tree and omit `.git`, `.gitmodules`, and app trash.
- Chat attachments are copied into an app-owned 256 MiB native store. Messages
  persist only opaque descriptors; thumbnails, provider URLs, absolute paths,
  and base64 image payloads are excluded from session JSON. Images are
  metadata-stripped and downsampled before sending.
- Git remote URLs are validated before credentials are used. HTTPS uses
  credential-free public DNS origins with PATs in native
  `WhenUnlockedThisDeviceOnly` Keychain storage; SSH profiles keep their
  private material in native storage and require strict `known_hosts`.
  Encrypted SSH private-key formats, force push, LFS, and submodules are
  rejected in the current surface.
- Read-only mode disables create, edit, rename, and trash controls. Saves use
  an expected revision to detect stale edits, and deletion means a recoverable
  move to app trash.
- Run `scripts/verify-no-bundled-secret.rb` before sharing an app bundle. Never
  place a key in source, shell history, a README, an environment file, or a
  test fixture.

## Install and run the React Native app

Node 22.11 or newer is required. From the repository root, check the source
layout before installing dependencies:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

The preflight runs offline and checks required source files, portable build
references, native entry points, and the npm lockfile. It does not compile
native code or prepare dependencies.

All iOS builds, including Metro-backed development builds, require the
vendored native frameworks before CocoaPods installation. Run this shared
preparation from the repository root:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-rish-agent-core.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
```

The default Rish preparation fetches the pinned source commit into an
isolated temporary checkout and downloads missing Cargo dependencies with
`--locked`. The actual builds use `--frozen`; dependency versions stay pinned.
To reuse a reviewed clean source checkout, pass its path to
`prepare-rish-ios.sh` or set `RISH_SOURCE_DIR`.

For an explicitly offline Rish preparation, the pinned Rust toolchain and
targets must already be installed, the Cargo cache must be populated, and a
reviewed source checkout must be supplied:

```sh
RISH_IOS_OFFLINE=1 RISH_SOURCE_DIR=/path/to/rish ./scripts/prepare-rish-ios.sh
```

This option disables source fetching and enables Cargo's offline mode for
Rish preparation. It does not make npm, CocoaPods, or the separate native
dependency preparation scripts offline.

The iOS dependency bootstrap requires Rust/Cargo, Xcode command-line tools,
CocoaPods, Perl, `make`, and CMake on `PATH`, plus the tools checked by the
preparation scripts. On macOS, CMake can be installed with
`brew install cmake`; an absolute override is also supported:

```sh
CMAKE_BIN=/absolute/path/to/cmake ./scripts/prepare-libgit2-ios.sh
```

`prepare-libgit2-ios.sh` automatically invokes the pinned libssh2 and OpenSSL
preparation helpers, so they do not need to be run separately.

After the shared iOS preparation, start a Metro-backed development run from
the repository root:

```sh
npm run ios --prefix apps/mobile
```

For Android UI development, after the npm installation above:

```sh
npm run android --prefix apps/mobile
```

Android task alerts, per-conversation mute, and user-started foreground-service
lifecycle are implemented and have scoped emulator tests. Android uses an
ongoing notification instead of iOS Live Activities. These checks do not prove
model, file/Git, or Agent execution.

Android now supports pure-text API chat through native OkHttp, Android Keystore
encrypted credentials, scoped custom-provider profiles, and atomic SQLite session
snapshots. API33 emulator checks cover DSH, GLM, GLM-backed Codex/Claude Code
profiles, and UI send/save/reopen without replay. Those profiles test API adapters,
not the official CLI harnesses or subscription login. Attachments, project context,
file/Git, and Agent execution remain unavailable; runtime status honestly
reports incomplete. Debug UI uses Metro; standalone Release and physical Android
device acceptance remain pending.

### Android guest runtime

The rish Linux guest runs on Android through the same pure-Rust x86_64
interpreter the iOS app uses. It is opt-in at build time because it adds the
runtime library and the 22 MB of guest boot assets to the APK:

```sh
scripts/prepare-rish-android.sh
apps/mobile/android/gradlew -p apps/mobile/android :app:assembleDebug -PreactNativeArchitectures=arm64-v8a
```

`prepare-rish-android.sh` carries the same rish commit, `rish.h`, `Cargo.lock`
and Rust pins as `prepare-rish-ios.sh`, builds `rish-ffi` with the pinned NDK
(27.1.12297006, API 24, 16 KiB page alignment), verifies the ELF machine,
segment alignment, Bionic-only dependencies and exported symbols, and stages
`apps/mobile/android/rish-ffi/` (gitignored) with a provenance manifest.
`RISH_ANDROID_ABIS` selects ABIs (default `arm64-v8a`; `x86_64` needs the
`x86_64-linux-android` Rust target). Gradle packages the runtime, compiles the
JNI shim under `app/src/main/cpp/`, and copies the pinned kernel and initramfs
from `apps/mobile/ios/Rish/GuestAssets/` into the APK assets; it refuses a
`reactNativeArchitectures` set the runtime was not staged for. Without the
staged directory the build stays a lite build and `LocalGuest` reports
`implemented = false`.

`LocalGuestModule` (Kotlin, `tech.zseven.rish.guest`) mirrors the iOS module:
fail-closed request validation, digest verification of the staged assets before
every boot, one session per process, boot on a dedicated thread, exec
serialised with shutdown, and receipts that never carry paths. JVM unit tests
cover the state machine against a fake runtime; the instrumented
`LocalGuestBootTest` is the real proof and skips on a lite build:

```sh
apps/mobile/android/gradlew -p apps/mobile/android :app:connectedDebugAndroidTest \
  -PreactNativeArchitectures=arm64-v8a \
  -Pandroid.testInstrumentationRunnerArguments.class=tech.zseven.rish.LocalGuestBootTest
```

On the arm64 API 33 emulator it boots the guest in about 34 s with 768 MiB,
reports `uname -m` as `x86_64`, installs `tree` from the offline apk repository
baked into the initramfs, runs it, and shuts down. This proves the runtime and
guest are genuinely in the APK and bootable; nothing in the Android UI drives
the guest yet, because the Agent runtime, workspace and file modules that use
it on iOS are still unavailable on Android.

For temporary Android compatibility-container testing, build a self-contained
debug-signed APK with bundled JS and developer-server support disabled:

```sh
apps/mobile/android/gradlew -p apps/mobile/android :app:assembleDebug -PrishStandalone=true -PreactNativeArchitectures=arm64-v8a
```

This remains a test build, not a production-signed release. Its launcher was
checked on the API33 emulator with airplane mode enabled; HarmonyOS compatibility
container installation and execution require a separate device check.

### Android release signing

Release builds never use the React Native debug keystore. `assembleRelease`,
`bundleRelease` and `installRelease` fail with an explanation unless you supply
a key, either as `apps/mobile/android/keystore.properties` (gitignored):

```properties
storeFile=/absolute/or/android-relative/path/to/release.jks
storePassword=...
keyAlias=...
keyPassword=...
```

or as the environment `RISH_ANDROID_KEYSTORE`, `RISH_ANDROID_KEYSTORE_PASSWORD`,
`RISH_ANDROID_KEY_ALIAS` and `RISH_ANDROID_KEY_PASSWORD` for CI. A properties
file that points at `debug.keystore` is refused. Debug builds keep the debug
key, and unit tests and configuration never need release signing.

## Editable DSH model catalog

In Settings, use **DSH model catalog** to add exact provider model IDs, display
names and image-input capability declarations, or edit/remove entries and restore
defaults. iOS and Android persist the catalog natively. Up to 32 selectable models
are supported; removed identities remain readable in existing conversations.
Adding a provider-supported model does not require another app update.

Android status now distinguishes configured chat from unavailable local tools.
API chat and session storage do not imply that file/Git, Agent or rish execution
has been implemented. Image capability declarations cannot add capabilities that
the provider or platform does not support.

## Build and verify the iOS local-substrate proof

The proof build links rish and libgit2 into a self-contained app and does not
depend on Metro or a Mac `dsh web` process. Both dependencies are packaged as
device + Simulator arm64 XCFrameworks.

Complete the [shared iOS preparation](#install-and-run-the-react-native-app)
above first, including `npm ci`, both framework preparation scripts, and
`pod install`. Then, from the repository root:

```sh
cd apps/mobile/ios
xcodebuild \
  -workspace Rish.xcworkspace \
  -scheme Rish \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=<UDID>' \
  -derivedDataPath build/local-proof-arm64 \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  build

xcrun simctl install <UDID> \
  build/local-proof-arm64/Build/Products/Release-iphonesimulator/Rish.app
cd ../../..
```

The separate unsigned `generic/platform=iOS` Release build is a required
device-link gate. It proves the iPhone arm64 slices link, but it is not evidence
that the app ran on a physical iPhone.

Confirm no Mac DSH listener is present, then import the key without putting the
value on the command line:

```sh
lsof -nP -iTCP:3180 -sTCP:LISTEN
./scripts/provision-simulator-key.rb \
  --secure-stdin <UDID> tech.zseven.rish
```

In the app, select **V4 Flash**, complete a real response, terminate and
relaunch the app, then verify the correlated record:

```sh
./scripts/verify-local-proof.rb <UDID> tech.zseven.rish
```

The verifier currently pins its acceptance request to V4 Flash. It checks the
actual container file and live Simulator process; a screenshot or an inherited
boolean is not sufficient evidence.

## Shared agent core (Rust)

`modules/rish/core` is a Cargo workspace (`rish-agent-core` for domain logic,
`rish-agent-ffi` for the C boundary) that will carry the Agent engine for both
platforms. The Objective-C++ engine under `modules/rish/ios/Sources` stays the
reference until each piece is migrated behind its existing interface.

Phase 0 ports the byte-level contracts every later piece depends on: canonical
JSON (`DSHWorkspaceCanonicalJSONData`), the domain-separated hashes
(`DSHAgentHJ`, `DSHAgentHB`) and the strict argument parser
(`DSHAgentParseArgumentsJSON`). Parity is pinned by a golden generated from the
Objective-C engine itself:

```sh
# 1. The XCTest writes the golden when this environment variable is exported
#    (an xcodebuild command-line argument does not reach the test process).
export TEST_RUNNER_RISH_CORE_GOLDEN_OUT="$PWD/modules/rish/core/fixtures/canonical-golden.json"
cd apps/mobile/ios
xcodebuild test -workspace Rish.xcworkspace -scheme Rish \
  -destination "platform=iOS Simulator,id=<simulator>" \
  -only-testing:RishTests/AgentCoreGoldenTests
unset TEST_RUNNER_RISH_CORE_GOLDEN_OUT

# 2. The Rust side replays the same corpus against that golden.
cd ../../../modules/rish/core
cargo test --workspace
```

Without the variable the XCTest runs in compare mode and fails when the
Objective-C output drifts from the committed golden. Add inputs to
`fixtures/canonical-corpus.json`, regenerate, and commit corpus and golden
together. The corpus `divergences` map lists the cases where the two sides
deliberately differ, with the stage responsible and the exact Rust output; the
Rust test asserts those too, so a divergence is pinned rather than skipped.

Phase 1 moves the schema-3 provider-round journal into the core as a pure
reducer (`crates/rish-agent-core/src/round_journal.rs`). The `…V3…` selectors
of `DSHAgentRoundJournal` are now a facade: they open the WAL transaction,
collect the round row, its dispatch marker, the bound transcript row and the
native-task liveness answers into a view, call `rish_agent_round_reduce`, and
apply the returned effect verbatim. Round policy (argument validation, CAS
matching, state transitions, transcript digests) lives only in Rust; the
provider catalogue answers a receipt needs (`DSHHarnessSupportedModels`,
`DSHHarnessIdForModel`, `DSHValidateProviderBinding`) are passed in as host
facts. The schema-2 selectors, which only two low-level tests used, were deleted
together with those tests.

Phase 2 does the same for the row-level half of the execution ledger
(`crates/rish-agent-core/src/execution_ledger.rs` for the row, precondition,
settled-fact, receipt and protected-feedback invariants;
`ledger_ops.rs` for insert, claim, heartbeat, CAS, mark dispatched, query,
release, settle, cancel, reconcile and the two in-state denial helpers). The
facade collects the row, the attempt's execution dispatch markers, the bound
transcript row, the attempt's reservation and batch records and the
task/attempt authorities as a view, calls `rish_agent_ledger_reduce`, and
applies the returned change list (each change names its table and, for
reservations, batches and authorities, the host-issued slot). Settlement also
returns the operation commit, which the facade performs through
`DSHAgentNativeWALCommitOperationInState` on the same candidate. Phase 3 moves the two production batch-level methods,
`prepareAgentToolBatch` and `openAgentWriteBatchEffectGate`, into
`ledger_batch.rs` with a wider view (the frozen round, the attempt's batches,
reservation, ledger rows and dispatch markers, the request's transcript row,
message-free summaries of every transcript, the round's denied calls, the
task/attempt authorities and operation results); approval-token UUIDs are
generated by the facade and passed in. `reserveWriteBytesForAttempt` and
`prepareAgentWriteBatch` had no production caller and were deleted together
with their tests, so the round journal and the execution ledger are now
Rust behind thin facades; `DSHAgentValidateRoundNativeEntryV2` and
`DSHAgentValidateExecutionLedgerEntryV2` stay in Objective-C because WAL
loading calls them.

Phase 4 moves `DSHAgentTranscriptStore` (create, validate, native message
reconstruction, append, mark terminal, discard, cleanup query) into
`transcript_store.rs`; the fresh transcript UUID and the retention
timestamp are generated by the facade and passed in, and the file-based
round presentation cache stays native because it is not authority.

Phase 5 moves the pure half of `DSHSessionSnapshotStore` into
`session_schema` (`scanner.rs`, `primitives.rs`, `validators.rs`,
`mod.rs`): the strict node-limited JSON scanner, the schema-9 candidate
validator with every sub-validator, the legacy (schema 2 to 8) root
validator, the v2/v3 envelope and tombstone validators and the
`chat-session` digest. The facade keeps file protection, pinned
descriptors, atomic writes, locks, the CAS decision and the validated
envelope cache; it hands the core the caller's exact bytes plus the host
facts the validators need (the supported models, harness ids and provider
hosts that occur in the tree, and the validity of every provider binding
in it) through `rish_agent_session_reduce`. The port is pinned to the
Objective-C validators by `fixtures/session-golden.json`, generated once
from `fixtures/session-corpus.json` before the native validators were
deleted: about 17,500 answers over the shared session fixtures, hand-written
legacy roots, envelopes, tombstones, lexical edge cases and a deterministic
mutation walk, replayed by `tests/session_schema.rs`. Three corpus inputs
made the native validator throw (a provider binding whose `endpoint_url` is
not a string) and are recorded as `!`; the core refuses them. The store's
CAS decisions follow in `session_schema/cas.rs`: request and authority
shapes, the replay-by-operation-id and expected-authority checks, the
tombstone-ledger rules, the next generation, the commit chain and the
canonical bytes of both files the host writes, the post-write verification,
`querySessionCommit`, and the clearance path's candidate, replay and
observed-operation rules. The host reads, locks, writes and reads back,
calling the core between those steps with what it observed.

Phase 6 moves `DSHAgentToolBatchService`'s decisions into `tool_batch.rs`
behind `rish_agent_tool_batch_reduce`: the prepare and bind request
shapes, the preparation gate, the per-call analysis of the round's raw
tool calls (identity against the round's presentation, registry access,
conversation grants, argument acceptance), the executor outcome mapping
with the whole-batch rejection cascade, the capability set, the final
authority check and the ledger's internal request, the ledger-failure
rejection, and the approval binding checks down to the result the WAL
commits. The host keeps the WAL operation relation, the committed session
load, the root proofs, the executors' preparation probes (run in call
order, stopping where the core would) and the denied-approval transaction.

Phase 7 does the same for `DSHAgentToolExecutionService` in
`tool_execution.rs` behind `rish_agent_tool_execution_reduce`: the request
shape, the committed-session relation, the pre-execution checks over the
WAL views (authority, batch, ledger row, prepared projection, approval or
grant binding, call ordering, row-state branching into replay, active,
unknown and ambiguous results), the ledger CAS, the settlement of an
executor's effect into receipt, tool message and patch, and the recovery
settlement. The host keeps the WAL operation relation, the session load,
the root proofs, liveness, the executors and the ledger calls.

Phase 8 moves `DSHAgentPreparedAttemptStore` into `prepared_attempt.rs`
behind `rish_agent_prepared_attempt_reduce`: the request shape, the
committed-session relation including the visible-history digest, the
observed safe values and the conflict result, the attempt projections,
and the prepare transaction itself (replay, not_agent, already_prepared,
prepared) as a change set the facade appends. The facade keeps the
session load, the root resolver, the tool registry, the workspace
authority guard held across the whole WAL transaction, and the
transaction itself; fresh transcript identities and clock readings are
passed in as host facts. `rish_agent_build_id` reports the linked core's
version and git revision so a test can prove which build it exercises.

The core links into the `RishLocalRuntime` pod as
`Vendor/rish_agent_core.xcframework`, built by
`scripts/prepare-rish-agent-core.sh` from the workspace toolchain
(`rust-toolchain.toml`) for `aarch64-apple-ios` and `aarch64-apple-ios-sim`;
the script refuses to install toolchains or targets itself. Rebuild it after
any change under `modules/rish/core` and before `pod install`.

Phase 9 moves the pure half of the provider round service —
`AgentProviderRoundServiceInternals.mm` — into `provider_round.rs` behind
`rish_agent_provider_round_reduce`: the round and selector request shapes,
the controller CAS and checkpoint relations, the transport result shape and
its relation to the request, the round locator and ledger CAS, the
native-to-provider message conversion, the public receipt, the recovered
round projection, the project-context bundle with its byte budget, the
failure-code mapping, the result projections, and the tool descriptions the
model is shown. The facade keeps the transport, credentials, the tool
registry's native descriptors, the root projection validator, the
completion transport's own schema validation, and the two provider digests.

Those digests are a second byte protocol and must not move: the model input
digest is `NSJSONSerialization` with `NSJSONWritingSortedKeys`, whose key
order is locale-sensitive, and the request body digest binds the exact bytes
that were sent. Both stay in `DSHProviderJSONSHA256` and reach the core as
host facts.

Phase 10 starts on the WAL itself, in the order the plan calls for: the
stored row shapes first, the transaction and resident state later.
`wal_state.rs` now owns what `AgentNativeWAL.mm` re-validated on every
load — transcript references and messages, reservations, cleanup rows,
dispatch markers, the frozen policy and tool registry, the attempt
authority with the exact tool set its root capabilities imply, and the
operation relation with its result references, safe results and result
snapshots (including each snapshot's own byte length and domain-separated
digest). The file, the descriptors, the locks and the transaction stay
native, and the loader reaches the core through
`rish_agent_wal_state_reduce`.

The second cut adds the rows those shapes are assembled into: the legacy
write batch and its schema-2 successor (read-only batches carry no manifest
at all, write batches must re-derive `manifest_sha256` from their own calls
and list exactly those calls' idempotency keys), tool receipts, denied and
rejected calls with their canonical feedback bytes, and the schema-3 round
row. The round row is the one place the boundary is crossed twice: the core
judges every V3 rule and returns the schema-2 projection, which the native
`DSHAgentValidateRoundNativeEntryV2` still has to accept before the row is
kept. The V1→V2 batch migration and the V2→V3 round migration move with
them, so an old file upgrades identically on both platforms.

The third cut moves the state-level validation itself: the root key lists for
both schemas, the per-attempt capacities, the transcript digests, the
authority and operation relations, the batch-to-reservation-to-ledger
agreement, the denied-call identities, and the dispatch bijection with the one
exception the WAL allows — a settled row with no dispatch is only ever a user
denial. Two typed validators stay native because the round journal and the
execution ledger still own them, so the loader computes one verdict per row
and passes them in as host facts; a ledger row the native validator refuses
comes back by index and is asked again, so the error the loader reports is
still the ledger validator's own. `AgentNativeWAL.mm` is down from 4,690 lines
to about 3,570.

Phase 11 moves the operation relation itself — start, query and commit, plus
the attempt authority, the write batch and the durable denial that share its
transaction. It is the first cut where the core decides a *transaction*
rather than judging a row, so it was recorded before it was moved:
`fixtures/wal-transaction-golden.json` holds 440 commands taken from the
native implementation by running the whole suite with its entry points
instrumented, each one a committed state, a command, the timestamps the clock
handed out, and the answer and committed rows that followed.
`crates/rish-agent-core/tests/wal_operations.rs` replays every one of them.
Like `session-golden.json` it cannot be regenerated: the native decisions it
records are gone.

The transaction stays where it was. `wal_operations.rs` is pure: it reads the
committed state and returns either a replay, an error, or the top-level
arrays to replace, and the host applies them only inside a transaction it has
written and confirmed. The commit is split in two halves so the in-state
variant can still let its fault hook refuse exactly where it used to — after
the relation has settled that this is a fresh commit and before anything is
written; the golden's faulted step asserts precisely that. The one deliberate
simplification is that the clock is now read once per command instead of only
on the paths that consume it. `AgentNativeWAL.mm` is down to about 2,840
lines, from 4,690 when phase 10 began.

Phase 12 starts on the coordinator, read-only half first. `runtime_coordinator.rs`
owns the controller-facing request shapes, the session proof every one of them
starts from, the tool and attempt projections, the merge of prepare-time
projections with persisted bind decisions and ledger settlements, and the
cleanup-outbox and cancel-source proofs the later cuts will need. The host
still loads the session snapshot and the WAL state and calls the typed
services; it passes the snapshot's generation and digest in as facts, because
only it can read them. Unlike phase 11 this cut writes nothing, so it rides on
the existing suites rather than a new golden — the recorded-golden treatment
is reserved for the cuts that settle transactions.

Phase 13 takes the settle path: finalize, discard and interrupt. All three
prove something and then rewrite WAL rows in one transaction, so all three were
recorded before they moved. `fixtures/runtime-coordinator-golden.json` holds 29
commands taken from the native coordinator with those entry points
instrumented: the committed WAL state, the request, the facts the typed stores
answered with, the timestamps the coordinator's own clock handed out, and the
answer and committed rows that followed.
`crates/rish-agent-core/tests/runtime_coordinator.rs` replays every one. Like
the other two goldens it cannot be regenerated.

The core returns the arrays to replace plus the arguments for the WAL
operation commit, which the host still makes itself, so the WAL's fault hook
keeps speaking where it always did. A refused finalize is not a failed call:
it commits its own conflict as the operation's result, and the golden holds
that case too.

### Device-only storage metadata

The session store and the agent WAL require every pinned item to report
`NSFileProtectionCompleteUntilFirstUserAuthentication` and the expected
`NSURLIsExcludedFromBackupKey` value. That requirement is enforced on a
physical device only: `requiresSessionResourceMetadata` and
`requiresWALResourceMetadata` return `NO` on the simulator and on macOS,
because CoreSimulator does not report the protection class through
`NSFileManager`. The simulator suites cover the path through injected
file managers (`sessionFileManager`, `walFileManager`) and an overridden
requirement, so a change there must be exercised with those fakes; a green
simulator run is not evidence about a device.

An item created by an earlier build can carry a different protection class
or no backup exclusion. Both stores now re-apply the required metadata in
place once and read it back before refusing, the way `LocalWorkspaceAccess`
migrates a legacy `NSFileProtectionComplete` item. Without that repair an
upgraded container fails every WAL read with `E_AGENT_PERSISTENCE` and never
recovers, which the simulator can never show.

## Quality gates

From the repository root:

```sh
node scripts/verify-source-checkout.mjs
cd apps/mobile
npm run typecheck
npm run lint
npm test -- --runInBand

cd android
./gradlew assembleDebug

cd ../../..
ruby scripts/verify-no-bundled-secret.rb
ruby scripts/verify-no-bundled-secret.rb \
  apps/mobile/ios/build/local-proof-arm64/Build/Products/Release-iphonesimulator/Rish.app
```

The Jest suite covers typed state/persistence, theme and locale resolution,
chat isolation/history, request cancellation/retry, reasoning, structured tool
display, the Markdown subset, credential recovery, workspace create/edit with
revision protection, and portable-tool receipts. The native Release build and
the proof verifier remain separate required gates.

The TestFlight Release gate also runs the real first-send storage graph:
workspace creation, session CAS checkpoints, prepared Agent authority, native
WAL, round journal, a scripted HTTP response and exact replay without another
request. Agent WAL protection uses `NSFileManager` for both writing and fresh
readback, with strict device checks for protection and backup exclusion. Tests
inject device metadata failures while keeping real file descriptors, inode
checks and atomic writes, and require the previous committed bytes to survive.
Simulator and macOS results do not establish the state of an existing device's
storage; physical-device reports still need confirmation.

Run this graph with the production `RISH_GUEST_CGI_ENABLED=1` define. The CGI
tool description previously exceeded the 1,024-character transport limit,
rejecting every Agent request that advertised it before HTTP dispatch. Keep
descriptions within that bound and test the actual capability-filtered tool
set. Round-create and dispatch failures are also injected into the real WAL:
an uncommitted in-memory row must never be returned as a successful write or
permit a provider request.

The real CGI HTTP client uses one 60-second host-time deadline across connect,
send and receive. A POST stages its body, executes the backend and removes the
temporary file through multiple software-guest exchanges; the backend's
five-second guest-shell timeout is not an end-to-end host-time bound. The test
requires complete responses and the exact counter sequence without retries,
and records timings without cookies or request contents.

For a native `complete_agent_round_v2` persistence rejection, error details
include a fixed diagnostic marker distinguishing storage failure, unavailable
dependencies and an exception. This marker is transient display information;
it never changes persisted failure codes or recovery authority and contains no
raw native error message, exception reason, path or credential.

## What is still missing

- The complete `local_harness` qualification and full upstream Harness
  coverage. The implemented bounded API-driven Agent loop, registered tools,
  approvals, journal, and recovery paths do not establish general Harness or
  official CLI compatibility. A general provider/plugin host and structured
  question flow remain outside the verified scope.
- Token/reasoning/event streaming; the current native request returns one
  completed response.
- DSH plans, goals, jobs, subagents, workflow runs, queues, steering, skills,
  plugins, agent presets, usage/stats, and produced-file event integration.
- Share-extension input, OCR for scanned PDFs, full DSH Markdown parity beyond
  the supported mobile subset, and message edit/regenerate/export/feedback
  actions.
- Git pull/fetch UI, merge/rebase, SSH profile picker/restart UI, encrypted SSH
  private-key formats, LFS, submodules, signed commits, and SSH push. The
  current Git slice intentionally supports a smaller auditable HTTPS workflow
  plus native SSH clone/fetch.
- Android native local runtime/workspace adapters and device proof.

Detailed DSH parity, mobile UI, and runtime proof records are maintained
separately from this source repository. This README keeps the implementation
boundary and known limitations self-contained for a source checkout.
