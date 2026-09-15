"""Normalize metadata in freshly built, checksum-free 32-bit ext4 images only.

Field layout: https://www.kernel.org/doc/html/latest/filesystems/ext4/inodes.html
No file contents, extents, allocation maps or directory entries are changed.
"""
import mmap
from pathlib import Path
import struct


def available_bytes(path: Path) -> int:
    """Read actual free blocks after packing, rather than estimating payload size."""
    with path.open('rb') as file:
        file.seek(1024)
        superblock = file.read(1024)
    if len(superblock) != 1024 or struct.unpack_from('<H', superblock, 56)[0] != 0xEF53:
        raise ValueError('invalid ext4 superblock')
    u32 = lambda offset: struct.unpack_from('<I', superblock, offset)[0]
    if u32(96) & 0x80:
        raise ValueError('unsupported 64bit ext4 free-space layout')
    if u32(24) != 2:
        raise ValueError('unsupported ext4 block size')
    block_size = 4096
    blocks, reserved, free = u32(4), u32(8), u32(12)
    if block_size != 4096 or blocks * block_size != path.stat().st_size or not reserved <= free <= blocks:
        raise ValueError('invalid ext4 free-space geometry')
    return (free - reserved) * block_size


def normalize_metadata(path: Path, epoch: int) -> None:
    with path.open('r+b') as file, mmap.mmap(file.fileno(), 0) as disk:
        if not 1 << 20 <= len(disk) <= 4 << 30:
            raise ValueError('unsupported ext4 disk size')
        superblock = 1024
        u32 = lambda offset: struct.unpack_from('<I', disk, superblock + offset)[0]
        u16 = lambda offset: struct.unpack_from('<H', disk, superblock + offset)[0]
        if u16(56) != 0xEF53 or u32(72) != 0:
            raise ValueError('expected Linux ext4 superblock')
        incompat, ro_compat = u32(96), u32(100)
        # This builder disables metadata_csum, 64bit, meta_bg and EA_INODE.
        # Refuse foreign formats instead of editing checksummed metadata blindly.
        if incompat & (0x80 | 0x10 | 0x400) or ro_compat & 0x400:
            raise ValueError('unsupported ext4 metadata checksum/layout features')
        blocksize = 1024 << u32(24)
        inode_size = u16(88)
        if blocksize != 4096 or inode_size != 256:
            raise ValueError('unsupported ext4 block or inode size')
        blocks, blocks_per_group, inodes_per_group = u32(4), u32(32), u32(40)
        if blocks * blocksize != len(disk) or not blocks_per_group or not inodes_per_group:
            raise ValueError('invalid ext4 geometry')
        groups = (blocks + blocks_per_group - 1) // blocks_per_group
        inodes = u32(0)
        if not 1 <= groups <= 32768 or not 1 <= inodes <= groups * inodes_per_group:
            raise ValueError('invalid ext4 inode geometry')
        for group in range(groups):
            descriptor = blocksize + group * 32
            bitmap_block, table_block = struct.unpack_from('<II', disk, descriptor + 4)
            bitmap = bitmap_block * blocksize
            table = table_block * blocksize
            count = min(inodes_per_group, inodes - group * inodes_per_group)
            if count < 0 or bitmap + (count + 7) // 8 > len(disk) or table + count * inode_size > len(disk):
                raise ValueError('ext4 metadata lies outside disk')
            for local in range(count):
                if not disk[bitmap + local // 8] & (1 << (local % 8)):
                    continue
                offset = table + local * inode_size
                if struct.unpack_from('<H', disk, offset)[0] == 0:
                    continue
                if struct.unpack_from('<I', disk, offset + 0x20)[0] & 0x200000:
                    raise ValueError('EA inode metadata is unsupported')
                for field in [0x02, 0x18, 0x78, 0x7A]:
                    struct.pack_into('<H', disk, offset + field, 0)
                for field in [0x08, 0x0C, 0x10]:
                    struct.pack_into('<I', disk, offset + field, epoch)
                extra_size = struct.unpack_from('<H', disk, offset + 0x80)[0]
                if extra_size >= 24:
                    for field in [0x84, 0x88, 0x8C, 0x94]:
                        struct.pack_into('<I', disk, offset + field, 0)
                    struct.pack_into('<I', disk, offset + 0x90, epoch)
        disk.flush()
