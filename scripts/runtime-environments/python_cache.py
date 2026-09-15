"""Validate official CPython bytecode as data; never load or execute a .pyc."""
import _imp
from pathlib import PurePosixPath
import re
import stat
import struct


def validate(entries: dict, lock: dict) -> dict | None:
    if lock.get('family') != 'python':
        return None
    policy = lock.get('python_bytecode')
    expected_keys = {'cache_tag', 'magic_hex', 'invalidation', 'expected_stdlib_cache_files'}
    if not isinstance(policy, dict) or set(policy) != expected_keys:
        raise ValueError('Python requires an explicit bytecode validation policy')
    count = policy['expected_stdlib_cache_files']
    if (policy['cache_tag'] != 'cpython-312' or policy['magic_hex'] != 'cb0d0d0a'
            or policy['invalidation'] != 'checked-hash' or type(count) is not int
            or not 1 <= count <= 10000):
        raise ValueError('unsupported Python bytecode policy')
    version = lock.get('version', '').split('+', 1)[0]
    if not re.fullmatch(r'3\.12\.\d+', version):
        raise ValueError('Python bytecode policy requires CPython 3.12')
    packages = {p['name']: p['version'] for p in lock.get('packages', [])}
    runtime_version = packages.get('python3', '')
    required = ['python3-pyc', 'python3-pycache-pyc0', 'pyc']
    if (not runtime_version.startswith(version + '-r')
            or any(packages.get(name) != runtime_version for name in required)):
        raise ValueError('Python requires matching explicit official pyc packages')
    magic = bytes.fromhex(policy['magic_hex'])
    prefix = 'usr/lib/python3.12/'
    checked = 0
    for name, (mode, data) in entries.items():
        if not name.endswith('.pyc'):
            continue
        path = PurePosixPath(name)
        suffix = '.' + policy['cache_tag'] + '.pyc'
        if (not stat.S_ISREG(mode) or not name.startswith(prefix)
                or path.parent.name != '__pycache__' or not path.name.endswith(suffix)
                or '..' in path.parts):
            raise ValueError('unexpected Python cache path, tag or file type: ' + name)
        if len(data) <= 16 or data[:4] != magic or struct.unpack_from('<I', data, 4)[0] != 3:
            raise ValueError('Python cache requires matching magic and checked-hash header: ' + name)
        source_name = str(path.parent.parent / (path.name.removesuffix(suffix) + '.py'))
        source = entries.get(source_name)
        if source is None or not stat.S_ISREG(source[0]):
            raise ValueError('Python cache has no regular matching source: ' + name)
        # The official checked-hash header remains valid after reproducible
        # filesystem timestamp normalization. Its key is the target magic,
        # never the host interpreter's magic; no marshal payload is evaluated.
        if _imp.source_hash(int.from_bytes(magic, 'little'), source[1]) != data[8:16]:
            raise ValueError('Python cache source hash mismatch: ' + name)
        checked += 1
    if checked != count:
        raise ValueError('Python cache file count differs from locked expectation')
    return {'cache_files': checked, 'cache_tag': policy['cache_tag'],
            'magic_hex': policy['magic_hex'], 'invalidation': policy['invalidation']}
