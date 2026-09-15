#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import stat
import unittest

spec = importlib.util.spec_from_file_location(
    'guest_modules', Path(__file__).resolve().parents[1] / 'refresh-guest-modules.py')
guest_modules = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest_modules)


class GuestModuleRefreshTests(unittest.TestCase):
    def test_preserves_binary_files_modes_and_symlink_payloads(self):
        entries = {
            'bin': (stat.S_IFDIR | 0o755, b''),
            'bin/sh': (stat.S_IFLNK | 0o777, b'busybox'),
            'bin/busybox': (stat.S_IFREG | 0o755, bytes(range(256))),
            'offline/package.apk': (stat.S_IFREG | 0o644, b'\0\xff\nkeep original bytes'),
        }
        archive = guest_modules.pack(entries)
        self.assertEqual(guest_modules.members(archive), entries)
        self.assertEqual(len(archive) % 512, 0)
        extended = {**entries, 'lib/modules/ext4.ko': (stat.S_IFREG | 0o644, b'ELF test')}
        parsed = guest_modules.members(guest_modules.pack(extended))
        for path in entries:
            self.assertEqual(parsed[path], entries[path])

    def test_rejects_truncation_missing_trailer_and_unsafe_names(self):
        archive = guest_modules.pack({'safe': (stat.S_IFREG | 0o644, b'test')})
        for invalid in (archive[:109], archive[:117], b'not an archive'):
            with self.assertRaises(ValueError):
                guest_modules.members(invalid)
        for name in ('/absolute', '../outside', 'safe/../outside'):
            with self.assertRaises(ValueError):
                guest_modules.members(guest_modules.pack({name: (stat.S_IFREG | 0o644, b'test')}))


if __name__ == '__main__':
    unittest.main()
