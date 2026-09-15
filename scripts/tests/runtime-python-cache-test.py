#!/usr/bin/env python3
"""Validate packaged CPython caches using byte fixtures, never compiled code."""
import _imp
import copy
from pathlib import Path
import stat
import struct
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts/runtime-environments'))
import python_cache
import ext4


MAGIC = bytes.fromhex('cb0d0d0a')
CACHE_TAG = 'cpython-312'
REGULAR = stat.S_IFREG | 0o644
REQUIRED_PACKAGES = ('python3', 'python3-pyc', 'python3-pycache-pyc0', 'pyc')
SOURCE_PATH = 'usr/lib/python3.12/example.py'
CACHE_PATH = 'usr/lib/python3.12/__pycache__/example.cpython-312.pyc'


def cache_bytes(source):
    # The validator checks provenance, not marshal contents. A deliberately
    # non-code payload also prevents the fixture from depending on host Python.
    source_hash = _imp.source_hash(int.from_bytes(MAGIC, 'little'), source)
    return MAGIC + struct.pack('<I', 3) + source_hash + b'not-marshal-code'


def fixture():
    sources = {
        SOURCE_PATH: b'value = 123\n',
        'usr/lib/python3.12/example_package/__init__.py':
            '# source bytes matter: \u03bb\r\n'.encode('utf-8'),
    }
    entries = {}
    for path, source in sources.items():
        source_path = Path(path)
        cached = source_path.parent / '__pycache__' / (source_path.stem + '.' + CACHE_TAG + '.pyc')
        entries[path] = (REGULAR, source)
        entries[str(cached)] = (REGULAR, cache_bytes(source))
    lock = {
        'family': 'python',
        'version': '3.12.14',
        'packages': [{'name': name, 'version': '3.12.14-r0'} for name in REQUIRED_PACKAGES],
        'python_bytecode': {
            'cache_tag': CACHE_TAG,
            'magic_hex': MAGIC.hex(),
            'invalidation': 'checked-hash',
            'expected_stdlib_cache_files': len(sources),
        },
    }
    return entries, lock


