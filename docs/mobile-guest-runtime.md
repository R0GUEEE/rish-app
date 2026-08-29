# Mobile guest runtime: persistent rish guest in DSHMobile

Status: **first vertical slice, verified on the iOS simulator.** A real rish
guest now boots inside the app process, runs commands over a persistent
session, and installs packages from the build-time-baked offline apk
repository. Staged mirror configuration still cannot enter the guest.

## What this round wired (proven end to end)

1. **Bundle assets.** The rish kernel and container initramfs are bundled with
   DSHMobile as resources (`apps/mobile/ios/DSHMobile/GuestAssets/`):

   | resource | bytes | sha256 |
   |---|---|---|
   | `vmlinuz-virt-6.18.35` | 12,575,744 | `1e6bf9027720c75c3ed0d79171f21b5791ee40ca9795d07c7c6e04dc5ea2ae90` |
   | `rish-container.cpio` | 9,835,008 | `152905238ade87b7e1cd495508ff1bb92807b4440cc0ed056030e4dfd72caea0` |

   Total raw delta: **22,410,752 bytes (~21.4 MiB)** added to the app bundle.
   The digests are recorded in `GuestAssets/SHA256SUMS` (verify with
   `shasum -a 256 -c SHA256SUMS` from that directory); `LocalGuestModule`
   re-checks both digests at every boot and fails closed with
   `E_GUEST_ASSET_INTEGRITY` on mismatch. Shipping ~21.4 MiB in the bundle
   was accepted for this round; an on-demand download of the assets is a
   possible later product decision and was deliberately not implemented.

2. **`LocalGuestModule`** (`modules/rish/ios/Sources/LocalGuestModule.mm`)
   exposes `bootGuest` / `guestExec` / `shutdownGuest` to React Native
   and a typed bridge (`apps/mobile/src/native/LocalGuest.ts`). See the
   module header for the full contract; the essentials:

   - a serial state queue owns the single opaque session handle; the blocking
     ~40 s FFI boot runs on a dedicated worker queue, never the main thread;
   - single-session, fail-closed: a second boot rejects with
     `E_GUEST_ALREADY_BOOTED` (or `E_GUEST_BOOT_IN_PROGRESS` during a
     boot); exec before boot rejects with `E_GUEST_NOT_BOOTED`;
   - every Rust-owned string is released with `rish_string_free` and the
     handle is released exactly once with `rish_vm_session_free` (shutdown,
     boot cancellation, or dealloc — no leak path);
   - input validation fail-closed: the exec envelope must be exactly
     `{schema_version: 1, command: [argv...]}` with 1–64 non-empty string
     arguments, each ≤ 4096 UTF-8 bytes, ≤ 65,536 bytes total, no embedded
     NULs; boot accepts only `{schema_version: 1, memory_mib: 256…4096}`;
   - receipts never return absolute container paths to JavaScript (boot
     reports bundle-relative resource names only).

3. **Proof test.** `DSHMobileTests/LocalGuestModuleTests.mm` boots the real
   guest in the app process on the simulator and asserts the full chain:
   boot → `apk add tree` with `exit_code == 0` → the installed
   `/usr/bin/tree` runs and reports v2.3.2 → shutdown → exec fails closed.
   No mocks are involved. The test raises `executionTimeAllowance` because
   the boot takes ~40 s.

## What this round did NOT wire (fail-closed, unchanged)

1. **Staged mirror configuration still cannot enter the guest.** The
   pure-Rust interpreter emulates no virtio-blk, so there is no block-device
   injection path: `LocalMirrorsModule` keeps writing
   `Application Support/rish-guest-overlay/` (staged), but nothing inside
   the guest ever reads those files. The guest uses the offline repository
   baked into the initramfs at build time (`/opt/rish-apk-repo/main`,
   `file://` repositories). The receipt now carries two honest fields:
   `guest_runtime_mounted` (true only while a `LocalGuestModule` session
   is genuinely booted in this process) and `staged_config_enters_guest:
   false`. No field or copy claims that a user-configured mirror source is
   in effect inside the guest.
2. **No network in the guest.** The interpreter has no virtio-net/NAT/DNS;
   remote mirrors, `apk update`, or any URL access from inside the guest is
   impossible today.
3. **No persistence.** The initramfs root lives in RAM; installed packages
   (including `tree`) vanish on the next boot. Each session starts from the
   baked image.
4. **`boot_units` is not part of the boot receipt.** The session FFI returns
   only an opaque handle; the boot instruction count rides along on every
   exec reply instead (the exec receipt carries `boot_units`). Boot
   duration is reported as wall-clock `boot_ms`.
5. **Device (真机) not verified.** The simulator-only FFI slice was exercised
   (arm64-simulator); a physical-device boot is untested this round.
6. **App-lifecycle policy is undefined.** Backgrounding a booted session
   (suspend/resume behavior) is not yet specified or handled.

## Verification record

- TS (`apps/mobile`): `npx jest` 814/814, `npx tsc --noEmit` 0 errors,
  `npx eslint .` 0 errors (2 pre-existing no-bitwise warnings in
  `src/agent/AgentTools.ts`).
- Native: the full `DSHMobileTests` bundle ran on the booted iPhone 17 Pro
  simulator — **306/306 passed, 0 failures** (baseline 299 + 7 new
  `LocalGuestModuleTests`). The real-boot test alone took 81.3 s.
- Execution path: plain `xcodebuild test` cannot launch tests in this
  session's sandbox — the default DerivedData arena is unwritable and, with
  `-derivedDataPath build/DerivedData`, the test launcher dies with
  `Pseudo Terminal Setup Error` (sandboxed pty allocation). The tests were
  therefore executed through the documented equivalent path:
  `xcodebuild` produced the real build-for-testing artifacts, then
  `simctl install` + `simctl launch` injected
  `libXCTestBundleInject.dylib` with `XCTestBundlePath` pointing at the
  embedded `DSHMobileTests.xctest` — the same host app and test bundle,
  really executed on the simulator, not mocked. (The launch prints one
  transient `_Testing_Foundation` dlopen note from the Swift Testing
  adapter; classic XCTest still discovered and ran all 306 tests.)

### Real guest boot output (in-app process, simulator)

Boot receipt, logged by the module inside the app process (boot wall time
42.9 s):

```
status = booted; boot_ms = 42911; memory_mib = 1024
kernel = vmlinuz-virt-6.18.35 (sha256 1e6bf902…5ea2ae90)
initramfs = rish-container.cpio (sha256 15290523…72caea0)
```

`apk add tree` over the live session — raw output, exit code 0,
boot_units 1,197,000,000 (identical to the rish repo build record):

```
GUEST_APK_ADD_EXIT=0 BOOT_UNITS=1197000000
(1/2) Installing musl (1.2.6-r2)
(2/2) Installing tree (2.3.2-r0)
OK: 743736 B in 2 packages
(stderr empty)
```

The installed `/usr/bin/tree --version` then ran in the same session with
exit code 0 and reported `tree v2.3.2` (asserted in the test).

### Bundle size

Measured on the built simulator app: `DSHMobile.app` is 78,772 KB in total
with the two guest assets inside it; the assets themselves are the full
22,410,752-byte delta (~21.4 MiB, copied verbatim, no processing).

See `docs/guest-mount-spike.md` for the earlier feasibility spike and
`docs/mobile-git-acceptance.md` for the repo-side integration precedents.
