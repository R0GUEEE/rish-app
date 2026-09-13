<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — 你的隨身 Agent。本機執行。模型自由。DSH / Claude Code / Codex / GLM" width="100%" />
</p>

<h1 align="center">Rish，你的隨身 Agent。</h1>

<p align="center">
  <strong>本機執行，自由選擇模型。</strong><br />
  <sub>本機工作區 · 模型選擇 · 工具執行 · 操作核准</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>內建連線 · Rish 原生轉接器</sub>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a> · <b>繁體中文</b> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#開始使用">開始使用</a> ·
  <a href="#內建連線">內建連線</a> ·
  <a href="#產品導覽">產品導覽</a> ·
  <a href="#平台與模型">平台與模型</a> ·
  <a href="#生態系">生態系</a> ·
  <a href="./docs/development.md">開發指南</a> ·
  <a href="./LICENSE">MIT License</a>
</p>

Rish 把 Agent 對話、工作區與工具執行帶到你的手機上。選擇模型、描述任務、檢視工作過程並核准變更，不必一直開著電腦。寫程式只是用途之一，並非唯一目的。

> **實驗性原始碼預覽準備中，尚無穩定的可安裝版本。** 平台範圍與帳號/訂閱驗證狀態整理於[平台與模型](#平台與模型)。

## 內建連線

**四個內建連線，一個隨身工作區。**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · 可編輯模型目錄</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · API Key / 訂閱登入¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · API Key / 訂閱登入¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · API Key / 訂閱登入¹</sub>
</td>
</tr>
</table>

¹ 訂閱登入目前僅限 iOS。已驗證 BigModel Coding Lite；Codex 與 Claude Code 需要選配的實驗性建置。驗證細節請見下方。

選擇一個 Harness，以 API Key 或你所用建置支援的帳號連線，然後開始處理手機裡的檔案與專案。Rish 管理 Agent 迴圈、工作區、工具核准與執行記錄；內建轉接器負責連接模型服務。

**帳號與訂閱驗證（iOS）**

- **Codex**：選配的實驗性建置已驗證官方 CLI 裝置登入、訂閱 `gpt-5.6-luna` 文字對話、本機 `list_dir` 工具呼叫，以及重新啟動後保留。官方 CLI 僅用於登入，並非所有工具與模型都已驗證。
- **GLM**：[ZCode](https://zcode.z.ai/en/docs/agents) 是 Zhipu 的 Agent 產品，GLM 則是模型系列。已驗證 BigModel 登入、重新啟動後保留，以及 Coding Lite 方案的 GLM-5.3 回應；試用額度尚未驗證。ZCode 官方執行環境尚未整合。
- **Claude Code**：選配的 iOS 實驗性建置已驗證訂閱登入、經由未修改官方 CLI 的 Haiku 4.5 文字回應，以及重新啟動後保留。此路徑目前僅支援文字，不包含工具或附件。實測單輪約 4.5 分鐘，效能仍有待改進。

## 產品導覽

追蹤 Agent 執行、審查專案變更並選擇模型連線。點擊螢幕截圖可查看原圖。

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Rish iOS 模擬器實際對話，顯示進度、list_dir 工具呼叫與最終回答" width="280" /></a><br />
  <sub><b>Agent 對話</b> — 掌握進度、工具與結果。圖中文字在 App 重新啟動後仍會保留。</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Rish iOS 模擬器顯示未暫存檔案與變更統計" width="280" /></a><br />
  <sub><b>本機專案</b> — 提交前檢查未暫存檔案與變更統計。</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Rish iPad 模擬器顯示工作區側欄與四個原生 API 轉接入口" width="100%" /></a><br />
  <sub><b>iPad 工作區與模型連線</b> — 寬螢幕側欄、深色外觀與 API 轉接入口。</sub>
</td>
</tr>
</table>

以上畫面皆取自實際模擬器，呈現目前的介面與工作流程。

## 為什麼選擇 Rish

<table>
<tr>
<td width="50%">

### 工作區帶著走

把檔案與專案保存在手機上 App 專屬的工作區。匯入資料、讀取檔案、審查專案變更，在同一個 App 裡繼續工作。

</td>
<td width="50%">

### 模型由你選

從內建的 DSH、Claude Code、Codex 與 GLM 入口開始，也可以設定相容的 API 服務與模型對應。模型提出下一步，本機工具負責執行。

</td>
</tr>
<tr>
<td width="50%">

### 看得見的執行過程

逐輪檢視文字內容、供應商回傳的可選推理過程、工具呼叫與最終結果。連結可直接開啟，也能回到已儲存的對話。

</td>
<td width="50%">

### 操作由你掌控

工具僅在受限的工作區內運作。需要授權的操作會先詢問；檔案變更與 Git 差異皆可供審查。

</td>
</tr>
</table>

## 實際應用

| 任務 | 起步方式 |
| --- | --- |
| 處理資訊 | 匯入文字或 PDF，請模型擷取重點，再審查 Agent 儲存的筆記。 |
| 整理檔案 | 檢視專案目錄、讀取指定檔案，核准新增或更新的內容。 |
| 維護專案 | 檢查 Git 狀態與差異、編輯檔案，並核准提交。 |

這些範例基於 iOS 目前可用的能力；支援的工具與檔案格式依平台而異。Linux Guest 相關實驗請見[執行環境參考](docs/development.md#honest-runtime-boundary)。

## 本機執行原理

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

受支援的工具會在手機上 App 專屬的環境中執行。模型請求會將選定的對話與任務上下文傳送給你設定的服務：**本機執行不代表離線模型推論**。

Rish 結合原生檔案/Git 操作、Rish 執行環境與實驗性的 Linux Guest。不保證完整的桌面程式相容性，也不保證無限期背景執行。[開發指南](docs/development.md)會區分已驗證的能力與實驗性路徑。

## 平台與模型

| 平台 | 目前範圍 |
| --- | --- |
| iOS / iPadOS | 原生對話、附件、檔案、Git 與受控 Agent 工具；包含 iPad 自適應版面配置。 |
| Android | 原生 API 對話、憑證儲存、工作階段恢復與限定範圍的任務通知。本機 Agent、檔案與 Git 執行尚不可用。 |
| HarmonyOS | 以 Android 相容容器進行的臨時檢查，並不構成原生 HarmonyOS 支援。 |

| 連線 | 目前方式 |
| --- | --- |
| DeepSeek / DSH | API Key 與可編輯的模型目錄；實際能力取決於模型與平台。 |
| GLM | API Key，另可連結選用的 BigModel/Z.ai 帳號；狀態見上方。 |
| Codex | API 轉接；選配的 iOS 實驗性建置另提供訂閱登入，狀態見上方。 |
| Claude Code | API 轉接，可設定相容服務；訂閱文字呼叫已在選配的 iOS 建置中驗證，範圍與延遲如上方所述。 |
| 自訂服務 | 在 iOS 上選擇 Messages、Responses 或 Chat Completions，並設定模型對應。 |

## 開始使用

目前暫時需從原始碼建置，尚無提供給一般使用者的穩定下載版本。取得原始碼後，從儲存庫根目錄開始：

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS：** 原生準備作業需要指定版本的 Xcode、Rust 與 SDK。請先閱讀[前置需求](docs/development.md#ios-build-prerequisites)，再執行：

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android：** 在已設定 Android 開發環境的情況下，執行 `npm run android --prefix apps/mobile`。開發指南也涵蓋[獨立測試 APK](docs/development.md#install-and-run-the-react-native-app)的說明。

開啟 App、選擇模型，並以 API Key 或支援的帳號連線。在 iOS 上建立或選擇專案、確認專案上下文後開始任務。Codex 與 Claude Code 的訂閱登入需要選配的實驗性建置（見[開發指南](docs/development.md)）；BigModel 帳號請參閱[帳號指南](docs/zcode-account-login.md)。憑證會保存在原生安全儲存空間中。

## 進展與參與

第一個原始碼預覽正在準備中，未來版本將標記為 **Pre-release**。完整的 Harness 相容性、Android 本機執行與持續背景執行仍有限制。詳見[預覽範圍與路線圖](docs/releases/v0.1.0.md)。

歡迎針對文件、平台支援、模型相容性與可重現的修正提出貢獻。請先閱讀 [CONTRIBUTING](CONTRIBUTING.md)。若有安全問題，請先查閱 [SECURITY](SECURITY.md) 再分享細節；切勿公開張貼憑證或敏感資料。

- [開發與建置指南](docs/development.md)
- [品牌與核定文案](brand/README.md)
- [第三方聲明與 Guest 來源](THIRD_PARTY_NOTICES.md)

專案程式碼採用 [MIT](LICENSE) 授權。第三方執行環境、Guest 元件與其他相依套件保留各自的授權條款。

## 生態系

基於同樣本機優先、模型自由理念的同源專案：

- **[rish](https://github.com/ZSeven-W/rish)** — 手機上的真 Docker。以純 Rust 實作、免 JIT 的 x86-64 全系統直譯器，可在 iOS 與 Android 上啟動 Linux 並執行容器。本專案的 Linux Guest 即來自該專案。
- **[OpenPencil](https://github.com/ZSeven-W/openpencil)** — 第一個開源的 AI 原生向量設計工具，也是第一個支援並行 Agent 團隊的設計工具。Design-as-Code，在即時畫布上把提示詞化為 UI。
- **[Jian](https://github.com/ZSeven-W/jian)** — Rust 原生的跨平台 UI 框架。一個 .op 檔案就是一個應用程式。
- **[Zode](https://github.com/ZSeven-W/zode)** — 供終端機使用的 AI 原生程式設計 CLI。微核心加外掛架構，支援多供應商，全螢幕 TUI。
- **[Noema](https://github.com/ZSeven-W/noema)** — 為程式設計 Agent 而生的本機優先記憶，不依賴向量儲存，具備審查佇列與 MCP。
