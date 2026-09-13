<p align="center">
  <img src="./brand/rish-banner.jpg" alt="Rish — tu agente de bolsillo. Ejecución local. Libertad de modelo. DSH / Claude Code / Codex / GLM" width="100%" />
</p>

<h1 align="center">Rish, tu agente de bolsillo.</h1>

<p align="center">
  <strong>Ejecuta localmente. Elige tu modelo.</strong><br />
  <sub>Espacios de trabajo locales · Elección de modelo · Ejecución de herramientas · Aprobaciones</sub>
</p>

<p align="center">
  <strong>DSH · Claude Code · Codex · GLM</strong><br />
  <sub>Conexiones integradas · Adaptadores nativos de Rish</sub>
</p>

<p align="center">
  <a href="./README.md">English</a> · <a href="./README.zh.md">简体中文</a> · <a href="./README.zh-TW.md">繁體中文</a> · <a href="./README.ja.md">日本語</a> · <a href="./README.ko.md">한국어</a> · <a href="./README.fr.md">Français</a> · <b>Español</b> · <a href="./README.de.md">Deutsch</a> · <a href="./README.pt.md">Português</a> · <a href="./README.ru.md">Русский</a> · <a href="./README.hi.md">हिन्दी</a> · <a href="./README.tr.md">Türkçe</a> · <a href="./README.th.md">ไทย</a> · <a href="./README.vi.md">Tiếng Việt</a> · <a href="./README.id.md">Bahasa Indonesia</a>
</p>

<p align="center">
  <a href="#primeros-pasos">Primeros pasos</a> ·
  <a href="#conexiones-integradas">Conexiones integradas</a> ·
  <a href="#recorrido-del-producto">Recorrido del producto</a> ·
  <a href="#plataformas-y-modelos">Plataformas y modelos</a> ·
  <a href="#ecosistema">Ecosistema</a> ·
  <a href="./docs/development.md">Guía para desarrolladores</a> ·
  <a href="./LICENSE">Licencia MIT</a>
</p>

Rish lleva las conversaciones del Agente, los espacios de trabajo y la ejecución de herramientas a tu teléfono. Elige un modelo, describe una tarea, inspecciona el trabajo y aprueba cambios sin mantener un ordenador encendido. Programar es uno de sus usos, no su único propósito.

