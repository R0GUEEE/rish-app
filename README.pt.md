<p align="center">
  <img src="./brand/rish-readme-icon.svg" alt="Rish" width="96" />
</p>

<h1 align="center">Rish, seu agente de bolso.</h1>

<p align="center">
  <strong>Execute localmente. Escolha seu modelo.</strong><br />
  <sub>Espaços de trabalho locais · Escolha de modelo · Execução de ferramentas · Aprovações</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>Conexões integradas · Adaptadores nativos de Rish</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <b>Português</b> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#como-começar">Como começar</a> ·
  <a href="#conexões-integradas">Conexões integradas</a> ·
  <a href="#tour-pelo-produto">Tour pelo produto</a> ·
  <a href="#plataformas-e-modelos">Plataformas e modelos</a> ·
  <a href="#ecossistema">Ecossistema</a> ·
  <a href="./docs/development.md">Guia do desenvolvedor</a> ·
  <a href="./LICENSE">Licença MIT</a>
</p>

<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — seu agente de bolso. Execução local. Liberdade de modelo. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

Rish leva para o seu telefone conversas de Agente, espaços de trabalho e
execução de ferramentas. Escolha um modelo, descreva uma tarefa, inspecione
o trabalho e aprove mudanças sem precisar manter um computador ligado.
Programar é um dos usos, não o único propósito.

