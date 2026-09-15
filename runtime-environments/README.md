# On-demand runtime environments

Each optional environment is a signed-source, self-contained Linux x86_64
root filesystem carried as a `RISHENV1` package. The package contains no kernel
or agent. Those remain controlled by the application.

| Family | Locked runtime | Raw disk | Minimum RAM |
| --- | --- | --- | --- |
| Python | 3.12.14 + pip 24.3.1 (Alpine 3.21) | 128 MiB | 512 MiB |
| Java | OpenJDK 21.0.12_p8 (Alpine 3.23) | 1 GiB | 1 GiB |
| Go | 1.25.10 (Alpine 3.23) | 1 GiB | 1 GiB |
| Rust | 1.91.1, Cargo 1.91.1 (Alpine 3.23) | 2 GiB | 1 GiB |
| Node.js | 24.18.1, npm 11.11.0 (Alpine 3.23) | 512 MiB | 768 MiB |
| Bun | 1.4.0 official musl baseline | 512 MiB | 1 GiB |

These are exact artifact versions, not an assertion that every language has
passed production iOS execution. Build receipts start with
`execution_verified: false`. A language is catalog-eligible only after its
exact disk digest has successful current-rish execution evidence.

The catalog pins the six release artifacts and their verified digests. Opening
the manager or selecting a package does not prefetch it. Large package, disk,
and source artifacts live under `.build/runtime-environments/packages` during
the build and are distributed as release assets rather than Git objects.

## Build and verify

From the repository root, using Python 3.10+, OpenSSL, curl and e2fsprogs:

```sh
python3 scripts/runtime-environments/build.py python
python3 scripts/tests/runtime-environments-test.py
```

`RISH_MKE2FS` may select the trusted host `mke2fs` executable. Otherwise the
standard path, Homebrew e2fsprogs and Android SDK platform-tools are checked.
The currently verified builder uses mke2fs 1.46.6. Reuse the same tool version
for byte-identical disks; its allocation/layout choices are part of the build.

The builder downloads only the requested family's locked closure, using
source-URL-specific cache identities and cross-process locks. It checks
package size, whole-package SHA256, signed APKINDEX control checksum, RSA
signature and compressed data SHA256. It never runs package scripts or guest
executables on the host. Archive paths, links, special files and conflicting
payloads are checked before staging.

Files, links and BusyBox entrypoints are populated as data, with all guest
paths confined to the new root. `mke2fs` creates the raw disk. The builder
normalizes inode timestamps/ownership in its own known checksum-free ext4
layout; it refuses foreign layouts. Fixed UUID, hash seed and gzip timestamp
make reconstruction repeatable with the same locked toolchain.

Bun's official GitHub release zip digest is locked independently from the
previously tested baseline executable digest; both must match. No generic
SSE4.2 or JIT support is inferred from a successful Bun command.

## Source provenance

Every `.lock.json` retains the exact official binary URL, version, license,
Alpine source origin, immutable aports commit, build-recipe URL and hashes.
The public Alpine signing keys come from the current hash-pinned base guest.
Bun is locked to the official `oven-sh/bun` release and source tag.

`collect-sources.py` retains the corresponding immutable Alpine APKBUILD
recipes as text data, including their upstream source URL/hash/patch lists.
The current build retained 75 distinct recipes and all 359 distinct literal
SHA512-locked Alpine source archives/patches, without executing them.
`collect-sources.py --archives` stores an explicit complete/missing manifest,
uses at most two source downloads concurrently and a 4032 MiB cumulative
Alpine budget, reserving room within the 6 GiB task cap for Bun/JSC.
Bun's immutable source archive, 21 pinned Git dependencies, 231 Cargo.lock
checksum-verified crates and Node API headers are retained. Its JSCOnly
WebKit build sources were retrieved through the official filtered Git
transport because the archive-creation endpoint is disabled. Every included
Git blob was verified at the fixed commit: JavaScriptCore, WTF, bmalloc,
ThirdParty, CMake, ICU patches and build tools/configuration. The separate
ICU 78.3 source archive matches WebKit's pinned Dockerfile checksum.
`source-status.json` and the bundle manifest record the exact scope; unrelated
web-browser implementation is outside the JSCOnly source archive. Keep
corresponding source materials with distributed releases.

Python includes pip and setuptools. Its pip configuration allows installation
into this disposable guest root; it does not change host Python. Installed
dependencies remain scoped to the run disk and are not silently written back.

Each rootfs includes `/usr/share/doc/rish-environment/sources.json` with the
package sources and licenses. Packages' own license/notice files are retained.
APK install triggers are not run; features that depend on generated files,
such as a Java certificate store, must be tested explicitly before claiming
network dependency-manager compatibility.

`resolve-locks.py` is a separate maintenance tool that reads and verifies
explicitly downloaded APKINDEX snapshots and emits candidate locks. Normal
builds never update locks or silently track latest tags. Review and verify
new whole-package hashes before accepting a lock refresh.

## Real execution and publishing

`smoke.py` requires an explicit current rish host library and controlled base
CPIO, clones the immutable disk, disables networking, applies host cancellation
and records boot/command timings, library/base/disk digests, output and exit
state. QEMU results do not count as current-rish or TestFlight evidence.

`package.py` validates the complete package by streaming: exact manifest keys,
limits, one gzip member, no trailing bytes, decoded size/SHA256 and ext4
geometry. `catalog.py` accepts explicit published HTTPS URLs and matching
successful execution evidence; it refuses an unverified disk. Publication is
performed separately after review of the actual artifacts.


## Go standard-library cache

The Go environment includes a verified cache for both CGO modes at the same
`GOCACHE=/tmp/go-build` path used by the native runner. This avoids recompiling
the complete standard library on the phone. The cache is derived from the
same official Linux/amd64 Go 1.25.10 toolchain in a network-disabled QEMU build
VM. QEMU is used only for cache generation and export, never as proof that a
user program runs under rish. Cached data outputs are SHA256-checked against
their Go content IDs; action-cache timestamps are normalized without changing
compiled output. The derived cache has its own locked size and SHA256.

For a clean build directory, generate it with:

```sh
python3 scripts/runtime-environments/build.py go --bootstrap-go-cache
python3 scripts/runtime-environments/warm-go-cache.py --base .build/runtime-environments/rish-runtime-base.cpio
python3 scripts/runtime-environments/export-go-cache.py
python3 scripts/runtime-environments/cache-go.py .build/runtime-environments/packages/go-cache-builder/cache-export.tar.disk
python3 scripts/runtime-environments/build.py go
```

The first command is an explicit bootstrap artifact, not a release candidate.
The cache builder has a 900-second host deadline. Export uses a dedicated
blank block disk and a read-only runtime disk, with no host directory sharing.
After packaging, the final cached disk must pass the real rish compile-and-run
smoke with the native runner's environment before becoming catalog-eligible.
