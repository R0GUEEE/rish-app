<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — 당신의 포켓 에이전트. 로컬 실행. 모델의 자유. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

<h1 align="center">Rish, 당신의 포켓 에이전트.</h1>

<p align="center">
  <strong>로컬에서 실행하세요. 모델을 선택하세요.</strong><br />
  <sub>로컬 작업 공간 · 모델 선택 · 도구 실행 · 승인</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>빌트인 연결 · Rish 네이티브 어댑터</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <b>한국어</b> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#시작하기">시작하기</a> ·
  <a href="#빌트인-연결">빌트인 연결</a> ·
  <a href="#제품-둘러보기">제품 둘러보기</a> ·
  <a href="#플랫폼과-모델">플랫폼과 모델</a> ·
  <a href="#생태계">생태계</a> ·
  <a href="./docs/development.md">개발자 안내</a> ·
  <a href="./LICENSE">MIT 라이선스</a>
</p>

Rish는 에이전트 대화, 작업 공간, 도구 실행을 휴대폰으로 가져옵니다.
모델을 선택하고, 작업을 설명하고, 진행 결과를 확인하고, 컴퓨터를 계속
켜두지 않고도 변경 사항을 승인하세요. 코딩은 용도 중 하나일 뿐, 유일한
목적은 아닙니다.

