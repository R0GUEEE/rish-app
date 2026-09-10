#!/bin/zsh
set -euo pipefail
export ZERO_AR_DATE=1

# Build the pinned libssh2 transport against the pinned OpenSSL crypto backend.
SCRIPT_DIR=${0:A:h}
APP_ROOT=${SCRIPT_DIR:h}
MODULE_ROOT=${APP_ROOT}/modules/rish/ios
VENDOR_ROOT=${MODULE_ROOT}/Vendor
DEPS_ROOT=${APP_ROOT}/.build/deps
SOURCE_ROOT=${DEPS_ROOT}/libssh2-src
LIBSSH2_REPOSITORY=https://github.com/libssh2/libssh2.git
LIBSSH2_VERSION=1.11.1
LIBSSH2_COMMIT=a312b43325e3383c865a87bb1d26cb52e3292641
DEPLOYMENT_TARGET=15.1

fail() { print -u2 -- "prepare-libssh2-ios: $*"; exit 1; }
sha256_file() { /usr/bin/shasum -a 256 "$1" | /usr/bin/awk '{print $1}'; }

if [[ -n ${CMAKE_BIN:-} ]]; then
  CMAKE=${CMAKE_BIN}
elif command -v cmake >/dev/null 2>&1; then
  CMAKE=$(command -v cmake)
elif [[ -x ${APP_ROOT}/.build/tools/cmake-wheel/cmake/data/bin/cmake ]]; then
  CMAKE=${APP_ROOT}/.build/tools/cmake-wheel/cmake/data/bin/cmake
else
  fail "cmake is required; set CMAKE_BIN to an absolute path"
fi

CLANG=$(xcrun --find clang)
AR=$(xcrun --find ar)
RANLIB=$(xcrun --find ranlib)
mkdir -p "${DEPS_ROOT}" "${VENDOR_ROOT}"

"${SCRIPT_DIR}/prepare-openssl-ios.sh"

if [[ ! -d ${SOURCE_ROOT}/.git ]]; then
  [[ ! -e ${SOURCE_ROOT} || -z "$(find "${SOURCE_ROOT}" -mindepth 1 -maxdepth 1 -print -quit)" ]] ||
    fail "libssh2 source path is not an empty checkout: ${SOURCE_ROOT}"
  mkdir -p "${SOURCE_ROOT}"
  git -C "${SOURCE_ROOT}" init --quiet
  git -C "${SOURCE_ROOT}" remote add origin "${LIBSSH2_REPOSITORY}"
fi
actual_remote=$(git -C "${SOURCE_ROOT}" remote get-url origin)
[[ ${actual_remote} == ${LIBSSH2_REPOSITORY} ]] || fail "libssh2 source has unexpected origin: ${actual_remote}"
[[ -z "$(git -C "${SOURCE_ROOT}" status --porcelain=v1 --untracked-files=all)" ]] ||
  fail "libssh2 source checkout is dirty; refusing to overwrite local files"
if ! git -C "${SOURCE_ROOT}" cat-file -e "${LIBSSH2_COMMIT}^{commit}" 2>/dev/null; then
  git -C "${SOURCE_ROOT}" fetch --filter=blob:none --depth=1 origin "${LIBSSH2_COMMIT}"
