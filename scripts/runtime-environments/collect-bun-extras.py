#!/usr/bin/env python3
"""Collect locked Bun Git/Cargo source archives as data, with bounded downloads."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import subprocess
import threading
import sources

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / '.build/runtime-environments/packages/source-archives/bun-extra'


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as file:
        while block := file.read(1024 * 1024): digest.update(block)
    return digest.hexdigest()


def main():
    locked = json.loads((ROOT / 'runtime-environments/bun-sources.lock.json').read_text())
    items = locked['dependencies']; OUT.mkdir(parents=True, exist_ok=True)
    budget = sources.DownloadBudget(2 * 1024 ** 3, 1024 ** 3)
    results, lock = [], threading.Lock()
    def one(item):
        name = item['filename']
        if Path(name).name != name or not item['url'].startswith('https://'):
            raise ValueError('invalid locked source location')
        destination = OUT / name; record = {**item, 'retained': False}
        for attempt in range(3):
            if destination.is_file() and destination.stat().st_size == item['bytes'] and sha256(destination) == item['sha256']:
                record.update({'retained': True, 'path': str(destination)}); break
            reservation = budget.reserve()
            if not reservation:
                record['error'] = 'network budget exhausted'; break
            received = 0
            try:
                temporary = destination.with_suffix(destination.suffix + '.partial')
                run = subprocess.run(['curl', '--http1.1', '--fail', '--location', '--silent', '--show-error',
                                      '--max-time', '180', '--max-filesize', str(min(reservation, item['bytes'])),
                                      '--write-out', '%{size_download}', item['url'], '-o', str(temporary)],
                                     text=True, capture_output=True)
                try: received = int(float(run.stdout.strip()))
                except ValueError: received = 0
                record['curl_exit'] = run.returncode
                if run.returncode == 0 and temporary.stat().st_size == item['bytes'] and sha256(temporary) == item['sha256']:
                    temporary.replace(destination)
                    record.update({'retained': True, 'path': str(destination)})
                    break
            finally:
                budget.release(reservation, received)
        with lock:
            results.append(record)
            report = {'schema_version': 1, 'planned': len(items), 'completed': len(results), 'network_bytes': budget.used,
                      'items': results, 'complete': len(results) == len(items) and all(r['retained'] for r in results)}
            temporary = OUT / 'manifest.partial.json'; temporary.write_text(json.dumps(report, indent=2) + '\n')
            temporary.replace(OUT / 'manifest.json')
        return record
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        for _ in pool.map(one, items): pass
    print(json.dumps({'retained': sum(r['retained'] for r in results), 'planned': len(items), 'network_bytes': budget.used}))


if __name__ == '__main__': main()
