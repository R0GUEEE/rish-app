# Rish Harness architecture

Rish is the product and local execution boundary. A Harness is an installable
agent implementation that declares what it needs and how Rish starts it. DSH is
the first built-in Harness.

## Manifest v1

Every Harness declares:

- stable id, name, version, and description;
- runtime kind: `native-adapter` or `rish-guest`;
- runtime entrypoint;
- capabilities such as chat, reasoning, images, tools, workspace, and guest
  execution;
- credential slots without credential values; and
- model catalog plus input modalities.

The typed contract is implemented in
`apps/mobile/src/harness/types.ts`. The registry rejects malformed ids,
duplicate Harness ids, empty entrypoints, and duplicate model ids.

## Built-in DSH adapter

`DshHarnessAdapter` owns the DeepSeek-specific credential and model transport.
The generic Rish runtime continues to own sessions, workspaces, proof,
package-mirror staging, and rish execution.

This is an intermediate split: `LocalRuntimeModule` still contains both proof
and the current DeepSeek transport for compatibility. It must be separated
into generic Rish runtime services and adapter-specific native modules before a
second Harness ships.

## Compatibility identifiers

The visible app name is `Rish`, but this migration intentionally retains:

- bundle id `dev.zseven.dsh.mobile`;
- Xcode module/target `DSHMobile`; and
- Keychain service `dev.zseven.dsh.mobile.credentials`.

Changing those identifiers immediately would orphan the installed Keychain
credential, sessions, workspaces, and runtime proof. A future migration should
first add a shared Keychain access group and one-time data-container migration,
then change package identifiers in a separate release.

## Remaining gate for arbitrary local Harnesses

The registry and UI accept multiple typed manifests, including `rish-guest`
entrypoints. User-imported manifests cannot execute yet because the persistent
rish guest and its signed-manifest loader are not mounted. Until then Rish must
show DSH as the only executable built-in Harness and must not imply that a
manifest information card is an installed runtime.
