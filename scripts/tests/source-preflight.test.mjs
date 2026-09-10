import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {auditSource, requiredFiles} from '../verify-source-checkout.mjs';

const checkout = fileURLToPath(new URL('../..', import.meta.url));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rish-source-preflight-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const file of requiredFiles) {
    fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
    fs.copyFileSync(path.join(checkout, file), path.join(root, file));
  }
  return root;
}
function edit(root, file, transform) {
  const absolute = path.join(root, file);
  fs.writeFileSync(absolute, transform(fs.readFileSync(absolute, 'utf8')));
}

test('minimal source archive passes without Git, Pods, node_modules, Vendor libraries or a sibling repo', t => {
  assert.deepEqual(auditSource(fixture(t)), []);
});
test('missing renamed project is rejected even if an old project exists', t => {
  const root = fixture(t);
  fs.renameSync(path.join(root, 'apps/mobile/ios/Rish.xcodeproj'), path.join(root, 'apps/mobile/ios/DSHMobile.xcodeproj'));
  assert.ok(auditSource(root).some(error => error.includes('Rish.xcodeproj/project.pbxproj: required source')));
});
test('old native component name is rejected', t => {
  const root = fixture(t);
  edit(root, 'apps/mobile/ios/Rish/AppDelegate.swift', text => text.replace('withModuleName: "Rish"', 'withModuleName: "DSHMobile"'));
  assert.ok(auditSource(root).some(error => error.includes('Rish entry point does not match')));
});
test('machine-specific CocoaPods executable is rejected', t => {
  const root = fixture(t);
  edit(root, 'run-simulator.sh', text => `${text}\n/opt/homebrew/bin/pod install\n`);
  assert.ok(auditSource(root).some(error => error.includes('machine-specific path')));
});
test('a retired Xcode SDK path is rejected', t => {
  const root = fixture(t);
  edit(root, 'apps/mobile/ios/Rish.xcodeproj/project.pbxproj', text => text.replace(
    'path = System/Library/Frameworks/Foundation.framework; sourceTree = SDKROOT;',
    'path = Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS18.0.sdk/System/Library/Frameworks/Foundation.framework; sourceTree = DEVELOPER_DIR;'));
  assert.ok(auditSource(root).some(error => error.includes('use SDKROOT instead')));
});
test('external local pod checkout is rejected', t => {
  const root = fixture(t);
  edit(root, 'apps/mobile/ios/Podfile', text => text.replace('../../../modules/rish/ios', '../../../../rish/ios'));
  assert.ok(auditSource(root).some(error => error.includes('local runtime must resolve inside')));
});
test('a symlink cannot conceal an external source prerequisite', t => {
  const root = fixture(t);
  const file = 'apps/mobile/ios/Rish/Info.plist';
  fs.unlinkSync(path.join(root, file));
  fs.symlinkSync(path.join(checkout, file), path.join(root, file));
  assert.ok(auditSource(root).some(error => error.includes('source resolves outside')));
});
test('local npm dependency and absent integrity are rejected', t => {
  const root = fixture(t);
  edit(root, 'apps/mobile/package-lock.json', text => {
    const lock = JSON.parse(text);
    const entry = lock.packages[Object.keys(lock.packages).find(key => key)];
    entry.resolved = 'file:../../../private-checkout';
    delete entry.integrity;
    return JSON.stringify(lock);
  });
  assert.ok(auditSource(root).some(error => error.includes('public, integrity-pinned npm resolution')));
});
test('a stale npm lock is rejected before npm ci', t => {
  const root = fixture(t);
  edit(root, 'apps/mobile/package.json', text => {
    const manifest = JSON.parse(text);
    manifest.dependencies.react = '0.0.0';
    return JSON.stringify(manifest);
  });
  assert.ok(auditSource(root).some(error => error.includes('dependencies differs from package.json')));
});
