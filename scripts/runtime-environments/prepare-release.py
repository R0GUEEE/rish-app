#!/usr/bin/env python3
"""Freeze verified runtime hashes and build source-material bundles without publishing."""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import build

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.build/runtime-environments/packages'
RELEASE = OUT / 'publication'
PART_LIMIT = 1800 * 1024 * 1024
FAMILIES = ['python', 'java', 'go', 'rust', 'node', 'bun']


def digest(path):
    result = hashlib.sha256()
    with path.open('rb') as file:
        while chunk := file.read(1024 * 1024): result.update(chunk)
    return result.hexdigest()


def public_evidence(value):
    if isinstance(value, dict):
        return {key: public_evidence(item) for key, item in value.items()
                if key not in {'library_path', 'result_bundle', 'execution_evidence'} and
                not (isinstance(item, str) and item.startswith(('/Users/', '/var/')))}
    if isinstance(value, list): return [public_evidence(item) for item in value]
    return value


class HashedReader:
    def __init__(self, file): self.file, self.sha = file, hashlib.sha256()
    def read(self, size=-1):
        data = self.file.read(size); self.sha.update(data); return data


def main():
    RELEASE.mkdir(parents=True, exist_ok=True)
    inputs, seen, missing = [], set(), []
    packages = []
    def include(path, name, kind, provenance=None):
        path = Path(path)
        if not path.is_file() or path.is_symlink():
            missing.append({'name': name, 'reason': 'regular input file unavailable'}); return
        if name in seen: raise ValueError('duplicate source bundle filename')
        seen.add(name)
        entry = {'path': str(path.resolve()), 'name': name, 'kind': kind,
                 'bytes': path.stat().st_size, 'sha256': digest(path)}
        if provenance:
            entry['provenance'] = provenance
            if provenance.get('expected_sha256') and provenance['expected_sha256'] != entry['sha256']:
                raise ValueError('source digest no longer matches its verification receipt')
            if provenance.get('sha512'):
                sha512 = hashlib.sha512()
                with path.open('rb') as file:
                    while chunk := file.read(1024 * 1024): sha512.update(chunk)
                if sha512.hexdigest() != provenance['sha512']:
                    raise ValueError('Alpine source no longer matches signed-recipe checksum')
        inputs.append(entry)

    for family in FAMILIES:
        receipt = json.loads((OUT / (family + '.build.json')).read_text())
        proof = json.loads(Path(receipt['execution_evidence']).read_text())
        if not receipt['execution_verified'] or not proof['execution_verified'] or proof['source_disk_sha256'] != receipt['manifest']['disk_sha256']:
            raise ValueError('runtime lacks matching real execution evidence: ' + family)
        path = Path(receipt['package_path'])
        if path.stat().st_size != receipt['package_bytes'] or digest(path) != receipt['package_sha256']:
            raise ValueError('frozen runtime artifact changed: ' + family)
        packages.append({'manifest': receipt['manifest'], 'package_path': str(path), 'filename': path.name,
                         'package_sha256': receipt['package_sha256'], 'package_bytes': receipt['package_bytes'],
                         'execution_evidence': receipt['execution_evidence']})
        evidence = RELEASE / (family + '-execution.json')
        evidence.write_text(json.dumps(public_evidence(proof), indent=2) + '\n')
        include(evidence, 'evidence/' + evidence.name, 'real_execution_evidence')
    alpine = json.loads((OUT / 'source-archives/manifest.json').read_text())
    if not alpine.get('all_literal_sources_retained'):
        missing.append({'component': 'Alpine', 'reason': 'source collection incomplete'})
    for item in alpine['items']:
        if not item['retained']:
            missing.append({'component': item['filename'], 'reason': 'source absent'}); continue
        include(item['path'], 'sources/alpine/' + item['sha512'][:24] + '-' + item['filename'], 'alpine_source_or_patch',
                {'sha512': item['sha512'], 'official_urls': item['urls'], 'references': item['references']})
    recipes = json.loads((OUT / 'sources/manifest.json').read_text())
    for recipe in recipes['recipes']:
        if not recipe['retained']:
            missing.append({'component': recipe['origin'], 'reason': 'recipe absent'}); continue
        include(recipe['path'], 'recipes/' + recipe['origin'] + '-' + recipe['commit'] + '/APKBUILD', 'source_build_recipe',
                {'url': recipe['url'], 'commit': recipe['commit'], 'expected_sha256': recipe['sha256']})
    bun = json.loads((OUT / 'source-archives/bun/manifest.json').read_text())['items'][0]
    if not bun['retained']: missing.append({'component': 'Bun', 'reason': 'Bun tag source absent'})
    else: include(bun['path'], 'sources/bun/' + Path(bun['path']).name, 'bun_source', {'commit': bun['commit'], 'url': bun['url'], 'expected_sha256': bun['sha256']})
    webkit = json.loads((OUT / 'source-archives/webkit-git/archive-receipt.json').read_text())
    if not webkit['jsc_build_sources_retained'] or webkit['jsc_source_files'] < 1000:
        missing.append({'component': 'WebKit/JSC', 'reason': 'actual JSC source/build closure unavailable'})
    else:
        include(webkit['path'], 'sources/bun/' + Path(webkit['path']).name, 'webkit_jsc_source',
                {**{key: webkit[key] for key in ['commit', 'scope', 'verified_blob_count', 'jsc_source_files', 'full_web_browser_source']}, 'expected_sha256': webkit['sha256']})
        include(OUT / 'source-archives/webkit-git/source-blobs.json', 'provenance/webkit-git-blobs.json', 'git_blob_inventory')
    icu = json.loads((OUT / 'source-archives/bun/icu-source-receipt.json').read_text())
    if not icu['retained']: missing.append({'component': 'Bun ICU', 'reason': 'pinned ICU source absent'})
    else: include(icu['path'], 'sources/bun/' + Path(icu['path']).name, 'icu_source', {'url': icu['url'], 'expected_sha256': icu['expected_sha256']})
    extras = json.loads((OUT / 'source-archives/bun-extra/manifest.json').read_text())
    if not extras['complete']: missing.append({'component': 'Bun dependencies', 'reason': 'fixed Git/Cargo source closure incomplete'})
    for item in extras['items']:
        if not item['retained']:
            missing.append({'component': item['name'], 'reason': 'dependency source absent'}); continue
        include(item['path'], 'sources/bun-dependencies/' + item['filename'], item['kind'],
                {**{key: item[key] for key in ['name', 'url', 'commit', 'version', 'identity'] if key in item}, 'expected_sha256': item['sha256']})
    headers = json.loads((OUT / 'source-archives/bun-extra/node-headers-source-receipt.json').read_text())
    if not headers['retained']: missing.append({'component': 'Bun Node headers', 'reason': 'pinned Node API headers absent'})
    else: include(headers['path'], 'sources/bun-dependencies/' + Path(headers['path']).name, 'node_api_headers',
                  {'url': headers['url'], 'checksum_source': headers['checksum_source'], 'expected_sha256': headers['sha256']})
    include(OUT / 'downloads/go-stdlib-cache-1.25.10-amd64.tar.gz', 'derived/go-stdlib-cache-1.25.10-amd64.tar.gz', 'reproducible_build_input')
    include(OUT / 'go-cache-receipt.json', 'provenance/go-cache-receipt.json', 'cache_build_provenance')
    for path in sorted((ROOT / 'runtime-environments').rglob('*')):
        if path.is_file() and not path.is_symlink(): include(path, 'rish-build/runtime-environments/' + str(path.relative_to(ROOT / 'runtime-environments')), 'runtime_build_lock_or_notice')
    for path in sorted((ROOT / 'scripts/runtime-environments').glob('*.py')):
        include(path, 'rish-build/scripts/runtime-environments/' + path.name, 'runtime_build_tool')
    include(ROOT / 'scripts/tests/runtime-environments-test.py', 'rish-build/scripts/tests/runtime-environments-test.py', 'build_tool_tests')
    (RELEASE / 'missing-materials.json').write_text(json.dumps(missing, indent=2) + '\n')
    if missing: raise ValueError('source materials remain missing; see missing-materials.json')

    components = []
    for family in FAMILIES:
        lock = json.loads((ROOT / 'runtime-environments' / (family + '.lock.json')).read_text())
        components.append({'family': family, 'version': lock['version'], 'packages': [
            {key: package[key] for key in ['name', 'version', 'license', 'source_origin', 'source_commit', 'source_tree_url']}
            for package in lock['packages']]})
    license_file = RELEASE / 'COMPONENTS.json'; license_file.write_text(json.dumps(components, indent=2) + '\n')
    include(license_file, 'COMPONENTS.json', 'component_license_and_source_index')
    notice = '''Rish runtime environment source and build materials\n\nThese materials correspond to the six exact runtime package hashes in\nMANIFEST.json. Upstream license notices and source archive contents are\nretained. COMPONENTS.json lists Alpine component versions and license\nidentifiers; original upstream terms are included in their source archives.\n\nBun materials include its fixed source commit, pinned Git dependencies,\nCargo.lock checksum-verified crates, Node API headers, and ICU sources.\nThe WebKit archive covers the JSCOnly build: JavaScriptCore, WTF, bmalloc,\nThirdParty, CMake, ICU patches/data scripts and build configuration/tools.\nIts exact scope and every included Git blob are recorded. The web-browser\nWebCore/WebKit implementation is outside this JSCOnly source archive.\n\nThe Go standard-library cache was generated with the same Linux/amd64\ntoolchain in a network-disabled QEMU build VM. QEMU was used for cache\ngeneration/export only. Runtime execution evidence comes from the real\nrish interpreter and the Rish iOS Simulator application as identified\nper language. Java and Go compilation can take several minutes.\n\nBuild scripts and fixed dependency locks are included under rish-build/.\nEach archive or patch keeps its original bytes and a recorded checksum.\n'''
    (RELEASE / 'NOTICE.txt').write_text(notice)
    public_inputs = [{key: value for key, value in item.items() if key != 'path'} for item in inputs]
    manifest = {'schema_version': 1, 'runtime_packages': [{key: value for key, value in p.items()
                    if key not in {'package_path', 'execution_evidence'}} for p in packages],
                'materials': public_inputs, 'missing_materials': [], 'notice': 'NOTICE.txt'}
    manifest_bytes = (json.dumps(manifest, indent=2) + '\n').encode()
    (RELEASE / 'MANIFEST.json').write_bytes(manifest_bytes)
    groups, current, current_size = [], [], len(manifest_bytes) + len(notice.encode()) + 16 * 1024 * 1024
    for item in sorted(inputs, key=lambda i: i['name']):
        padded = ((item['bytes'] + 511) // 512) * 512 + 2048
        if current and current_size + padded > PART_LIMIT:
            groups.append(current); current = []; current_size = len(manifest_bytes) + len(notice.encode()) + 16 * 1024 * 1024
        if current_size + padded > PART_LIMIT: raise ValueError('single source input exceeds bundle part limit')
        current.append(item); current_size += padded
    if current: groups.append(current)
    bundles = []
    for number, group in enumerate(groups, 1):
        name = f'rish-runtime-source-materials-2026-09-15-part{number:02d}.tar'
        destination = RELEASE / name; temporary = destination.with_suffix('.tar.partial')
        with tarfile.open(temporary, 'w', format=tarfile.PAX_FORMAT) as archive:
            for label, data in [('MANIFEST.json', manifest_bytes), ('NOTICE.txt', notice.encode())]:
                info = tarfile.TarInfo(label); info.size = len(data); info.mode = 0o644; info.mtime = build.EPOCH
                archive.addfile(info, io.BytesIO(data))
            for item in group:
                info = tarfile.TarInfo(item['name']); info.size = item['bytes']; info.mode = 0o644; info.mtime = build.EPOCH
                with Path(item['path']).open('rb') as file:
                    status = os.fstat(file.fileno())
                    if not stat.S_ISREG(status.st_mode) or status.st_size != item['bytes']: raise ValueError('source input changed')
                    checked = HashedReader(file); archive.addfile(info, checked)
                    if checked.sha.hexdigest() != item['sha256']: raise ValueError('source changed while bundling')
        if temporary.stat().st_size >= 2 * 1024 ** 3: raise ValueError('source bundle exceeds 2 GiB')
        temporary.replace(destination)
        bundles.append({'file': str(destination), 'filename': name, 'bytes': destination.stat().st_size,
                        'sha256': digest(destination), 'material_count': len(group)})
    publication = {'schema_version': 1, 'runtime_packages': packages, 'source_bundles': bundles,
                   'manifest': str(RELEASE / 'MANIFEST.json'), 'notice': str(RELEASE / 'NOTICE.txt'),
                   'missing_materials': [], 'urls_assigned': False, 'published': False}
    (RELEASE / 'publication-input.json').write_text(json.dumps(publication, indent=2) + '\n')
    (RELEASE / 'source-bundles.json').write_text(json.dumps(bundles, indent=2) + '\n')
    print(json.dumps({'source_bundles': bundles, 'runtime_packages': len(packages), 'missing_materials': []}, indent=2), flush=True)


if __name__ == '__main__': main()
