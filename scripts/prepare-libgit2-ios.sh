#!/bin/zsh
set -euo pipefail
export ZERO_AR_DATE=1

SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
MODULE_ROOT=${APP_ROOT}/modules/rish/ios
VENDOR_ROOT=${MODULE_ROOT}/Vendor
DEPS_ROOT=${APP_ROOT}/.build/deps
SOURCE_ROOT=${DEPS_ROOT}/libgit2-src
LIBSSH2_INSTALL_ROOT=${DEPS_ROOT}/libssh2-ios-install
LIBGIT2_REPOSITORY=https://github.com/libgit2/libgit2.git
LIBGIT2_VERSION=1.9.6
LIBGIT2_COMMIT=26055f5af74ab1cf636d272e8a34315496d3f06f
DEPLOYMENT_TARGET=15.1

fail() {
  print -u2 -- "prepare-libgit2-ios: $*"
  exit 1
}

sha256_file() {
  /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'
}

verify_archive() {
  local library=$1
  local expected_platform=$2
  local label=$3
  local architectures platforms
  [[ -f ${library} ]] || fail "${label} archive is missing"
  architectures=$(xcrun lipo -archs "${library}")
  [[ ${architectures} == arm64 ]] || fail "${label} architecture is ${architectures}, expected arm64"
  platforms=$(
    /usr/bin/otool -l "${library}" |
      /usr/bin/awk '$1 == "platform" { print $2 }' |
      /usr/bin/sort -u |
      /usr/bin/tr '\n' ' ' |
      /usr/bin/sed 's/[[:space:]]*$//'
  )
  [[ ${platforms} == ${expected_platform} ]] || \
    fail "${label} LC_BUILD_VERSION platform is ${platforms:-none}, expected ${expected_platform}"
  for symbol in _git_libgit2_init _git_clone _git_status_list_new \
    _git_diff_tree_to_index _git_commit_create _git_remote_push; do
    xcrun nm -gU "${library}" 2>/dev/null | \
      /usr/bin/grep "[[:space:]]${symbol}$" >/dev/null || \
      fail "${label} is missing ${symbol}"
  done
  # libgit2's private zlib is built with NO_GZIP. Its public symbols must
  # never replace the SDK zlib used by runtime environment package decoding.
  for symbol in _z_inflate _z_deflate; do
    xcrun nm -gU "${library}" 2>/dev/null | \
      /usr/bin/grep "[[:space:]]${symbol}$" >/dev/null || \
      fail "${label} is missing private zlib symbol ${symbol}"
  done
  for symbol in _inflate _inflateInit2_ _deflate _zlibVersion; do
    if xcrun nm -gU "${library}" 2>/dev/null | \
      /usr/bin/grep "[[:space:]]${symbol}$" >/dev/null; then
      fail "${label} exports unprefixed zlib symbol ${symbol}"
    fi
  done
}

if [[ -n ${CMAKE_BIN:-} ]]; then
  CMAKE=${CMAKE_BIN}
elif command -v cmake >/dev/null 2>&1; then
  CMAKE=$(command -v cmake)
elif [[ -x ${APP_ROOT}/.build/tools/cmake-wheel/cmake/data/bin/cmake ]]; then
  CMAKE=${APP_ROOT}/.build/tools/cmake-wheel/cmake/data/bin/cmake
else
  print -u2 "cmake is required (3.24 or newer recommended). Set CMAKE_BIN to its absolute path."
  exit 1
fi

CLANG=$(xcrun --find clang)
AR=$(xcrun --find ar)
RANLIB=$(xcrun --find ranlib)

mkdir -p "${DEPS_ROOT}" "${VENDOR_ROOT}"

# libgit2's SSH transport is linked as a separate static dependency. Keep its
# crypto backend and source pin in the dedicated helper so this script remains
# reproducible when called directly.
"${SCRIPT_DIR}/prepare-libssh2-ios.sh"

