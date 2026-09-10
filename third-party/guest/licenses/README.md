# Guest license and source references

These references apply only to the tracked GuestAssets payload. They are
paired with `../manifest.tsv` and the package records in
`../minirootfs-packages.tsv`; the App's top-level notice inventory remains the
release owner's integration point.

## Notice text already present in this source tree

- The rish overlay, guest-agent source, packer, and build scripts are covered
  by the sibling runtime's MIT license. The copied text is
  [`../../licenses/rish-MIT.txt`](../../licenses/rish-MIT.txt).
- The Alpine `libssl3` and `libcrypto3` package metadata declares Apache-2.0.
  The Apache 2.0 text already copied for the OpenSSL dependency is
  [`../../licenses/openssl-Apache-2.0.txt`](../../licenses/openssl-Apache-2.0.txt).
  The Alpine package version and APK metadata commit remain authoritative for
  the exact guest libraries. Its SHA-256
  `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a`
  matches OpenSSL 3.5.7's `LICENSE.txt`; this file does not reattribute the
  guest libraries to the iOS OpenSSL build.
- The canonical GPL-2.0 text is copied as [`GPL-2.0-only.txt`](GPL-2.0-only.txt)
  (SHA-256 `4f2416509c30c4f0c4de101cc30c571e3be33fdb5c42cabc0d2915e8ed5ea51e`).
  It is also the base text for the tree package's GPL-2.0-or-later grant; the
  tree source notice must retain its own "or later" wording.
- The canonical MIT and zlib texts are copied as [`MIT.txt`](MIT.txt) (SHA-256
  `b85dcd3e453d05982552c52b5fc9e0bdd6d23c6f8e844b984a88af32570b0cc0`) and
  [`Zlib.txt`](Zlib.txt) (SHA-256
  `5770c9eccc9c51b6253165bc93aea3893083aeba913280440adb4e27c91e3e5a`).
- The exact BusyBox and apk-tools source distributions include the GPL notice
  files copied as [`busybox-LICENSE.txt`](busybox-LICENSE.txt) (SHA-256
  `408e6fdbbb084b54aadab5a73327b0cb9f2aabebf198f3606fed0a4ce24adfef`) and
  [`apk-tools-LICENSE.txt`](apk-tools-LICENSE.txt) (SHA-256
  `57c7b0068d2a40edaa8d1f283ab31203c8ff4613eab331b9c6f6cdcb482d4516`).
  BusyBox's copied file explicitly selects GPL version 2 only, which is the
  license shown for the package metadata.
- The exact musl, tree, and zlib source notice files are copied as
  [`musl-COPYRIGHT.txt`](musl-COPYRIGHT.txt) (SHA-256
  `7f26933ec44f09fcb51ef4848967f29b14aee611eac057f7a3ba9a03215d2935`),
  [`tree-LICENSE.txt`](tree-LICENSE.txt) (SHA-256
  `95c19cdb42f59f3e7be8fbb5d74b53c6721b334cac922df7205245df49aa9bef`), and
  [`zlib-LICENSE.txt`](zlib-LICENSE.txt) (SHA-256
  `e589b065d0b2f203584be60fed4839f7d3f6be99a6862b0c8928940b78b44d11`).
- The Linux `Linux-syscall-note` exception text is copied as
  [`Linux-syscall-note.txt`](Linux-syscall-note.txt) (SHA-256
  `a4e320e33e8d4b1540eb46ccfed47621b670ea0b0acd34b7dce9d1921d69adf0`).

## Guest-agent Rust crates

The guest-agent's target-resolved Rust crates and their Cargo.lock checksums,
roles, source URLs, and license choices are recorded in
[`../rust-dependencies.tsv`](../rust-dependencies.tsv). The `rust-*` files in
this directory were taken from the exact crates.io archives named there and
preserve the crate-provided MIT, Apache-2.0, LLVM-exception, Unlicense, and
Unicode notice texts. Proc-macro licenses are included because they are needed
to rebuild the agent, while dev-only and target-excluded crates are explicitly
marked in the manifest. Rust standard-library copyright and Apache/MIT notices
are copied in the `rust-std-*` files and indexed by
[`rust-std-license-reference.md`](rust-std-license-reference.md); the compiler
toolchain itself is not redistributed.

## Guest package notices and corresponding source

The payload includes BusyBox 1.37.0-r31 (GPL-2.0-only), apk-tools/libapk
3.0.6-r0 (GPL-2.0-only), musl 1.2.6-r2 (MIT), zlib 1.3.2-r0 (Zlib), Alpine
signing keys (MIT), and tree 2.3.2-r0 (GPL-2.0-or-later). Their exact APK
metadata, upstream project URLs, package revisions, and hashes are in the
two manifest files above. Canonical license texts are available from the
SPDX project:

- <https://spdx.org/licenses/GPL-2.0-only.html>
- <https://spdx.org/licenses/GPL-2.0-or-later.html>
- <https://spdx.org/licenses/MIT.html>
- <https://spdx.org/licenses/Zlib.html>

The Alpine package records also identify the upstream package URLs and `c:`
commit fields. The source corresponding to the exact package bytes must be
offered from those upstream projects or mirrored before a public binary
release; this directory does not claim that a license identifier alone
fulfills that step. No App-local patch files were found for these packages.
The Linux kernel's exact Alpine APKBUILD source, commit, and SHA-256 are
recorded in `../PROVENANCE.md`.
