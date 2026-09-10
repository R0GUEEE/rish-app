<p align="center">
  <img src="./brand/rish-readme-icon.svg" alt="Rish" width="96" />
</p>

<h1 align="center">Rish, your pocket Agent.</h1>

<p align="center">
  <strong>Execute on your phone. Connect your choice of model.</strong><br />
  <sub>Local workspaces · Model choice · Tool execution · Approvals</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM API</strong><br />
  <sub>Built-in connections · Native Rish adapters</sub>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#built-in-connections">Built-in connections</a> ·
  <a href="#product-tour">Product tour</a> ·
  <a href="#platforms-and-models">Platforms and models</a> ·
  <a href="./docs/development.md">Developer guide</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

Rish brings Agent conversations, workspaces, and tool execution to your phone.
Choose a model, describe a task, inspect the work, and approve changes without
keeping a computer running. Coding is one of its uses, not its only purpose.

> **Preparing an experimental source preview.** iOS supports local Files, Git,
> and controlled Agent tools. Android supports API chat and session storage;
> local tool execution is still in development. No stable installable release
> is available yet.

## Built-in connections

**Four built-in connections. One pocket workspace.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · Editable model catalog</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · Messages API</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · Responses API</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM API</strong><br />
  <sub>Zhipu · Messages-compatible API</sub>
</td>
</tr>
</table>

Select a Harness, configure your own key, and work with files and projects on
your phone. This first set uses native API adapters built into Rish, which
manages the workspace, tool approvals, and execution records. Platform
availability is listed below.

These entries provide API adaptation under the listed names. Full official CLI
and subscription-login support have a separate [experimental status](docs/ios-harness-auth-status.md).

[ZCode](https://zcode.z.ai/en/docs/agents) is Zhipu's agent product; GLM is the
model family. iOS now includes a separate account connection: BigModel sign-in
and restart persistence have been verified, along with a real GLM-5.3 response
using a personal Coding Plan. Trial allowance remains unverified. The ZCode runtime is not integrated.
See [account connection status](docs/zcode-account-login.md).

## Product tour

Follow Agent execution, review project changes, and choose a model connection.
Click a screenshot to open the original.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Actual Rish iOS Simulator conversation showing progress, a list_dir tool call, and its final answer" width="280" /></a><br />
  <sub><b>Agent conversation</b> — Follow progress, tools, and results. The shown text survives app restart.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Rish iOS Simulator showing unstaged files and change statistics" width="280" /></a><br />
  <sub><b>Local projects</b> — Inspect unstaged files and change statistics before committing.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Rish iPad Simulator showing the workspace sidebar and four native API adapter entries" width="100%" /></a><br />
  <sub><b>iPad workspace and model connections</b> — A wide-screen sidebar, dark appearance, and API adapter entries.</sub>
</td>
</tr>
</table>

All captures are from actual Simulators. The adapter screen demonstrates the
UI, not verified official CLI or subscription-login support.

## Why Rish

<table>
<tr>
<td width="50%">

### Your workspace travels with you

Keep files and projects in the phone's app-owned workspace. Import material,
read files, review project changes, and continue working in one app.

</td>
<td width="50%">

### Choose your model

Start with the built-in DSH, Claude Code, Codex, and GLM API entries, or configure
a compatible API service and model mappings. The model proposes the next step;
local tools perform the operation.

</td>
</tr>
<tr>
<td width="50%">

### See the work happen

Follow each round's text, optional provider-returned reasoning, tool calls,
and final result. Open links directly and return to saved conversations.

</td>
<td width="50%">

### Stay in control

Tools operate inside a bounded workspace. Operations that need authorization
ask first; file changes and Git diffs are available for review.

</td>
</tr>
</table>

## Put it to work

| Task | A starting point |
| --- | --- |
| Work with information | Import text or a PDF, ask for key points, then review the notes the Agent saves. |
| Organize files | Inspect a project directory, read selected files, and approve new or updated content. |
| Maintain a project | Review Git status and diffs, edit files, and approve a commit. |

These examples use the currently available iOS capabilities. Supported tools
and file formats vary by platform. For the Linux Guest experiments, see the
[runtime reference](docs/development.md#honest-runtime-boundary).

## How local execution works

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

Supported tools execute in the phone's app-owned environment. Model requests
send selected conversation and task context to your configured service:
**local execution does not mean offline model inference**.

Rish combines native file/Git operations, the Rish runtime, and an experimental
Linux Guest. Full desktop-program compatibility and indefinite background
execution are not promised. The [developer guide](docs/development.md) separates
verified capabilities from experimental paths.

## Platforms and models

| Platform | Current scope |
| --- | --- |
| iOS / iPadOS | Native conversations, attachments, Files, Git, and controlled Agent tools; includes adaptive iPad layouts. |
| Android | Native API chat, credential storage, session recovery, and scoped task notifications. Local Agent, Files, and Git execution are not yet available. |
| HarmonyOS | Temporary Android compatibility-container checks do not establish native HarmonyOS support. |

| Connection | Current method |
| --- | --- |
| DeepSeek / DSH | API key and editable model catalog; capabilities depend on the model and platform. |
| GLM | API key, plus a separate iOS account connection. BigModel Coding Lite requests with GLM-5.3 are verified; trial access remains unverified. |
| Codex | API adapter; the optional iOS experiment has verified subscription login, Luna chat, and an on-device directory tool call. |
| Claude Code | API adapter with compatible-service configuration; subscription login remains unverified. |
| Custom services | On iOS, select Messages, Responses, or Chat Completions and configure model mappings. |

Codex subscription access requires the optional experimental build and does not
establish full official CLI compatibility. See [auth status](docs/ios-harness-auth-status.md).

## Get started

Build from source for now; there is no stable end-user download. Once you have
the source, start at the repository root:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** Native preparation requires pinned Xcode, Rust, and SDK versions.
Read the [prerequisites](docs/development.md#ios-build-prerequisites), then run:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** With an Android development environment configured, run
`npm run android --prefix apps/mobile`. The developer guide also covers
[standalone test APKs](docs/development.md#install-and-run-the-react-native-app).

In the app, select a model and configure your key. On iOS, create or select a
project and confirm its context before starting a task. Keys use native secure
storage; do not put them in source or commits.

## Progress and contributing

The first source preview is in preparation. Future releases will be marked
**Pre-release**. Complete Harness compatibility, Android local execution, and
continuous background operation remain limited. See the
[preview scope and roadmap](docs/releases/v0.1.0.md).

Contributions to documentation, platform support, model compatibility, and
reproducible fixes are welcome. Read [CONTRIBUTING](CONTRIBUTING.md) first.
For security issues, consult [SECURITY](SECURITY.md) before sharing details;
never post credentials or sensitive data publicly.

- [Developer and build guide](docs/development.md)
- [Source-preview progress](docs/open-source-sprint.md)
- [Brand and approved copy](brand/README.md)
- [Third-party notices and Guest sources](THIRD_PARTY_NOTICES.md)

Project code is licensed under [MIT](LICENSE). Third-party runtimes, Guest
components, and other dependencies retain their own licenses.
