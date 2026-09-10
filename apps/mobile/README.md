# Rish Mobile (React Native)

The touch-first Rish Harness runtime, built with React Native 0.87, Fabric, and
Hermes. DSH is the first built-in native adapter. The product renders native
React Native views and is separate from the historical Swift `WKWebView` proxy
at the repository root.

## Current boundary

The verified iOS mode is `local_substrate`:

- the DeepSeek credential stays in `WhenUnlockedThisDeviceOnly` Keychain and
  is consumed by native code only;
- native `URLSession` sends complete multi-turn history with the selected
  V4 Flash/Pro/Flash Vision Exp model and per-conversation thinking mode;
- local conversations, preferences, assistant text, and optional reasoning are
  persisted in the App Container and restored after process restart;
- the linked rish library executes portable applets inside bounded app-owned
  workspaces;
- a native proof record correlates the request/history/assistant/reasoning
  hashes, session bytes, rish receipt, process restart, live Simulator PID, and
  a closed Mac DSH port.

This is not yet `local_harness`. The DSH AgentLoop, SessionEvent log/replay,
Cordis tool registry, autonomous tool loop, approvals, questions, plugins, and
provider host are not mounted yet.

## Implemented mobile surfaces

- Multiple local chats with create, search, switch, automatic title, rename,
  confirmed delete, per-chat model, Stop, retry, and late-response rejection.
- Follow-system/light/dark appearance and follow-system/Simplified
  Chinese/English UI, applied immediately and persisted.
- Right-side animated Settings and Files drawers.
- Thinking off/high/max selected beside the composer, with persisted, hideable, collapsible reasoning.
- Markdown headings, bullets, quotes, inline code, and fenced code, plus
  collapsible tool-call/result cards.
- App-owned file manager with nested folders, text create/read/edit,
  revision-protected atomic writes, rename, recoverable trash/restore, and
  explicit `sha256sum`/`wc` rish receipts.
- Read-only/read-write workspace preference and destructive-action
  confirmation. This is a mobile file-manager guard, not the DSH permission
  policy engine.
- Package mirror manager for Alpine APK, Python pip, and Node npm with presets,
  custom HTTPS URLs, speed tests, and native rish guest-overlay staging.

Android compiles the shared React Native UI but currently fails closed for
local runtime/workspace operations. Android KeyStore, native model transport,
session persistence, rish bindings, and device proof remain to be implemented.

## Toolchain

- React Native 0.87.0 and React 19.2.3
- React Native Community CLI 20.2.0
- TypeScript 6
- Hermes and Fabric / New Architecture
- Node 22.11 or newer

## Install and run

```sh
npm ci
```

iOS development build:

```sh
cd ios
/opt/homebrew/bin/pod install
cd ..
npm run ios
```

Android UI development:

```sh
npm run android
```

The self-contained iOS Release proof also requires the pinned rish source
checkout. From the repository root, run `./scripts/prepare-rish-ios.sh` to
fetch a temporary detached copy, or pass a reviewed checkout path (also
accepted through `RISH_SOURCE_DIR`), then install Pods,
build the arm64 Simulator Release app, provision Keychain through
`scripts/provision-simulator-key.rb`, complete and restore a V4 Flash turn, and
run `scripts/verify-local-proof.rb`. The full reproducible commands are in the
root [`README.md`](../../README.md).

## Quality gates

```sh
npm run typecheck
npm run lint
npm test -- --runInBand

cd android
./gradlew assembleDebug
```

The Jest suite covers strict chat/preference state, deterministic persistence,
theme/locale resolution, complete-history requests, model/thinking selection,
reasoning and structured output, Markdown, cancellation/retry, credential
recovery, workspace create/edit with revision protection, and real portable
tool receipts.

Before sharing source or a built app, run the root
`scripts/verify-no-bundled-secret.rb`. Never place an API key in source, an
environment file, shell history, a README, a fixture, logs, session JSON, or an
app bundle.

## Native boundary

`LocalRuntime` and `LocalWorkspace` are temporary legacy bridge modules.
JavaScript receives typed status/data, never the API key, arbitrary filesystem
roots, raw VM pointers, or a general shell. The production migration should use
Codegen TurboModules while retaining the same narrow, bounded contracts.

See the root [README](../../README.md), [contribution guide](../../CONTRIBUTING.md),
and [security policy](../../SECURITY.md) for the source checkout's current
boundary. Product evidence and detailed parity records are maintained
separately and are not required to build this directory.
