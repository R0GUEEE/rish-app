# Contributing to Rish App

This is a draft contribution guide for the source repository. Rish App source
is licensed under the [MIT License](LICENSE). No contributor agreement is
currently declared; the owner may choose whether one is needed.

## Before changing code

Use a clean checkout and keep credentials, Keychain values, private keys,
provider tokens, and generated app data outside the repository. Do not add
secrets to source, fixtures, logs, README files, environment files, or app
bundles.

The mobile app requires Node 22.11 or newer. The default iOS preparation
script fetches the pinned `rish` source over HTTPS into an isolated temporary
checkout and downloads missing Cargo dependencies using the verified lockfile
with `--locked`; compilation remains `--frozen`. A reviewed source checkout
may be selected with `RISH_SOURCE_DIR` or the script's explicit path argument.
`RISH_IOS_OFFLINE=1` requires that checkout, the installed pinned Rust toolchain
and targets, and a populated Cargo cache; it disables the Rish source fetch
and puts Cargo dependency preparation in offline mode. It does not put npm,
CocoaPods, or the other dependency preparation scripts in offline mode.
iOS native and guest work also requires Rust/Cargo, Xcode command-line tools,
CocoaPods, Perl, `make`, CMake, and the tools described by the preparation
scripts. CMake must be on `PATH`,
or can be selected with `CMAKE_BIN=/absolute/path/to/cmake`. Generated
`.build`, Pods, Vendor archives, and signed products are local build inputs and
should not be submitted as source changes.

## Local checks

From the repository root:

```sh
node scripts/verify-source-checkout.mjs
cd apps/mobile
npm ci
npm run typecheck
npm run lint
npm test -- --runInBand
```

The source preflight checks file layout, portable build references, native
entry points, and the npm lockfile without network access. Passing it does not
prove that native dependencies are prepared or that an app build succeeds.

For every iOS build, including Metro development, follow the root README and
run `prepare-rish-ios.sh` followed by `prepare-libgit2-ios.sh` from a clean
checkout before `pod install`. The libgit2 script invokes the libssh2 and
OpenSSL helpers itself; there is no separate manual dependency sequence.
Before sharing a source tree or bundle, run the repository's value-free
secret scan:

```sh
cd ../..
ruby scripts/verify-no-bundled-secret.rb
```

The current checks are maintainer guidance rather than a promise that every
platform or product feature is complete. Android local runtime, full
`local_harness`, and App Store distribution have separate status boundaries.

## Changes and review

Keep changes focused, describe the user-visible or runtime effect, and include
the exact checks and environment used. Do not claim a simulator result as a
physical-device or complete-product result. Changes to bundled guest assets,
third-party dependencies, generated Vendor archives, or release metadata need
the corresponding source, hash, license, and provenance review before release.

The public contribution workflow, issue templates, review rules, and release
branch policy remain to be established by the repository owner. A contributor
agreement is optional owner policy and is not currently declared.
