# OpenMinis mirror reference

The implementation was informed by a read-only shallow clone of
`OpenMinis/OpenMinis` at commit `09fc199`. OpenMinis is GPLv3; no source code or
UI assets were copied into `dsh-app`.

The reusable product facts were:

- separate Alpine APK, Python pip, and Node npm mirror categories;
- official and regional presets;
- bounded concurrent HEAD latency checks;
- explicit enable/disable state independent from the selected URL;
- writing package-manager-native configuration files; and
- restoring official sources when a mirror is disabled.

Rish adds behavior not present in the referenced screen:

- user-entered custom HTTPS base URLs;
- native validation that rejects credentials, query strings, fragments, and
  non-HTTPS schemes;
- explicit `local_substrate` disclosure when the persistent rish guest is not
  mounted;
- an atomic `rish-guest-overlay` staging receipt rather than claiming a live
  package manager was reconfigured; and
- typed bilingual React Native state with strict backwards-compatible
  persistence.

## Staged paths

The native adapter writes app-private files beneath
`Application Support/rish-guest-overlay/`:

| Category   | Guest-relative path    |
| ---------- | ---------------------- |
| Alpine APK | `etc/apk/repositories` |
| Python pip | `etc/pip/pip.conf`     |
| Node npm   | `root/.npmrc`          |

`mirrors.json` records the selected sources and `guest_runtime_mounted: false`.
Mounting and consuming this overlay is a future `local_harness`/persistent-guest
gate; the current UI must continue to say "staged" until that gate is real.
