# DSH Web parity matrix

This matrix covers the built-in DSH Harness adapter inside Rish and compares it
with the checked DSH Web snapshot at
DeepSeek Harness commit `b150a551b8d4` (`@deepseek-ai/dsh-web-frontend`
`0.1.1-rc.2`) on 2026-08-24. Unless a path is shown, Web evidence basenames
live under `apps/web/tests/`; `reasoning-chunks.stress.ts` lives under
`apps/web/stress-tests/`. Mobile evidence paths belong to this repository.

Parity means functional coverage adapted to a touch-first, single-column app.
It does not mean copying the desktop Web layout.

## Status legend

- **Implemented**: usable mobile behavior exists in the current slice.
- **Partial**: a meaningful mobile subset or presentation primitive exists,
  but the DSH protocol/coverage is incomplete.
- **Not mounted**: the capability depends on DSH Core or UI that is absent.
- **Mobile-specific**: additional mobile trust or device behavior with no direct
  Web equivalent.

## Capability matrix

| Capability in DSH Web                                                                                                                         | Mobile status       | What exists on mobile                                                                                                                                | Exact remaining gap                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Conversation creation and continuous history (`apps/web/tests/chat-continuous-conversation.e2e.ts`, `apps/web/tests/seeded-history.e2e.ts`)   | **Implemented**     | Multiple local chats, full ordered history, restore, per-chat preview/model in `apps/mobile/src/state/` and `apps/mobile/src/screens/HomeScreen.tsx` | No server-side DSH SessionEvent history or cross-device sync.                                                                         |
| Recent-chat navigation and search (`rail-search-expand.e2e.ts`, `sidebar-scrollbar.e2e.ts`)                                                   | **Implemented**     | Touch drawer with New Chat, search over title/preview, active state, rename, and delete                                                              | No Web rail expansion/desktop pane behavior by design.                                                                                |
| Model/default-model settings (`models-settings.e2e.ts`, `default-model.e2e.ts`)                                                               | **Partial**         | V4 Flash/Pro/Flash Vision Exp per chat plus persisted default; thinking is selected beside the composer                                              | No provider/model registry, provider onboarding, capability discovery, or arbitrary model configuration.                              |
| Declared reasoning (`declared-reasoning.e2e.ts`, `reasoning-chunks.stress.ts`)                                                                | **Partial**         | Off/high/max native request option; persisted reasoning; collapsible/hidden reasoning block                                                          | Response is not streamed; no ordered reasoning chunks in a DSH trajectory.                                                            |
| Theme and settings chrome (`settings-chrome.e2e.ts`)                                                                                          | **Implemented**     | Follow-system/light/dark palette in the animated Settings drawer                                                                                     | Mobile setting inventory is intentionally smaller than Web.                                                                           |
| Locale (`packages/client/locale/`)                                                                                                            | **Implemented**     | Follow-system, Simplified Chinese, and English with typed dictionary parity                                                                          | Only two explicit app locales; no Web plugin-provided locale inventory.                                                               |
| Markdown text/code (`markdown-cjk-strong.e2e.ts`, `markdown-inline-code-links.e2e.ts`)                                                        | **Partial**         | Headings, bullets, quotes, inline code, fenced code                                                                                                  | Strong/emphasis, links, richer lists, copy actions, and full CJK edge-case parity remain.                                             |
| Markdown tables, math, and images (`markdown-wide-table.e2e.ts`, `math-rendering.e2e.ts`, `markdown-images.e2e.ts`)                           | **Not mounted**     | None beyond plain Markdown subset                                                                                                                    | Add renderers, safe media loading, horizontal table UX, and math layout.                                                              |
| Streaming trajectory and lifecycle (`trajectory-virtualization.e2e.ts`, `lifecycle-chrome.e2e.ts`)                                            | **Not mounted**     | Completed native response plus local request busy/error state                                                                                        | Native transport must stream tokens/reasoning; DSH event trajectory, lifecycle, and virtualization are absent.                        |
| Tool call/result presentation (`cordis-tool-round.e2e.ts`, `bash-abort-row.e2e.ts`)                                                           | **Partial**         | Collapsible status-aware tool cards; Files emits real `sha256sum`/`wc` receipts                                                                      | Cards are not fed by DSH tool events; no autonomous multi-step tool round, abort event, or replay ordering.                           |
| Tool registry and code/terminal rounds (`code-mode-round.e2e.ts`, `pwsh-terminal.e2e.ts`, `web-search-round.e2e.ts`)                          | **Not mounted**     | Six bounded read-only rish applets exist behind `LocalWorkspace`; two are exposed in UI                                                              | No general shell, terminal, code mode, Web tools, Cordis registry, or AgentLoop invocation. This is an intentional security boundary. |
| Workspace/cwd management (`workspace-management.e2e.ts`, `home-path-tilde.snapshot.ts`)                                                       | **Partial**         | App-owned nested workspace; bounded text CRUD; revision checks; recoverable trash                                                                    | No arbitrary filesystem root/cwd picker, external document provider, project pin/browse, or Web workspace registry.                   |
| Local package mirrors                                                                                                                         | **Mobile-specific** | Alpine APK, Python pip, and Node npm presets/custom HTTPS URLs, HEAD speed tests, persisted settings, and native guest-overlay staging               | Persistent rish guest is not mounted, so staged files are not yet consumed by a running package manager.                              |
| Attachments and references (`reference-composer.e2e.ts`, `command-image-envelope.snapshot.ts`)                                                | **Not mounted**     | No visible attachment/import control                                                                                                                 | Add safe document/photo/camera ingestion, app-sandbox copies, reference envelopes, limits, previews, and cleanup.                     |
| Produced files (`produced-files.e2e.ts`, `produced-file-mentions.e2e.ts`)                                                                     | **Partial**         | Users can create and edit app-owned text files manually                                                                                              | No DSH produced-file events, mentions, overlay/preview, download/export, or share integration.                                        |
| Permission-policy context (`permission-policy-context.e2e.ts`)                                                                                | **Partial**         | Stored read-only/read-write preference disables all workspace mutations, including trash restore                                                     | It is a UI/native workspace guard, not DSH policy evaluation for agent tools.                                                         |
| Approval composer (`approval-composer.e2e.ts`, `access-confirmation.e2e.ts`)                                                                  | **Partial**         | `approval_request`/`approval_response` trajectory events with `once`/`conversation` scope choice, allow/deny composer, fail-closed settlement, persisted + restart replay, denied `tool_result` (`apps/mobile/src/agent/AgentApprovals.ts`, `runAgentTurn.ts`, `components/ApprovalComposer.tsx`) | Agent-loop submission is not wired to the send path, so no production flow starts a turn yet; conversation-scope grants deliberately do not survive turns/restarts; user-initiated file-delete confirmations remain native Alerts (they are not tool calls). |
| Structured questions (`question-composer.e2e.ts`)                                                                                             | **Partial**         | `question`/`question_response` trajectory events behind the `ask_user` tool; options/free-text composer with validation, submit, cancel; answers reach the model via tool feedback; persisted + replayable (`apps/mobile/src/agent/AgentQuestions.ts`, `components/QuestionComposer.tsx`) | Questions can only arise while an agent turn runs, and no production trigger starts agent turns yet; no runtime-originated question source (harness/MCP) is mounted.                                     |
| Plans and plan review (`plan-control-row.e2e.ts`, `plan-review.e2e.ts`)                                                                       | **Not mounted**     | None                                                                                                                                                 | Add plan lifecycle, review/approve/edit controls, and trajectory rendering.                                                           |
| Goals (`goal-bar.e2e.ts`, `goal-multi-turn-actions.e2e.ts`, `goal-command-presentation.e2e.ts`)                                               | **Not mounted**     | None                                                                                                                                                 | Add goal state, budget/status, multi-turn controls, and command presentation.                                                         |
| Subagents (`subagent-conversation.e2e.ts`, `subagent-interrupt-ui.e2e.ts`, `sidebar-subagent-activity.e2e.ts`)                                | **Not mounted**     | None                                                                                                                                                 | Add subagent event tree, activity, conversation drill-in, interrupt, and result handoff.                                              |
| Background jobs, workflows, queues, steering (`background-job-list.e2e.ts`, `workflow-run.e2e.ts`, `queue-actions.e2e.ts`, `steering.e2e.ts`) | **Not mounted**     | None                                                                                                                                                 | All corresponding DSH services, events, and mobile control surfaces are absent.                                                       |
| Skills (`skill-user-invoke.e2e.ts`, `skill-tool-row.e2e.ts`, `skill-invocation-policy.e2e.ts`)                                                | **Not mounted**     | None                                                                                                                                                 | No skill inventory, invocation, policy, content rendering, or tool row.                                                               |
| Plugins (`plugin-config.e2e.ts`)                                                                                                              | **Not mounted**     | None                                                                                                                                                 | No Cordis/plugin host, inventory, install/configure/permission UI, or plugin-contributed surfaces.                                    |
| Agent presets (`agent-preset-selection.e2e.ts`, `agent-preset-authoring.e2e.ts`)                                                              | **Not mounted**     | None                                                                                                                                                 | No preset inventory, authoring, selection, or runtime application.                                                                    |
| Usage, statistics, and paged history (`stats-paged-history.e2e.ts`)                                                                           | **Not mounted**     | Local chat list only                                                                                                                                 | No DSH usage accounting, token/cost statistics, server paging, or analytics view.                                                     |
| Message actions and feedback (`message-actions.e2e.ts`, `message-feedback.e2e.ts`, `turn-tail-actions.e2e.ts`)                                | **Not mounted**     | Conversation rename/delete and request retry only                                                                                                    | Add per-message copy/edit/regenerate/quote/export/feedback actions and protocol events.                                               |
| Runtime proof                                                                                                                                 | **Mobile-specific** | Native proof correlates transport, request/history/assistant/reasoning hashes, rish, persisted/restore launches, live PID, and closed Mac port       | Extend the proof only when DSH Core and Android are genuinely mounted; do not relabel early.                                          |
| Secure mobile credential boundary                                                                                                             | **Mobile-specific** | Native secure prompt and iOS Keychain; JavaScript receives status only                                                                               | Android KeyStore and Android-native transport are missing.                                                                            |

