#!/bin/zsh
set -euo pipefail
export ZERO_AR_DATE=1

# Build the OpenSSL crypto provider used by libssh2. The source and commit are
# pinned here so a cached checkout cannot silently change the SSH implementation.
SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
MODULE_ROOT=${APP_ROOT}/modules/rish/ios
VENDOR_ROOT=${MODULE_ROOT}/Vendor
DEPS_ROOT=${APP_ROOT}/.build/deps
SOURCE_ROOT=${DEPS_ROOT}/openssl-src
OPENSSL_REPOSITORY=https://github.com/openssl/openssl.git
OPENSSL_VERSION=3.6.2
OPENSSL_COMMIT=fe686e15d84334b284f883118ed92f64b409b3aa
DEPLOYMENT_TARGET=15.1
# The OpenSSL repository carries large test/fuzz corpora that are not needed
# by this no-tests/no-apps build. Keep the pinned Git commit and export only
# the source needed by Configure and libcrypto. This avoids materializing the
# repository's unrelated history and bulk fixtures in the build cache.
OPENSSL_SOURCE_PATHS=(
  '/Configure' '/VERSION.dat' '/config' '/configdata.pm.in' '/Makefile.in' '/build.info'
  '/**/build.info'
  '/Configurations/**' '/apps/**' '/crypto/**' '/engines/**' '/external/**' '/exporters/**' '/include/**'
  '/providers/**' '/ssl/**' '/tools/**' '/util/**'
)

fail() {
  print -u2 -- "prepare-openssl-ios: $*"
  exit 1
}

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

verify_archive() {
  local library=$1
  local expected_platform=$2
  local label=$3
  local platforms
  [[ -f ${library} ]] || fail "${label} archive is missing"
  [[ $(xcrun lipo -archs "${library}") == arm64 ]] || \
    fail "${label} architecture is not arm64"
  platforms=$(
    /usr/bin/otool -l "${library}" |
      /usr/bin/awk '$1 == "platform" { print $2 }' |
      /usr/bin/sort -u |
      /usr/bin/tr '\n' ' ' |
      /usr/bin/sed 's/[[:space:]]*$//'
  )
  [[ ${platforms} == ${expected_platform} ]] || \
    fail "${label} LC_BUILD_VERSION platform is ${platforms:-none}, expected ${expected_platform}"
  for symbol in _EVP_PKEY_new_raw_private_key _EVP_PKEY_new_raw_public_key \
    _EVP_DigestSignInit _EVP_DigestVerifyInit; do
    xcrun nm -gU "${library}" 2>/dev/null |
      /usr/bin/grep "[[:space:]]${symbol}$" >/dev/null ||
      fail "${label} is missing ${symbol} (ed25519 support)"
  done
}

mkdir -p "${DEPS_ROOT}" "${VENDOR_ROOT}"