class PythonCacheTests(unittest.TestCase):
    def test_accepts_checked_hash_caches_with_raw_source_bytes(self):
        entries, lock = fixture()
        original_entries, original_lock = copy.deepcopy(entries), copy.deepcopy(lock)
        self.assertEqual(python_cache.validate(entries, lock), {
            'cache_files': 2,
            'cache_tag': CACHE_TAG,
            'magic_hex': MAGIC.hex(),
            'invalidation': 'checked-hash',
        })
        self.assertEqual(entries, original_entries)
        self.assertEqual(lock, original_lock)

    def test_other_runtime_families_do_not_require_python_metadata(self):
        for family in ('java', 'go', 'rust', 'node', 'bun'):
            with self.subTest(family=family):
                self.assertIsNone(python_cache.validate({}, {'family': family}))

    def test_environment_build_revision_preserves_the_target_python_abi(self):
        entries, lock = fixture()
        lock['version'] = '3.12.14+cache.1'
        self.assertEqual(python_cache.validate(entries, lock)['cache_files'], 2)

    def test_rejects_source_change_even_when_size_is_unchanged(self):
        entries, lock = fixture()
        entries[SOURCE_PATH] = (REGULAR, b'value = 124\n')
        with self.assertRaises(ValueError):
            python_cache.validate(entries, lock)

    def test_rejects_altered_header_hash(self):
        entries, lock = fixture()
        mode, content = entries[CACHE_PATH]
        entries[CACHE_PATH] = (mode, content[:8] + bytes([content[8] ^ 1]) + content[9:])
        with self.assertRaises(ValueError):
            python_cache.validate(entries, lock)

    def test_rejects_timestamp_unchecked_hash_and_unknown_flag_bits(self):
        for flags in (0, 1, 2, 7, 0xffffffff):
            with self.subTest(flags=flags):
                entries, lock = fixture()
                mode, content = entries[CACHE_PATH]
                entries[CACHE_PATH] = (mode, content[:4] + struct.pack('<I', flags) + content[8:])
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_wrong_magic_even_with_a_hash_for_that_magic(self):
        entries, lock = fixture()
        other_magic = bytes.fromhex('a70d0d0a')
        source = entries[SOURCE_PATH][1]
        other_hash = _imp.source_hash(int.from_bytes(other_magic, 'little'), source)
        entries[CACHE_PATH] = (REGULAR, other_magic + struct.pack('<I', 3) + other_hash + b'x')
        with self.assertRaises(ValueError):
            python_cache.validate(entries, lock)

    def test_rejects_truncated_header_and_header_without_payload(self):
        for length in (0, 3, 4, 7, 8, 15, 16):
            with self.subTest(length=length):
                entries, lock = fixture()
                mode, content = entries[CACHE_PATH]
                entries[CACHE_PATH] = (mode, content[:length])
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_missing_source_instead_of_trusting_the_cache(self):
        entries, lock = fixture()
        del entries[SOURCE_PATH]
        with self.assertRaises(ValueError):
            python_cache.validate(entries, lock)

    def test_rejects_nonregular_source_and_cache_entries(self):
        for path in (SOURCE_PATH, CACHE_PATH):
            for kind in (stat.S_IFLNK, stat.S_IFDIR, stat.S_IFIFO):
                with self.subTest(path=path, kind=kind):
                    entries, lock = fixture()
                    entries[path] = (kind | 0o644, entries[path][1])
                    with self.assertRaises(ValueError):
                        python_cache.validate(entries, lock)

    def test_rejects_missing_cache_and_empty_cache_set(self):
        for remove_all in (False, True):
            with self.subTest(remove_all=remove_all):
                entries, lock = fixture()
                for path in list(entries):
                    if path == CACHE_PATH or (remove_all and path.endswith('.pyc')):
                        del entries[path]
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_count_mismatch_and_nonpositive_or_noninteger_count(self):
        for count in (0, -1, 1, 3, True, 2.0, '2'):
            with self.subTest(count=count):
                entries, lock = fixture()
                lock['python_bytecode']['expected_stdlib_cache_files'] = count
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_other_cache_tags_and_unapproved_cache_layouts(self):
        for path in (
            'usr/lib/python3.12/__pycache__/example.cpython-313.pyc',
            'usr/lib/python3.12/__pycache__/example.cpython-312.opt-1.pyc',
            'usr/lib/python3.12/example.pyc',
            'usr/lib/python3.12/example.cpython-312.pyc',
        ):
            with self.subTest(path=path):
                entries, lock = fixture()
                entries[path] = entries.pop(CACHE_PATH)
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_cache_outside_stdlib_even_with_matching_source(self):
        for prefix in ('usr/lib/python3.11', 'tmp', 'usr/share/python3.12'):
            with self.subTest(prefix=prefix):
                entries, lock = fixture()
                entries[prefix + '/example.py'] = entries.pop(SOURCE_PATH)
                entries[prefix + '/__pycache__/example.cpython-312.pyc'] = entries.pop(CACHE_PATH)
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_absolute_and_parent_traversal_cache_paths(self):
        for prefix in ('/usr/lib/python3.12', '../usr/lib/python3.12',
                       'usr/lib/python3.12/../python3.12'):
            with self.subTest(prefix=prefix):
                entries, lock = fixture()
                entries[prefix + '/example.py'] = entries.pop(SOURCE_PATH)
                entries[prefix + '/__pycache__/example.cpython-312.pyc'] = entries.pop(CACHE_PATH)
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_missing_or_incompatible_bytecode_metadata(self):
        entries, lock = fixture()
        del lock['python_bytecode']
        with self.assertRaises(ValueError):
            python_cache.validate(entries, lock)
        for key, value in (('cache_tag', 'cpython-313'), ('magic_hex', 'a70d0d0a'),
                           ('invalidation', 'timestamp')):
            with self.subTest(key=key):
                entries, lock = fixture()
                lock['python_bytecode'][key] = value
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_requires_every_explicit_cache_package(self):
        for missing in REQUIRED_PACKAGES:
            with self.subTest(missing=missing):
                entries, lock = fixture()
                lock['packages'] = [item for item in lock['packages'] if item['name'] != missing]
                with self.assertRaises(ValueError):
                    python_cache.validate(entries, lock)

    def test_rejects_package_version_drift_including_revision(self):
        for name in REQUIRED_PACKAGES:
            for version in ('3.12.13-r0', '3.12.14-r1'):
                with self.subTest(name=name, version=version):
                    entries, lock = fixture()
                    for item in lock['packages']:
                        if item['name'] == name:
                            item['version'] = version
                    with self.assertRaises(ValueError):
                        python_cache.validate(entries, lock)

    def test_rejects_lock_version_that_disagrees_with_the_package_set(self):
        entries, lock = fixture()
        lock['version'] = '3.12.13'
        with self.assertRaises(ValueError):
            python_cache.validate(entries, lock)


class PythonCacheDiskSpaceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.path = Path(self.temporary.name) / 'runtime.ext4'

    def tearDown(self):
        self.temporary.cleanup()

    def write_disk(self, blocks=256, reserved=12, free=200, log_block_size=2, incompat=0):
        disk = bytearray(1024 * 1024)
        for offset, value in ((4, blocks), (8, reserved), (12, free),
                              (24, log_block_size), (96, incompat)):
            struct.pack_into('<I', disk, 1024 + offset, value)
        struct.pack_into('<H', disk, 1024 + 56, 0xEF53)
        self.path.write_bytes(disk)
        return bytes(disk)

    def test_available_space_excludes_reserved_blocks_without_mutating_the_disk(self):
        original = self.write_disk()
        self.assertEqual(ext4.available_bytes(self.path), 188 * 4096)
        self.assertEqual(self.path.read_bytes(), original)

    def test_full_disk_reports_zero_available_bytes(self):
        for reserved in (0, 12):
            with self.subTest(reserved=reserved):
                self.write_disk(reserved=reserved, free=reserved)
                self.assertEqual(ext4.available_bytes(self.path), 0)

    def test_rejects_free_blocks_outside_the_declared_geometry(self):
        for values in ({'blocks': 255}, {'blocks': 257}, {'free': 257},
                       {'reserved': 201}, {'free': 0, 'reserved': 1}):
            with self.subTest(values=values):
                self.write_disk(**values)
                with self.assertRaises(ValueError):
                    ext4.available_bytes(self.path)

    def test_rejects_unsupported_block_sizes_including_overflow_sized_exponent(self):
        for exponent in (0, 1, 3, 31, 0xffffffff):
            with self.subTest(exponent=exponent):
                self.write_disk(log_block_size=exponent)
                with self.assertRaises(ValueError):
                    ext4.available_bytes(self.path)

    def test_rejects_64bit_layout_instead_of_using_only_low_block_counts(self):
        self.write_disk(incompat=0x80)
        with self.assertRaises(ValueError):
            ext4.available_bytes(self.path)

    def test_rejects_bad_magic_and_incomplete_superblock(self):
        disk = bytearray(self.write_disk())
        struct.pack_into('<H', disk, 1024 + 56, 0)
        self.path.write_bytes(disk)
        with self.assertRaises(ValueError):
            ext4.available_bytes(self.path)
        for size in (0, 1024, 2047):
            with self.subTest(size=size):
                disk = self.write_disk()
                self.path.write_bytes(disk[:size])
                with self.assertRaises(ValueError):
                    ext4.available_bytes(self.path)


if __name__ == '__main__':
    unittest.main(verbosity=2)
