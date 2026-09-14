#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ "${RISH_IOS_GUEST_CGI_ENABLED:-}" == 1 ]] || {
  echo 'Release preview tests require RISH_IOS_GUEST_CGI_ENABLED=1' >&2
  exit 1
}
output="$PWD/.build/preview-tests"
mkdir -p "$output"
xcrun simctl list devices available --json > "$output/devices.json"
device=$(python3 - "$output/devices.json" <<'PY'
import json, sys
inventory = json.load(open(sys.argv[1]))['devices']
for runtime, devices in sorted(inventory.items(), reverse=True):
    if '.iOS-' not in runtime:
        continue
    for device in devices:
        if device['name'].startswith('iPhone') and device.get('isAvailable'):
            print(device['udid'])
            sys.exit(0)
raise SystemExit('No available iPhone simulator')
PY
)
xcrun simctl boot "$device" || true
xcrun simctl bootstatus "$device" -b
trap 'xcrun simctl shutdown "$device" >/dev/null 2>&1 || true' EXIT
xcodebuild build-for-testing -workspace apps/mobile/ios/Rish.xcworkspace \
  -scheme Rish -configuration Release -destination "id=$device" \
  -derivedDataPath "$output/DerivedData" CODE_SIGNING_ALLOWED=NO \
  -only-testing:RishTests/RishGuestCgiLiveTests \
  -only-testing:RishTests/AgentGuestCgiAdapterTests \
  -only-testing:RishTests/RishGuestCgiHTTPTests
python3 - "$output/DerivedData/Build/Products" "$PWD/scripts/tests/fixtures/guest-cgi" <<'PY'
import pathlib, plistlib, sys
paths = list(pathlib.Path(sys.argv[1]).glob('*.xctestrun'))
if len(paths) != 1:
    raise SystemExit('Expected one generated xctestrun file')
path = paths[0]
config = plistlib.loads(path.read_bytes())
updated = 0
def visit(value):
    global updated
    if isinstance(value, dict):
        if 'TestBundlePath' in value:
            value.setdefault('EnvironmentVariables', {}).update({
                'RISH_GUEST_CGI_LIVE': '1', 'RISH_GUEST_CGI_FIXTURE_DIR': sys.argv[2],
            })
            updated += 1
        else:
            for child in value.values(): visit(child)
    elif isinstance(value, list):
        for child in value: visit(child)
visit(config)
if not updated: raise SystemExit('No test targets found in xctestrun')
path.write_bytes(plistlib.dumps(config))
PY
plans=("$output"/DerivedData/Build/Products/*.xctestrun)
xcodebuild test-without-building -xctestrun "${plans[0]}" \
  -destination "id=$device" -parallel-testing-enabled NO \
  -resultBundlePath "$output/Preview.xcresult" \
  -only-testing:RishTests/RishGuestCgiLiveTests \
  -only-testing:RishTests/AgentGuestCgiAdapterTests \
  -only-testing:RishTests/RishGuestCgiHTTPTests
xcrun xcresulttool get test-results tests --path "$output/Preview.xcresult" --compact > "$output/tests.json"
python3 - "$output/tests.json" <<'PY'
import json, sys
nodes = json.load(open(sys.argv[1]))['testNodes']
found = []
def visit(node):
    if node.get('nodeType') == 'Test Case' and 'testOptInRealGuestCgiCounterOverLoopback' in node.get('name', ''):
        found.append(node.get('result'))
    for child in node.get('children', []): visit(child)
for node in nodes: visit(node)
if found != ['Passed']:
    raise SystemExit(f'Real guest preview test must run and pass; observed: {found}')
print('Release guest preview: registry enabled, guest boot, HTTP GET/POST, and teardown verified.')
PY
