# Plugins, skills and the marketplace

Rish lets a person add **plugins**: named declarations of tools they want the
Agent to be able to call. This document is the contract between the app-side
manager (`apps/mobile/src/plugins/plugins.ts`) and the native Agent core, and it
records what the native side still has to do before a plugin tool can be called.
It also covers **skills**, which are text rather than tools, and the
**marketplace**, which is how both arrive (`apps/mobile/src/skills.ts`,
`apps/mobile/src/marketplace.ts`).

## Why a plugin is a declaration

Two facts bound what a plugin can be on iOS:

- **Nothing loads third-party executable code into the app.** A plugin cannot
  ship a binary, a dylib, or a script the app evaluates. Anything a plugin tool
  executes has to be something the app already knows how to run, in a place the
  app already controls.
- **The Agent's tool table is frozen in the native core**
  (`modules/rish/core/crates/rish-agent-core/src/tool_registry.rs`). Its
  canonical bytes are the `toolset_sha256` that every stored attempt,
  checkpoint, and journal row is bound to. A tool that is not in that table is
  not in the digest, is not advertised to the model, and cannot be granted.

So a plugin declares tools, and the app records, validates and displays the
declaration. It does not, today, make those tools callable — see
*What the native side must do*.

## The declaration

A plugin carries a bounded, validated shape:

| Field | Rule |
| --- | --- |
| `id` | `^[a-z][a-z0-9_]{0,39}$` |
| `name` | trimmed, 1–60 characters, no control characters |
| `version` | trimmed, 1–32 characters |
| `description` | trimmed, 1–512 characters |
| `enabled` | whether its tools would be offered |
| `tools` | 0–16 tool declarations |

A tool declaration carries `name` (`^[a-z][a-z0-9_]{0,39}$`), `description`
(1–1024 characters — the provider request's transport limit), `capability`, and
`requiresApproval`.

Rules that exist for a reason:

- **A tool may not shadow a built-in.** `read_file`, `git_push`,
  `run_program` and the rest of `ALL_AGENT_TOOL_NAMES` are refused as plugin
  tool names. Two tools under one name is a call nobody can attribute.
- **The offered name is namespaced**: `<id>__<tool>`. Provider function names
  are at most 64 characters, so the pair is checked against that budget when a
  plugin is created or loaded, and a pair that would not fit is refused rather
  than truncated.
- **Only capabilities the core already checks are allowed**: `file_read`,
  `file_write`, `git_status`, `git_commit`, `git_push`, `guest_service` — the
  `CAPABILITIES` list in `tool_registry.rs`. A plugin asking for an invented
  capability would be describing a permission nothing enforces.
- **The list is bounded at 25 plugins.** Reaching the bound refuses a new
  plugin rather than evicting one; replacing an existing id stays allowed.
- **Persistence refuses a partial list.** Plugins are stored as an app
  preference (`plugins`), and hydration validates the whole list, exactly as
  presets and pinned conversations do: a plugin silently dropped on load is a
  set of tools a person believes the Agent can call.

## What the native side must do

A registry version that admits plugin tools. The Agent's current table is v3
(`AGENT_REGISTRY_VERSIONS` in `apps/mobile/src/native/agent-policy.ts`); the
manager compares the version it reads from the policy against
`PLUGIN_TOOL_REGISTRY_VERSION` (4) and reports `awaiting_native` until then.

The native work, in the order it has to land:

1. **Descriptor admission.** `tool_registry::descriptors` grows an extension
   input — the host-supplied plugin tool declarations, each carrying the
   offered name, a description, a parameter schema, and the `required_capability`
   it maps to. The digest is taken over the extended table, so
   `toolset_sha256` still binds an attempt to exactly the tools it advertised.
   `agentRegistryToolLimit` in the host raises to whatever v4 allows
   (v3 is 13).
2. **Policy projection.** `agent_policy.rs` reports the plugin tools with the
   access level their capability implies, so the Agent policy sheet and the
   approval path keep working unchanged: a declared tool with
   `requiresApproval` is `conversation_confirm`, one without is `auto` when its
   capability is read-only.
3. **Execution.** A plugin tool has no native implementation. The only
   in-app executors are the workspace tools and the guest, so a v4 execution
   either maps the tool to a bounded guest program invocation (the plugin
   declares the program and arguments once, and the tool's parameters fill the
   rest) or hands the call back to the host through a callback the round waits
   on. The former needs no new host protocol and reuses the guest service
   limits; the latter is a new round state and should not be built first.
4. **Refusal stays fail-closed.** A call for a plugin tool whose plugin is
   disabled, removed, or was never admitted must be rejected before dispatch,
   with the same evidence a missing built-in tool produces today.

Until steps 1–3 land, the manager records declarations and says so on screen.
It does not offer a switch that appears to change what the Agent can do while
changing nothing.

## What the app-side manager does today

`apps/mobile/src/plugins/plugins.ts` is pure and fully tested
(`__tests__/plugins.test.ts`): declaration validation, list rules
(add/replace/remove/enable), what the enabled plugins would offer, and the
posture. `PluginManagerSheet` shows the list, each tool under its offered name
with the capability it needs and whether a call asks first, and the posture
line. `HomeScreen` reads the posture from the policy the Agent would actually
run under rather than guessing from a constant.

## Skills

A skill is an instruction document: an id, a name, a version, a description and
up to 8,192 characters of instructions. Using one puts `skillMessageText(skill)`
in the message box, so it becomes an ordinary message the person can read,
edit and send.

That is the whole mechanism, and it is deliberately not more. The visible
history an attempt may use is the conversation's own messages, so a skill that
silently joined every round would be a claim about what the Agent was told that
no transcript supports. Skills take effect when they are sent.

The library holds at most 50 skills, ids are unique, and instructions may
contain newlines and tabs but not the characters that render as nothing.

## The marketplace

A marketplace entry is a kind (`plugin` or `skill`), a publisher, a summary and
one payload that passes the same validation the managers apply by hand. A
catalog is a schema version, a source label and up to 200 entries, and it is
refused as a whole if any part of it is not installable -- a listing silently
missing from a marketplace is worse than one that says it could not be read.

Installing writes the payload into the matching library, replacing the entry
with the same id; a listing shows `Install`, `Update` or `Installed`. Versions
are compared only when both are sequences of numbers: `1.2.10` is newer than
`1.2.9`, while `2026-02-draft` has no ordering and counts as installed rather
than inventing an update.

The catalog this build ships with is bundled (`BUILTIN_MARKETPLACE`), so
nothing is transferred and no digest is claimed. A remote catalog would have to
provide the same shape and go through the same parser, which is the only door
in; when one exists, its entries should carry a digest of the content and the
install path should verify it before writing into a library.

## Guest-mapped execution (the v4 contract)

A plugin brings no code. Nothing loads third-party executable code into an iOS
app, so a plugin tool is a **mapping**: it names a program the guest already
knows how to run, inside one of the language environments the app installs.

```json
{
  "name": "fetch_page",
  "description": "Fetch one page and return its readable text.",
  "capability": "file_read",
  "requiresApproval": false,
  "execution": {
    "kind": "guest_program",
    "environmentId": "node",
    "programPath": "plugin-scripts/fetch_page.js",
    "arguments": []
  }
}
```

The app validates that declaration today: the id shape is the environment
catalog's, the path is workspace-relative with no traversal (the same rule the
workspace tools apply, because a mapping that could name a path outside the run
would be a way around every approval the rest of the Agent asks for), and up to
eight arguments of 256 characters each are passed literally. A tool without a
mapping is accepted but reported as something the Agent could not call.