if [[ ! -d ${SOURCE_ROOT}/.git ]]; then
  [[ ! -e ${SOURCE_ROOT} || -z "$(find "${SOURCE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
    fail "libgit2 source path is not an empty checkout: ${SOURCE_ROOT}"
  mkdir -p "${SOURCE_ROOT}"
  git -C "${SOURCE_ROOT}" init --quiet
  git -C "${SOURCE_ROOT}" remote add origin "${LIBGIT2_REPOSITORY}"
fi

actual_remote=$(git -C "${SOURCE_ROOT}" remote get-url origin)
if [[ ${actual_remote} != ${LIBGIT2_REPOSITORY} ]]; then
  print -u2 "Refusing to use libgit2 source with unexpected origin: ${actual_remote}"
  exit 1
fi
[[ -z "$(git -C "${SOURCE_ROOT}" status --porcelain=v1 --untracked-files=all)" ]] ||
  fail "libgit2 source checkout is dirty; refusing to overwrite local files"

if ! git -C "${SOURCE_ROOT}" cat-file -e "${LIBGIT2_COMMIT}^{commit}" 2>/dev/null; then
  git -C "${SOURCE_ROOT}" fetch --filter=blob:none --depth=1 origin "${LIBGIT2_COMMIT}"
fi
git -C "${SOURCE_ROOT}" checkout --detach "${LIBGIT2_COMMIT}"

actual_commit=$(git -C "${SOURCE_ROOT}" rev-parse HEAD)
if [[ ${actual_commit} != ${LIBGIT2_COMMIT} ]]; then
  print -u2 "libgit2 checkout mismatch: expected ${LIBGIT2_COMMIT}, got ${actual_commit}"
  exit 1
fi

build_slice() {
  local name=$1
  local sysroot=$2
  local build_root=${DEPS_ROOT}/libgit2-ios-build-${name}
  local install_root=${DEPS_ROOT}/libgit2-ios-install-${name}
  local libssh2_install=${LIBSSH2_INSTALL_ROOT}-${name}

  "${CMAKE}" \
    -S "${SOURCE_ROOT}" \
    -B "${build_root}" \
    -G "Unix Makefiles" \
    -DCMAKE_C_COMPILER="${CLANG}" \
    -DCMAKE_C_FLAGS=-DZ_PREFIX \
    -DCMAKE_AR="${AR}" \
    -DCMAKE_RANLIB="${RANLIB}" \
    -DCMAKE_SYSTEM_NAME=iOS \
    -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_OSX_SYSROOT="${sysroot}" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" \
    -DCMAKE_INSTALL_PREFIX="${install_root}" \
    -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTS=OFF \
    -DBUILD_CLI=OFF \
    -DBUILD_EXAMPLES=OFF \
    -DBUILD_FUZZERS=OFF \
    -DUSE_HTTPS=SecureTransport \
    -DUSE_SSH=libssh2 \
    -DPKG_CONFIG_EXECUTABLE=/usr/bin/false \
    -DLIBSSH2_INCLUDE_DIR="${libssh2_install}/include" \
    -DLIBSSH2_LIBRARY="${libssh2_install}/lib/libssh2.a" \
    -DUSE_GSSAPI=OFF \
    -DUSE_NTLMCLIENT=OFF \
    -DUSE_ICONV=OFF \
    -DUSE_BUNDLED_ZLIB=ON \
    -DREGEX_BACKEND=builtin \
    -DUSE_HTTP_PARSER=builtin \
    -DUSE_SHA1=CollisionDetection \
    -DUSE_SHA256=HTTPS

  "${CMAKE}" --build "${build_root}" --config Release --parallel
  "${CMAKE}" --install "${build_root}" --config Release
  local features=${build_root}/gen_headers/git2_features.h
  [[ -f ${features} ]] || fail "libgit2 ${name} feature header is missing"
  /usr/bin/grep -q '^#define GIT_SSH_LIBSSH2 1$' "${features}" || \
    fail "libgit2 ${name} was built without the libssh2 SSH feature"
}

build_slice device iphoneos
build_slice simulator iphonesimulator

DEVICE_INSTALL=${DEPS_ROOT}/libgit2-ios-install-device
SIMULATOR_INSTALL=${DEPS_ROOT}/libgit2-ios-install-simulator
if ! cmp -s "${DEVICE_INSTALL}/include/git2/version.h" \
  "${SIMULATOR_INSTALL}/include/git2/version.h"; then
  print -u2 "libgit2 headers differ between device and Simulator builds"
  exit 1
fi
verify_archive "${DEVICE_INSTALL}/lib/libgit2.a" 2 "iOS device"
verify_archive "${SIMULATOR_INSTALL}/lib/libgit2.a" 7 "iOS Simulator"

temp_root=$(mktemp -d "${VENDOR_ROOT}/.libgit2-xcframework.XXXXXX")
trap 'rm -rf -- "${temp_root}"' EXIT
temp_xcframework=${temp_root}/libgit2.xcframework

xcodebuild -create-xcframework \
  -library "${DEVICE_INSTALL}/lib/libgit2.a" \
  -headers "${DEVICE_INSTALL}/include" \
  -library "${SIMULATOR_INSTALL}/lib/libgit2.a" \
  -headers "${SIMULATOR_INSTALL}/include" \
  -output "${temp_xcframework}"

verify_archive "${temp_xcframework}/ios-arm64/libgit2.a" 2 "packaged iOS device"
verify_archive "${temp_xcframework}/ios-arm64-simulator/libgit2.a" 7 \
  "packaged iOS Simulator"
cmp -s "${DEVICE_INSTALL}/include/git2/version.h" \
  "${temp_xcframework}/ios-arm64/Headers/git2/version.h" || \
  fail "packaged device header differs from the built header"
cmp -s "${SIMULATOR_INSTALL}/include/git2/version.h" \
  "${temp_xcframework}/ios-arm64-simulator/Headers/git2/version.h" || \
  fail "packaged Simulator header differs from the built header"

xcframework=${VENDOR_ROOT}/libgit2.xcframework
previous=${VENDOR_ROOT}/.libgit2.xcframework.previous.$$
if [[ -e ${xcframework} ]]; then
  mv "${xcframework}" "${previous}"
fi
mv "${temp_xcframework}" "${xcframework}"
if [[ -e ${previous} ]]; then
  rm -rf -- "${previous}"
fi

device_sha=$(sha256_file "${xcframework}/ios-arm64/libgit2.a")
simulator_sha=$(sha256_file "${xcframework}/ios-arm64-simulator/libgit2.a")
header_sha=$(sha256_file "${xcframework}/ios-arm64/Headers/git2/version.h")
libssh2_device_sha=$(sha256_file "${DEPS_ROOT}/libssh2-ios-install-device/lib/libssh2.a")
libssh2_simulator_sha=$(sha256_file "${DEPS_ROOT}/libssh2-ios-install-simulator/lib/libssh2.a")
openssl_device_sha=$(sha256_file "${DEPS_ROOT}/openssl-install-device/lib/libcrypto.a")
openssl_simulator_sha=$(sha256_file "${DEPS_ROOT}/openssl-install-simulator/lib/libcrypto.a")
xcode_version=$(xcodebuild -version | /usr/bin/tr '\n' ';' | /usr/bin/sed 's/;$//')

print -r -- "format=1" > "${VENDOR_ROOT}/libgit2.version"
print -r -- "source=${LIBGIT2_REPOSITORY}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "version=${LIBGIT2_VERSION}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "commit=${LIBGIT2_COMMIT}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "https=SecureTransport" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "ssh=libssh2" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "crypto=OpenSSL" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "zlib=bundled-z-prefix" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "libssh2_commit=a312b43325e3383c865a87bb1d26cb52e3292641" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "openssl_commit=fe686e15d84334b284f883118ed92f64b409b3aa" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "redirect_policy=caller-enforced-none" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "ios_deployment_target=${DEPLOYMENT_TARGET}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "xcode=${xcode_version}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "architectures=ios-arm64,ios-simulator-arm64" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "device_platform=LC_BUILD_VERSION:2" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "simulator_platform=LC_BUILD_VERSION:7" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "header_version_sha256=${header_sha}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "device_library_sha256=${device_sha}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "simulator_library_sha256=${simulator_sha}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "libssh2_device_library_sha256=${libssh2_device_sha}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "libssh2_simulator_library_sha256=${libssh2_simulator_sha}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "openssl_device_library_sha256=${openssl_device_sha}" >> "${VENDOR_ROOT}/libgit2.version"
print -r -- "openssl_simulator_library_sha256=${openssl_simulator_sha}" >> "${VENDOR_ROOT}/libgit2.version"

print "prepared libgit2 ${LIBGIT2_VERSION} at ${xcframework}"
