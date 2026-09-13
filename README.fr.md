<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — votre agent de poche. Exécution locale. Liberté de modèle. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

<h1 align="center">Rish, votre agent de poche.</h1>

<p align="center">
  <strong>Exécutez en local. Choisissez votre modèle.</strong><br />
  <sub>Espaces de travail locaux · Choix du modèle · Exécution d'outils · Approbations</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>Connexions intégrées · Adaptateurs Rish natifs</sub>
</p>

<p align="center">
  <a href="./README.md">简体中文</a> · <a href="./README.en.md">English</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <b>Français</b> · <a href="./README.es.md">Español</a> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#premiers-pas">Premiers pas</a> ·
  <a href="#connexions-intégrées">Connexions intégrées</a> ·
  <a href="#visite-du-produit">Visite du produit</a> ·
  <a href="#plateformes-et-modèles">Plateformes et modèles</a> ·
  <a href="#écosystème">Écosystème</a> ·
  <a href="./docs/development.md">Guide du développeur</a> ·
  <a href="./LICENSE">Licence MIT</a>
</p>

Rish apporte sur votre téléphone les conversations avec l'Agent, les espaces
de travail et l'exécution d'outils. Choisissez un modèle, décrivez une tâche,
examinez le travail et approuvez les modifications sans laisser un ordinateur
allumé. Coder est l'un de ses usages, pas sa seule finalité.

