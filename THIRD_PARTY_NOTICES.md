# Third-party notices

This file is a source-tree notice inventory for the current Rish App checkout.
It is not a complete SBOM and is not a legal conclusion about a future App
binary or guest distribution. It covers the fixed native libraries used by the
current iOS build and the directly declared npm packages whose lockfile
metadata and license files were available during this audit. Transitive npm
packages, CocoaPods, guest package closures, and any optional externally
downloaded CLI must be audited against the exact release candidate before
distribution.

The project source is licensed under the top-level [MIT License](LICENSE), with
copyright stated there as `2026 Rish contributors`. That project license does
not relicense third-party components, guest payloads, or brand/trademark assets.
The Rish MIT text below also preserves the pinned sibling Rish source's own
license record. The Podspec's MIT metadata does not replace these notices.

## Copied license texts

The exact upstream license files are kept under `third-party/licenses/`:

| Component | Version / source revision | License text | SHA-256 of copied text |
| --- | --- | --- | --- |
| Rish runtime/FFI | [`ZSeven-W/rish`](https://github.com/ZSeven-W/rish) commit `ef660dc81fa31cbe279b1f4ba355a97734ff1740` | [rish-MIT.txt](third-party/licenses/rish-MIT.txt), MIT | `7cfca0a2a21dc7b205a5c4289dc1605056280edb858e2ea5894d38efaa926f6d` |
| libgit2 | `1.9.6`, commit `26055f5af74ab1cf636d272e8a34315496d3f06f` | [libgit2-COPYING.txt](third-party/licenses/libgit2-COPYING.txt), GPLv2 plus the upstream linking exception | `e0938121c0554985fe17196ac38fc590d149268e9c46e0c0e7a2eae1354fae71` |
| libssh2 | `1.11.1`, commit `a312b43325e3383c865a87bb1d26cb52e3292641` | [libssh2-COPYING.txt](third-party/licenses/libssh2-COPYING.txt), BSD-3-Clause | `f7f9633cf9ff2f1333f3d7ce46973a8716a4d2a2815ad56f30d437d5fea7bafe` |
| OpenSSL | `3.6.2`, commit `fe686e15d84334b284f883118ed92f64b409b3aa` | [openssl-Apache-2.0.txt](third-party/licenses/openssl-Apache-2.0.txt), Apache-2.0 | `7d5450cb2d142651b8afa315b5f238efc805dad827d91ba367d8516bc9d49e7a` |

The fixed native build metadata is in `modules/rish/ios/Vendor/*.version`.
The generated `libgit2`, `libssh2`, and `libcrypto` XCFramework archives are
ignored build outputs; their source revision, configuration, architecture, and
archive hashes are recorded there rather than copied into this source tree.

## Direct npm dependencies

The following direct runtime dependencies are pinned by
`apps/mobile/package-lock.json` at the versions shown. Their exact package
license files are copied under `third-party/licenses/`:

| Package | Locked version / source URL | Declared license | License text / copied-text SHA-256 |
| --- | --- | --- | --- |
| `react` | `19.2.3`; [facebook/react](https://github.com/facebook/react.git) | MIT | [react-MIT.txt](third-party/licenses/react-MIT.txt); `da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93` |
| `react-native` | `0.87.0`; [react/react-native](https://github.com/react/react-native.git) | MIT | [react-native-MIT.txt](third-party/licenses/react-native-MIT.txt); `da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93` |
| `react-native-safe-area-context` | `5.9.1`; [AppAndFlow/react-native-safe-area-context](https://github.com/AppAndFlow/react-native-safe-area-context.git) | MIT | [react-native-safe-area-context-MIT.txt](third-party/licenses/react-native-safe-area-context-MIT.txt); `f5c7a4d527258e11fdfe3d84eb73cd14fe6d64224ef051e59f6ee21fe378800c` |
| `react-native-svg` | `15.15.5`; [software-mansion/react-native-svg](https://github.com/software-mansion/react-native-svg) | MIT | [react-native-svg-MIT.txt](third-party/licenses/react-native-svg-MIT.txt); `1bc2aa7dad15097cd71308d9ae013ff14d11a84357b170c1554f4035fb8a3acb` |
| `lucide-react-native` | `1.34.0`; [lucide-icons/lucide](https://github.com/lucide-icons/lucide.git) | ISC | [lucide-react-native-ISC.txt](third-party/licenses/lucide-react-native-ISC.txt); `b495047bd93a9b06913511076f504daba17d5bbeb3e0650f3bb53a4220329c57` |

The lockfile contains 879 package entries; 877 carry a license field. The
remaining transitive entries with missing fields and all other non-MIT license
families require candidate-level review. This table does not claim that the
five direct packages exhaust the JavaScript or native dependency graph.

## Guest and optional runtime boundary

The app tracks a kernel and CPIO guest payload under
`apps/mobile/ios/Rish/GuestAssets/`, with `SHA256SUMS` for the exact bytes.
The pinned sibling Rish source provides the guest provenance and license
correspondence in
[`guest/x86_64/SOURCES-AND-LICENSES.md`](https://github.com/ZSeven-W/rish/blob/ef660dc81fa31cbe279b1f4ba355a97734ff1740/guest/x86_64/SOURCES-AND-LICENSES.md)
and its `assets.lock.tsv`/build recipes. The exact App hashes are paired with
the verified member mapping, Alpine package records, source lock, and guest
license texts in [`third-party/guest/`](third-party/guest/PROVENANCE.md).
The currently tracked values are CPIO SHA-256
`152905238ade87b7e1cd495508ff1bb92807b4440cc0ed056030e4dfd72caea0` and
kernel SHA-256
`1e6bf9027720c75c3ed0d79171f21b5791ee40ca9795d07c7c6e04dc5ea2ae90`, both
verified against the adjacent `SHA256SUMS` file.
The CPIO includes BusyBox, musl, apk/libapk, OpenSSL/zlib and the pinned
musl/tree APK inputs. A local corresponding-source handoff was also prepared
for review, but has not been uploaded or published; its local-only status does
not constitute a written offer. The guest directory records the source
coverage and the remaining release decisions without claiming a complete SBOM
for unrelated future payloads.

For source-release readiness, the bounded guest source set and notices are
prepared locally in the corresponding-source handoff, but that archive has
not been uploaded or made publicly available. A release owner still needs to
choose the public source-hosting or offer mechanism. Binary-release optional
exclusions remain the separately downloaded official CLI experiments and the
unresolved full CocoaPods/transitive dependency notice report; neither is
silently represented by this guest inventory.

Official Codex and Claude CLI binaries are not tracked in this repository. If a
future installer or release downloads or redistributes them, their exact
source, version, hash, terms and user-facing boundary must be reviewed
separately. No closed-source CLI authorization is asserted here.

## CocoaPods and other scope limits

`apps/mobile/ios/Podfile.lock` is tracked and fixes the React Native dependency
graph, but the Pods sources and complete license set are not tracked. This
notice file therefore does not claim to cover every Pod. The release owner
should generate a license report from the exact clean checkout and resolved
Pods before public distribution.

No API keys, private keys, passwords, credential-bearing URLs, or user data are
included in these notices. This file and the copied texts are source-release
materials only; they do not authorize a commit, push, repository visibility
change, binary release, or product claim.
