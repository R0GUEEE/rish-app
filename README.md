<p align="center">
  <img src="./brand/rish-readme-icon.svg" alt="Rish" width="96" />
</p>

<h1 align="center">Rish，你的随身 Agent。</h1>

<p align="center">
  <strong>手机本地执行，模型自由接入。</strong><br />
  <sub>本地工作区 · 多模型接入 · 工具执行 · 操作审批</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM API</strong><br />
  <sub>首批内置接入 · Rish 原生适配器</sub>
</p>

<p align="center">
  <b>简体中文</b> · <a href="./README.en.md">English</a>
</p>

<p align="center">
  <a href="#开始使用">开始使用</a> ·
  <a href="#首批内置接入">内置接入</a> ·
  <a href="#产品导览">产品导览</a> ·
  <a href="#平台与模型">平台与模型</a> ·
  <a href="./docs/development.md">开发文档</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

Rish 把 Agent 的会话、工作区和工具执行放进手机。选一个模型，交代任务，在本机查看过程、批准操作、保留结果，无需电脑常驻。用途不限于编程。

> **实验性源码预览准备中。** 当前 iOS 支持本地文件、Git 与受控 Agent 执行；Android 支持 API 对话和会话保存，本地工具执行仍在开发。暂未提供正式安装包。

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
  <sub>智谱 · 兼容 Messages API</sub>
</td>
</tr>
</table>

在 App 中选择 Harness、配置自己的 Key，围绕手机里的文件和项目开始任务。首批采用 Rish 内置的原生 API 适配器，工作区、工具授权与执行记录由 Rish 管理；具体平台支持见下方表格。

当前内置的是这些名称对应的 API 适配能力，完整官方 CLI 与订阅登录另见[实验状态](docs/ios-harness-auth-status.md)。

智谱的官方 Agent 产品名是 [ZCode](https://zcode.z.ai/cn/docs/agents)，GLM 是模型系列。iOS 已实测 BigModel 账号登录、重开保留，以及个人 Coding Plan 的 GLM-5.3 调用；体验额度通道仍待验证。ZCode 运行时尚未集成，详见[账号接入状态](docs/zcode-account-login.md)。

## 产品导览

从会话执行、项目变更到模型选择，看看 Rish 的实际界面。点击图片查看原图。

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Rish iOS 模拟器中的进度正文、list_dir 工具调用和最终回答" width="280" /></a><br />
  <sub><b>Agent 会话</b> — 查看进度、工具调用和结果；图中正文在重启后仍保留。</sub>
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

以上均为真实模拟器截图；模型入口图展示界面，不代表官方 CLI 或订阅登录已验证。

## 为什么用 Rish

<table>
<tr>
<td width="50%">

### 工作区随身带

文件与项目保存在手机的应用工作区。导入资料、查看文件、检查项目变化，在同一个 App 里继续处理任务。

</td>
<td width="50%">

### 模型由你选

从内置的 DSH、Claude Code、Codex 与 GLM API 入口开始，也可配置兼容的 API 服务与模型映射。模型负责生成下一步，手机上的工具执行操作。

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
| GLM | API Key；iOS 独立账号授权已验证 BigModel Coding Lite 的 GLM-5.3 调用，体验套餐仍待验证。 |
| Codex | API 适配；可选 iOS 实验包已实测订阅登录、Luna 对话与手机本地目录工具调用。 |
| Claude Code | API 适配，可配置兼容服务；订阅登录仍待验证。 |
| 自定义服务 | iOS 可选择 Messages、Responses 或 Chat Completions 协议及模型映射。 |

Codex 订阅接入仍需可选实验构建，并不代表完整官方 CLI 兼容。详见[订阅登录状态](docs/ios-harness-auth-status.md)。

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

打开 App 后，选择模型并配置自己的 Key。iOS 上创建或选择项目，确认项目上下文，再开始任务。Key 由原生安全存储保管，请勿放进源码或提交记录。

## 进展与参与

Rish 正在准备首个源码预览，后续发布将标记为 **Pre-release**。当前完整 Harness 兼容、Android 本地执行和持续后台运行仍有明确限制，详见[当前范围与路线](docs/releases/v0.1.0.md)。

欢迎从文档、平台适配、模型兼容和可复现的问题入手参与。开始前请阅读[贡献指南](CONTRIBUTING.md)；安全问题请先查看[安全策略](SECURITY.md)，不要在公开讨论中贴凭据或敏感数据。

- [开发与构建文档](docs/development.md)
- [源码预览进度](docs/open-source-sprint.md)
- [品牌与宣传语](brand/README.md)
- [第三方声明与 Guest 来源](THIRD_PARTY_NOTICES.md)

项目代码使用 [MIT License](LICENSE)。第三方运行时、Guest 组件和其他依赖保留各自许可证。
