<p align="center">
  <img src="./brand/rish-readme-icon.svg" alt="Rish" width="96" />
</p>

<h1 align="center">Rish, dein Agent für die Hosentasche.</h1>

<p align="center">
  <strong>Lokal ausführen. Modell frei wählen.</strong><br />
  <sub>Lokale Arbeitsbereiche · Modellwahl · Tool-Ausführung · Freigaben</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>Integrierte Verbindungen · Native Rish-Adapter</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <b>Deutsch</b> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#erste-schritte">Erste Schritte</a> ·
  <a href="#integrierte-verbindungen">Integrierte Verbindungen</a> ·
  <a href="#produkt-tour">Produkt-Tour</a> ·
  <a href="#plattformen-und-modelle">Plattformen und Modelle</a> ·
  <a href="#ökosystem">Ökosystem</a> ·
  <a href="./docs/development.md">Entwickler-Leitfaden</a> ·
  <a href="./LICENSE">MIT-Lizenz</a>
</p>

<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — dein Agent für die Hosentasche. Lokale Ausführung. Freie Modellwahl. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

Rish bringt Agent-Gespräche, Arbeitsbereiche und Tool-Ausführung auf dein
Telefon. Wähle ein Modell, beschreibe eine Aufgabe, prüfe die Arbeit und gib
Änderungen frei, ohne einen Computer laufen lassen zu müssen. Programmieren ist
eine seiner Anwendungen, nicht sein einziger Zweck.

