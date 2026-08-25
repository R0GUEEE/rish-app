# Local Git engine

Rish uses a host-native libgit2 engine for the first local project vertical
slice. It does not shell out to macOS `git`, a local proxy, or a remote wrapper.

## Build provenance

- libgit2: `1.9.6`
- pinned commit: `26055f5af74ab1cf636d272e8a34315496d3f06f`
- HTTPS backend: Apple SecureTransport
- slices: iOS arm64 and iOS Simulator arm64
- SSH, GSSAPI, NTLM, and iconv are disabled
- zlib, HTTP parser, regex, and xdiff are bundled by the pinned source build

Run `scripts/prepare-libgit2-ios.sh` after installing CMake 3.24 or newer. The
script checks the origin and exact commit, builds both slices, checks Mach-O
platform values and required symbols, then creates
`modules/rish/ios/Vendor/libgit2.xcframework`. Generated binaries are ignored;
`Vendor/libgit2.version` is the reviewable provenance record.

## Native API

`LocalProjects` exposes list, create, public HTTPS clone, status, staged and
unstaged diff, stage-all, commit, set-origin, native credential prompt,
credential clear/status, and non-force push. JavaScript receives only opaque
project IDs and workspace-relative paths such as
`projects/<opaque-id>/repo`; absolute container paths are never returned.

Repositories are always rooted at:

`Application Support/workspace/projects/<opaque-id>/repo`

Clone uses a sibling staging directory and publishes it with one same-volume
rename only after checkout validation. The initial implementation rejects
symlinks, gitlinks/submodules, `.gitmodules`, unsafe paths, and oversized tree
enumerations because the current workspace API cannot safely represent those
repositories.

## Network and credential boundary

- Remote URLs must be HTTPS DNS names with no userinfo, query, fragment, IP
  literal, local hostname, or non-443 custom port.
- libgit2 redirects and proxy discovery are disabled for clone and push.
- Clone is intentionally public-only and its credential callback always
  rejects authentication requests.
- Push refspecs are constructed by native code without the force (`+`) marker.
- Username and PAT are entered in a native alert and stored as a Generic
  Password with `WhenUnlockedThisDeviceOnly`; the PAT is never returned to JS
  or written to Git config, a remote URL, project metadata, or logs.
- Credentials are keyed by HTTPS host in v1. Multiple accounts on the same host
  are not yet supported.
- libgit2 error details are not surfaced across the bridge because they may
  contain a URL, local container path, or server-provided text.

## Current limits

This slice does not yet include pull/fetch, conflict resolution, repository
deletion, background transfer/cancellation, OAuth, SSH, multiple accounts per
host, submodules, or symlink-capable file management. Private clone is also not
enabled; credentials are currently used only for push.