if [[ ! -d ${SOURCE_ROOT}/.git ]]; then
  [[ ! -e ${SOURCE_ROOT} || -z "$(find "${SOURCE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
    fail "OpenSSL source path is not an empty checkout: ${SOURCE_ROOT}"
  mkdir -p "${SOURCE_ROOT}"
  git -C "${SOURCE_ROOT}" init --quiet
  git -C "${SOURCE_ROOT}" remote add origin "${OPENSSL_REPOSITORY}"
fi
actual_remote=$(git -C "${SOURCE_ROOT}" remote get-url origin)
[[ ${actual_remote} == ${OPENSSL_REPOSITORY} ]] ||
  fail "OpenSSL source has unexpected origin: ${actual_remote}"
[[ -z "$(git -C "${SOURCE_ROOT}" status --porcelain=v1 --untracked-files=all)" ]] ||
  fail "OpenSSL source checkout is dirty; refusing to overwrite local files"
if ! git -C "${SOURCE_ROOT}" cat-file -e "${OPENSSL_COMMIT}^{commit}" 2>/dev/null; then
  git -C "${SOURCE_ROOT}" fetch --filter=blob:none --depth=1 origin "${OPENSSL_COMMIT}"
fi
git -C "${SOURCE_ROOT}" sparse-checkout init --no-cone
git -C "${SOURCE_ROOT}" sparse-checkout set --no-cone "${OPENSSL_SOURCE_PATHS[@]}"
git -C "${SOURCE_ROOT}" checkout --detach "${OPENSSL_COMMIT}"
[[ $(git -C "${SOURCE_ROOT}" rev-parse HEAD) == ${OPENSSL_COMMIT} ]] ||
  fail "OpenSSL checkout mismatch"
openssl_version=$(git -C "${SOURCE_ROOT}" show "${OPENSSL_COMMIT}:VERSION.dat" |
  /usr/bin/awk -F= '
    $1 == "MAJOR" { major=$2 }
    $1 == "MINOR" { minor=$2 }
    $1 == "PATCH" { patch=$2 }
    END { print major "." minor "." patch }
  ')
[[ ${openssl_version} == ${OPENSSL_VERSION} ]] ||
  fail "OpenSSL checkout reports ${openssl_version}, expected ${OPENSSL_VERSION}"

build_slice() {
  local name=$1
  local target=$2
  local platform_flag=$3
  local slice_source=${DEPS_ROOT}/openssl-src-${name}
  local install_root=${DEPS_ROOT}/openssl-install-${name}
  local log=${DEPS_ROOT}/openssl-${name}.log
  local sdk=iphoneos
  [[ ${name} == simulator ]] && sdk=iphonesimulator
  local fingerprint="source=${OPENSSL_COMMIT};version=${OPENSSL_VERSION};target=${target};sdk=${sdk};arch=arm64;deployment=${DEPLOYMENT_TARGET};cflags=${platform_flag};archive=zero-ar-date;options=no-shared,no-tests,no-apps,no-docs,no-async,no-dso,no-engine,no-zlib,no-zstd,no-legacy"

  if [[ -f ${install_root}/.prepare-fingerprint &&
    $(<${install_root}/.prepare-fingerprint) == ${fingerprint} &&
    -f ${install_root}/lib/libcrypto.a && -f ${install_root}/include/openssl/evp.h ]]; then
    local cached_platform=7
    [[ ${name} == device ]] && cached_platform=2
    verify_archive "${install_root}/lib/libcrypto.a" "${cached_platform}" "cached OpenSSL ${name}"
    return
  fi

  rm -rf -- "${slice_source}" "${install_root}"
  mkdir -p "${slice_source}"
  (cd "${SOURCE_ROOT}" && tar -cf - --exclude='./.git' .) | tar -x -C "${slice_source}"

  (
    cd "${slice_source}"
    CFLAGS="${platform_flag}" ./Configure "${target}" \
      no-shared no-tests no-apps no-docs no-async no-dso no-engine \
      no-zlib no-zstd no-legacy \
      --prefix="${install_root}" \
      --openssldir="${install_root}/ssl"
    /usr/bin/make -j"$(sysctl -n hw.ncpu)" build_sw
    /usr/bin/make install_sw
  ) >| "${log}" 2>&1
  print -r -- "${fingerprint}" > "${install_root}/.prepare-fingerprint"

  local platform=7
  [[ ${name} == device ]] && platform=2
  verify_archive "${install_root}/lib/libcrypto.a" "${platform}" "OpenSSL ${name}"
  [[ -f ${install_root}/include/openssl/evp.h ]] || fail "OpenSSL ${name} headers are missing"
}

build_slice device ios64-xcrun -miphoneos-version-min=${DEPLOYMENT_TARGET}
build_slice simulator iossimulator-arm64-xcrun -mios-simulator-version-min=${DEPLOYMENT_TARGET}

device=${DEPS_ROOT}/openssl-install-device
simulator=${DEPS_ROOT}/openssl-install-simulator
temp_root=$(mktemp -d "${VENDOR_ROOT}/.libcrypto-xcframework.XXXXXX")
trap 'rm -rf -- "${temp_root}"' EXIT
temp_xcframework=${temp_root}/libcrypto.xcframework
xcodebuild -create-xcframework \
  -library "${device}/lib/libcrypto.a" -headers "${device}/include" \
  -library "${simulator}/lib/libcrypto.a" -headers "${simulator}/include" \
  -output "${temp_xcframework}"

verify_archive "${temp_xcframework}/ios-arm64/libcrypto.a" 2 "packaged OpenSSL device"
verify_archive "${temp_xcframework}/ios-arm64-simulator/libcrypto.a" 7 "packaged OpenSSL Simulator"

xcframework=${VENDOR_ROOT}/libcrypto.xcframework
previous=${VENDOR_ROOT}/.libcrypto.xcframework.previous.$$
if [[ -e ${xcframework} ]]; then mv "${xcframework}" "${previous}"; fi
mv "${temp_xcframework}" "${xcframework}"
if [[ -e ${previous} ]]; then rm -rf -- "${previous}"; fi

device_sha=$(sha256_file "${xcframework}/ios-arm64/libcrypto.a")
simulator_sha=$(sha256_file "${xcframework}/ios-arm64-simulator/libcrypto.a")
header_sha=$(sha256_file "${xcframework}/ios-arm64/Headers/openssl/evp.h")
xcode_version=$(xcodebuild -version | /usr/bin/tr '\n' ';' | /usr/bin/sed 's/;$//')
print -r -- "format=1" > "${VENDOR_ROOT}/openssl.version"
print -r -- "source=${OPENSSL_REPOSITORY}" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "version=${OPENSSL_VERSION}" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "commit=${OPENSSL_COMMIT}" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "crypto=OpenSSL" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "ios_deployment_target=${DEPLOYMENT_TARGET}" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "xcode=${xcode_version}" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "architectures=ios-arm64,ios-simulator-arm64" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "device_platform=LC_BUILD_VERSION:2" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "simulator_platform=LC_BUILD_VERSION:7" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "header_evp_sha256=${header_sha}" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "device_library_sha256=${device_sha}" >> "${VENDOR_ROOT}/openssl.version"
print -r -- "simulator_library_sha256=${simulator_sha}" >> "${VENDOR_ROOT}/openssl.version"
print "prepared OpenSSL ${OPENSSL_VERSION} at ${xcframework}"
