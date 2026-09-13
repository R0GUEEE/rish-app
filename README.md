<p align="center">
  <img src="./brand/rish-readme-icon.svg" alt="Rish" width="96" />
</p>

<h1 align="center">Rish, your pocket agent.</h1>

<p align="center">
  <strong>Run locally. Choose your model.</strong><br />
  <sub>Local workspaces · Model choice · Tool execution · Approvals</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>Built-in connections · Native Rish adapters</sub>
</p>

<p align="center">
  <b>English</b> · <a href="./README.zh.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#built-in-connections">Built-in connections</a> ·
  <a href="#product-tour">Product tour</a> ·
  <a href="#platforms-and-models">Platforms and models</a> ·
  <a href="#ecosystem">Ecosystem</a> ·
  <a href="./docs/development.md">Developer guide</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — your pocket agent. Local execution. Model freedom. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

Rish brings Agent conversations, workspaces, and tool execution to your phone.
Choose a model, describe a task, inspect the work, and approve changes without
keeping a computer running. Coding is one of its uses, not its only purpose.

> **Preparing an experimental source preview; no stable installable release
> yet.** Platform scope and account/subscription verification status are
> summarized in [Platforms and models](#platforms-and-models).

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
  <sub>Anthropic · API key / Subscription sign-in¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · API key / Subscription sign-in¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · API key / Subscription sign-in¹</sub>
</td>
</tr>
</table>

¹ Subscription sign-in is currently iOS-only. BigModel Coding Lite is verified; Codex and Claude Code require the optional experimental build. See the verification details below.

Choose a harness and connect with an API key or an account supported by your
build. Then start working with files and projects on your phone. Rish manages
the agent loop, workspace, tool approvals, and execution records; the built-in
adapters connect to model services.

**Account and subscription verification (iOS)**

- **Codex**: the optional experimental build has verified official-CLI device
  login, a subscription `gpt-5.6-luna` text chat, a local `list_dir` tool call,
  and persistence across restart. The official CLI is used only for login; not
  all tools and models are verified.
- **GLM**: [ZCode](https://zcode.z.ai/en/docs/agents) is Zhipu's agent product;
  GLM is the model family. BigModel sign-in, restart persistence, and a Coding
  Lite GLM-5.3 response are verified; the trial allowance is not. The official
  ZCode runtime is not integrated.
- **Claude Code**: the optional iOS experimental build has verified subscription
  login, a Haiku 4.5 text response through the unmodified official CLI, and
  persistence across restart.
  This path currently supports text only, without tools or attachments. A
  measured turn took about 4.5 minutes; performance still needs work.

## Product tour

Follow Agent execution, review project changes, and choose a model connection.
Click a screenshot to open the original.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Rish on an iPhone showing two successful tool calls and a summary explaining that an absolute path was refused" width="280" /></a><br />
  <sub><b>Agent conversation</b> — Follow progress, tool calls, and results on the phone. A path outside the workspace is refused, and the model corrects itself in the next round.</sub>
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

All captures are from actual Simulators, showing the current UI and workflow.

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

Start with the built-in DSH, Claude Code, Codex, and GLM entries, or configure
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
| GLM | API key, plus an optional BigModel/Z.ai account connection; see the status above. |
| Codex | API adapter; the optional iOS experimental build adds subscription sign-in — see the status above. |
| Claude Code | API adapter with compatible-service configuration; subscribed text calls are verified in the optional iOS build, with the scope and latency noted above. |
| Custom services | On iOS, select Messages, Responses, or Chat Completions and configure model mappings. |

## Ecosystem

Rish is part of a family of local-first, AI-native tools from **[ZSeven-W](https://github.com/ZSeven-W)**. `rish` boots the Linux guest inside this app; the others carry the same idea onto other surfaces — the terminal, the design canvas, and an agent's memory.

| Project | What it is |
| ------- | ---------- |
| **[rish](https://github.com/ZSeven-W/rish)** | Real Docker on a phone: a no-JIT x86-64 full-system interpreter in pure Rust that boots Linux and runs containers on iOS and Android. This app's Linux Guest comes from here. |
| <img src="./docs/images/ecosystem/openpencil.png" alt="OpenPencil" width="40" /> **[OpenPencil](https://github.com/ZSeven-W/openpencil)** | The first open-source AI-native vector design tool, and the first with concurrent Agent Teams. Design-as-Code — turn prompts into UI directly on the live canvas. |
| <img src="./docs/images/ecosystem/jian.png" alt="jian" width="40" /> **[jian](https://github.com/ZSeven-W/jian)** | Pure-Rust, GPU-Skia UI framework. Turns a declarative `.op` document into a native app — no JS runtime, no DOM, no Electron. |
| <img src="./docs/images/ecosystem/zode.png" alt="Zode" width="40" /> **[Zode](https://github.com/ZSeven-W/zode)** | AI-native coding CLI for your terminal. A fast Rust TUI that reads your code, runs commands, searches files, and manages git. |
| <img src="./docs/images/ecosystem/noema.png" alt="noema" width="40" /> **[noema](https://github.com/ZSeven-W/noema)** | Local-first, non-vector memory for coding agents. Durable memory as inspectable files, a review queue, and embedding-free recall. |

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

Open the app, choose a model, and connect with an API key or a supported account.
On iOS, create or select a project, review its context, and start a task. Codex and Claude Code
subscription sign-in requires an optional experimental build (see the [developer guide](docs/development.md));
see the [account guide](docs/zcode-account-login.md) for BigModel. Credentials
stay in native secure storage.

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
- [Brand and approved copy](brand/README.md)
- [Third-party notices and Guest sources](THIRD_PARTY_NOTICES.md)

Project code is licensed under [MIT](LICENSE). Third-party runtimes, Guest
components, and other dependencies retain their own licenses.
