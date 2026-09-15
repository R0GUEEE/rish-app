#!/usr/bin/env python3
"""Retain immutable official Alpine build recipes as data, without evaluating them."""
import argparse
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.build/runtime-environments/packages/sources'


def retain(package):
    identity = package['source_origin'] + '-' + package['source_commit']
    destination = OUT / identity / 'APKBUILD'
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        temporary = destination.with_suffix('.partial')
        run = subprocess.run(['curl', '--http1.1', '--fail', '--location', '--silent', '--show-error',
                              '--max-time', '60', '--retry', '2', '--retry-all-errors', '--max-filesize', '262144',
                              package['source_recipe_url'], '-o', str(temporary)], capture_output=True)
        if run.returncode:
            return {'origin': package['source_origin'], 'commit': package['source_commit'], 'url': package['source_recipe_url'], 'retained': False}
        temporary.replace(destination)
    blob = destination.read_bytes()
    return {'origin': package['source_origin'], 'commit': package['source_commit'],
            'url': package['source_recipe_url'], 'tree_url': package['source_tree_url'],
            'path': str(destination), 'sha256': hashlib.sha256(blob).hexdigest(),
            'bytes': len(blob), 'retained': True, 'executed': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-budget-mib', type=int, default=4032, help='archive network cap; reserve remaining 2 GiB for Bun/JSC')
    parser.add_argument('--archives', action='store_true', help='also fetch literal SHA512-locked tar/patch source data')
    parser.add_argument('families', nargs='+', choices=['python', 'java', 'go', 'rust', 'node', 'bun'])
    args = parser.parse_args()
    sources = {}
    for family in args.families:
        lock = json.loads((ROOT / 'runtime-environments' / (family + '.lock.json')).read_text())
        for package in lock['packages']:
            sources[(package['source_origin'], package['source_commit'])] = package
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(retain, sources.values()))
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / 'manifest.json').write_text(json.dumps({'schema_version': 1, 'recipes': results,
                                                 'upstream_source_archives_included': False,
                                                 'note': 'APKBUILD records upstream URLs, hashes and patches; scripts were not evaluated.'}, indent=2) + '\n')
    print(json.dumps({'retained': sum(x['retained'] for x in results), 'total': len(results)}))

    if args.archives:
        import sources as source_archives
        plan = source_archives.source_plan(OUT / 'manifest.json')
        target = source_archives.DEFAULT
        target.mkdir(parents=True, exist_ok=True)
        (target / 'plan.json').write_text(json.dumps(plan, indent=2) + '\n')
        print(json.dumps({'source_items': len(plan['items']), 'unresolved': len(plan['unresolved_recipe_items'])}), flush=True)
        collected = source_archives.collect(plan, total_bytes=args.source_budget_mib * 1024 * 1024)
        print(json.dumps({'retained': sum(i['retained'] for i in collected['items']), 'missing': len(collected['missing']), 'network_bytes': collected['network_bytes']}), flush=True)