fi
git -C "${SOURCE_ROOT}" checkout --detach "${LIBSSH2_COMMIT}"
[[ $(git -C "${SOURCE_ROOT}" rev-parse HEAD) == ${LIBSSH2_COMMIT} ]] || fail "libssh2 checkout mismatch"
libssh2_version=$(git -C "${SOURCE_ROOT}" show "${LIBSSH2_COMMIT}:include/libssh2.h" |
  /usr/bin/awk '
    /#define LIBSSH2_VERSION_MAJOR/ { major=$3 }
    /#define LIBSSH2_VERSION_MINOR/ { minor=$3 }
    /#define LIBSSH2_VERSION_PATCH/ { patch=$3 }
    END { print major "." minor "." patch }
  ')
[[ ${libssh2_version} == ${LIBSSH2_VERSION} ]] ||
  fail "libssh2 checkout reports ${libssh2_version}, expected ${LIBSSH2_VERSION}"

build_slice() {
  local name=$1
  local sysroot=$2
  local build_root=${DEPS_ROOT}/libssh2-ios-build-${name}
  local install_root=${DEPS_ROOT}/libssh2-ios-install-${name}
  local openssl_root=${DEPS_ROOT}/openssl-install-${name}
  local openssl_sha=$(sha256_file "${openssl_root}/lib/libcrypto.a")
  local cmake_version=$("${CMAKE}" --version | /usr/bin/sed -n '1p')
  local fingerprint="source=${LIBSSH2_COMMIT};version=${LIBSSH2_VERSION};crypto=OpenSSL;openssl_commit=fe686e15d84334b284f883118ed92f64b409b3aa;openssl_sha256=${openssl_sha};sysroot=${sysroot};arch=arm64;deployment=${DEPLOYMENT_TARGET};archive=zero-ar-date;flags=static,no-zlib;cmake=${cmake_version}"
  if [[ -f ${install_root}/lib/libssh2.a && -f ${install_root}/include/libssh2.h &&
    -f ${build_root}/CMakeCache.txt && -f ${install_root}/.prepare-fingerprint &&
    $(<${install_root}/.prepare-fingerprint) == ${fingerprint} ]] &&
    /usr/bin/grep -q '^CRYPTO_BACKEND:STRING=OpenSSL$' "${build_root}/CMakeCache.txt" &&
    /usr/bin/grep -q "^OPENSSL_CRYPTO_LIBRARY:FILEPATH=${openssl_root}/lib/libcrypto.a$" "${build_root}/CMakeCache.txt"; then
    return
  fi
  rm -rf -- "${build_root}" "${install_root}"
  "${CMAKE}" -S "${SOURCE_ROOT}" -B "${build_root}" -G "Unix Makefiles" \
    -DCMAKE_C_COMPILER="${CLANG}" -DCMAKE_AR="${AR}" -DCMAKE_RANLIB="${RANLIB}" \
    -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
    -DCMAKE_OSX_SYSROOT="${sysroot}" -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET="${DEPLOYMENT_TARGET}" \
    -DCMAKE_INSTALL_PREFIX="${install_root}" -DCMAKE_INSTALL_LIBDIR=lib \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DBUILD_STATIC_LIBS=ON \
    -DBUILD_TESTING=OFF -DBUILD_EXAMPLES=OFF -DENABLE_ZLIB_COMPRESSION=OFF \
    -DCRYPTO_BACKEND=OpenSSL \
    -DOPENSSL_ROOT_DIR="${openssl_root}" -DOPENSSL_INCLUDE_DIR="${openssl_root}/include" \
    -DOPENSSL_CRYPTO_LIBRARY="${openssl_root}/lib/libcrypto.a" \
    -DOPENSSL_USE_STATIC_LIBS=TRUE
  "${CMAKE}" --build "${build_root}" --config Release --parallel
  "${CMAKE}" --install "${build_root}" --config Release
  print -r -- "${fingerprint}" > "${install_root}/.prepare-fingerprint"
}

build_slice device iphoneos
build_slice simulator iphonesimulator

verify_archive() {
  local library=$1 expected_platform=$2 label=$3
  [[ -f ${library} ]] || fail "${label} archive is missing"
  [[ $(xcrun lipo -archs "${library}") == arm64 ]] || fail "${label} is not arm64"
  local platforms=$(/usr/bin/otool -l "${library}" | /usr/bin/awk '$1=="platform"{print $2}' | /usr/bin/sort -u | /usr/bin/tr '\n' ' ' | /usr/bin/sed 's/[[:space:]]*$//')
  [[ ${platforms} == ${expected_platform} ]] || fail "${label} platform ${platforms:-none}, expected ${expected_platform}"
  for symbol in _libssh2_session_init_ex _libssh2_userauth_publickey_frommemory _libssh2_knownhost_check; do
    xcrun nm -gU "${library}" 2>/dev/null | /usr/bin/grep "[[:space:]]${symbol}$" >/dev/null || fail "${label} missing ${symbol}"
  done
}

device=${DEPS_ROOT}/libssh2-ios-install-device
simulator=${DEPS_ROOT}/libssh2-ios-install-simulator
temp_root=$(mktemp -d "${VENDOR_ROOT}/.libssh2-xcframework.XXXXXX")
trap 'rm -rf -- "${temp_root}"' EXIT
temp_xcframework=${temp_root}/libssh2.xcframework
xcodebuild -create-xcframework \
  -library "${device}/lib/libssh2.a" -headers "${device}/include" \
  -library "${simulator}/lib/libssh2.a" -headers "${simulator}/include" \
  -output "${temp_xcframework}"
verify_archive "${temp_xcframework}/ios-arm64/libssh2.a" 2 "packaged libssh2 device"
verify_archive "${temp_xcframework}/ios-arm64-simulator/libssh2.a" 7 "packaged libssh2 Simulator"

xcframework=${VENDOR_ROOT}/libssh2.xcframework
previous=${VENDOR_ROOT}/.libssh2.xcframework.previous.$$
if [[ -e ${xcframework} ]]; then mv "${xcframework}" "${previous}"; fi
mv "${temp_xcframework}" "${xcframework}"
if [[ -e ${previous} ]]; then rm -rf -- "${previous}"; fi
device_sha=$(sha256_file "${xcframework}/ios-arm64/libssh2.a")
simulator_sha=$(sha256_file "${xcframework}/ios-arm64-simulator/libssh2.a")
header_sha=$(sha256_file "${xcframework}/ios-arm64/Headers/libssh2.h")
openssl_device_sha=$(sha256_file "${DEPS_ROOT}/openssl-install-device/lib/libcrypto.a")
openssl_simulator_sha=$(sha256_file "${DEPS_ROOT}/openssl-install-simulator/lib/libcrypto.a")
xcode_version=$(xcodebuild -version | /usr/bin/tr '\n' ';' | /usr/bin/sed 's/;$//')
print -r -- "format=1" > "${VENDOR_ROOT}/libssh2.version"
print -r -- "source=${LIBSSH2_REPOSITORY}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "version=${LIBSSH2_VERSION}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "commit=${LIBSSH2_COMMIT}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "ssh=libssh2" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "crypto=OpenSSL" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "openssl_commit=fe686e15d84334b284f883118ed92f64b409b3aa" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "ios_deployment_target=${DEPLOYMENT_TARGET}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "xcode=${xcode_version}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "architectures=ios-arm64,ios-simulator-arm64" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "device_platform=LC_BUILD_VERSION:2" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "simulator_platform=LC_BUILD_VERSION:7" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "header_sha256=${header_sha}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "openssl_device_library_sha256=${openssl_device_sha}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "openssl_simulator_library_sha256=${openssl_simulator_sha}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "device_library_sha256=${device_sha}" >> "${VENDOR_ROOT}/libssh2.version"
print -r -- "simulator_library_sha256=${simulator_sha}" >> "${VENDOR_ROOT}/libssh2.version"
print "prepared libssh2 ${LIBSSH2_VERSION} at ${xcframework}"
