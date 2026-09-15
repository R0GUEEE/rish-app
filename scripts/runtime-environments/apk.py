"""Read and verify Alpine APK v2 data; never run package scripts or binaries."""
from __future__ import annotations
import base64
import hashlib
import io
import os
from pathlib import Path, PurePosixPath
import posixpath
import re
import stat
import subprocess
import tarfile
import zlib

MAX_EXPANDED_MEMBER = 1024 * 1024 * 1024


def gzip_members(blob: bytes) -> list[tuple[bytes, bytes]]:
    result = []
    while blob:
        if len(result) >= 3:
            raise ValueError('too many gzip members')
        dec = zlib.decompressobj(31)
        data = dec.decompress(blob, MAX_EXPANDED_MEMBER + 1)
        if len(data) > MAX_EXPANDED_MEMBER or not dec.eof:
            raise ValueError('oversized or truncated gzip member')
        consumed = len(blob) - len(dec.unused_data)
        if consumed <= 0:
            raise ValueError('invalid gzip member')
        result.append((blob[:consumed], data))
        blob = dec.unused_data
    return result


def tar_data(data: bytes) -> tarfile.TarFile:
    return tarfile.open(fileobj=io.BytesIO(data), mode='r:')


def safe_path(raw: str) -> str:
    path = PurePosixPath(raw)
    if '\\' in raw or '\x00' in raw or path.is_absolute() or '..' in path.parts:
        raise ValueError('archive path escapes root')
    return str(path)


def safe_link(name: str, target: str) -> str:
    if '\\' in target or '\x00' in target:
        raise ValueError('unsafe archive link')
    # Absolute guest links become equivalent relative links before host staging.
    if target.startswith('/'):
        target = posixpath.relpath(target.lstrip('/'), posixpath.dirname(name) or '.')
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
    if resolved == '..' or resolved.startswith('../'):
        raise ValueError('archive link escapes root')
    return target


def read_newc(path: Path) -> dict[str, tuple[int, bytes]]:
    blob = path.read_bytes()
    offset = 0
    result = {}
    while offset + 110 <= len(blob):
        header = blob[offset:offset + 110]
        if header[:6] not in (b'070701', b'070702'):
            raise ValueError('invalid newc header')
        fields = [int(header[i:i + 8], 16) for i in range(6, 110, 8)]
        mode, size, namesize = fields[1], fields[6], fields[11]
        name = blob[offset + 110:offset + 110 + namesize - 1].decode('utf-8')
        data_start = (offset + 110 + namesize + 3) & ~3
        if name == 'TRAILER!!!':
            return result
        name = safe_path(name)
        if data_start + size > len(blob):
            raise ValueError('truncated newc data')
        result[name] = (mode, blob[data_start:data_start + size])
        offset = (data_start + size + 3) & ~3
    raise ValueError('missing newc trailer')


def verify_signature(parts: list[tuple[bytes, bytes]], keys: Path, scratch: Path) -> str:
    with tar_data(parts[0][1]) as archive:
        members = archive.getmembers()
        if len(members) != 1 or not members[0].isreg():
            raise ValueError('invalid signature segment')
        name = members[0].name
        if not name.startswith('.SIGN.RSA.'):
            raise ValueError('unsupported signature algorithm')
        keyname = name.removeprefix('.SIGN.RSA.')
        if '/' in keyname or not (keys / keyname).is_file():
            raise ValueError('untrusted Alpine signing key')
        signature = archive.extractfile(members[0]).read()
    scratch.mkdir(parents=True, exist_ok=True)
    (scratch / 'signature').write_bytes(signature)
    (scratch / 'control.gz').write_bytes(parts[1][0])
    result = subprocess.run(
        ['openssl', 'dgst', '-sha1', '-verify', str(keys / keyname),
         '-signature', str(scratch / 'signature'), str(scratch / 'control.gz')],
        text=True, capture_output=True, check=False,
    )
    if result.returncode:
        raise ValueError('Alpine RSA signature verification failed')
    return keyname


def read_index(path: Path, keys: Path, scratch: Path) -> tuple[dict, str]:
    parts = gzip_members(path.read_bytes())
    if len(parts) != 2:
        raise ValueError('invalid APKINDEX segment count')
    signer = verify_signature(parts, keys, scratch)
    with tar_data(parts[1][1]) as archive:
        raw = archive.extractfile('APKINDEX').read().decode('utf-8')
    records = {}
    for block in raw.strip().split('\n\n'):
        record = dict(line.split(':', 1) for line in block.splitlines())
        records[record['P']] = record
    return records, signer


def dependency_name(value: str) -> str:
    return re.split('[=<>~]', value, maxsplit=1)[0]


