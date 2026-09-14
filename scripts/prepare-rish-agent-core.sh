#!/bin/zsh
# Builds the shared Rust agent core (modules/rish/core) for iOS device and
# simulator and stages it as modules/rish/ios/Vendor/rish_agent_core.xcframework
# for the RishLocalRuntime pod. Run before `pod install`, next to
# prepare-rish-ios.sh. Requires the workspace toolchain (rust-toolchain.toml)
# with the aarch64-apple-ios and aarch64-apple-ios-sim targets installed; this
# script never installs toolchains or targets itself.
set -euo pipefail

readonly SCRIPT_DIR=${0:A:h}
readonly REPO_ROOT=${SCRIPT_DIR:h}
readonly CORE_ROOT=${REPO_ROOT}/modules/rish/core
readonly MODULE_ROOT=${REPO_ROOT}/modules/rish/ios
readonly VENDOR_ROOT=${MODULE_ROOT}/Vendor
readonly OUTPUT=${VENDOR_ROOT}/rish_agent_core.xcframework
readonly HEADER_DIR=${CORE_ROOT}/include
readonly LIBRARY_NAME=librish_agent_ffi.a
readonly DEVICE_TARGET="aarch64-apple-ios"
readonly SIMULATOR_TARGET="aarch64-apple-ios-sim"
readonly IOS_DEPLOYMENT_TARGET="15.1"

fail() {
  print -u2 -- "prepare-rish-agent-core: $*"
  exit 1
}

command -v cargo >/dev/null || fail "cargo is required"
command -v rustup >/dev/null || fail "rustup is required"
command -v xcodebuild >/dev/null || fail "xcodebuild is required"

toolchain=$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "${CORE_ROOT}/rust-toolchain.toml")
[[ -n "${toolchain}" ]] || fail "rust-toolchain.toml names no channel"
for target in "${DEVICE_TARGET}" "${SIMULATOR_TARGET}"; do
  rustup target list --installed --toolchain "${toolchain}" |
    /usr/bin/grep -x "${target}" >/dev/null ||
    fail "Rust target ${target} is not installed for toolchain ${toolchain}; install it with: rustup target add --toolchain ${toolchain} ${target}"
done

export IPHONEOS_DEPLOYMENT_TARGET="${IOS_DEPLOYMENT_TARGET}"
export RISH_AGENT_CORE_GIT_SHA="$(git -C "${REPO_ROOT}" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)$(git -C "${REPO_ROOT}" diff --quiet -- modules/rish/core 2>/dev/null || echo -dirty)"
for target in "${DEVICE_TARGET}" "${SIMULATOR_TARGET}"; do
  (cd "${CORE_ROOT}" && cargo "+${toolchain}" build --release --locked \
      --package rish-agent-ffi --target "${target}") ||
    fail "cargo build failed for ${target}"
  [[ -f "${CORE_ROOT}/target/${target}/release/${LIBRARY_NAME}" ]] ||
    fail "no ${LIBRARY_NAME} for ${target}"
done

staging=$(mktemp -d "${TMPDIR:-/tmp}/rish-agent-core.XXXXXX")
trap '/bin/rm -rf -- "${staging}"' EXIT
xcodebuild -create-xcframework \
  -library "${CORE_ROOT}/target/${DEVICE_TARGET}/release/${LIBRARY_NAME}" -headers "${HEADER_DIR}" \
  -library "${CORE_ROOT}/target/${SIMULATOR_TARGET}/release/${LIBRARY_NAME}" -headers "${HEADER_DIR}" \
  -output "${staging}/rish_agent_core.xcframework" >/dev/null ||
  fail "xcodebuild -create-xcframework failed"

/bin/mkdir -p "${VENDOR_ROOT}"
/bin/rm -rf -- "${OUTPUT}"
/bin/mv "${staging}/rish_agent_core.xcframework" "${OUTPUT}"
version=$(cd "${CORE_ROOT}" && git rev-parse --short HEAD 2>/dev/null || print unknown)
print -- "rish-agent-core ${version} (${toolchain})" > "${VENDOR_ROOT}/rish_agent_core.version"
print -- "prepare-rish-agent-core: staged ${OUTPUT}"