> **Eine experimentelle Quellcode-Vorschau ist in Vorbereitung; ein stabiles,
> installierbares Release gibt es noch nicht.** Plattformumfang und Status der
> Konto-/Abo-Verifizierung sind unter
> [Plattformen und Modelle](#plattformen-und-modelle) zusammengefasst.

## Integrierte Verbindungen

**Vier integrierte Verbindungen. Ein Arbeitsbereich für die Hosentasche.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · Editierbarer Modellkatalog</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · API-Key / Abo-Anmeldung¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · API-Key / Abo-Anmeldung¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · API-Key / Abo-Anmeldung¹</sub>
</td>
</tr>
</table>

¹ Die Abo-Anmeldung ist derzeit nur für iOS verfügbar. BigModel Coding Lite ist verifiziert; Codex und Claude Code erfordern den optionalen experimentellen Build. Die Details zur Verifizierung findest du weiter unten.

Wähle einen Harness und verbinde dich mit einem API-Key oder einem Konto, das
dein Build unterstützt. Arbeite dann mit Dateien und Projekten auf deinem
Telefon. Rish verwaltet die Agent-Schleife, den Arbeitsbereich, Tool-Freigaben
und Ausführungsprotokolle; die integrierten Adapter stellen die Verbindung zu
Modelldiensten her.

**Konto- und Abo-Verifizierung (iOS)**

- **Codex**: Der optionale experimentelle Build hat den Geräte-Login über die offizielle CLI, einen Abo-Text-Chat mit `gpt-5.6-luna`, einen lokalen Aufruf des `list_dir`-Tools und die Persistenz über Neustarts hinweg verifiziert. Die offizielle CLI wird nur für den Login verwendet; nicht alle Tools und Modelle sind verifiziert.
- **GLM**: [ZCode](https://zcode.z.ai/en/docs/agents) ist Zhipus Agent-Produkt; GLM ist die Modellfamilie. Die BigModel-Anmeldung, die Persistenz über Neustarts und eine Antwort von GLM-5.3 über Coding Lite sind verifiziert; das Testguthaben nicht. Die offizielle ZCode-Runtime ist nicht integriert.
- **Claude Code**: Der optionale experimentelle iOS-Build hat die Abo-Anmeldung, eine Textantwort von Haiku 4.5 über die unveränderte offizielle CLI und die Persistenz über Neustarts hinweg verifiziert. Dieser Weg unterstützt derzeit nur Text, ohne Tools oder Anhänge. Eine gemessene Runde dauerte etwa 4,5 Minuten; an der Performance muss noch gearbeitet werden.

## Produkt-Tour

Verfolge die Ausführung des Agents, prüfe Projektänderungen und wähle eine
Modellverbindung aus. Klicke auf einen Screenshot, um das Original zu öffnen.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Rish auf einem iPhone mit zwei erfolgreichen Tool-Aufrufen und einer Zusammenfassung, die erklärt, dass ein absoluter Pfad abgelehnt wurde" width="280" /></a><br />
  <sub><b>Agent-Gespräch</b> — Verfolge Fortschritt, Tool-Aufrufe und Ergebnisse auf dem Telefon. Ein Pfad außerhalb des Arbeitsbereichs wird abgelehnt, und das Modell korrigiert sich in der nächsten Runde.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Rish im iOS-Simulator mit unstaged Dateien und Änderungsstatistiken" width="280" /></a><br />
  <sub><b>Lokale Projekte</b> — Prüfe unstaged Dateien und Änderungsstatistiken, bevor du committest.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Rish im iPad-Simulator mit Arbeitsbereich-Seitenleiste und vier nativen API-Adaptereinträgen" width="100%" /></a><br />
  <sub><b>iPad-Arbeitsbereich und Modellverbindungen</b> — Eine Seitenleiste für breite Bildschirme, ein dunkles Erscheinungsbild und API-Adaptereinträge.</sub>
</td>
</tr>
</table>

Alle Aufnahmen stammen aus echten Simulatoren und zeigen die aktuelle UI und den Workflow.

## Warum Rish

<table>
<tr>
<td width="50%">

### Dein Arbeitsbereich reist mit dir

Bewahre Dateien und Projekte im App-eigenen Arbeitsbereich des Telefons auf.
Importiere Material, lies Dateien, prüfe Projektänderungen und arbeite in
einer einzigen App weiter.

</td>
<td width="50%">

### Wähle dein Modell

Beginne mit den integrierten Einträgen für DSH, Claude Code, Codex und GLM,
oder konfiguriere einen kompatiblen API-Dienst und Modellzuordnungen. Das
Modell schlägt den nächsten Schritt vor; lokale Tools führen die Operation aus.

</td>
</tr>
<tr>
<td width="50%">

### Sieh, wie die Arbeit entsteht

Verfolge den Text jeder Runde, optionales vom Anbieter geliefertes Reasoning,
Tool-Aufrufe und das Endergebnis. Öffne Links direkt und kehre zu
gespeicherten Gesprächen zurück.

</td>
<td width="50%">

### Behalte die Kontrolle

Tools arbeiten in einem begrenzten Arbeitsbereich. Operationen, die eine
Autorisierung benötigen, fragen zuerst nach; Dateiänderungen und Git-Diffs
stehen zur Prüfung bereit.

</td>
</tr>
</table>

## Erste Aufgaben

| Aufgabe | Ein Ausgangspunkt |
| --- | --- |
| Mit Informationen arbeiten | Importiere Text oder ein PDF, frage nach den Kernpunkten und prüfe dann die Notizen, die der Agent speichert. |
| Dateien organisieren | Sieh dir ein Projektverzeichnis an, lies ausgewählte Dateien und gib neue oder aktualisierte Inhalte frei. |
| Ein Projekt pflegen | Prüfe Git-Status und Diffs, bearbeite Dateien und gib einen Commit frei. |

Diese Beispiele nutzen die derzeit verfügbaren iOS-Funktionen. Unterstützte
Tools und Dateiformate variieren je nach Plattform. Zu den Linux-Guest-Experimenten
siehe die [Runtime-Referenz](docs/development.md#honest-runtime-boundary).

## Wie die lokale Ausführung funktioniert

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

Unterstützte Tools werden in der App-eigenen Umgebung des Telefons ausgeführt.
Modellanfragen senden ausgewählten Gesprächs- und Aufgabenkontext an den von dir
konfigurierten Dienst: **lokale Ausführung bedeutet keine Offline-Modellinferenz**.

Rish kombiniert native Datei-/Git-Operationen, die Rish-Runtime und einen
experimentellen Linux Guest. Volle Kompatibilität mit Desktop-Programmen und
unbegrenzte Hintergrund-Ausführung werden nicht versprochen. Der
[Entwickler-Leitfaden](docs/development.md) trennt verifizierte Fähigkeiten von
experimentellen Pfaden.

## Plattformen und Modelle

| Plattform | Aktueller Umfang |
| --- | --- |
| iOS / iPadOS | Native Gespräche, Anhänge, Dateien, Git und kontrollierte Agent-Tools; inklusive adaptiver iPad-Layouts. |
| Android | Nativer API-Chat, Speicherung von Zugangsdaten, Sitzungswiederherstellung und bereichsbezogene Aufgabenbenachrichtigungen. Lokale Ausführung von Agent, Dateien und Git ist noch nicht verfügbar. |
| HarmonyOS | Temporäre Prüfungen im Android-Kompatibilitätscontainer begründen keine native HarmonyOS-Unterstützung. |

| Verbindung | Aktuelle Methode |
| --- | --- |
| DeepSeek / DSH | API-Key und editierbarer Modellkatalog; die Fähigkeiten hängen von Modell und Plattform ab. |
| GLM | API-Key, plus eine optionale BigModel/Z.ai-Kontoverbindung; siehe den Status oben. |
| Codex | API-Adapter; der optionale experimentelle iOS-Build ergänzt die Abo-Anmeldung — siehe den Status oben. |
| Claude Code | API-Adapter mit Konfiguration für kompatible Dienste; Text-Aufrufe über das Abonnement sind im optionalen iOS-Build verifiziert, mit dem oben angegebenen Umfang und der Latenz. |
| Eigene Dienste | Wähle auf iOS Messages, Responses oder Chat Completions und konfiguriere Modellzuordnungen. |

## Ökosystem

Rish ist Teil einer Familie von Local-first-, KI-nativen Werkzeugen von **[ZSeven-W](https://github.com/ZSeven-W)**. `rish` bootet den Linux-Gast in dieser App; die anderen tragen dieselbe Idee auf andere Oberflächen — das Terminal, die Design-Canvas und das Gedächtnis eines Agents.

| Projekt | Was es ist |
| ------- | ---------- |
| **[rish](https://github.com/ZSeven-W/rish)** | Echtes Docker auf dem Telefon: ein JIT-freier x86-64-Vollsystem-Interpreter in reinem Rust, der Linux bootet und Container auf iOS und Android ausführt. Der Linux Guest dieser App stammt von hier. |
| <img src="./docs/images/ecosystem/openpencil.png" alt="OpenPencil" width="40" /> **[OpenPencil](https://github.com/ZSeven-W/openpencil)** | Das erste Open-Source-Werkzeug für KI-natives Vektordesign und das erste mit gleichzeitigen Agent Teams. Design-as-Code — verwandle Prompts direkt auf der Live-Canvas in UI. |
| <img src="./docs/images/ecosystem/jian.png" alt="jian" width="40" /> **[jian](https://github.com/ZSeven-W/jian)** | UI-Framework in reinem Rust mit GPU-Skia. Verwandelt ein deklaratives `.op`-Dokument in eine native App — keine JS-Runtime, kein DOM, kein Electron. |
| <img src="./docs/images/ecosystem/zode.png" alt="Zode" width="40" /> **[Zode](https://github.com/ZSeven-W/zode)** | KI-native Coding-CLI für dein Terminal. Eine schnelle Rust-TUI, die deinen Code liest, Befehle ausführt, Dateien durchsucht und git verwaltet. |
| <img src="./docs/images/ecosystem/noema.png" alt="noema" width="40" /> **[noema](https://github.com/ZSeven-W/noema)** | Local-first-Speicher ohne Vektoren für Coding-Agents. Dauerhaftes Gedächtnis als einsehbare Dateien, eine Review-Warteschlange und Abruf ohne Embeddings. |

## Erste Schritte

Baue die App vorerst aus dem Quellcode; es gibt noch keinen stabilen Download
für Endnutzer. Sobald du den Quellcode hast, beginne im Stammverzeichnis des
Repositorys:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** Die native Vorbereitung erfordert fixierte Xcode-, Rust- und
SDK-Versionen. Lies die [Voraussetzungen](docs/development.md#ios-build-prerequisites),
und führe dann aus:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** Mit einer eingerichteten Android-Entwicklungsumgebung führe
`npm run android --prefix apps/mobile` aus. Der Entwickler-Leitfaden behandelt
außerdem [eigenständige Test-APKs](docs/development.md#install-and-run-the-react-native-app).

Öffne die App, wähle ein Modell und verbinde dich mit einem API-Key oder einem
unterstützten Konto. Lege auf iOS ein Projekt an oder wähle eines, prüfe seinen
Kontext und starte eine Aufgabe. Die Abo-Anmeldung für Codex und Claude Code
erfordert einen optionalen experimentellen Build (siehe den
[Entwickler-Leitfaden](docs/development.md)); für BigModel siehe die
[Konto-Anleitung](docs/zcode-account-login.md). Zugangsdaten bleiben im nativen
sicheren Speicher.

## Fortschritt und Mitwirken

Die erste Quellcode-Vorschau ist in Vorbereitung. Künftige Releases werden als
**Pre-release** markiert. Vollständige Harness-Kompatibilität, lokale Ausführung
unter Android und durchgehender Hintergrundbetrieb bleiben eingeschränkt. Siehe
den [Umfang der Vorschau und die Roadmap](docs/releases/v0.1.0.md).

Beiträge zu Dokumentation, Plattformunterstützung, Modellkompatibilität und
reproduzierbaren Fixes sind willkommen. Lies zuerst [CONTRIBUTING](CONTRIBUTING.md).
Konsultiere bei Sicherheitsproblemen [SECURITY](SECURITY.md), bevor du Details
teilst; veröffentliche niemals Zugangsdaten oder sensible Daten öffentlich.

- [Entwickler- und Build-Leitfaden](docs/development.md)
- [Marke und freigegebene Texte](brand/README.md)
- [Hinweise zu Drittanbietern und Guest-Quellen](THIRD_PARTY_NOTICES.md)

Der Projektcode steht unter der [MIT-Lizenz](LICENSE). Drittanbieter-Runtimes,
Guest-Komponenten und weitere Abhängigkeiten behalten ihre eigenen Lizenzen.
