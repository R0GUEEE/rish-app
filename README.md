# Rish

Rish is a local-first mobile runtime for running Harnesses on-device. DSH is
the first built-in Harness, not the product boundary. The app lives in
`apps/mobile` and renders native React Native views with Fabric and Hermes; it
is not a `WKWebView` wrapper.

The Swift/WebKit code at the repository root is retained only as the original
`web_proxy` baseline. `run-simulator.sh` now builds and launches the React
Native product; it never starts or embeds that baseline.

## Product documentation

Rish App product designs, stable interface specs, plans, and evidence live in
the private [Z-Seven document center](https://github.com/ZSeven-W/openpencil-docs/tree/main/rish-app).
This source repository remains the implementation and runtime truth; do not
infer completed behavior from a design document.

## Honest runtime boundary

| Mode              | What runs on the phone                                                                                                     | Current status             |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `web_proxy`       | UI only; DSH runs elsewhere                                                                                                | Historical WebKit baseline |
| `local_substrate` | Native model transport, secure credential storage, local sessions, bounded workspace operations, and rish portable applets | Implemented on iOS         |
| `local_harness`   | One selected Harness runtime, agent loop, event log, registered tools, approvals, and persistence                          | Not implemented            |

The app must continue to identify itself as `local_substrate`. A local model
request plus a few local tools is not a complete local Harness runtime.

## Current mobile product

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
  and fenced code blocks, plus collapsible reasoning/tool-call/tool-result
  cards.
- A right-side animated Settings drawer with system/light/dark appearance,
  system/Simplified Chinese/English locale, default model, thinking display,
  tool-card behavior, local workspace permission, destructive-action
  confirmation, credential management, package mirrors, and runtime evidence.
- Alpine APK, Python pip, and Node npm mirror settings support presets, custom
  HTTPS bases, bounded speed tests, persistence, and native staging for the
  rish guest. The UI explicitly reports that the persistent guest is not
  mounted yet.
- A right-side local Files drawer with nested directory navigation, text-file
  create/read/edit, revision-protected atomic save, rename, recoverable trash,
  restore, and real `sha256sum`/`wc` rish receipts. Files and folders can be
  imported from and exported to the iOS Files app through the native document
  picker; security-scoped provider URLs never cross into JavaScript.
- App-owned Git Projects backed by pinned libgit2: create, public HTTPS clone,
  status, unified diff, stage all, commit, configure `origin`, native Keychain
  credentials, and non-force push. Each conversation can bind to one opaque
  project id, and project Files stay scoped to that worktree while `.git`
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
- Git remote URLs must be credential-free public DNS HTTPS URLs. PATs remain in
  native `WhenUnlockedThisDeviceOnly` Keychain storage; force push, SSH, LFS,
  and submodules are rejected in version 1.
- Read-only mode disables create, edit, rename, and trash controls. Saves use
  an expected revision to detect stale edits, and deletion means a recoverable
  move to app trash.
- Run `scripts/verify-no-bundled-secret.rb` before sharing an app bundle. Never
  place a key in source, shell history, a README, an environment file, or a
  test fixture.

## Install and run the React Native app

Node 22.11 or newer is required.

```sh
cd apps/mobile
npm ci
```

For a Metro-backed iOS development run:

```sh
cd ios
/opt/homebrew/bin/pod install
cd ..
npm run ios
```

For Android UI development:

```sh
npm run android
```

Android currently compiles the shared React Native UI but fails closed for
local runtime/workspace operations because Android KeyStore, model transport,
session persistence, and rish native bindings have not been implemented.

## Build and verify the iOS local-substrate proof

The proof build links rish and libgit2 into a self-contained app and does not
depend on Metro or a Mac `dsh web` process. Both dependencies are packaged as
device + Simulator arm64 XCFrameworks.

From the repository root:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
/opt/homebrew/bin/pod install

xcodebuild \
  -workspace DSHMobile.xcworkspace \
  -scheme DSHMobile \
  -configuration Release \
  -sdk iphonesimulator \
  -destination 'platform=iOS Simulator,id=<UDID>' \
  -derivedDataPath build/local-proof-arm64 \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  build

xcrun simctl install <UDID> \
  build/local-proof-arm64/Build/Products/Release-iphonesimulator/DSHMobile.app
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
  --secure-stdin <UDID> dev.zseven.dsh.mobile
```

In the app, select **V4 Flash**, complete a real response, terminate and
relaunch the app, then verify the correlated record:

```sh
./scripts/verify-local-proof.rb <UDID> dev.zseven.dsh.mobile
```

The verifier currently pins its acceptance request to V4 Flash. It checks the
actual container file and live Simulator process; a screenshot or an inherited
boolean is not sufficient evidence.

## Quality gates

```sh
cd apps/mobile
npm run typecheck
npm run lint
npm test -- --runInBand

cd android
./gradlew assembleDebug

cd ../../..
ruby scripts/verify-no-bundled-secret.rb
ruby scripts/verify-no-bundled-secret.rb \
  apps/mobile/ios/build/local-proof-arm64/Build/Products/Release-iphonesimulator/DSHMobile.app
```

The Jest suite covers typed state/persistence, theme and locale resolution,
chat isolation/history, request cancellation/retry, reasoning, structured tool
display, the Markdown subset, credential recovery, workspace create/edit with
revision protection, and portable-tool receipts. The native Release build and
the proof verifier remain separate required gates.

## What is still missing

- The real DSH AgentLoop, SessionEvent replay, tool registry, provider/plugin
  host, autonomous tool loop, approvals, and structured questions.
- Token/reasoning/event streaming; the current native request returns one
  completed response.
- DSH plans, goals, jobs, subagents, workflow runs, queues, steering, skills,
  plugins, agent presets, usage/stats, and produced-file event integration.
- Share-extension input, OCR for scanned PDFs, full DSH Markdown parity (links,
  tables, math, images), and message edit/regenerate/export/feedback actions.
- Git pull/fetch UI, merge/rebase, SSH, LFS, submodules, signed commits, and
  force push. The current Git slice intentionally supports a smaller auditable
  HTTPS workflow.
- Android native local runtime/workspace adapters and device proof.

See [the DSH Web parity matrix](docs/dsh-web-parity.md),
[the mobile UI audit](docs/mobile-ui-audit.md), and
[the proof contract](docs/local-runtime-proof.md) for the exact boundaries.
