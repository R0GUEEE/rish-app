# Rish positioning and launch copy

## Approved Chinese copy

Main title:

> **Rish，你的随身 Agent。**

Subtitle:

> **手机本地执行，模型自由接入。**

Compact line for promotional graphics:

> **随身 Agent，本地执行。**

These are the approved brand lines. Keep their wording and punctuation when
using them in launch materials.

## Short introduction

> Rish 把会话、工作区和工具执行放进手机，让 Agent 围绕你的文件和项目完成任务。
> 接入你选择的模型服务，在手机上查看过程、批准操作、保留结果；用途不限于编程。

For source-preview announcements, include the current availability alongside
that introduction:

> 当前为实验性源码预览准备阶段。iOS 已实现本地会话、文件、Git 与受控 Agent
> 工具执行；Android 已支持 API 对话和本地会话保存，本地 Agent、文件与 Git
> 执行仍待完成。完整 Harness 能力尚未全部验证。

Update this availability paragraph from verified release evidence when the
candidate changes. The brand line is a product positioning statement, not a
claim that every platform or provider has reached feature parity.

## What the positioning means

Rish is a mobile Agent workspace for multiple task types. Coding is one use
case alongside working with files, organizing information, and running the
tools available in the selected runtime. Its distinction is the supported
execution environment on the phone, controlled by the app's workspace,
credential, and approval boundaries.

"手机本地执行" means supported tools act in the phone's app-owned environment.
It does not mean unrestricted access to the whole device or that every
desktop program works. The app still reports `local_substrate` until the
complete `local_harness` gate is satisfied.

"模型自由接入" means users choose supported providers, configure compatible
API endpoints and credentials, and map supported model IDs. It does not
promise compatibility with every model, API protocol, subscription, or
official CLI. Model requests may send the selected conversation and task
context to that provider; this is not an all-offline or all-local-inference
claim.

Use the [runtime reference](development.md#honest-runtime-boundary) and
[source-preview checklist](releases/v0.1.0.md) for the current implementation
scope. Avoid "全球首个", complete desktop-environment claims, and indefinite
iOS background-service claims without evidence that establishes them.

## Demonstrations and screenshots

A promotional capture should identify what actually ran and where. A browser
page by itself does not prove that Rish's Agent generated its files or that
the backend ran on the phone.

| Capture or check | What it establishes |
| --- | --- |
| Rish Agent reads or writes files through its native tool path | The observed Agent operation within that workspace |
| Simulator Safari calls a service started by Rish's local guest, including a real state change and reload | That bounded local runtime path on the tested Simulator build |
| Physical-device run through the same path | The observed behavior on that device and build |
| A styled page served by a host-side preview server | Visual presentation; it does not establish phone-local execution |

The earlier styled counter promotional captures used a host-side Python
preview. Treat them as visual design material, not native execution evidence.
Do not present a host preview as an on-device backend or imply physical-device
validation from Simulator screenshots.

For a runtime demonstration, record the build, platform, real Agent/tool
result, service owner, and browser interaction. Capture an actual successful
state; if the preview expires or a request fails, restore and verify the real
service before capturing it again. iOS background preview is time-limited.
The current guest CGI experiment does not establish a general Node/Python
server or unrestricted desktop runtime.
