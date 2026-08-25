# Rish App repository design

## Decision

Create `ZSeven-W/rish-app` as a private GitHub repository. Keep the local
checkout at `/Users/fini/workspace/z-seven/dsh-app` and use `main` as the
default branch.

The existing public `ZSeven-W/rish` repository remains the independent Rust
runtime project. The app and runtime stay separate so they can use different
visibility, release, review, and compatibility policies.

## Initial baseline

The first commit contains the React Native app, native iOS modules, Android UI
shell, product documentation, brand assets, preparation scripts, lockfiles,
and tests. It excludes generated builds, dependency directories, CocoaPods,
local Bundler state, generated XCFrameworks, static archives, and generated
rish headers.

Before pushing the baseline:

1. Run TypeScript, ESLint, and the complete Jest suite.
2. Run the source secret scanner.
3. Inspect every staged path and reject unexpected generated or oversized
   files.
4. Run Git whitespace validation.

## Remote contract

- Owner: `ZSeven-W`
- Repository: `rish-app`
- Visibility: private
- Default branch: `main`
- Git transport: SSH
- Initial description: local-first mobile runtime for running Harnesses
  on-device

Completion requires independent verification of the GitHub visibility, the
remote `main` commit, the configured `origin`, and a clean local worktree.
