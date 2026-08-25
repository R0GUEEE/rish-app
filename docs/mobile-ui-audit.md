# Mobile UI audit

## Current Rish implementation boundary

- Target: iPhone 17 Pro Simulator, iOS 26.5, portrait.
- UI: React Native 0.87 native views with Fabric and Hermes; no `WKWebView`.
- Runtime claim: `local_substrate`, with Mac `127.0.0.1:3180` closed during the
  proof run.
- Credential: `WhenUnlockedThisDeviceOnly` iOS Keychain storage; its value is
  never returned to React Native, persisted with chats, logged, or bundled.
- Harness: DSH is the first built-in native adapter under the Rish runtime.
- Model: native `URLSession` requests to DeepSeek V4 Flash/Pro/Flash Vision Exp
  with the complete active-conversation history and selected thinking mode.
- Execution: linked rish portable applets in an app-owned workspace.
- Persistence: multiple local conversations plus preferences restored from the
  Simulator App Container and correlated to response/session/reasoning hashes.

This remains explicitly below `local_harness`: the selected Harness AgentLoop,
event log, tool registry, approval/question protocols, and registered agent
round are not mounted.

## Reference-derived mobile rules

The supplied Claude and ChatGPT mobile references converge on a useful mobile
shape without requiring a visual clone:

1. Keep the conversation canvas quiet and single-column.
2. Put navigation and recent chats in a temporary drawer, not a desktop rail.
3. Make the bottom composer the primary interaction and keep it above the
   keyboard and safe area.
4. Move settings and local files into focused sliding panels; use compact
   bottom sheets for model and conversation actions.
5. Surface runtime trust as a small status that can open exact evidence, not as
   a marketing claim on the home screen.
6. Never leave visible controls inert. Features such as camera, import, share,
   or voice stay hidden until their native behavior exists.
7. Adapt DSH Web capabilities to touch, safe areas, and one-handed interaction;
   do not transplant its desktop column layout.

DSH keeps its own identity: an original geometric mark, near-black/light
paired palettes, restrained coral action accents, and green reserved for
verified local state. The approved app icon intentionally has no whale and
does not reuse plugin artwork.

## Implemented React Native surfaces

### Conversation

- Quiet time-aware empty state with three localized prompt suggestions.
- Compact multiline composer with per-chat model choice and request-scoped Stop.
- Assistant content on an open canvas and restrained user bubbles.
- Mobile Markdown for headings, bullets, quotes, inline code, and fenced code.
- Collapsible model-reasoning section, controlled by the stored visibility
  preference.
- Collapsible tool-call/result cards with pending/running/success/error/
  cancelled presentation and optional auto-expand.
- Failure banner that keeps the composer usable and exposes Retry.

The model response is currently delivered as one completed result. The
reasoning and tool components are event-ready presentation primitives, but the
chat does not yet receive a streaming DSH trajectory or autonomous tool events.

### Navigation and chat state

- Temporary navigation drawer with New Chat, search, local Files, Runtime,
  Settings, recent conversations, and active state.
- Multiple conversations with automatic title, preview, switch, rename, and
  confirmed deletion.
- V4 Flash/Pro/Flash Vision Exp model persisted per conversation; new conversations use the
  stored default.
- Complete multi-turn history in each native request, late-response rejection,
  safe cancellation by request ID, and retry after failure.

### Settings

- Right-side animated drawer that slides in/out over a scrim.
- Theme: follow system, light, or dark.
- Language: follow system, Simplified Chinese, or English. Both dictionaries
  share the same typed key set, and changes apply without restart.
- DeepSeek credential status, native secure configure/replace prompt, and
  clear action.
- Default model and current-chat model; thinking off/high/max lives beside the composer; show reasoning,
  and auto-expand tool cards.
- Local workspace permission: read-only or read/write, plus an optional delete
  confirmation.
- Link to native runtime evidence and reset-to-default preferences.

The workspace permission setting currently guards this app's file-manager
mutations. It is not yet the DSH permission-policy engine and cannot authorize,
deny, or approve autonomous AgentLoop tool calls.

### Local Files

- Right-side animated Files drawer rooted in an app-owned workspace.
- Nested directory navigation and bounded list/read operations.
- Create text file/folder, open/edit text, revision-protected atomic save,
  rename, recoverable move-to-trash, trash listing, and restore.
