#!/bin/zsh
set -euo pipefail

# Package user-supplied, already verified Codex device-auth inputs for the
# phone-local harness. This script intentionally performs no downloads and
# never accepts tokens, account files, or an OAuth exchange as input.
readonly SCRIPT_DIR=${0:A:h}
readonly APP_ROOT=${SCRIPT_DIR:h}
readonly OUTPUT_DIR=${APP_ROOT}/apps/mobile/ios/Rish/HarnessAuth
readonly MODULE_VENDOR_DIR=${APP_ROOT}/modules/rish/ios/Vendor
readonly AUTH_FRAMEWORK_LINK=${MODULE_VENDOR_DIR}/rish_ffi-harness-auth.xcframework
readonly SOURCE_DIR=${1:-${RISH_IOS_HARNESS_AUTH_SOURCE:-}}
readonly RISH_FRAMEWORK=${RISH_IOS_HARNESS_AUTH_RISH_XCFRAMEWORK:-${SOURCE_DIR}/PatchedRish.xcframework}

fail() {
  print -u2 -- "prepare-ios-harness-auth: $*"
  exit 1
}

[[ -n "${SOURCE_DIR}" ]] || fail "usage: $0 /path/to/verified/official-cli-assets"
[[ -d "${SOURCE_DIR}" ]] || fail "source directory does not exist: ${SOURCE_DIR}"
command -v shasum >/dev/null 2>&1 || fail "shasum is required"
command -v jq >/dev/null 2>&1 || fail "jq is required"
command -v plutil >/dev/null 2>&1 || fail "plutil is required"
command -v xcrun >/dev/null 2>&1 || fail "xcrun is required"
[[ -d "${RISH_FRAMEWORK}/ios-arm64" && -f "${RISH_FRAMEWORK}/Info.plist" ]] || \
  fail "patched device-only rish_ffi.xcframework is missing: ${RISH_FRAMEWORK}"
plutil -p "${RISH_FRAMEWORK}/Info.plist" | rg -q '"LibraryIdentifier" => "ios-arm64"' || \
  fail "patched framework does not declare an ios-arm64 slice"
xcrun nm -gU "${RISH_FRAMEWORK}/ios-arm64/librish_ffi.a" 2>/dev/null | \
  rg '_rish_vm_session_exec_stream_json' >/dev/null || \
  fail "patched device framework lacks rish_vm_session_exec_stream_json"

# CocoaPods rejects absolute vendored-framework paths. Keep the reviewed
# framework outside the source tree and expose only a temporary, untracked
# symlink inside the pod while the device-only install runs.
/bin/ln -sfn -- "${RISH_FRAMEWORK}" "${AUTH_FRAMEWORK_LINK}"

for asset in kernel codex.cpio; do
  [[ -f "${SOURCE_DIR}/${asset}" ]] || fail "missing ${asset}"
  [[ -f "${SOURCE_DIR}/${asset}.sha256" ]] || \
    fail "missing ${asset}.sha256 (the reviewed digest is required)"
  expected=$(<"${SOURCE_DIR}/${asset}.sha256")
  expected=${expected%%[[:space:]]*}
  [[ "${expected}" =~ '^[0-9a-f]{64}$' ]] || fail "invalid ${asset}.sha256"
  actual=$(/usr/bin/shasum -a 256 "${SOURCE_DIR}/${asset}" | /usr/bin/awk '{print $1}')
  [[ "${actual}" == "${expected}" ]] || fail "${asset} digest does not match reviewed sidecar"
done
[[ -f "${SOURCE_DIR}/codex.version" ]] || \
    fail "missing codex.version (the reviewed CLI version is required)"
version=$(<"${SOURCE_DIR}/codex.version")
  [[ "${version}" != *$'\n'* && "${version}" != *$'\r'* && \
      ${#version} -gt 0 && ${#version} -le 64 ]] || \
    fail "invalid codex.version"

/bin/mkdir -p -- "${OUTPUT_DIR}"
/usr/bin/install -m 0644 -- "${SOURCE_DIR}/kernel" "${OUTPUT_DIR}/kernel"
/usr/bin/install -m 0644 -- "${SOURCE_DIR}/codex.cpio" "${OUTPUT_DIR}/codex.cpio"
kernel_sha=$(/usr/bin/shasum -a 256 "${OUTPUT_DIR}/kernel" | /usr/bin/awk '{print $1}')
initrd_sha=$(/usr/bin/shasum -a 256 "${OUTPUT_DIR}/codex.cpio" | /usr/bin/awk '{print $1}')
codex_version=${version}
tmp_manifest=$(mktemp "${OUTPUT_DIR}/HarnessAuthAssets.XXXXXX.json")
trap '/bin/rm -f -- "${tmp_manifest}"' EXIT
jq -n --arg cv "${codex_version}" --arg ks "${kernel_sha}" --arg is "${initrd_sha}" \
  '{schema_version:1,harnesses:{codex:{kernel_resource:"HarnessAuth/kernel",initrd_resource:"HarnessAuth/codex.cpio",version:$cv,kernel_sha256:$ks,initrd_sha256:$is}}}' \
  > "${tmp_manifest}"
/bin/mv -f -- "${tmp_manifest}" "${OUTPUT_DIR}/HarnessAuthAssets.json"
/bin/chmod 0644 -- "${OUTPUT_DIR}/HarnessAuthAssets.json"
trap - EXIT
print -- "Prepared official CLI assets and a digest manifest under Rish/HarnessAuth."
print -- "Use RISH_IOS_HARNESS_AUTH_RISH_XCFRAMEWORK=Vendor/rish_ffi-harness-auth.xcframework with a device-only pod install to link the stream-capable FFI."
