import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = file => fs.readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

test('all iOS targets use the release app identifier and distinct suffixes', () => {
  const project = read('apps/mobile/ios/Rish.xcodeproj/project.pbxproj');
  const identifiers = [...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(match => match[1]);
  assert.equal(identifiers.length, 8);
  assert.deepEqual([...new Set(identifiers)].sort(), [
    'tech.zseven.rish', 'tech.zseven.rish.taskactivity',
    'tech.zseven.rish.tests', 'tech.zseven.rish.uitests',
  ]);
});

test('app and Live Activity inherit the same release version and build number', () => {
  for (const target of ['Rish', 'RishTaskActivity']) {
    const plist = read(`apps/mobile/ios/${target}/Info.plist`);
    assert.match(plist, /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/);
    assert.match(plist, /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/);
  }
});

test('Android application and entry point packages match the release identifier', () => {
  const gradle = read('apps/mobile/android/app/build.gradle');
  assert.match(gradle, /namespace "tech\.zseven\.rish"/);
  assert.match(gradle, /applicationId "tech\.zseven\.rish"/);
  for (const entry of ['MainActivity', 'MainApplication']) {
    assert.match(read(`apps/mobile/android/app/src/main/java/tech/zseven/rish/${entry}.kt`), /^package tech\.zseven\.rish$/m);
  }
});
