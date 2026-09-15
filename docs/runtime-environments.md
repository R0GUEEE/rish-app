# Language environments

Rish can install language environments separately from the app. Python, Java,
Go, Rust, Bun, and Node.js each have their own package and version. Opening the
environment manager or choosing an environment does not download it. **Install**
downloads one package; **Run** also installs the selected package when necessary.
An installed package is reused until the user removes it.

The chat agent uses the same catalog, installation state and cached packages.
It can list environments, install the one needed for a requested task, run a
program, and start or stop an actual language HTTP service. Installation and
execution follow the conversation's agent permissions. Custom imported
environments can run; automatic installation accepts bundled catalog IDs only.
Users can still install, import, inspect or remove environments in Settings.

## Using an environment

Open **Settings → Language environments** to see available versions, storage
sizes and installation progress. You can cancel a download, remove a cached
environment, import a `.rishenv` file from Files, or enter its HTTPS download
address. Removal is refused while that environment is in use.
An installation started by the agent also appears here and can be cancelled.
Closing the manager leaves the shared cache installation running. Cancelling a
manual program's own installation does not cancel another task's download.

Open a workspace's **Files → Run a program**, select an environment and enter
the source file's path relative to the workspace, for example `src/main.py`.
Program arguments are an array of strings; they are passed literally to the
program. No model API key is needed. The panel displays stdout, stderr and the
exit code, and **Stop** interrupts the guest execution.

For a web application, ask the agent to start the requested language service.
The program must listen on the requested port; `PORT` and `HOST=127.0.0.1` are
provided. The returned loopback URL forwards requests to that program inside
the guest. It supports bounded HTTP/1.1 requests and responses, including
binary and chunked responses; WebSocket upgrades are not supported. A BusyBox
CGI preview is a separate tool and does not substitute for a language server.

The program receives a copy of the workspace. Generated files and dependency
installations belong to that run's disposable environment, which is removed
when the run ends. The original files remain available
in Files. Snapshots currently accept up to 256 files, 16 MiB in total and 2 MiB
per file; Git metadata and build/dependency caches are excluded.

Programs run while the app is in the foreground. Leaving the app cancels the
run. A single guest can run at a time, including previews and official CLI
login sessions. A busy guest must finish or stop before another starts.
One-shot program execution is bounded to ten minutes. Java source-file compilation
and execution has a separate twenty-minute limit to accommodate slower devices.
Services use the same startup limits, then keep running in the foreground until
stopped or the program exits. Stop remains available throughout startup and execution.

## Delivery and validation

Environment metadata is bundled in `RuntimeEnvironmentCatalog.json`; only
published, digest-verified artifacts with recorded execution evidence belong
in that catalog. Package downloads are streamed and checked before an atomic
installation. The installed disk is retained as an immutable template, and
each run gets an independent writable copy.

Python 3.12.14 cache revision 1 includes the matching official standard-library
bytecode, so a new run can import modules such as `http.server` without first
compiling their source in the software guest. It appears as `3.12.14+cache.1`;
the Python language version is unchanged. The earlier package remains usable,
and existing installations are not silently replaced.

The application keeps control of the kernel and guest agent. Environment
packages contain an x86_64 ext4 userland disk, not another native iOS
executable. The package format and reproducible build tools are documented in
[the environment build reference](../runtime-environments/README.md).

Validation distinguishes package installation, real rish execution, native
Simulator execution and physical-device results. Passing a small source-file
test does not establish compatibility with every framework, native extension
or dependency manager. The software guest has one virtual CPU and at most
1 GiB of guest memory; compiler startup and first builds can be slow.