## Release gates by parity layer

### Current `local_substrate` gate

- Native Release app runs without Metro or a Mac DSH listener.
- Key remains Keychain-only and bundle secret scan passes.
- Real DeepSeek request, optional reasoning, session persistence, process
  restart, and rish probe correlate through the external verifier.
- Files CRUD, revision protection, trash/restore, and rish tool receipts pass
  unit/integration plus Simulator smoke tests.
- Theme and both explicit locales survive restart.

### Required before the DSH adapter reaches `local_harness`

- AgentLoop submission and a persisted/replayed DSH SessionEvent trajectory.
  Trajectory persistence/replay and the approval/question protocol rows land;
  submission itself (a production send-path trigger for `runAgentTurn`) is the
  remaining piece.
- Registered tool calls/results with approval and structured-question handling.
  The protocol, composers, fail-closed settlement, and restart replay are
  implemented and tested; the send-path entry point that would surface them
  to users is still missing.
- Correct replay ordering for assistant reasoning/tool calls and tool results.
- DSH permission policy, workspace context, provider/plugin host, and failure/
  cancellation semantics.
- Restart proof extended to verify the DSH event log and registered tool round.

### Later parity layers

- Attachments/produced files and richer Markdown/message actions.
- Plans/goals/subagents/jobs/workflows/queues/steering.
- Skills, plugins, agent presets, usage/stats, and Android native parity.

The order is deliberate: proving the local agent/event/tool boundary matters
more than reproducing every desktop Web control.