> **Preparando uma prévia experimental do código-fonte; ainda não há uma
> versão estável para instalação.** O escopo por plataforma e o status de
> verificação de contas/assinaturas estão resumidos em
> [Plataformas e modelos](#plataformas-e-modelos).

## Conexões integradas

**Quatro conexões integradas. Um espaço de trabalho de bolso.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · Catálogo de modelos editável</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · Chave de API / Login com assinatura¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · Chave de API / Login com assinatura¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · Chave de API / Login com assinatura¹</sub>
</td>
</tr>
</table>

¹ O login com assinatura está disponível atualmente apenas no iOS. O BigModel Coding Lite está verificado; Codex e Claude Code exigem a compilação experimental opcional. Consulte os detalhes de verificação abaixo.

Escolha um harness e conecte-se com uma chave de API ou com uma conta
compatível com a sua compilação. Em seguida, comece a trabalhar com arquivos
e projetos no seu telefone. O Rish gerencia o loop do agente, o espaço de
trabalho, as aprovações de ferramentas e os registros de execução; os
adaptadores integrados se conectam aos serviços de modelos.

**Verificação de contas e assinaturas (iOS)**

- **Codex**: a compilação experimental opcional verificou o login por
  dispositivo via CLI oficial, um chat de texto com a assinatura
  `gpt-5.6-luna`, uma chamada da ferramenta local `list_dir` e a persistência
  após reiniciar. A CLI oficial é usada apenas para login; nem todas as
  ferramentas e modelos estão verificados.
- **GLM**: o [ZCode](https://zcode.z.ai/en/docs/agents) é o produto de agentes
  da Zhipu; GLM é a família de modelos. O login no BigModel, a persistência
  após reiniciar e uma resposta de Coding Lite com GLM-5.3 estão verificados;
  o crédito de avaliação não está. O runtime oficial do ZCode não está
  integrado.
- **Claude Code**: a compilação experimental opcional de iOS verificou o login
  com assinatura, uma resposta de texto do Haiku 4.5 pela CLI oficial sem
  modificações e a persistência após reiniciar.
  Esse caminho atualmente suporta apenas texto, sem ferramentas nem anexos.
  Um turno medido levou cerca de 4,5 minutos; o desempenho ainda precisa
  melhorar.

## Tour pelo produto

Acompanhe a execução do Agente, revise as mudanças do projeto e escolha uma
conexão de modelo. Clique em uma captura de tela para abrir a original.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Rish em um iPhone mostrando duas chamadas de ferramentas bem-sucedidas e um resumo explicando que um caminho absoluto foi recusado" width="280" /></a><br />
  <sub><b>Conversa do Agente</b> — Acompanhe o progresso, as chamadas de ferramentas e os resultados no telefone. Um caminho fora do espaço de trabalho é recusado, e o modelo se corrige na rodada seguinte.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Simulador de iOS do Rish mostrando arquivos não preparados e estatísticas de mudanças" width="280" /></a><br />
  <sub><b>Projetos locais</b> — Inspecione arquivos não preparados e estatísticas de mudanças antes de fazer commit.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Simulador de iPad do Rish mostrando a barra lateral do espaço de trabalho e quatro entradas de adaptadores de API nativos" width="100%" /></a><br />
  <sub><b>Espaço de trabalho e conexões de modelos no iPad</b> — Uma barra lateral para tela larga, aparência escura e entradas de adaptadores de API.</sub>
</td>
</tr>
</table>

Todas as capturas vêm de Simuladores reais e mostram a interface e o fluxo de
trabalho atuais.

## Por que Rish

<table>
<tr>
<td width="50%">

### Seu espaço de trabalho viaja com você

Mantenha arquivos e projetos no espaço de trabalho próprio do app no
telefone. Importe material, leia arquivos, revise as mudanças do projeto e
continue trabalhando em um só app.

</td>
<td width="50%">

### Escolha seu modelo

Comece com as entradas integradas de DSH, Claude Code, Codex e GLM, ou
configure um serviço de API compatível e mapeamentos de modelos. O modelo
propõe o próximo passo; as ferramentas locais executam a operação.

</td>
</tr>
<tr>
<td width="50%">

### Veja o trabalho acontecer

Acompanhe o texto de cada rodada, o raciocínio opcional retornado pelo
provedor, as chamadas de ferramentas e o resultado final. Abra links
diretamente e volte às conversas salvas.

</td>
<td width="50%">

### Mantenha o controle

As ferramentas operam dentro de um espaço de trabalho delimitado. Operações
que precisam de autorização perguntam primeiro; mudanças de arquivos e diffs
de Git ficam disponíveis para revisão.

</td>
</tr>
</table>

## Coloque-o para trabalhar

| Tarefa | Um ponto de partida |
| --- | --- |
| Trabalhar com informações | Importe texto ou um PDF, peça os pontos principais e depois revise as notas que o Agente salva. |
| Organizar arquivos | Inspecione um diretório do projeto, leia os arquivos selecionados e aprove o conteúdo novo ou atualizado. |
| Manter um projeto | Revise o status e os diffs do Git, edite arquivos e aprove um commit. |

Esses exemplos usam as capacidades do iOS disponíveis atualmente. As
ferramentas e os formatos de arquivo suportados variam por plataforma. Para
os experimentos do Linux Guest, consulte a
[referência do runtime](docs/development.md#honest-runtime-boundary).

## Como funciona a execução local

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

As ferramentas suportadas são executadas no ambiente próprio do app no
telefone. As requisições ao modelo enviam o contexto selecionado da conversa
e da tarefa para o seu serviço configurado: **execução local não significa
inferência do modelo offline**.

O Rish combina operações nativas de arquivos e Git, o runtime do Rish e um
Linux Guest experimental. Compatibilidade completa com programas de desktop
e execução ilimitada em segundo plano não são prometidas. O
[guia do desenvolvedor](docs/development.md) separa as capacidades verificadas
dos caminhos experimentais.

## Plataformas e modelos

| Plataforma | Escopo atual |
| --- | --- |
| iOS / iPadOS | Conversas nativas, anexos, Arquivos, Git e ferramentas controladas do Agente; inclui layouts adaptativos para iPad. |
| Android | Chat nativo por API, armazenamento de credenciais, recuperação de sessão e notificações de tarefas com escopo definido. A execução local de Agente, Arquivos e Git ainda não está disponível. |
| HarmonyOS | Verificações temporárias no contêiner de compatibilidade do Android não estabelecem suporte nativo ao HarmonyOS. |

| Conexão | Método atual |
| --- | --- |
| DeepSeek / DSH | Chave de API e catálogo de modelos editável; as capacidades dependem do modelo e da plataforma. |
| GLM | Chave de API, mais uma conexão opcional com conta BigModel/Z.ai; consulte o status acima. |
| Codex | Adaptador de API; a compilação experimental opcional de iOS adiciona login com assinatura — consulte o status acima. |
| Claude Code | Adaptador de API com configuração de serviços compatíveis; chamadas de texto com assinatura estão verificadas na compilação opcional de iOS, com o escopo e a latência indicados acima. |
| Serviços personalizados | No iOS, selecione Messages, Responses ou Chat Completions e configure mapeamentos de modelos. |

## Ecossistema

Rish faz parte de uma família de ferramentas local-first e nativas de IA de **[ZSeven-W](https://github.com/ZSeven-W)**. O `rish` inicializa o Linux Guest dentro deste app; as demais levam a mesma ideia para outras superfícies — o terminal, o canvas de design e a memória de um agente.

| Projeto | O que é |
| ------- | ---------- |
| **[rish](https://github.com/ZSeven-W/rish)** | Docker de verdade em um telefone: um interpretador de sistema completo x86-64 sem JIT, em Rust puro, que inicializa o Linux e executa contêineres no iOS e no Android. O Linux Guest deste app vem daqui. |
| <img src="./docs/images/ecosystem/openpencil.png" alt="OpenPencil" width="40" /> **[OpenPencil](https://github.com/ZSeven-W/openpencil)** | A primeira ferramenta de design vetorial nativa de IA e de código aberto, e a primeira com Agent Teams concorrentes. Design-as-Code — transforme prompts em UI diretamente no canvas em tempo real. |
| <img src="./docs/images/ecosystem/jian.png" alt="jian" width="40" /> **[jian](https://github.com/ZSeven-W/jian)** | Framework de UI em Rust puro e com GPU-Skia. Transforma um documento declarativo `.op` em um app nativo — sem runtime de JS, sem DOM, sem Electron. |
| <img src="./docs/images/ecosystem/zode.png" alt="Zode" width="40" /> **[Zode](https://github.com/ZSeven-W/zode)** | CLI de programação nativa de IA para o seu terminal. Uma TUI rápida em Rust que lê o seu código, executa comandos, pesquisa arquivos e gerencia o git. |
| <img src="./docs/images/ecosystem/noema.png" alt="noema" width="40" /> **[noema](https://github.com/ZSeven-W/noema)** | Memória local-first e não vetorial para agentes de programação. Memória durável como arquivos inspecionáveis, uma fila de revisão e recuperação sem embeddings. |

## Como começar

Por enquanto, compile a partir do código-fonte; não há download estável para
o usuário final. Depois de obter o código-fonte, comece na raiz do
repositório:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** A preparação nativa exige versões fixadas de Xcode, Rust e SDKs.
Leia os [pré-requisitos](docs/development.md#ios-build-prerequisites) e
execute:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** Com um ambiente de desenvolvimento Android configurado, execute
`npm run android --prefix apps/mobile`. O guia do desenvolvedor também cobre
[APKs de teste independentes](docs/development.md#install-and-run-the-react-native-app).

Abra o app, escolha um modelo e conecte-se com uma chave de API ou uma conta
suportada. No iOS, crie ou selecione um projeto, revise o contexto dele e
comece uma tarefa. O login com assinatura do Codex e do Claude Code exige uma
compilação experimental opcional (consulte o [guia do desenvolvedor](docs/development.md));
para o BigModel, consulte o [guia de contas](docs/zcode-account-login.md). As
credenciais ficam no armazenamento seguro nativo.

## Progresso e contribuições

A primeira prévia do código-fonte está em preparação. Versões futuras serão
marcadas como **Pre-release**. A compatibilidade completa de Harness, a
execução local no Android e a operação contínua em segundo plano permanecem
limitadas. Consulte o [escopo e o roteiro da prévia](docs/releases/v0.1.0.md).

Contribuições para documentação, suporte a plataformas, compatibilidade de
modelos e correções reproduzíveis são bem-vindas. Leia primeiro o
[CONTRIBUTING](CONTRIBUTING.md). Para problemas de segurança, consulte o
[SECURITY](SECURITY.md) antes de compartilhar detalhes; nunca publique
credenciais ou dados sensíveis publicamente.

- [Guia de desenvolvimento e compilação](docs/development.md)
- [Marca e textos aprovados](brand/README.md)
- [Avisos de terceiros e fontes do Guest](THIRD_PARTY_NOTICES.md)

O código do projeto está licenciado sob [MIT](LICENSE). Runtimes de terceiros,
componentes do Guest e outras dependências mantêm suas próprias licenças.
