<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — あなたのポケットエージェント。ローカル実行。モデルの自由。DSH / Claude Code / GLM" width="100%" />
</p>

<h1 align="center">Rish、ポケットの中のエージェント。</h1>

<p align="center">
  <strong>ローカルで実行。モデルは自分で選ぶ。</strong><br />
  <sub>ローカルワークスペース · モデル選択 · ツール実行 · 承認</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>内蔵接続 · ネイティブな Rish アダプター</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <b>日本語</b> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#はじめに">はじめに</a> ·
  <a href="#内蔵接続">内蔵接続</a> ·
  <a href="#プロダクトツアー">プロダクトツアー</a> ·
  <a href="#プラットフォームとモデル">プラットフォームとモデル</a> ·
  <a href="#エコシステム">エコシステム</a> ·
  <a href="./docs/development.md">開発者ガイド</a> ·
  <a href="./LICENSE">MIT ライセンス</a>
</p>

Rish は、エージェントとの会話、ワークスペース、ツール実行をスマートフォンにもたらします。
モデルを選び、タスクを記述し、作業内容を確認して、変更を承認できます。パソコンを
稼働させたままにする必要はありません。コーディングは用途のひとつであり、唯一の目的ではありません。

> **実験的なソースプレビューを準備中。現時点で安定したインストール可能なリリースは
> まだありません。** プラットフォームの範囲とアカウント/サブスクリプションの検証状況は、
> [プラットフォームとモデル](#プラットフォームとモデル)にまとめています。

## 内蔵接続

**4 つの内蔵接続。ひとつのポケットワークスペース。**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · 編集可能なモデルカタログ</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · APIキー / サブスクリプションでのサインイン¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · APIキー / サブスクリプションでのサインイン¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · APIキー / サブスクリプションでのサインイン¹</sub>
</td>
</tr>
</table>

¹ サブスクリプションでのサインインは現時点では iOS のみ対応しています。BigModel Coding Lite は検証済みです。Codex と Claude Code にはオプションの実験的ビルドが必要です。検証の詳細は下記をご覧ください。

ハーネスを選び、APIキー、またはお使いのビルドでサポートされているアカウントで接続します。
その後、スマートフォン上でファイルやプロジェクトを操作できます。Rish がエージェントループ、
ワークスペース、ツール承認、実行記録を管理し、内蔵アダプターがモデルサービスへの接続を担います。

**アカウントとサブスクリプションの検証(iOS)**

- **Codex**: オプションの実験的ビルドでは、公式 CLI によるデバイスログイン、サブスクリプションでの
  `gpt-5.6-luna` テキストチャット、ローカルでの `list_dir` ツール呼び出し、再起動後の永続化を
  検証済みです。公式 CLI はログインのみに使用しており、すべてのツールとモデルが検証済みとは限りません。
- **GLM**: [ZCode](https://zcode.z.ai/en/docs/agents) は Zhipu のエージェント製品であり、
  GLM はモデルファミリーです。BigModel へのサインイン、再起動後の永続化、Coding Lite での
  GLM-5.3 の応答を検証済みです。トライアル枠は未検証です。公式の ZCode ランタイムは統合していません。
- **Claude Code**: オプションの iOS 実験的ビルドでは、サブスクリプションでのログイン、未変更の
  公式 CLI を通じた Haiku 4.5 によるテキスト応答、再起動後の永続化を検証済みです。
  この経路は現在テキストのみの対応で、ツールや添付ファイルには対応していません。
  計測では 1 ターンに約 4.5 分かかり、パフォーマンスはまだ改善が必要です。

## プロダクトツアー

エージェントの実行を追いかけ、プロジェクトの変更を確認し、モデル接続を選択できます。
スクリーンショットをクリックすると元画像が開きます。

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="進行状況、list_dir ツール呼び出し、最終回答を示す Rish iOS Simulator の実際の会話" width="280" /></a><br />
  <sub><b>エージェントとの会話</b> — 進行状況、ツール、結果を追跡できます。表示されているテキストはアプリ再起動後も保持されます。</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="未ステージのファイルと変更統計を示す Rish iOS Simulator" width="280" /></a><br />
  <sub><b>ローカルプロジェクト</b> — コミット前に、未ステージのファイルと変更統計を確認できます。</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="ワークスペースサイドバーと 4 つのネイティブ API アダプター項目を示す Rish iPad Simulator" width="100%" /></a><br />
  <sub><b>iPad のワークスペースとモデル接続</b> — ワイド画面のサイドバー、ダークアピアランス、API アダプターの項目。</sub>
</td>
</tr>
</table>

いずれも実際の Simulator からのキャプチャで、現在の UI とワークフローを示しています。

## Rish を選ぶ理由

<table>
<tr>
<td width="50%">

### ワークスペースを持ち歩く

ファイルやプロジェクトは、スマートフォンのアプリ専用ワークスペースに保持します。資料を
取り込み、ファイルを読み、プロジェクトの変更を確認し、ひとつのアプリで作業を続けられます。

</td>
<td width="50%">

### モデルを選ぶ

内蔵の DSH、Claude Code、Codex、GLM の項目から始めることも、互換性のある API サービスと
モデルマッピングを設定することもできます。次のステップはモデルが提案し、操作はローカルツールが実行します。

</td>
</tr>
<tr>
<td width="50%">

### 作業の様子を見る

各ラウンドのテキスト、プロバイダーが返す推論(オプション)、ツール呼び出し、最終結果を
追跡できます。リンクを直接開き、保存した会話に戻ることもできます。

</td>
<td width="50%">

### 主導権を保つ

ツールは限定されたワークスペース内で動作します。権限が必要な操作は必ず事前に尋ね、
ファイル変更と Git 差分は確認できる形で残ります。

</td>
</tr>
</table>

## 実際に使ってみる

| タスク | はじめの一歩 |
| --- | --- |
| 情報を扱う | テキストや PDF を取り込み、要点を尋ね、エージェントが保存したノートを確認します。 |
| ファイルを整理する | プロジェクトディレクトリを調べ、選択したファイルを読み、新規または更新された内容を承認します。 |
| プロジェクトを維持する | Git のステータスと差分を確認し、ファイルを編集し、コミットを承認します。 |

これらの例は、現時点で利用可能な iOS の機能を使用しています。サポートされるツールと
ファイル形式はプラットフォームによって異なります。Linux Guest の実験については、
[ランタイムリファレンス](docs/development.md#honest-runtime-boundary)をご覧ください。

## ローカル実行の仕組み

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

サポートされたツールは、スマートフォンのアプリ専用環境で実行されます。モデルへの
リクエストは、選択された会話とタスクのコンテキストを、設定したサービスへ送信します。
つまり、**ローカル実行はオフラインでのモデル推論を意味しません**。

Rish は、ネイティブのファイル/Git 操作、Rish ランタイム、実験的な Linux Guest を
組み合わせています。デスクトッププログラムとの完全な互換性や無期限のバックグラウンド
実行は約束しません。[開発者ガイド](docs/development.md)が、検証済みの機能と実験的な経路を区別して説明しています。

## プラットフォームとモデル

| プラットフォーム | 現在の範囲 |
| --- | --- |
| iOS / iPadOS | ネイティブな会話、添付ファイル、Files、Git、制御付きのエージェントツール。アダプティブな iPad レイアウトも含まれます。 |
| Android | ネイティブな API チャット、認証情報の保存、セッションの復帰、スコープ付きのタスク通知。ローカルでのエージェント、Files、Git 実行はまだ利用できません。 |
| HarmonyOS | 一時的な Android 互換コンテナでの確認は、ネイティブな HarmonyOS 対応を意味しません。 |

| 接続 | 現在の方法 |
| --- | --- |
| DeepSeek / DSH | APIキーと編集可能なモデルカタログ。機能はモデルとプラットフォームによって異なります。 |
| GLM | APIキーに加え、オプションで BigModel/Z.ai アカウント接続が可能。状況は上記をご覧ください。 |
| Codex | API アダプター。オプションの iOS 実験的ビルドがサブスクリプションでのサインインを追加します。状況は上記をご覧ください。 |
| Claude Code | 互換サービスを設定できる API アダプター。サブスクリプションによるテキスト呼び出しはオプションの iOS ビルドで検証済みで、その範囲とレイテンシは上記のとおりです。 |
| カスタムサービス | iOS では、Messages、Responses、Chat Completions のいずれかを選択し、モデルマッピングを設定します。 |

## はじめに

現時点ではソースからビルドしてください。エンドユーザー向けの安定版ダウンロードはありません。
ソースを入手したら、リポジトリのルートから始めます:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** ネイティブの準備には、バージョンを固定した Xcode、Rust、SDK が必要です。
[前提条件](docs/development.md#ios-build-prerequisites)を読んでから、次を実行します:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** Android 開発環境を構成済みであれば、`npm run android --prefix apps/mobile` を
実行します。開発者ガイドでは[スタンドアロンのテスト APK](docs/development.md#install-and-run-the-react-native-app) についても説明しています。

アプリを開いたら、モデルを選び、APIキーまたはサポートされているアカウントで接続します。
iOS では、プロジェクトを作成または選択し、そのコンテキストを確認して、タスクを開始します。
Codex と Claude Code のサブスクリプションサインインにはオプションの実験的ビルドが必要です
([開発者ガイド](docs/development.md)を参照)。BigModel については
[アカウントガイド](docs/zcode-account-login.md)をご覧ください。認証情報は
ネイティブのセキュアストレージに保持されます。

## 進捗とコントリビューション

最初のソースプレビューを準備中です。今後のリリースには **Pre-release** のマークが付きます。
完全なハーネス互換性、Android でのローカル実行、継続的なバックグラウンド動作には
依然として制限があります。[プレビューの範囲とロードマップ](docs/releases/v0.1.0.md)をご覧ください。

ドキュメント、プラットフォーム対応、モデル互換性、再現可能な修正へのコントリビューションを
歓迎します。まず [CONTRIBUTING](CONTRIBUTING.md) をお読みください。セキュリティ問題の
詳細を共有する前に [SECURITY](SECURITY.md) をご確認ください。認証情報や機密データを
公開の場に投稿しないでください。

- [開発・ビルドガイド](docs/development.md)
- [ブランドと承認済みコピー](brand/README.md)
- [サードパーティー通知と Guest ソース](THIRD_PARTY_NOTICES.md)

プロジェクトのコードは [MIT](LICENSE) ライセンスの下で提供されます。サードパーティーの
ランタイム、Guest コンポーネント、その他の依存コンポーネントはそれぞれ独自のライセンスを保持します。

## エコシステム

同じローカルファースト・モデルフリーの考えに基づく兄弟プロジェクト:

- **[rish](https://github.com/ZSeven-W/rish)** — スマートフォン上で本物の Docker を実現。純粋な Rust で書かれた JIT 不要の x86-64 フルシステムインタープリターで、Linux を起動し、iOS と Android でコンテナを実行します。このプロジェクトの Linux Guest はここ由来です。
- **[OpenPencil](https://github.com/ZSeven-W/openpencil)** — 初のオープンソース・AI ネイティブのベクターデザインツールであり、エージェントチームの同時実行を初めて備えたツール。Design-as-Code により、プロンプトをライブキャンバス上の UI に変えます。
- **[Jian](https://github.com/ZSeven-W/jian)** — Rust ネイティブのクロスプラットフォーム UI フレームワーク。.op ファイルがそのままアプリになります。
- **[Zode](https://github.com/ZSeven-W/zode)** — ターミナル向けの AI ネイティブなコーディング CLI。マイクロカーネルとプラグイン、マルチプロバイダー、フルスクリーン TUI。
- **[Noema](https://github.com/ZSeven-W/noema)** — コーディングエージェントのためのローカルファーストなメモリ。ベクターストア不要で、レビューキューと MCP を備えます。
