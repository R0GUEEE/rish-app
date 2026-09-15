"""Strict streaming RISHENV1 validator shared by build/release verification."""
import hashlib
import json
from pathlib import Path
import re
import struct
import zlib

MANIFEST_KEYS = {'schema_version', 'environment_id', 'family', 'display_name', 'version', 'architecture',
                 'kernel_sha256', 'disk_sha256', 'disk_bytes', 'minimum_memory_mib'}
FAMILIES = {'python', 'java', 'go', 'rust', 'bun', 'node'}


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate manifest key')
        result[key] = value
    return result


def validate_manifest(value):
    if not isinstance(value, dict) or set(value) != MANIFEST_KEYS:
        raise ValueError('manifest keys differ from v1 schema')
    for name in ['schema_version', 'disk_bytes', 'minimum_memory_mib']:
        if type(value[name]) is not int:
            raise ValueError('manifest integer field is invalid')
    if value['schema_version'] != 1 or value['architecture'] != 'x86_64' or value['family'] not in FAMILIES:
        raise ValueError('unsupported environment schema/architecture/family')
    if not isinstance(value['environment_id'], str) or not re.fullmatch('[a-z0-9][a-z0-9-]{0,95}', value['environment_id']):
        raise ValueError('invalid environment identifier')
    for name, limit in [('display_name', 80), ('version', 64)]:
        if not isinstance(value[name], str) or not 1 <= len(value[name]) <= limit or any(ord(c) < 32 for c in value[name]):
            raise ValueError('invalid environment text')
    for name in ['kernel_sha256', 'disk_sha256']:
        if not isinstance(value[name], str) or not re.fullmatch('[0-9a-f]{64}', value[name]):
            raise ValueError('invalid digest')
    if not 1 << 20 <= value['disk_bytes'] <= 4 << 30 or value['disk_bytes'] % 512:
        raise ValueError('invalid disk byte length')
    if not 256 <= value['minimum_memory_mib'] <= 1024:
        raise ValueError('invalid minimum memory')
    return value


def verify(path: Path, expected_kernel=None):
    size = path.stat().st_size
    if not 13 <= size <= 768 * 1024 * 1024:
        raise ValueError('invalid package byte length')
    outer = hashlib.sha256()
    disk_hash = hashlib.sha256()
    decoded = 0
    prefix = bytearray()
    with path.open('rb') as file:
        preamble = file.read(12); outer.update(preamble)
        if len(preamble) != 12 or preamble[:8] != b'RISHENV1':
            raise ValueError('invalid package magic')
        length = struct.unpack('>I', preamble[8:])[0]
        if not 1 <= length <= 16384:
            raise ValueError('invalid header length')
        header = file.read(length); outer.update(header)
        if len(header) != length:
            raise ValueError('truncated header')
        manifest = validate_manifest(json.loads(header.decode('utf-8'), object_pairs_hook=unique_object))
        if expected_kernel and manifest['kernel_sha256'] != expected_kernel:
            raise ValueError('kernel digest mismatch')
        inflate = zlib.decompressobj(31)
        while data := file.read(1024 * 1024):
            outer.update(data)
            if inflate.eof:
                raise ValueError('trailing package data')
            while data:
                block = inflate.decompress(data, min(1024 * 1024, manifest['disk_bytes'] - decoded + 1))
                if len(prefix) < 4096:
                    prefix.extend(block[:4096 - len(prefix)])
                decoded += len(block)
                if decoded > manifest['disk_bytes']:
                    raise ValueError('inflated disk exceeds manifest')
                disk_hash.update(block)
                if inflate.unused_data:
                    raise ValueError('concatenated gzip or trailing bytes')
                data = inflate.unconsumed_tail
        if not inflate.eof or decoded != manifest['disk_bytes']:
            raise ValueError('truncated or wrong-size disk')
    if disk_hash.hexdigest() != manifest['disk_sha256']:
        raise ValueError('disk SHA256 mismatch')
    if prefix[1080:1082] != b'\x53\xef':
        raise ValueError('missing ext4 magic')
    blocks = struct.unpack_from('<I', prefix, 1028)[0]
    log_block_size = struct.unpack_from('<I', prefix, 1048)[0]
    if log_block_size > 6 or blocks * (1024 << log_block_size) != decoded:
        raise ValueError('invalid ext4 block geometry')
    return {'manifest': manifest, 'package_sha256': outer.hexdigest(), 'package_bytes': size}