> **Preparando una vista previa experimental del código fuente; todavía no
> hay una versión estable instalable.** El alcance por plataforma y el estado
> de verificación de cuentas/suscripciones se resumen en
> [Plataformas y modelos](#plataformas-y-modelos).

## Conexiones integradas

**Cuatro conexiones integradas. Un espacio de trabajo de bolsillo.**

<table>
<tr>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/deepseek-color.svg" alt="DSH / DeepSeek" width="40" height="40" /><br />
  <strong>DSH</strong><br />
  <sub>DeepSeek · Catálogo de modelos editable</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/claude-color.svg" alt="Claude Code" width="40" height="40" /><br />
  <strong>Claude Code</strong><br />
  <sub>Anthropic · Clave de API / Inicio de sesión con suscripción¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/codex-color.svg" alt="Codex" width="40" height="40" /><br />
  <strong>Codex</strong><br />
  <sub>OpenAI · Clave de API / Inicio de sesión con suscripción¹</sub>
</td>
<td align="center" width="25%">
  <img src="./apps/mobile/src/assets/harness/zai.svg" alt="GLM" width="40" height="40" /><br />
  <strong>GLM</strong><br />
  <sub>Zhipu · Clave de API / Inicio de sesión con suscripción¹</sub>
</td>
</tr>
</table>

¹ El inicio de sesión con suscripción está disponible actualmente solo en iOS. BigModel Coding Lite está verificado; Codex y Claude Code requieren la compilación experimental opcional. Consulta los detalles de verificación más abajo.

Elige un harness y conéctate con una clave de API o con una cuenta compatible con tu compilación. Luego empieza a trabajar con archivos y proyectos en tu teléfono. Rish gestiona el bucle del agente, el espacio de trabajo, las aprobaciones de herramientas y los registros de ejecución; los adaptadores integrados se conectan a los servicios de modelos.

**Verificación de cuentas y suscripciones (iOS)**

- **Codex**: la compilación experimental opcional ha verificado el inicio de sesión de dispositivo mediante la CLI oficial, un chat de texto con la suscripción `gpt-5.6-luna`, una llamada a la herramienta local `list_dir` y la persistencia tras reiniciar. La CLI oficial se usa únicamente para iniciar sesión; no todas las herramientas y modelos están verificados.
- **GLM**: [ZCode](https://zcode.z.ai/en/docs/agents) es el producto de agentes de Zhipu; GLM es la familia de modelos. El inicio de sesión en BigModel, la persistencia tras reiniciar y una respuesta de Coding Lite con GLM-5.3 están verificados; la asignación de prueba no lo está. El runtime oficial de ZCode no está integrado.
- **Claude Code**: la compilación experimental opcional de iOS ha verificado el inicio de sesión con suscripción, una respuesta de texto de Haiku 4.5 a través de la CLI oficial sin modificar y la persistencia tras reiniciar. Esta vía actualmente solo admite texto, sin herramientas ni adjuntos. Un turno medido tardó unos 4,5 minutos; el rendimiento aún necesita mejorar.

## Recorrido del producto

Sigue la ejecución del Agente, revisa los cambios del proyecto y elige una conexión de modelo. Haz clic en una captura para abrir la original.

<table>
<tr>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/agent-workflow-ios.png"><img src="./docs/images/agent-workflow-ios.png" alt="Conversación real del Agente en el Simulador de iOS mostrando el progreso, una llamada a la herramienta list_dir y su respuesta final" width="280" /></a><br />
  <sub><b>Conversación del Agente</b> — Sigue el progreso, las herramientas y los resultados. El texto mostrado sobrevive al reinicio de la app.</sub>
</td>
<td width="50%" valign="top" align="center">
  <a href="./docs/images/project-changes-ios.png"><img src="./docs/images/project-changes-ios.png" alt="Simulador de iOS de Rish mostrando archivos sin preparar y estadísticas de cambios" width="280" /></a><br />
  <sub><b>Proyectos locales</b> — Inspecciona los archivos sin preparar y las estadísticas de cambios antes de hacer commit.</sub>
</td>
</tr>
<tr>
<td colspan="2" valign="top">
  <a href="./docs/images/model-adapters-ipad.png"><img src="./docs/images/model-adapters-ipad.png" alt="Simulador de iPad de Rish mostrando la barra lateral del espacio de trabajo y cuatro entradas de adaptadores de API nativos" width="100%" /></a><br />
  <sub><b>Espacio de trabajo y conexiones de modelos en iPad</b> — Una barra lateral para pantalla ancha, apariencia oscura y entradas de adaptadores de API.</sub>
</td>
</tr>
</table>

Todas las capturas provienen de Simuladores reales y muestran la interfaz y el flujo de trabajo actuales.

## Por qué Rish

<table>
<tr>
<td width="50%">

### Tu espacio de trabajo viaja contigo

Guarda archivos y proyectos en el espacio de trabajo propio de la app en el teléfono. Importa material, lee archivos, revisa los cambios del proyecto y sigue trabajando en una sola app.

</td>
<td width="50%">

### Elige tu modelo

Empieza con las entradas integradas de DSH, Claude Code, Codex y GLM, o configura un servicio de API compatible y asignaciones de modelos. El modelo propone el siguiente paso; las herramientas locales realizan la operación.

</td>
</tr>
<tr>
<td width="50%">

### Mira cómo se realiza el trabajo

Sigue el texto de cada ronda, el razonamiento opcional devuelto por el proveedor, las llamadas a herramientas y el resultado final. Abre los enlaces directamente y vuelve a las conversaciones guardadas.

</td>
<td width="50%">

### Mantén el control

Las herramientas operan dentro de un espacio de trabajo acotado. Las operaciones que necesitan autorización preguntan primero; los cambios de archivos y los diffs de Git quedan disponibles para su revisión.

</td>
</tr>
</table>

## Ponlo a trabajar

| Tarea | Un punto de partida |
| --- | --- |
| Trabajar con información | Importa texto o un PDF, pide los puntos clave y luego revisa las notas que guarda el Agente. |
| Organizar archivos | Inspecciona un directorio del proyecto, lee los archivos seleccionados y aprueba el contenido nuevo o actualizado. |
| Mantener un proyecto | Revisa el estado y los diffs de Git, edita archivos y aprueba un commit. |

Estos ejemplos usan las capacidades de iOS disponibles actualmente. Las herramientas y los formatos de archivo admitidos varían según la plataforma. Para los experimentos del Linux Guest, consulta la [referencia del runtime](docs/development.md#honest-runtime-boundary).

## Cómo funciona la ejecución local

```text
Your task → Rish assembles context → Your chosen model service
                                           ↓ Text / tool requests
Phone workspace ← Local tools ← Rish validation and approval
```

Las herramientas admitidas se ejecutan en el entorno propio de la app en el teléfono. Las solicitudes al modelo envían el contexto seleccionado de la conversación y de la tarea a tu servicio configurado: **la ejecución local no significa inferencia del modelo sin conexión**.

Rish combina operaciones nativas de archivos y Git, el runtime de Rish y un Linux Guest experimental. No se promete una compatibilidad completa con programas de escritorio ni una ejecución en segundo plano indefinida. La [guía para desarrolladores](docs/development.md) distingue las capacidades verificadas de las rutas experimentales.

## Plataformas y modelos

| Plataforma | Alcance actual |
| --- | --- |
| iOS / iPadOS | Conversaciones nativas, adjuntos, Archivos, Git y herramientas controladas del Agente; incluye diseños adaptativos para iPad. |
| Android | Chat nativo por API, almacenamiento de credenciales, recuperación de sesión y notificaciones de tareas con ámbito acotado. La ejecución local del Agente, de Archivos y de Git aún no está disponible. |
| HarmonyOS | Las comprobaciones temporales en el contenedor de compatibilidad de Android no establecen soporte nativo de HarmonyOS. |

| Conexión | Método actual |
| --- | --- |
| DeepSeek / DSH | Clave de API y catálogo de modelos editable; las capacidades dependen del modelo y de la plataforma. |
| GLM | Clave de API, más una conexión opcional con cuenta de BigModel/Z.ai; consulta el estado más arriba. |
| Codex | Adaptador de API; la compilación experimental opcional de iOS añade el inicio de sesión con suscripción; consulta el estado más arriba. |
| Claude Code | Adaptador de API con configuración de servicios compatibles; las llamadas de texto con suscripción están verificadas en la compilación opcional de iOS, con el alcance y la latencia señalados más arriba. |
| Servicios personalizados | En iOS, selecciona Messages, Responses o Chat Completions y configura las asignaciones de modelos. |

## Primeros pasos

Por ahora hay que compilar a partir del código fuente; no existe una descarga estable para el usuario final. Una vez que tengas el código fuente, empieza en la raíz del repositorio:

```sh
node scripts/verify-source-checkout.mjs
npm ci --prefix apps/mobile
```

**iOS:** La preparación nativa requiere versiones fijadas de Xcode, Rust y los SDK. Lee los [requisitos previos](docs/development.md#ios-build-prerequisites) y luego ejecuta:

```sh
./scripts/prepare-rish-ios.sh
./scripts/prepare-libgit2-ios.sh
cd apps/mobile/ios
pod install
cd ../../..
npm run ios --prefix apps/mobile
```

**Android:** Con un entorno de desarrollo de Android configurado, ejecuta `npm run android --prefix apps/mobile`. La guía para desarrolladores también cubre los [APK de prueba independientes](docs/development.md#install-and-run-the-react-native-app).

Abre la app, elige un modelo y conéctate con una clave de API o con una cuenta admitida. En iOS, crea o selecciona un proyecto, revisa su contexto y empieza una tarea. El inicio de sesión con suscripción de Codex y Claude Code requiere una compilación experimental opcional (consulta la [guía para desarrolladores](docs/development.md)); para BigModel, consulta la [guía de cuentas](docs/zcode-account-login.md). Las credenciales permanecen en el almacenamiento seguro nativo.

## Progreso y contribuciones

La primera vista previa del código fuente está en preparación. Las próximas versiones se marcarán como **Pre-release**. La compatibilidad completa de Harness, la ejecución local en Android y la operación continua en segundo plano siguen siendo limitadas. Consulta el [alcance y la hoja de ruta de la vista previa](docs/releases/v0.1.0.md).

Se agradecen las contribuciones a la documentación, al soporte de plataformas, a la compatibilidad de modelos y a las correcciones reproducibles. Lee primero [CONTRIBUTING](CONTRIBUTING.md). Para problemas de seguridad, consulta [SECURITY](SECURITY.md) antes de compartir detalles; nunca publiques credenciales ni datos sensibles públicamente.

- [Guía de desarrollo y compilación](docs/development.md)
- [Marca y textos aprobados](brand/README.md)
- [Avisos de terceros y fuentes del Guest](THIRD_PARTY_NOTICES.md)

El código del proyecto está licenciado bajo [MIT](LICENSE). Los runtimes de terceros, los componentes del Guest y otras dependencias conservan sus propias licencias.

## Ecosistema

Proyectos hermanos construidos sobre la misma idea local-first y de libertad de modelos:

- **[rish](https://github.com/ZSeven-W/rish)** — Docker real en un teléfono. Un intérprete de sistema completo x86-64 sin JIT, escrito en Rust puro, que arranca Linux y ejecuta contenedores en iOS y Android. El Linux Guest de este proyecto proviene de allí.
- **[OpenPencil](https://github.com/ZSeven-W/openpencil)** — la primera herramienta de diseño vectorial nativa de IA de código abierto, y la primera con Agent Teams concurrentes. Design-as-Code: convierte prompts en UI sobre el lienzo en vivo.
- **[Jian](https://github.com/ZSeven-W/jian)** — un framework de UI multiplataforma nativo de Rust. Un archivo .op es una app.
- **[Zode](https://github.com/ZSeven-W/zode)** — una CLI de programación nativa de IA para tu terminal. Micronúcleo con plugins, multiproveedor y TUI a pantalla completa.
- **[Noema](https://github.com/ZSeven-W/noema)** — memoria local-first para agentes de programación, sin almacén de vectores, con colas de revisión y MCP.
