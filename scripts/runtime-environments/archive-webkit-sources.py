#!/usr/bin/env python3
"""Archive selected real JSC source blobs from a fixed, already-fetched Git commit."""
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import apk

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.build/runtime-environments/packages/source-archives/webkit-git'
COMMIT = '0f966e81b78c84bb23213e391bc679c4ef83e56b'
SCOPE = ['Source/JavaScriptCore', 'Source/WTF', 'Source/bmalloc', 'Source/ThirdParty', 'Source/cmake',
         'Tools/CMake', 'Tools/Scripts', 'Configurations', 'icu', '.github/workflows']


def main():
    checkout = OUT / 'checkout'
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_SYSTEM': '/dev/null', 'GIT_NO_LAZY_FETCH': '1'}
    scope = list(SCOPE)
    for prefix in ['', 'Source', 'Tools']:
        tree = COMMIT + (':' + prefix if prefix else '')
        data = subprocess.run(['git', 'ls-tree', '-z', tree], cwd=checkout, env=env, capture_output=True, check=True).stdout
        for row in data.split(b'\0'):
            if not row: continue
            metadata, name = row.split(b'\t', 1)
            if b' blob ' in metadata:
                scope.append((prefix + '/' if prefix else '') + name.decode())
    listing = subprocess.run(['git', 'ls-tree', '-r', '-z', COMMIT, '--', *scope], cwd=checkout, env=env,
                             capture_output=True, check=True).stdout
    entries = []
    for row in listing.split(b'\0'):
        if not row: continue
        metadata, name = row.split(b'\t', 1)
        mode, kind, identity = metadata.decode().split()
        if kind != 'blob': raise ValueError('source scope contains an unresolved submodule')
        entries.append((apk.safe_path(name.decode()), mode, identity))
    entries.sort()
    destination = OUT / ('WebKit-JSC-' + COMMIT + '.tar.gz')
    temporary = destination.with_suffix('.gz.partial')
    process = subprocess.Popen(['git', 'cat-file', '--batch'], cwd=checkout, env=env,
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    total, jsc_files, verified = 0, 0, []
    try:
        with temporary.open('wb') as raw, gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode='w|', format=tarfile.PAX_FORMAT) as archive:
                for name, mode, identity in entries:
                    process.stdin.write((identity + '\n').encode()); process.stdin.flush()
                    header = process.stdout.readline().decode().strip().split()
                    if len(header) != 3 or header[:2] != [identity, 'blob']:
                        raise ValueError('selected source blob is unavailable: ' + name)
                    size = int(header[2])
                    if not 0 <= size <= 1024 ** 3: raise ValueError('source file exceeds 1 GiB cap')
                    data = process.stdout.read(size)
                    if len(data) != size or process.stdout.read(1) != b'\n': raise ValueError('truncated Git blob')
                    if hashlib.sha1(b'blob ' + str(size).encode() + b'\0' + data).hexdigest() != identity:
                        raise ValueError('Git source blob checksum mismatch')
                    member = tarfile.TarInfo('WebKit-JSC-' + COMMIT + '/' + name)
                    member.uid = member.gid = 0; member.mtime = 0
                    member.mode = 0o755 if mode == '100755' else 0o644
                    if mode == '120000':
                        member.type = tarfile.SYMTYPE; member.linkname = data.decode(); member.size = 0
                        archive.addfile(member)
                    else:
                        member.size = size; archive.addfile(member, io.BytesIO(data))
                    total += size; jsc_files += name.startswith('Source/JavaScriptCore/')
                    verified.append({'path': name, 'git_blob_sha1': identity, 'bytes': size})
                    if raw.tell() > 1024 ** 3: raise ValueError('source archive exceeds per-file cap')
        process.stdin.close(); process.wait(timeout=10)
        if process.returncode: raise ValueError('Git object reader failed')
    finally:
        if process.poll() is None: process.terminate(); process.wait(timeout=10)
    temporary.replace(destination)
    digest = hashlib.sha256(); strong = hashlib.sha512()
    with destination.open('rb') as file:
        while block := file.read(1024 * 1024): digest.update(block); strong.update(block)
    receipt = {'commit': COMMIT, 'path': str(destination), 'bytes': destination.stat().st_size,
               'sha256': digest.hexdigest(), 'sha512': strong.hexdigest(), 'scope': sorted(set(scope)),
               'verified_blob_count': len(verified), 'jsc_source_files': jsc_files, 'source_bytes': total,
               'full_web_browser_source': False, 'jsc_build_sources_retained': True,
               'provenance': 'fixed official Git commit; each included actual blob SHA1 verified; no submodule pointers'}
    (OUT / 'archive-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    (OUT / 'source-blobs.json').write_text(json.dumps(verified, indent=2) + '\n')
    print(json.dumps(receipt, indent=2), flush=True)


if __name__ == '__main__': main()
