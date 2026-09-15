#!/usr/bin/env python3
"""Normalize a QEMU-built official Go std cache as data for reproducible packing."""
import argparse
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import build

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.build/runtime-environments/packages'


def normalize(export_tar: Path):
    entries = {}
    counts = {'action_entries': 0, 'data_entries': 0}
    with tarfile.open(export_tar, 'r:') as archive:
        for member in archive:
            name = build.apk.safe_path(member.name)
            if name != 'tmp/go-build' and not name.startswith('tmp/go-build/'):
                raise ValueError('cache export escaped fixed cache directory')
            if member.isdir():
                entries[name] = (True, b'')
                continue
            if not member.isfile() or member.size > 64 * 1024 * 1024:
                raise ValueError('unexpected Go cache entry')
            filename = Path(name).name
            data = archive.extractfile(member).read()
            match = re.fullmatch('([0-9a-f]{64})-([ad])', filename)
            if match:
                identity, kind = match.groups()
                if Path(name).parent.name != identity[:2]:
                    raise ValueError('invalid Go cache bucket')
                if kind == 'a':
                    parts = data.decode('ascii').split()
                    if len(parts) != 5 or parts[0] != 'v1' or parts[1] != identity or not re.fullmatch('[0-9a-f]{64}', parts[2]):
                        raise ValueError('invalid Go action-cache header')
                    size = int(parts[3])
                    if size < 0: raise ValueError('negative Go cache size')
                    data = f'v1 {parts[1]} {parts[2]} {size:20d} {build.EPOCH * 1000000000:20d}\n'.encode()
                    counts['action_entries'] += 1
                else:
                    if hashlib.sha256(data).hexdigest() != identity:
                        raise ValueError('Go cached output digest mismatch')
                    counts['data_entries'] += 1
            elif filename == 'trim.txt':
                data = str(build.EPOCH).encode() + b'\n'
            elif filename != 'README':
                raise ValueError('unrecognized Go cache file')
            entries[name] = (False, data)
    if not counts['action_entries'] or not counts['data_entries']:
        raise ValueError('empty cache is not a warm cache')
    destination = OUT / 'downloads/go-stdlib-cache-1.25.10-amd64.tar.gz'
    with destination.open('wb') as raw, gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0, compresslevel=6) as zipped:
        with tarfile.open(fileobj=zipped, mode='w|', format=tarfile.USTAR_FORMAT) as archive:
            for name in sorted(entries):
                directory, data = entries[name]
                member = tarfile.TarInfo(name)
                member.uid = member.gid = 0; member.uname = member.gname = ''
                member.mode = 0o755 if directory else 0o644; member.mtime = build.EPOCH
                member.type = tarfile.DIRTYPE if directory else tarfile.REGTYPE
                member.size = 0 if directory else len(data)
                archive.addfile(member, None if directory else io.BytesIO(data))
    receipt = {'filename': destination.name, 'bytes': destination.stat().st_size, 'sha256': build.sha256(destination),
               'prefix': 'tmp/go-build', 'builder': 'QEMU TCG; build-only, not runtime verification',
               'go_version': '1.25.10', 'architecture': 'x86_64', 'cgo_modes': [0, 1], 'network': 'disabled',
               'runtime_env': {'HOME': '/tmp/rish-home', 'GOCACHE': '/tmp/go-build', 'TMPDIR': '/tmp'},
               'normalization': 'official v1 action-cache timestamps and filesystem metadata only; data outputs SHA256 verified', **counts}
    (OUT / 'go-cache-receipt.json').write_text(json.dumps(receipt, indent=2) + '\n')
    lockpath = ROOT / 'runtime-environments/go.lock.json'; lock = json.loads(lockpath.read_text())
    lock['derived_archives'] = [receipt]
    lockpath.write_text(json.dumps(lock, indent=2) + '\n')
    print(json.dumps(receipt, indent=2), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export_tar', type=Path)
    normalize(parser.parse_args().export_tar.resolve())
