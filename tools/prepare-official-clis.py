#!/usr/bin/env python3
"""Download, verify, and stage the optional official Android CLI binaries.

The output is an Android jniLibs directory. Files are copied byte-for-byte;
the .so names are packaging names only, allowing AGP to extract executables
into ApplicationInfo.nativeLibraryDir. This script never writes into source.
"""

import argparse
import base64
import hashlib
import json
import os
import pathlib
import shutil
import tarfile
import tempfile
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
MANIFEST = ROOT / "official-cli-manifest.json"


def sha512(path: pathlib.Path) -> bytes:
    digest = hashlib.sha512()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.digest()


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def download(url: str, destination: pathlib.Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(url, timeout=60) as source, destination.open("wb") as target:
        shutil.copyfileobj(source, target, length=1024 * 1024)


def verify_integrity(path: pathlib.Path, integrity: str) -> None:
    algorithm, encoded = integrity.split("-", 1)
    if algorithm != "sha512" or base64.b64encode(sha512(path)).decode() != encoded:
        raise SystemExit(f"integrity mismatch: {path}")


def safe_extract_tar(archive: pathlib.Path, destination: pathlib.Path) -> None:
    with tarfile.open(archive) as tar:
        for member in tar.getmembers():
            target = (destination / member.name).resolve()
            if not str(target).startswith(str(destination.resolve()) + os.sep):
                raise SystemExit(f"unsafe archive path: {member.name}")
            if member.issym() or member.islnk():
                raise SystemExit(f"links are not accepted in CLI archive: {member.name}")
            if not member.isdir() and not member.isfile():
                raise SystemExit(f"special archive member is not accepted: {member.name}")
        # All paths and member types were validated above. Avoid the newer
        # `filter=` parameter so the script remains usable with Python 3.9.
        tar.extractall(destination)


def verify_aarch64_elf(path: pathlib.Path) -> None:
    header = path.read_bytes()[:20]
    # ELF64 little endian, EM_AARCH64 (183).
    if len(header) < 20 or header[:4] != b"\x7fELF" or header[4] != 2 or header[5] != 1 or header[18:20] != b"\xb7\x00":
        raise SystemExit(f"expected unmodified aarch64 ELF: {path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=pathlib.Path, required=True, help="jniLibs root")
    parser.add_argument("--cache", type=pathlib.Path, help="download cache (default: output/.downloads)")
    parser.add_argument("--manifest", type=pathlib.Path, default=MANIFEST)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    if manifest.get("schema_version") != 1 or manifest.get("target") != "linux-arm64-musl":
        raise SystemExit("unsupported CLI manifest")
    cache = (args.cache or args.output / ".downloads").resolve()
    output = args.output.resolve()
    abi = output / "arm64-v8a"
    abi.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="rish-cli-prepare-") as temporary:
        staging = pathlib.Path(temporary)
        for package in manifest["packages"].values():
            archive = cache / pathlib.Path(package["tarball"]).name
            if not archive.exists():
                download(package["tarball"], archive)
            verify_integrity(archive, package["integrity"])
            safe_extract_tar(archive, staging / package["name"].replace("/", "_"))
            # The package name directory is deterministic and the binary path
            # is rooted at the extracted package directory.
            source = staging / package["name"].replace("/", "_") / package["binary"]
            verify_aarch64_elf(source)
            shutil.copyfile(source, abi / package["output"])
            os.chmod(abi / package["output"], 0o755)

        loader = manifest["musl_loader"]
        apk = cache / pathlib.Path(loader["url"]).name
        if not apk.exists():
            download(loader["url"], apk)
        if sha256(apk) != loader["apk_sha256"]:
            raise SystemExit(f"checksum mismatch: {apk}")
        # Alpine .apk files are gzip-compressed tar archives. Read just the
        # regular loader member so APK symlinks cannot enter the staging tree.
        source = staging / "ld-musl-aarch64.so.1"
        with tarfile.open(apk) as package:
            member = package.getmember(loader["binary"])
            if not member.isfile():
                raise SystemExit(f"loader is not a regular APK member: {loader['binary']}")
            extracted = package.extractfile(member)
            if extracted is None:
                raise SystemExit(f"loader could not be read: {loader['binary']}")
            with source.open("wb") as target:
                shutil.copyfileobj(extracted, target, length=1024 * 1024)
        if sha256(source) != loader["loader_sha256"]:
            raise SystemExit(f"loader checksum mismatch: {source}")
        verify_aarch64_elf(source)
        shutil.copyfile(source, abi / loader["output"])
        os.chmod(abi / loader["output"], 0o755)

    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(output)


if __name__ == "__main__":
    main()