### What the native core still has to do

1. **Carry the declarations.** The round request grows an optional, bounded
   field: the enabled plugins' tool declarations, taken from the same validated
   library the manager writes. It travels with `registry_version`, so a host
   that sends none keeps asking for the v3 table.
2. **Admit them into the table.** `tool_registry::descriptors` grows the
   declared tools — name (namespaced, `id__tool`), description, parameter
   schema, `required_capability` — and the digest is taken over the extended
   table. **This is why v4 is additive and policy-versioned:** `toolset_sha256`
   is bound into every stored attempt, journal row and checkpoint, so a session
   written under a v3 table must keep validating against the v3 table rather
   than being re-read under v4. The table version a round used is already
   recorded; it has to be *honoured* on read.
3. **Project them into the policy.** Each declared tool appears in the policy
   descriptor with an access level derived from its own declaration:
   `conversation_confirm` when it asks first or when its capability writes,
   `auto` only for a read-only capability that does not. The capability names
   are the core's existing six, so the policy sheet and the conversation-grant
   path need no change.
4. **Execute by mapping.** A call for a plugin tool runs the named program
   through the path `run_program` already uses: the same install-if-necessary
   step, the same foreground bound (one guest at a time, ten minutes for a
   one-shot), the same workspace copy handed to the run, and the same
   stdout/stderr/exit reporting. The tool's `arguments` are passed literally
   after the program path. Nothing new is executed that the environments
   catalog and its digests do not already cover.
5. **Refuse fail-closed.** A call whose plugin is disabled or removed, whose
   mapping the table did not admit, or whose environment is not installed is
   refused before dispatch, with the same evidence a missing built-in tool
   produces today.

### What is already done on the app side

`apps/mobile/src/plugins.ts` validates the declaration and its bounds, the
manager shows each tool under the name a provider would see, the editors write
mappings by hand, a fetched catalog must pass a digest of its payload before it
is shown at all, and the posture line reports whether the Agent's table can
carry any of it yet. What remains above is the native half, and it is the only
part of this document that is a plan rather than a description.
