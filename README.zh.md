<p align="center">
  <img src="./brand/rish-readme-icon.svg" alt="Rish" width="96" />
</p>

<h1 align="center">Rish，你的随身 Agent。</h1>

<p align="center">
  <strong>手机本地执行，模型自由接入。</strong><br />
  <sub>本地工作区 · 多模型接入 · 工具执行 · 操作审批</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>首批内置接入 · Rish 原生适配器</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <b>简体中文</b> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="#首批内置接入">内置接入</a> ·
  <a href="#产品导览">产品导览</a> ·
  <a href="#平台与模型">平台与模型</a> ·
  <a href="#生态">生态</a> ·
  <a href="./docs/development.md">开发文档</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — your pocket agent. Local execution. Model freedom. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

Rish 把 Agent 的会话、工作区和工具执行放进手机。选一个模型，交代任务，在本机查看过程、批准操作、保留结果，无需电脑常驻。用途不限于编程。

> **实验性源码预览准备中，暂未提供正式安装包。** 平台范围与账号/订阅验证状态见下方[平台与模型](#平台与模型)。

## 首批内置接入

**四个内置接入，一个随身工作区。**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · 可编辑模型目录</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · API Key / 订阅登录¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · API Key / 订阅登录¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>智谱 · API Key / 订阅登录¹</sub>
</td>
</tr>
</table>

¹ 订阅登录目前限 iOS：智谱 BigModel Coding Lite 已验证；Codex 和 Claude Code 需要可选实验构建。详细验证范围见下方。

选择 Harness，通过 API Key 或当前构建支持的账号登录接入模型，再围绕手机里的文件和项目开始任务。Rish 管理 Agent 循环、工作区、工具审批与执行记录；内置适配器负责连接模型服务。

**账号与订阅验证（iOS）**

- **Codex**：可选实验构建已实测官方 CLI 设备登录、订阅 `gpt-5.6-luna` 文本对话、本地 `list_dir` 工具调用及重启后保留；官方 CLI 仅用于登录，并非所有工具和模型都已验证。
- **GLM**：智谱官方 Agent 产品名是 [ZCode](https://zcode.z.ai/cn/docs/agents)，GLM 是模型系列。已实测 BigModel 账号登录、重开保留，以及 Coding Lite 套餐的 GLM-5.3 调用；体验额度通道未验证。ZCode 官方运行时尚未集成。
- **Claude Code**：可选 iOS 实验构建已实测订阅登录、Haiku 4.5 文本回复及重启后保留，请求由未修改的官方 CLI 发起。目前仅支持文本，工具及附件尚未开放；实测整轮约 4 分半，性能仍需优化。

## 产品导览

从会话执行、项目变更到模型选择，看看 Rish 的实际界面。点击图片查看原图。

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="iPhone 上的 Rish：两次成功的工具调用，以及说明绝对路径被拒的总结" width="280" /></a><br />
  <sub><b>Agent 对话</b> — 在手机上跟进度、工具调用和结果。超出工作区的路径会被拒绝，模型在下一轮自己改正。</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Rish iOS 模拟器中的未暂存文件和变更统计" width="280" /></a><br />
  <sub><b>本地项目</b> — 查看未暂存文件和变更统计，在提交前审核工作区变化。</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Rish iPad 模拟器中的侧栏与四个原生 API 适配入口" width="100%" /></a><br />
  <sub><b>iPad 工作区与模型接入</b> — 宽屏侧栏、深色界面和 API 适配入口。</sub>
</td>
</tr>
</table>

以上均为真实模拟器截图，展示当前实际界面与执行流程。

## 为什么用 Rish

<table>
<tr>
<td width="50%">

### 工作区随身带

文件与项目保存在手机的应用工作区。导入资料、查看文件、检查项目变化，在同一个 App 里继续处理任务。

</td>
<td width="50%">

### 模型由你选

从内置的 DSH、Claude Code、Codex 与 GLM 入口开始，也可配置兼容的 API 服务与模型映射。模型负责生成下一步，手机上的工具执行操作。

</td>
</tr>
<tr>
<td width="50%">

### 看得见的执行过程

每轮正文、模型返回的可选思考区块、工具调用和最终结果按顺序显示。链接可直接打开，历史会话可以重开。

</td>
<td width="50%">

### 操作由你掌控

Agent 在限定的工作区内使用工具。需要授权的操作会先请求批准，文件变更和 Git 差异可供查看。

</td>
</tr>
</table>

## 可以拿它做什么

从这些任务开始，逐步把自己的工作带进手机：

| 场景 | 可以这样开始 |
| --- | --- |
| 处理资料 | 导入文本或 PDF，让模型提取重点，再审核 Agent 保存的笔记。 |
| 整理文件 | 让 Agent 查看项目目录、读取指定文件，确认后创建或更新内容。 |
| 维护项目 | 查看 Git 状态和差异，修改文件，审核后提交变更。 |

这些场景以 iOS 当前可用能力为基础；可用工具和文件格式取决于平台。Linux Guest 运行实验的范围见[运行环境说明](docs/development.md#honest-runtime-boundary)。

## 怎么在本地运行

```text
你交代任务 → Rish 组织上下文 → 你选择的模型服务
                                  ↓ 返回文字 / 工具请求
手机工作区 ← 本地工具执行 ← Rish 校验与审批
```

Rish 的受控工具在手机本地执行，会话和工作区由 App 管理。模型请求会将选定的对话及任务上下文发送给你配置的服务，**本地执行不等于模型离线推理**。

底层结合原生文件与 Git 能力、Rish 运行时和实验性的 Linux Guest。当前不承诺完整桌面软件兼容或后台常驻；已验证能力和实验功能分别列在[开发文档](docs/development.md)。

## 平台与模型

| 平台 | 当前范围 |
| --- | --- |
| iOS / iPadOS | 原生会话、附件、文件、Git、受控 Agent 工具执行；包含 iPad 布局适配。 |
| Android | 原生 API 对话、凭据存储、会话恢复和部分任务通知；本地 Agent、文件与 Git 执行待完成。 |
| HarmonyOS | Android 兼容容器的临时测试不代表原生鸿蒙支持。 |

| 模型接入 | 当前方式 |
| --- | --- |
| DeepSeek / DSH | API Key、可编辑模型目录；能力取决于具体模型和平台。 |
| GLM | API Key；可选 BigModel/Z.ai 账号连接，验证进度见上方状态。 |
| Codex | API 适配；可选 iOS 实验构建支持订阅登录，验证进度见上方状态。 |
| Claude Code | API 适配，可配置兼容服务；可选 iOS 实验构建已验证订阅文本调用，范围与性能见上方。 |
| 自定义服务 | iOS 可选择 Messages、Responses 或 Chat Completions 协议及模型映射。 |

## 生态

Rish 属于 **[ZSeven-W](https://github.com/ZSeven-W)** 的一组本地优先、AI 原生工具。`rish` 负责在本应用内启动 Linux Guest；其余几个把同一套思路带到别的地方——终端、设计画布，以及 Agent 的记忆。

| 项目 | 是什么 |
| ---- | ---- |
| **[rish](https://github.com/ZSeven-W/rish)** | 手机上的真 Docker：纯 Rust 写的免 JIT x86-64 全系统解释器，在 iOS 和 Android 上启动 Linux 并运行容器。本应用的 Linux Guest 就来自这里。 |
| <img src="./docs/images/ecosystem/openpencil.png" alt="OpenPencil" width="40" /> **[OpenPencil](https://github.com/ZSeven-W/openpencil)** | 首个开源的 AI 原生矢量设计工具，也是首个支持并发 Agent 团队的设计工具。Design-as-Code，在画布上把提示词直接变成 UI。 |
| <img src="./docs/images/ecosystem/jian.png" alt="jian" width="40" /> **[jian](https://github.com/ZSeven-W/jian)** | 纯 Rust、GPU-Skia 的 UI 框架。把声明式的 `.op` 文档变成原生应用——没有 JS 运行时，没有 DOM，没有 Electron。 |
| <img src="./docs/images/ecosystem/zode.png" alt="Zode" width="40" /> **[Zode](https://github.com/ZSeven-W/zode)** | 终端里的 AI 原生编程 CLI。快速的 Rust TUI，会读代码、跑命令、搜文件、管 git。 |
| <img src="./docs/images/ecosystem/noema.png" alt="noema" width="40" /> **[noema](https://github.com/ZSeven-W/noema)** | 面向编程 Agent 的本地优先记忆，不用向量库。记忆是可检阅的文件，带复核队列和无嵌入召回。 |

## 开始使用

当前从源码构建，尚无面向普通用户的正式下载。访问源码后，先在仓库根目录安装依赖：

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS：** 原生依赖需要指定版本的 Xcode、Rust 和 SDK。先按[构建指南](docs/development.md#ios-build-prerequisites)准备，再运行：

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android：** 配置好 Android 开发环境后运行 `npm run android --prefix apps/mobile`。[独立测试 APK 的构建方法](docs/development.md#install-and-run-the-react-native-app)另见开发文档。

打开 App 后，选择模型，通过 API Key 或该构建支持的账号入口连接。iOS 上创建或选择项目，确认项目上下文，再开始任务。Codex 和 Claude Code 订阅登录需要可选实验构建（见[开发文档](docs/development.md)）；BigModel 账号接入见[说明](docs/zcode-account-login.md)。凭据由原生安全存储保管。

## 进展与参与

Rish 正在准备首个源码预览，后续发布将标记为 **Pre-release**。当前完整 Harness 兼容、Android 本地执行和持续后台运行仍有明确限制，详见[当前范围与路线](docs/releases/v0.1.0.md)。

欢迎从文档、平台适配、模型兼容和可复现的问题入手参与。开始前请阅读[贡献指南](CONTRIBUTING.md)；安全问题请先查看[安全策略](SECURITY.md)，不要在公开讨论中贴凭据或敏感数据。

- [开发与构建文档](docs/development.md)
- [品牌与宣传语](brand/README.md)
- [第三方声明与 Guest 来源](THIRD_PARTY_NOTICES.md)

项目代码使用 [MIT License](LICENSE)。第三方运行时、Guest 组件和其他依赖保留各自许可证。
