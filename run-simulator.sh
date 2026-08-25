#!/bin/zsh
set -euo pipefail

APP_ROOT=${0:A:h}
IOS_ROOT="${APP_ROOT}/apps/mobile/ios"
DERIVED_DATA="${APP_ROOT}/.build/ios-simulator"
BUNDLE_ID=dev.zseven.dsh.mobile

DEVICE_ID=${1:-}
if [[ -z "${DEVICE_ID}" ]]; then
  DEVICE_ID=$(
    xcrun simctl list devices available |
      awk -F '[()]' '/iPhone 17 Pro/ { print $2; exit } /iPhone/ { fallback = $2 } END { if (fallback != "") print fallback }' |
      head -1
  )
fi
if [[ -z "${DEVICE_ID}" ]]; then
  print -u2 "No available iPhone Simulator was found"
  exit 2
fi

if [[ ! -d "${IOS_ROOT}/Pods" ]]; then
  (cd "${IOS_ROOT}" && /opt/homebrew/bin/pod install)
fi

xcrun simctl boot "${DEVICE_ID}" >/dev/null 2>&1 || true
xcrun simctl bootstatus "${DEVICE_ID}" -b

xcodebuild \
  -workspace "${IOS_ROOT}/DSHMobile.xcworkspace" \
  -scheme DSHMobile \
  -configuration Release \
  -sdk iphonesimulator \
  -destination "platform=iOS Simulator,id=${DEVICE_ID}" \
  -derivedDataPath "${DERIVED_DATA}" \
  ARCHS=arm64 \
  ONLY_ACTIVE_ARCH=YES \
  build

APP_BUNDLE="${DERIVED_DATA}/Build/Products/Release-iphonesimulator/DSHMobile.app"
xcrun simctl install "${DEVICE_ID}" "${APP_BUNDLE}"
xcrun simctl launch --terminate-running-process "${DEVICE_ID}" "${BUNDLE_ID}"

print "app=${APP_BUNDLE}"
print "simulator=${DEVICE_ID}"
print "bundle_id=${BUNDLE_ID}"
print "mode=local_substrate"