def closure(records: dict, roots: list[str]) -> list[str]:
    providers = {name: name for name in records}
    for name, record in records.items():
        for provided in record.get('p', '').split():
            providers.setdefault(dependency_name(provided), name)
    # /bin/sh is an installed BusyBox applet supplied explicitly by this builder.
    providers['/bin/sh'] = 'busybox'
    selected = set()
    pending = list(roots) + ['busybox', 'ca-certificates-bundle']
    while pending:
        dependency = pending.pop()
        if dependency.startswith('!'):
            continue
        name = providers.get(dependency_name(dependency))
        if name is None:
            raise ValueError('unresolved dependency: ' + dependency)
        if name in selected:
            continue
        selected.add(name)
        pending.extend(records[name].get('D', '').split())
    return sorted(selected)


def verify_package(path: Path, package: dict, keys: Path, scratch: Path) -> tuple[bytes, dict]:
    blob = path.read_bytes()
    if len(blob) != package['package_bytes']:
        raise ValueError('APK byte length differs from signed index')
    parts = gzip_members(blob)
    if len(parts) != 3:
        raise ValueError('invalid APK segment count')
    checksum = 'Q1' + base64.b64encode(hashlib.sha1(parts[1][0]).digest()).decode()
    if checksum != package['control_checksum']:
        raise ValueError('APK checksum differs from signed index')
    signer = verify_signature(parts, keys, scratch)
    with tar_data(parts[1][1]) as archive:
        properties = {}
        for line in archive.extractfile('.PKGINFO').read().decode().splitlines():
            if ' = ' in line:
                key, value = line.split(' = ', 1)
                properties[key] = value
    if properties.get('pkgname') != package['name'] or properties.get('pkgver') != package['version']:
        raise ValueError('APK identity differs from signed index')
    if hashlib.sha256(parts[2][0]).hexdigest() != properties.get('datahash'):
        raise ValueError('APK compressed data checksum mismatch')
    return parts[2][1], {'sha256': hashlib.sha256(blob).hexdigest(), 'signature_key': signer}


def add_tar(entries: dict, data: bytes) -> None:
    hardlinks = []
    with tar_data(data) as archive:
        for member in archive:
            name = safe_path(member.name)
            if name == '.':
                continue
            if member.isdir():
                mode, content = stat.S_IFDIR | 0o755, b''
            elif member.isreg():
                mode = stat.S_IFREG | (member.mode & 0o777)
                content = archive.extractfile(member).read()
                expected = member.pax_headers.get('APK-TOOLS.checksum.SHA1')
                if expected and hashlib.sha1(content).hexdigest() != expected:
                    raise ValueError('APK file checksum mismatch')
            elif member.issym():
                mode, content = stat.S_IFLNK | 0o777, safe_link(name, member.linkname).encode()
            elif member.islnk():
                hardlinks.append((name, safe_path(member.linkname)))
                continue
            else:
                raise ValueError('unsupported special archive entry')
            old = entries.get(name)
            if old and old != (mode, content) and not stat.S_ISDIR(mode):
                raise ValueError('conflicting package file: ' + name)
            entries[name] = mode, content
    for name, target in hardlinks:
        if target not in entries or not stat.S_ISREG(entries[target][0]):
            raise ValueError('invalid archive hardlink')
        entries[name] = entries[target]


def stage_entries(entries: dict, root: Path, epoch: int) -> None:
    """Create files first and validated symlinks last; never follow guest links."""
    if root.exists():
        raise ValueError('refusing to overwrite an existing staging root')
    root.mkdir(parents=True)
    for name, (mode, _) in list(entries.items()):
        safe_path(name)
        for parent in PurePosixPath(name).parents:
            key = str(parent)
            if key == '.':
                continue
            if key in entries and not stat.S_ISDIR(entries[key][0]):
                raise ValueError('archive entry has a non-directory ancestor')
            entries.setdefault(key, (stat.S_IFDIR | 0o755, b''))
    for name in sorted(entries, key=lambda n: (len(PurePosixPath(n).parts), n)):
        mode, content = entries[name]
        destination = root / name
        if stat.S_ISDIR(mode):
            destination.mkdir(exist_ok=True)
            destination.chmod(mode & 0o7777)
        elif stat.S_ISREG(mode):
            with destination.open('xb') as file:
                file.write(content)
            destination.chmod(mode & 0o777)
    for name, (mode, content) in entries.items():
        if stat.S_ISLNK(mode):
            os.symlink(safe_link(name, content.decode()), root / name)
    for name in sorted(entries, reverse=True):
        os.utime(root / name, (epoch, epoch), follow_symlinks=False)
    os.utime(root, (epoch, epoch))
