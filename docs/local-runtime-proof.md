# Local runtime proof

Rish reports three mutually exclusive runtime modes. A UI surface never
upgrades its own mode; only evidence emitted and verified from the native
runtime may do so.

## Modes

| Mode              | Meaning                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `web_proxy`       | UI is on the device; DSH runs elsewhere.                                                             |
| `local_substrate` | Generic local transport, Keychain, sessions, workspaces, and rish substrate run in the app.          |
| `local_harness`   | The selected Harness agent, event log, tool registry, approvals, and persistence all run in the app. |

The root Swift/WebKit spike is always `web_proxy`. The React Native iOS slice
may claim `local_substrate` only after the checks below pass. It must not claim
`local_harness` until the selected Harness event log contains a completed agent
and registered-tool round.

## Machine-readable evidence

The iOS app persists one `runtime-proof.json` record in its Application Support
directory. The relevant schema-v2 shape is:

```json
{
  "schema_version": 2,
  "product": "rish",
  "active_harness": "dsh",
  "mode": "local_substrate",
  "platform": "ios_simulator",
  "bundle_id": "dev.zseven.dsh.mobile",
  "runtime_id": "opaque-native-runtime-id",
  "launch_instance_id": "current-process-id",
  "process_id": 12345,
  "generated_at": "2026-08-24T00:00:00.000Z",
  "proof_run_id": "one-completed-proof-run",
  "container_root": "Application Support",
  "session_store": "sessions.json",
  "model_transport": "url_session",
  "rish_backend": "portable_applet",
  "rish_protocol_version": 1,
  "rish_probe": {
    "protocol_version": 1,
    "program": "sha256sum",
    "exit_code": 0,
    "path_kind": "portable_applet",
    "path_name": "sha256sum",
    "stdout": "<expected digest receipt>"
  },
  "model_response": {
    "proof_run_id": "one-completed-proof-run",
    "launch_instance_id": "writer-process-id",
    "request_id": "one-request-id",
    "request_history_sha256": "canonical-request-history-digest",
    "request_message_count": 3,
    "assistant_text_sha256": "final-assistant-text-digest",
    "reasoning_text_sha256": "reasoning-digest-or-none",
    "thinking_mode": "high",
    "http_status": 200,
    "model": "deepseek-v4-flash",
    "finish_reason": "stop",
    "response_id": "provider-response-id"
  },
  "session_persisted": {
    "proof_run_id": "one-completed-proof-run",
    "request_id": "one-request-id",
    "request_history_sha256": "canonical-request-history-digest",
    "assistant_text_sha256": "final-assistant-text-digest",
    "reasoning_text_sha256": "reasoning-digest-or-none",
    "writer_launch_instance_id": "writer-process-id",
    "sha256": "container-session-file-digest",
    "message_count": 4
  },
  "session_restore": {
    "proof_run_id": "one-completed-proof-run",
    "request_id": "one-request-id",
    "writer_launch_instance_id": "writer-process-id",
    "restore_launch_instance_id": "current-process-id",
    "sha256": "container-session-file-digest",
    "message_count": 4
  },
  "mac_dsh_port_3180_reachable": false,
  "checks": {
    "credential_in_keychain": true,
    "model_response_received": true,
    "session_restored_after_restart": true,
    "rish_applet_executed": true
  }
}
```

The UI renders a value-redacted projection of the same facts. It never shows
the credential, an authorization header, or the full app-container path.

## What the verifier independently checks

`scripts/verify-local-proof.rb` does not trust the proof's four booleans. It
requires:

1. Mac TCP port 3180 has no listener and the proof also reports it unreachable.
2. Product `rish`, active Harness `dsh`, schema, mode, platform, compatibility
   bundle ID, timestamp, proof-run UUID, and request UUID are current and
   internally consistent.
3. The rish receipt is protocol-compatible, used the `sha256sum` portable
   applet, exited successfully, and returned the digest for the verifier's
   fixed input.
4. The DeepSeek request completed over HTTP with a provider response ID and a
   final `stop` result. The current verifier intentionally expects V4 Flash.
5. Model, persisted-session, and restored-session sections belong to the same
   proof run and request.
6. The current `sessions.json` bytes match both persisted and restored SHA-256
   values.
7. Reconstructed request history, final assistant text, and optional reasoning
   independently match the native hashes. Empty reasoning must be recorded as
   `none`.
8. The session writer launch differs from the restore launch, and all launch
   identities correlate to the expected sections.
9. The recorded PID is a live `DSHMobile` process inside that Simulator.

Changing the active conversation, settings, or other persisted session data
after a completed response invalidates the prior proof until another response
is completed, persisted, and restored. This prevents a rewritten session from
borrowing an older successful request.

## `local_substrate` acceptance procedure

1. Build an arm64 Release Simulator app with the linked rish archive and a
   bundled React Native JavaScript bundle; Metro is not part of the proof.
2. Stop every Mac `dsh web` process and prove port 3180 is closed.
3. Install and launch the app in an iOS Simulator.
4. Provision a DeepSeek key into `WhenUnlockedThisDeviceOnly` Keychain storage
   without printing it or putting it in source, session JSON, or the app bundle.
5. Complete a real V4 Flash model request from native `URLSession`. Thinking
   may be off, high, or max; returned reasoning is included in the correlation.
6. Persist the completed turn beneath the Simulator app container.
7. Terminate the app process, relaunch it, and restore the same session bytes.
8. Execute the linked rish `sha256sum` portable applet in the app process.
9. Run `scripts/verify-local-proof.rb` while the relaunched process is alive.
10. Run the bundle secret scanner and capture UI screenshots as supporting,
    not sufficient, evidence.

## Credential handling

The credential is consumed only by native iOS code. The in-app secure prompt
writes directly to Keychain. The command-line provisioner either imports the
managed DSH credential file after ownership/mode checks or reads hidden terminal
input. Its temporary staging file is mode `0600`, is deleted after the app's
value-free acknowledgement, and is never printed.

The proof and session intentionally contain response text and optional model
reasoning, but never the API key. Treat those local files as private user data.

## Relationship to the local workspace

`LocalWorkspace` is a separate bounded native contract. It restricts callers
to the app-owned workspace, rejects symlinks/traversal/reserved trash paths,
limits text reads to 1 MiB and directory listings to 1,000 entries, performs
atomic revision-checked writes, and exposes recoverable trash. Its allowlisted
read-only rish tools are `cat`, `grep`, `head`, `tail`, `wc`, and `sha256sum`,
with tool output capped at 256 KiB.

The Files drawer currently invokes `sha256sum` and `wc` explicitly and renders
their real receipts. These calls demonstrate local tool execution, but they do
not constitute a DSH autonomous tool round and are not used to promote the
runtime to `local_harness`.

## Built-in DSH `local_harness` acceptance

All substrate checks remain required, plus:

1. Mount the DSH agent, session, LLM, prompt, tool, approval, and persistence
   services in the mobile process.
2. Submit through the DSH Agent API rather than the direct native completion
   boundary.
3. Persist and restore the DSH SessionEvent log, including reasoning/tool
   ordering required for valid replay.
4. Execute a registered DSH tool through `dsh-rish` and record its tool call,
   approval if required, and tool result events.
5. Show the reconstructed model history matches that persisted event log.
6. Repeat the process-restart and external verification gates without a remote
   DSH listener.