- Read-only UI mode disables every mutation, including create, edit, rename,
  trash, and restore, while retaining navigation, reads, and the allowlisted
  read-only tools.
- Explicit `sha256sum` and word-count actions produce real rish receipts and
  render through the same structured tool cards.

The native contract also allowlists `cat`, `grep`, `head`, `tail`, `wc`, and
`sha256sum`; only checksum and count are currently exposed as Files UI actions.
Import, document-provider access, export, and share are not implemented.

### Runtime evidence

- Platform, Fabric/Hermes, model transport, credential status, rish path, Mac
  port state, process ID, proof run, and restart restore are visible without
  leaking the key or full container path.
- The surface explicitly states `DSH Core: not mounted`.
- A separate Ruby verifier reconstructs request/session/assistant/reasoning
  hashes and checks the live Simulator process.

## Functional regression matrix

| Flow                  | Expected result                                                                                           |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| Empty suggestion      | Fills the composer in the active locale.                                                                  |
| First request         | Sends native full history, persists user/assistant, and records proof metadata.                           |
| Second request        | Includes the preceding turn in request order.                                                             |
| Thinking high/max     | Passes the selected mode and persists/renders returned reasoning.                                         |
| Hide reasoning        | Keeps reasoning in local state/proof while omitting it from the chat surface.                             |
| Stop                  | Cancels only the matching request ID; a late completion is ignored.                                       |
| Retry                 | Retains the user's failed turn and successfully replaces the response path.                               |
| New Chat              | Preserves prior conversations and applies the stored default model.                                       |
| Search                | Filters titles and previews without mutating chat order.                                                  |
| Rename/Delete         | Opens only after drawer handoff; persists rename and confirms deletion.                                   |
| Theme/locale          | Applies immediately and survives process restart.                                                         |
| Credential prompt     | Is secure/cancellable and never reveals the stored value.                                                 |
| Workspace create/read | Creates an app-owned text file and reads the same content.                                                |
| Workspace stale save  | Expected-revision mismatch fails instead of overwriting a newer file.                                     |
| Workspace read-only   | Disables create, edit, rename, trash, and restore; browsing, reads, and read-only tools remain available. |
| Trash/restore         | Produces a recoverable receipt, survives reload, and restores by receipt ID.                              |
| rish tool             | Displays a validated portable-applet receipt for the selected file.                                       |
| Restart proof         | Restores the completed session with a new launch/process identity.                                        |
| Corrupt state         | Strict schema validation fails closed without crashing the app.                                           |
| Missing adapter       | Shared Android UI remains usable and local capabilities fail closed.                                      |

## Automated gates

- TypeScript `tsc --noEmit` and React Native ESLint.
- Jest reducer/store/persistence tests and React Native integration tests for
  chat, preferences, Markdown, reasoning/tool cards, Keychain recovery, Files,
  revision protection, and rish receipts.
- Signed arm64 iOS Release Simulator build and Xcode build/analyze checks.
- Android Debug assembly for the shared UI.
- Source/app-bundle secret scanning.
- External machine-readable proof verification after a real request and real
  process restart.

Passing unit tests or compiling Android does not by itself prove the native iOS
runtime. Passing the iOS build does not by itself prove restart restoration or
that the Mac DSH proxy was closed. Keep the gates separate.

## Remaining product work

1. Mount DSH Core: AgentLoop, SessionEvent log/replay, tool registry, provider
   and plugin host, permission policy, approvals, and structured questions.
2. Stream model tokens, reasoning, lifecycle, and tool events instead of
   waiting for a completed native response.
3. Add attachment/document-provider import with safe app-sandbox copies,
   produced-file previews, export, and share.
4. Reach full Markdown parity for links, tables, math, images, richer lists,
   and selectable/copyable code actions.
5. Add message copy, edit, regenerate, quote, export, and feedback actions.
6. Add DSH plans, goals, jobs, subagents, workflows, queues, steering, skills,
   plugins, agent presets, usage, and statistics in mobile-native forms.
7. Implement Android KeyStore, native model transport, persistence, workspace,
   and rish bindings, then establish an Android device proof.
8. Replace the temporary legacy bridge with Codegen TurboModules while keeping
   the same narrow native security boundary.

The feature-by-feature Web comparison is maintained in
[`dsh-web-parity.md`](dsh-web-parity.md).