> **실험적인 소스 프리뷰를 준비 중이며, 아직 설치 가능한 안정 릴리스는
> 없습니다.** 플랫폼 범위와 계정/구독 검증 상태는
> [플랫폼과 모델](#플랫폼과-모델)에서 정리되어 있습니다.

## 빌트인 연결

**네 가지 빌트인 연결. 하나의 포켓 작업 공간.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · 편집 가능한 모델 카탈로그</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · API 키 / 구독 로그인¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · API 키 / 구독 로그인¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · API 키 / 구독 로그인¹</sub>
</td>
</tr>
</table>

¹ 구독 로그인은 현재 iOS에서만 지원됩니다. BigModel Coding Lite는 검증되었으며, Codex와 Claude Code는 선택적 실험 빌드가 필요합니다. 자세한 검증 내용은 아래를 참고하세요.

하니스를 선택하고 API 키 또는 빌드에서 지원하는 계정으로 연결하세요.
그다음 휴대폰에서 파일과 프로젝트 작업을 시작하세요. Rish는 에이전트
루프, 작업 공간, 도구 승인, 실행 기록을 관리하며, 빌트인 어댑터가
모델 서비스에 연결합니다.

**계정 및 구독 검증 (iOS)**

- **Codex**: 선택적 실험 빌드에서 공식 CLI 기기 로그인, 구독 `gpt-5.6-luna` 텍스트 채팅, 로컬 `list_dir` 도구 호출, 재시작 후에도 유지되는 지속성을 검증했습니다. 공식 CLI는 로그인에만 사용되며, 모든 도구와 모델이 검증된 것은 아닙니다.
- **GLM**: [ZCode](https://zcode.z.ai/en/docs/agents)는 Zhipu의 에이전트 제품이며, GLM은 모델 패밀리입니다. BigModel 로그인, 재시작 지속성, Coding Lite GLM-5.3 응답은 검증되었으며, 트라이얼 사용량은 검증되지 않았습니다. 공식 ZCode 런타임은 통합되어 있지 않습니다.
- **Claude Code**: 선택적 iOS 실험 빌드에서 구독 로그인, 수정하지 않은 공식 CLI를 통한 Haiku 4.5 텍스트 응답, 재시작 후에도 유지되는 지속성을 검증했습니다.
  이 경로는 현재 텍스트만 지원하며 도구나 첨부 파일은 지원하지 않습니다.
  실측한 한 턴은 약 4.5분이 걸렸으며, 성능은 여전히 개선이 필요합니다.

## 제품 둘러보기

에이전트 실행을 따라가고, 프로젝트 변경 사항을 검토하고, 모델 연결을 선택하세요.
스크린샷을 클릭하면 원본을 열 수 있습니다.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="진행 상황, list_dir 도구 호출, 최종 답변을 보여주는 실제 Rish iOS 시뮬레이터 대화" width="280" /></a><br />
  <sub><b>에이전트 대화</b> — 진행 상황, 도구, 결과를 확인하세요. 표시된 텍스트는 앱을 재시작해도 유지됩니다.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="스테이징되지 않은 파일과 변경 통계를 보여주는 Rish iOS 시뮬레이터" width="280" /></a><br />
  <sub><b>로컬 프로젝트</b> — 커밋 전에 스테이징되지 않은 파일과 변경 통계를 확인하세요.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="작업 공간 사이드바와 네 가지 네이티브 API 어댑터 항목을 보여주는 Rish iPad 시뮬레이터" width="100%" /></a><br />
  <sub><b>iPad 작업 공간과 모델 연결</b> — 와이드스크린 사이드바, 다크 모양, API 어댑터 항목.</sub>
</td>
</tr>
</table>

모든 캡처는 실제 시뮬레이터에서 가져온 것으로, 현재 UI와 워크플로를 보여줍니다.

## 왜 Rish인가

<table>
<tr>
<td width="50%">

### 작업 공간이 함께 이동합니다

파일과 프로젝트를 휴대폰의 앱 전용 작업 공간에 보관하세요. 자료를 가져오고,
파일을 읽고, 프로젝트 변경 사항을 검토하고, 하나의 앱에서 작업을 이어가세요.

</td>
<td width="50%">

### 모델을 선택하세요

빌트인 DSH, Claude Code, Codex, GLM 항목으로 시작하거나, 호환되는 API 서비스와
모델 매핑을 구성하세요. 모델은 다음 단계를 제안하고, 로컬 도구가 작업을
수행합니다.

</td>
</tr>
<tr>
<td width="50%">

### 작업 과정을 지켜보세요

각 라운드의 텍스트, 선택적으로 제공되는 공급자의 추론, 도구 호출, 최종 결과를
따라가세요. 링크를 바로 열고 저장된 대화로 돌아갈 수 있습니다.

</td>
<td width="50%">

### 제어권을 유지하세요

도구는 제한된 작업 공간 안에서 동작합니다. 인가가 필요한 작업은 먼저 요청하며,
파일 변경과 Git diff는 검토할 수 있습니다.

</td>
</tr>
</table>

## 활용해 보기

| 작업 | 시작점 |
| --- | --- |
| 정보 다루기 | 텍스트나 PDF를 가져오고 핵심 내용을 요청한 뒤, 에이전트가 저장한 노트를 검토하세요. |
| 파일 정리 | 프로젝트 디렉터리를 살펴보고, 선택한 파일을 읽고, 새 콘텐츠나 업데이트된 콘텐츠를 승인하세요. |
| 프로젝트 유지보수 | Git 상태와 diff를 검토하고, 파일을 편집하고, 커밋을 승인하세요. |

이 예시는 현재 사용 가능한 iOS 기능을 기반으로 합니다. 지원되는 도구와 파일
형식은 플랫폼에 따라 다릅니다. Linux 게스트 실험에 대해서는
[런타임 참조](docs/development.md#honest-runtime-boundary)를 참고하세요.

## 로컬 실행 방식

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

지원되는 도구는 휴대폰의 앱 전용 환경에서 실행됩니다. 모델 요청은 선택된
대화와 작업 컨텍스트를 구성한 서비스로 전송합니다:
**로컬 실행은 오프라인 모델 추론을 의미하지 않습니다**.

Rish는 네이티브 파일/Git 작업, Rish 런타임, 실험적인 Linux 게스트를 결합합니다.
완전한 데스크톱 프로그램 호환성과 무제한 백그라운드 실행은 약속하지
않습니다. [개발자 안내](docs/development.md)는 검증된 기능과 실험적 경로를
구분하여 설명합니다.

## 플랫폼과 모델

| 플랫폼 | 현재 범위 |
| --- | --- |
| iOS / iPadOS | 네이티브 대화, 첨부 파일, 파일 앱, Git, 제어되는 에이전트 도구. 적응형 iPad 레이아웃 포함. |
| Android | 네이티브 API 채팅, 자격 증명 저장, 세션 복구, 범위가 지정된 작업 알림. 로컬 에이전트, 파일, Git 실행은 아직 사용할 수 없습니다. |
| HarmonyOS | 일시적인 Android 호환 컨테이너 확인만으로는 네이티브 HarmonyOS 지원을 확립한 것이 아닙니다. |

| 연결 | 현재 방법 |
| --- | --- |
| DeepSeek / DSH | API 키와 편집 가능한 모델 카탈로그. 기능은 모델과 플랫폼에 따라 달라집니다. |
| GLM | API 키, 선택적 BigModel/Z.ai 계정 연결. 위 상태를 참고하세요. |
| Codex | API 어댑터. 선택적 iOS 실험 빌드는 구독 로그인을 추가합니다 — 위 상태를 참고하세요. |
| Claude Code | 호환 서비스 구성이 가능한 API 어댑터. 구독 텍스트 호출은 선택적 iOS 빌드에서 검증되었으며, 그 범위와 지연 시간은 위에 안내되어 있습니다. |
| 커스텀 서비스 | iOS에서 Messages, Responses 또는 Chat Completions를 선택하고 모델 매핑을 구성하세요. |

## 시작하기

현재는 소스에서 직접 빌드해야 하며, 안정적인 최종 사용자 다운로드는 없습니다.
소스를 받은 후 저장소 루트에서 시작하세요:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** 네이티브 준비에는 고정된 Xcode, Rust, SDK 버전이 필요합니다.
[필수 구성 요소](docs/development.md#ios-build-prerequisites)를 읽은 다음 실행하세요:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** Android 개발 환경을 구성한 상태에서
`npm run android --prefix apps/mobile`을 실행하세요. 개발자 안내에는
[독립 실행형 테스트 APK](docs/development.md#install-and-run-the-react-native-app)도 다루고 있습니다.

앱을 열고, 모델을 선택하고, API 키 또는 지원되는 계정으로 연결하세요.
iOS에서는 프로젝트를 만들거나 선택하고, 컨텍스트를 검토하고, 작업을 시작하세요. Codex와
Claude Code 구독 로그인에는 선택적 실험 빌드가 필요합니다([개발자 안내](docs/development.md) 참고).
BigModel은 [계정 안내](docs/zcode-account-login.md)를 참고하세요. 자격 증명은
네이티브 보안 저장소에 보관됩니다.

## 진행 상황과 기여

첫 번째 소스 프리뷰를 준비 중입니다. 향후 릴리스에는 **Pre-release** 표시가
붙습니다. 완전한 하니스 호환성, Android 로컬 실행, 연속 백그라운드 작동은
여전히 제한적입니다. [프리뷰 범위와 로드맵](docs/releases/v0.1.0.md)을
참고하세요.

문서화, 플랫폼 지원, 모델 호환성, 재현 가능한 수정에 대한 기여를 환영합니다.
먼저 [CONTRIBUTING](CONTRIBUTING.md)을 읽어주세요.
보안 문제는 세부 사항을 공유하기 전에 [SECURITY](SECURITY.md)를 참조하세요.
자격 증명이나 민감한 데이터를 공개적으로 게시하지 마세요.

- [개발자 및 빌드 안내](docs/development.md)
- [브랜드와 승인된 문구](brand/README.md)
- [서드파티 고지 및 게스트 소스](THIRD_PARTY_NOTICES.md)

프로젝트 코드는 [MIT](LICENSE) 라이선스하에 배포됩니다. 서드파티 런타임, 게스트
구성 요소, 기타 의존성은 각자의 라이선스를 유지합니다.

## 생태계

같은 로컬 우선·모델 자유 철학으로 만든 형제 프로젝트들:

- **[rish](https://github.com/ZSeven-W/rish)** — 휴대폰에서 동작하는 진짜 Docker. 순수 Rust로 작성된 JIT 없는 x86-64 풀시스템 인터프리터로, Linux를 부팅하고 iOS와 Android에서 컨테이너를 실행합니다. 이 프로젝트의 Linux 게스트는 여기서 왔습니다.
- **[OpenPencil](https://github.com/ZSeven-W/openpencil)** — 최초의 오픈소스 AI 네이티브 벡터 디자인 도구이자, 동시 실행 에이전트 팀을 갖춘 최초의 도구입니다. Design-as-Code로, 프롬프트를 라이브 캔버스에서 UI로 바꿉니다.
- **[Jian](https://github.com/ZSeven-W/jian)** — Rust 네이티브 크로스 플랫폼 UI 프레임워크. .op 파일 하나가 앱입니다.
- **[Zode](https://github.com/ZSeven-W/zode)** — 터미널을 위한 AI 네이티브 코딩 CLI. 마이크로커널과 플러그인, 다중 공급자, 전체 화면 TUI.
- **[Noema](https://github.com/ZSeven-W/noema)** — 코딩 에이전트를 위한 로컬 우선 메모리. 벡터 저장소 없이, 검토 큐와 MCP를 갖추고 있습니다.
