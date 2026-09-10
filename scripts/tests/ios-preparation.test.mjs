import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';

// These execute the actual zsh iOS preparation entry point, with all build /
// download commands replaced. They do not need Xcode, Rust, Git, or a cache.
const script = fileURLToPath(new URL('../prepare-rish-ios.sh', import.meta.url));
const hasZsh = spawnSync('zsh', ['--version']).status === 0;
function runPreflight(t, installed) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rish-ios-preflight-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const log = path.join(root, 'commands.log');
  for (const command of ['cargo', 'git', 'jq', 'rustc', 'rustup', 'tar', 'xcodebuild', 'xcrun']) {
    const body = '#!/bin/sh\n' +
      'printf "%s\\n" "${0##*/} $*" >> "$RISH_TEST_COMMAND_LOG"\n' +
      (command === 'rustup'
        ? 'if [ "$*" = "toolchain list --quiet" ]; then printf "%s\\n" "$RISH_TEST_INSTALLED"; exit 0; fi\n'
        : '') +
      'exit 81\n';
    fs.writeFileSync(path.join(root, command), body, {mode: 0o755});
  }
  const result = spawnSync('zsh', ['-f', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${root}:/usr/bin:/bin`,
      RISH_IOS_OFFLINE: '1',
      RISH_SOURCE_DIR: root,
      RISH_TEST_COMMAND_LOG: log,
      RISH_TEST_INSTALLED: installed,
    },
  });
  return {...result, commands: fs.readFileSync(log, 'utf8').trim().split('\n')};
}

test('offline preparation fails before any Rust proxy or fetch when pinned toolchain is absent', {skip: !hasZsh}, t => {
  const result = runPreflight(t, 'stable-aarch64-apple-darwin\n1.94.1-aarch64-apple-darwin');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /offline preparation requires preinstalled Rust 1\.94/);
  assert.deepEqual(result.commands, ['rustup toolchain list --quiet']);
});

test('offline preparation uses the installed full toolchain identity for its first Rust proxy', {skip: !hasZsh}, t => {
  const result = runPreflight(t, 'stable-aarch64-apple-darwin\n1.94-aarch64-apple-darwin');
  assert.notEqual(result.status, 0); // The fake compiler deliberately stops all later work.
  assert.deepEqual(result.commands, [
    'rustup toolchain list --quiet',
    'rustc +1.94-aarch64-apple-darwin -vV',
  ]);
});
