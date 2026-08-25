# Mobile Git acceptance contract

Rish may claim a local Git workflow only when the repository, index, objects,
worktree edits, commits, and network transfer all execute inside the mobile app
process and its app container. A Mac Git subprocess or remote shell is not
acceptable evidence.

## Version 1 scope

- Projects live under an opaque native project id.
- Native code maps the id to
  `Application Support/workspace/projects/<id>/repo`.
- React Native and Harnesses never receive an absolute app-container path.
- Supported Git operations are create, public HTTPS clone, status, unified
  diff, stage all, commit, configure `origin`, and non-force push.
- Project files can be imported from and exported to the iOS Files app through
  `UIDocumentPicker`. External provider URLs and security-scoped bookmarks are
  consumed only by native code and are never returned to React Native.
- HTTPS credentials stay in
  `WhenUnlockedThisDeviceOnly` Keychain storage. Tokens never enter
  JavaScript, repository URLs, `.git/config`, session JSON, logs, proof files,
  or tool results.
- Version 1 does not support SSH, LFS, submodules, signed commits, rebase,
  merge, or force push.

## Required safety behavior

1. Project paths are native-resolved and reject traversal, absolute paths,
   reserved metadata, and cross-project access.
2. The normal file API hides and rejects every `.git` component.
3. Clone writes to a private staging directory and atomically publishes only a
   complete checkout.
4. Remote URLs require credential-free HTTPS, a DNS host, and no query,
   fragment, userinfo, or cross-origin redirect.
5. Commit and push require explicit user confirmation. Push shows the host,
   owner/repository, branch, and outgoing commit count. Force push is rejected.
6. Non-fast-forward, revoked credentials, TLS failure, cancellation, offline,
   disk-full, oversized diff, symlink, and malformed repository states return
   structured failures without corrupting the project.
7. Files imports reject traversal, symlinks, reserved Git metadata, duplicate
   top-level names, oversized selections, and collisions. Files exports stage a
   sanitized copy and omit Git metadata.

## Evidence levels

### G1 — deterministic local fixture

- Create a project.
- Write at least two files through the app file API.
- Verify status and unified diff.
- Stage and commit.
- Restart the app and verify the same branch, HEAD OID, clean status, and file
  hashes.
- Export one committed file to iOS Files, import it into a different project
  subdirectory, and verify identical content hashes.

### G2 — remote HTTPS service

- Clone a public repository without credentials.
- Configure a dedicated test remote.
- Provision a least-privilege, expiring token through the native prompt.
- Push a new branch.
- Verify with an independent client that remote OID and file hashes equal the
  mobile receipts.
- Create a competing remote commit and prove the mobile push fails as
  non-fast-forward without rewriting history.

### G3 — physical iPhone

Repeat G1 and G2 on a signed Release build installed on a physical iPhone.
Terminate the process after editing and after committing, then verify recovery.
Simulator-only evidence cannot satisfy G3.

## Evidence recorded on 2026-08-24

- An iPhone 17 Pro Simulator Release build created an isolated `main` project.
- The app wrote `proof.txt`, exported it to **On My iPhone**, imported it back
  into `imports/`, and read identical content from the imported copy.
- Native Git reported two untracked files, produced their real unified diff,
  staged both, and committed them as
  `9d01727e6baf1b5c2eaf5c085847b36c7a8900ab`.
- After forced process termination and relaunch, the same project reopened on
  `main` with a clean worktree. An independent host-side read of the Simulator
  app container confirmed the same HEAD and identical SHA-256 hashes for both
  copies.
- The app cloned `https://github.com/octocat/Hello-World.git` through native
  libgit2. An independent check confirmed `origin`, a clean `master`, and HEAD
  `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d`.
- Simulator and unsigned generic iPhone arm64 Release builds linked both pinned
  XCFramework slices. No physical iPhone was available, so this is G1 plus the
  public-clone portion of G2, not G3 and not yet a remote-push claim.

## Separate execution claim

A successful Git push proves local source-control capability. It does not prove
that compilers, package managers, tests, or an arbitrary Harness execute on the
phone. Those require a separately mounted and verified guest/tool runtime.