> **Préparation d'un aperçu expérimental des sources ; pas encore de version
> stable installable.** L'étendue des plateformes et l'état de la vérification
> des comptes et des abonnements sont résumés dans [Plateformes et modèles](#plateformes-et-modèles).

## Connexions intégrées

**Quatre connexions intégrées. Un espace de travail de poche.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · Catalogue de modèles modifiable</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · Clé API / Connexion par abonnement¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · Clé API / Connexion par abonnement¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · Clé API / Connexion par abonnement¹</sub>
</td>
</tr>
</table>

¹ La connexion par abonnement est pour l'instant réservée à iOS. BigModel
Coding Lite est vérifié ; Codex et Claude Code nécessitent la build
expérimentale facultative. Voir les détails de vérification ci-dessous.

Choisissez un harnais et connectez-vous avec une clé API ou un compte pris en
charge par votre build. Commencez ensuite à travailler avec des fichiers et des
projets sur votre téléphone. Rish gère la boucle de l'agent, l'espace de
travail, les approbations d'outils et les enregistrements d'exécution ; les
adaptateurs intégrés se connectent aux services de modèles.

**Vérification des comptes et des abonnements (iOS)**

- **Codex** : la build expérimentale facultative a permis de vérifier la
  connexion appareil via la CLI officielle, une discussion texte sur abonnement
  `gpt-5.6-luna`, un appel d'outil local `list_dir`, ainsi que la persistance
  après redémarrage. La CLI officielle n'est utilisée que pour la connexion ;
  tous les outils et modèles ne sont pas vérifiés.
- **GLM** : [ZCode](https://zcode.z.ai/en/docs/agents) est le produit d'agent
  de Zhipu ; GLM est la famille de modèles. La connexion BigModel, la
  persistance après redémarrage et une réponse Coding Lite GLM-5.3 sont
  vérifiées ; l'allocation d'essai ne l'est pas. Le runtime ZCode officiel
  n'est pas intégré.
- **Claude Code** : la build expérimentale iOS facultative a permis de
  vérifier la connexion par abonnement, une réponse texte Haiku 4.5 via la CLI
  officielle non modifiée et la persistance après redémarrage. Cette voie ne
  prend actuellement en charge que le texte, sans outils ni pièces jointes. Un
  tour mesuré a pris environ 4,5 minutes ; les performances restent à
  améliorer.

## Visite du produit

Suivez l'exécution de l'Agent, examinez les modifications du projet et
choisissez une connexion de modèle. Cliquez sur une capture d'écran pour ouvrir
l'original.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Conversation réelle sur Simulateur iOS de Rish montrant la progression, un appel d'outil list_dir et la réponse finale" width="280" /></a><br />
  <sub><b>Conversation avec l'Agent</b> — Suivez la progression, les outils et les résultats. Le texte affiché survit au redémarrage de l'application.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Simulateur iOS de Rish montrant les fichiers non indexés et les statistiques de modifications" width="280" /></a><br />
  <sub><b>Projets locaux</b> — Examinez les fichiers non indexés et les statistiques de modifications avant de faire un commit.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Simulateur iPad de Rish montrant la barre latérale de l'espace de travail et quatre entrées d'adaptateurs API natifs" width="100%" /></a><br />
  <sub><b>Espace de travail et connexions de modèles sur iPad</b> — Une barre latérale grand écran, une apparence sombre et des entrées d'adaptateurs API.</sub>
</td>
</tr>
</table>

Toutes les captures proviennent de véritables Simulateurs et montrent
l'interface et le flux de travail actuels.

## Pourquoi Rish

<table>
<tr>
<td width="50%">

### Votre espace de travail voyage avec vous

Gardez vos fichiers et projets dans l'espace de travail propre à l'application,
sur le téléphone. Importez du contenu, lisez des fichiers, examinez les
modifications du projet et poursuivez le travail dans une seule application.

</td>
<td width="50%">

### Choisissez votre modèle

Commencez avec les entrées intégrées DSH, Claude Code, Codex et GLM, ou
configurez un service API compatible et des mappages de modèles. Le modèle
propose l'étape suivante ; les outils locaux réalisent l'opération.

</td>
</tr>
<tr>
<td width="50%">

### Voyez le travail se dérouler

Suivez le texte de chaque tour, le raisonnement facultatif renvoyé par le
fournisseur, les appels d'outils et le résultat final. Ouvrez les liens
directement et revenez aux conversations enregistrées.

</td>
<td width="50%">

### Gardez le contrôle

Les outils opèrent dans un espace de travail délimité. Les opérations
nécessitant une autorisation demandent d'abord votre accord ; les modifications
de fichiers et les diffs Git sont disponibles pour révision.

</td>
</tr>
</table>

## Mettez-le au travail

| Tâche | Un point de départ |
| --- | --- |
| Travailler avec l'information | Importez du texte ou un PDF, demandez les points clés, puis examinez les notes enregistrées par l'Agent. |
| Organiser des fichiers | Inspectez un répertoire de projet, lisez les fichiers choisis et approuvez le contenu nouveau ou mis à jour. |
| Maintenir un projet | Examinez le statut et les diffs Git, modifiez des fichiers et approuvez un commit. |

Ces exemples reposent sur les capacités iOS actuellement disponibles. Les
outils et formats de fichiers pris en charge varient selon la plateforme. Pour
les expérimentations du Linux Guest, consultez la
[référence du runtime](docs/development.md#honest-runtime-boundary).

## Comment fonctionne l'exécution locale

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

Les outils pris en charge s'exécutent dans l'environnement propre à
l'application du téléphone. Les requêtes envoyées au modèle transmettent une
sélection de la conversation et du contexte de la tâche à votre service
configuré : **l'exécution locale ne signifie pas une inférence de modèle hors
ligne**.

Rish combine des opérations natives sur les fichiers et Git, le runtime Rish et
un Linux Guest expérimental. La compatibilité complète avec les logiciels de
bureau et l'exécution illimitée en arrière-plan ne sont pas promises. Le
[guide du développeur](docs/development.md) distingue les capacités vérifiées
des pistes expérimentales.

## Plateformes et modèles

| Plateforme | Étendue actuelle |
| --- | --- |
| iOS / iPadOS | Conversations natives, pièces jointes, Fichiers, Git et outils Agent contrôlés ; inclut des mises en page iPad adaptatives. |
| Android | Conversations API natives, stockage des identifiants, récupération de session et notifications de tâches ciblées. L'exécution locale de l'Agent, des Fichiers et de Git n'est pas encore disponible. |
| HarmonyOS | Des vérifications temporaires dans le conteneur de compatibilité Android n'établissent pas de prise en charge native d'HarmonyOS. |

| Connexion | Méthode actuelle |
| --- | --- |
| DeepSeek / DSH | Clé API et catalogue de modèles modifiable ; les capacités dépendent du modèle et de la plateforme. |
| GLM | Clé API, plus une connexion de compte BigModel/Z.ai facultative ; voir l'état ci-dessus. |
| Codex | Adaptateur API ; la build expérimentale iOS facultative ajoute la connexion par abonnement — voir l'état ci-dessus. |
| Claude Code | Adaptateur API avec configuration de services compatibles ; les appels texte sur abonnement sont vérifiés dans la build iOS facultative, avec l'étendue et la latence indiquées ci-dessus. |
| Services personnalisés | Sur iOS, sélectionnez Messages, Responses ou Chat Completions et configurez les mappages de modèles. |

## Premiers pas

Pour l'instant, compilez à partir des sources ; il n'existe aucun téléchargement
stable pour l'utilisateur final. Une fois les sources en main, commencez à la
racine du dépôt :

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS :** La préparation native requiert des versions épinglées de Xcode, Rust
et des SDK. Lisez les [prérequis](docs/development.md#ios-build-prerequisites),
puis exécutez :

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android :** Avec un environnement de développement Android configuré,
exécutez `npm run android --prefix apps/mobile`. Le guide du développeur couvre
également les [APK de test autonomes](docs/development.md#install-and-run-the-react-native-app).

Ouvrez l'application, choisissez un modèle, puis connectez-vous avec une clé
API ou un compte pris en charge. Sur iOS, créez ou sélectionnez un projet,
examinez son contexte et lancez une tâche. La connexion par abonnement à Codex
et Claude Code nécessite une build expérimentale facultative (voir le
[guide du développeur](docs/development.md)) ; pour BigModel, consultez le
[guide de compte](docs/zcode-account-login.md). Les identifiants restent dans
le stockage sécurisé natif.

## Avancement et contributions

Le premier aperçu des sources est en préparation. Les prochaines versions
porteront la mention **Pre-release**. La compatibilité Harness complète,
l'exécution locale sur Android et le fonctionnement continu en arrière-plan
restent limités. Consultez [l'étendue de l'aperçu et la feuille de
route](docs/releases/v0.1.0.md).

Les contributions à la documentation, à la prise en charge des plateformes, à
la compatibilité des modèles et aux correctifs reproductibles sont les
bienvenues. Lisez d'abord [CONTRIBUTING](CONTRIBUTING.md). Pour les problèmes
de sécurité, consultez [SECURITY](SECURITY.md) avant de partager des détails ;
ne publiez jamais d'identifiants ni de données sensibles en public.

- [Guide du développeur et de compilation](docs/development.md)
- [Marque et textes approuvés](brand/README.md)
- [Mentions tierces et sources du Guest](THIRD_PARTY_NOTICES.md)

Le code du projet est sous licence [MIT](LICENSE). Les runtimes tiers, les
composants du Guest et les autres dépendances conservent leurs propres
licences.

## Écosystème

Projets frères bâtis sur la même idée — le local d'abord et le libre choix du
modèle :

- **[rish](https://github.com/ZSeven-W/rish)** — un vrai Docker sur un
  téléphone. Un interpréteur système complet x86-64 sans JIT, en Rust pur, qui
  démarre Linux et exécute des conteneurs sur iOS et Android. Le Linux Guest
  de ce projet en est issu.
- **[OpenPencil](https://github.com/ZSeven-W/openpencil)** — le premier outil
  de conception vectorielle natif IA open source, et le premier à proposer des
  Agent Teams concurrentes. Du Design-as-Code : transformez des prompts en
  interface sur le canevas en direct.
- **[Jian](https://github.com/ZSeven-W/jian)** — un framework d'interface
  multiplateforme natif Rust. Un fichier .op est une application.
- **[Zode](https://github.com/ZSeven-W/zode)** — un CLI de codage natif IA
  pour votre terminal. Micro-noyau plus extensions, multi-fournisseurs, TUI
  plein écran.
- **[Noema](https://github.com/ZSeven-W/noema)** — une mémoire « local
  d'abord » pour agents de codage, sans base vectorielle, avec files de
  révision et MCP.
