#!/usr/bin/env python3
"""Resolve explicitly downloaded, signed indexes into reviewable version locks."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import apk

REPO = Path(__file__).resolve().parents[2]
DIRECTORY = REPO / 'runtime-environments'
DOWNLOADS = REPO / '.build/runtime-environments/packages/downloads'
FAMILIES = {
    'python': ('3.21', ['python3', 'py3-pip'], 'python3', 'Python', 128, 512, 'usr/bin/python3', {}),
    'java': ('3.23', ['openjdk21-jdk'], 'openjdk21-jdk', 'Java 21', 1024, 1024, 'usr/bin/java',
             {'usr/bin/java': '../lib/jvm/java-21-openjdk/bin/java', 'usr/bin/javac': '../lib/jvm/java-21-openjdk/bin/javac'}),
    'go': ('3.23', ['go'], 'go', 'Go', 1024, 1024, 'usr/bin/go', {}),
    'rust': ('3.23', ['rust', 'cargo'], 'rust', 'Rust', 2048, 1024, 'usr/bin/rustc', {}),
    'node': ('3.23', ['nodejs', 'npm'], 'nodejs', 'Node.js', 512, 768, 'usr/bin/node', {}),
    'bun': ('3.23', ['libgcc', 'libstdc++'], None, 'Bun', 512, 1024, 'usr/bin/bun', {}),
}


def resolve(family: str) -> dict:
    branch, roots, primary, display, disk_mib, memory, entrypoint, links = FAMILIES[family]
    records, indexes = {}, []
    for repository in ['main', 'community']:
        filename = ('' if branch == '3.21' else 'v' + branch + '-') + repository + '-APKINDEX.tar.gz'
        path = DOWNLOADS / filename
        parsed, signer = apk.read_index(path, DIRECTORY / 'keys', DOWNLOADS / ('index-check-' + branch + '-' + repository))
        for name, record in parsed.items():
            if name in records:
                raise ValueError('ambiguous package in repositories')
            records[name] = {**record, 'repository': repository}
        indexes.append({'url': f'https://dl-cdn.alpinelinux.org/alpine/v{branch}/{repository}/x86_64/APKINDEX.tar.gz',
                        'bytes': path.stat().st_size, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'signature_key': signer})
    previous_path = DIRECTORY / (family + '.lock.json')
    previous = json.loads(previous_path.read_text()) if previous_path.exists() else {}
    old_packages = {(p['name'], p['version'], p['url'], p['control_checksum']): p for p in previous.get('packages', [])}
    selected = apk.closure(records, roots)
    packages = []
    for name in selected:
        record = records[name]
        filename = name + '-' + record['V'] + '.apk'
        source_path = record['repository'] + '/' + record['o']
        packages.append({'name': name, 'version': record['V'], 'filename': filename,
                         'url': f'https://dl-cdn.alpinelinux.org/alpine/v{branch}/{record["repository"]}/x86_64/{filename}',
                         'package_bytes': int(record['S']), 'installed_bytes': int(record['I']),
                         'control_checksum': record['C'], 'license': record.get('L', ''),
                         'dependencies': record.get('D', '').split(),
                         'source_origin': record['o'], 'source_commit': record['c'],
                         'source_recipe_url': f'https://raw.githubusercontent.com/alpinelinux/aports/{record["c"]}/{source_path}/APKBUILD',
                         'source_tree_url': f'https://github.com/alpinelinux/aports/tree/{record["c"]}/{source_path}'})
    for package in packages:
        old = old_packages.get((package['name'], package['version'], package['url'], package['control_checksum']), {})
        for field in ['sha256', 'source_recipe_sha256']:
            if field in old:
                package[field] = old[field]
    version = records[primary]['V'].rsplit('-r', 1)[0] if primary else '1.4.0'
    environment_id = family + '-' + re.sub('[^a-z0-9]+', '-', version.lower()) + '-alpine' + branch.replace('.', '-') + '-amd64'
    lock = {'schema_version': 1, 'environment_id': environment_id, 'family': family, 'display_name': display,
            'version': version, 'architecture': 'x86_64',
            'kernel_sha256': '1e6bf9027720c75c3ed0d79171f21b5791ee40ca9795d07c7c6e04dc5ea2ae90',
            'minimum_memory_mib': memory, 'disk_mib': disk_mib, 'entrypoint': entrypoint, 'entry_links': links,
            'alpine_version': branch, 'indexes': indexes, 'packages': packages,
            'minimum_scratch_bytes': 48 * 1024 * 1024,
            'verification_status': 'built_artifacts_require_current_rish_execution', 'extra_archives': []}
    if family == 'bun':
        release = json.loads((DOWNLOADS / 'bun-release.json').read_text())
        if release.get('tag_name') != 'bun-v1.4.0':
            raise ValueError('unexpected Bun release')
        asset = next(a for a in release['assets'] if a['name'] == 'bun-linux-x64-musl-baseline.zip')
        digest = asset.get('digest', '')
        if not re.fullmatch('sha256:[0-9a-f]{64}', digest):
            raise ValueError('official Bun release does not provide a usable digest')
        lock['extra_archives'].append({'kind': 'bun-official-zip', 'filename': asset['name'], 'url': asset['browser_download_url'],
                                      'bytes': asset['size'], 'sha256': digest.removeprefix('sha256:'),
                                      'digest_source_url': 'https://api.github.com/repos/oven-sh/bun/releases/tags/bun-v1.4.0',
                                      'member': 'bun-linux-x64-musl-baseline/bun',
                                      'binary_sha256': '805ecd8b91244de1c14d8d7e24841add8cb15c4eefffd17ce3d93cb87b3162ed',
                                      'license': 'MIT and bundled dependency licenses',
                                      'source_tree_url': 'https://github.com/oven-sh/bun/tree/bun-v1.4.0'})
    (DIRECTORY / (family + '.lock.json')).write_text(json.dumps(lock, indent=2) + '\n')
    print(json.dumps({'family': family, 'version': version, 'packages': len(packages),
                      'download_bytes': sum(p['package_bytes'] for p in packages) + sum(a['bytes'] for a in lock['extra_archives']),
                      'installed_bytes': sum(p['installed_bytes'] for p in packages), 'disk_mib': disk_mib}))
    return lock


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('families', nargs='+', choices=list(FAMILIES))
    for family in parser.parse_args().families:
        resolve(family)
