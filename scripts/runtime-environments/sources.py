"""Collect literal checksum-locked source archives without evaluating APKBUILD."""
import concurrent.futures
import hashlib
import json
from pathlib import Path
import re
import subprocess
import threading
import time
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[2]
DEFAULT = ROOT / '.build/runtime-environments/packages/source-archives'


def source_plan(recipes_manifest: Path):
    recipes = json.loads(recipes_manifest.read_text())['recipes']
    references = {}
    for path in (ROOT / 'runtime-environments').glob('*.lock.json'):
        lock = json.loads(path.read_text())
        if 'packages' not in lock or 'alpine_version' not in lock:
            continue
        for package in lock['packages']:
            references.setdefault((package['source_origin'], package['source_commit']), []).append((lock['alpine_version'], package))
    items, missing, generated = {}, [], []
    for recipe in recipes:
        if not recipe['retained']:
            missing.append({'origin': recipe['origin'], 'reason': 'recipe unavailable'})
            continue
        raw = Path(recipe['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest() != recipe['sha256']:
            raise ValueError('retained recipe digest changed')
        text = raw.decode()
        block = re.search(r'(?ms)^sha512sums=([\"\'])(.*?)\1', text)
        if not block:
            if recipe['origin'] in ['java-common', 'java-cacerts']:
                generated.append({'origin': recipe['origin'], 'commit': recipe['commit'],
                                  'source': 'runtime payload generated inline by retained APKBUILD', 'recipe_sha256': recipe['sha256']})
            else:
                missing.append({'origin': recipe['origin'], 'reason': 'no static SHA512 block'})
            continue
        lines = [line.strip() for line in block.group(2).splitlines() if line.strip()]
        for line in lines:
            match = re.fullmatch(r'([0-9a-f]{128})[ \t]+([A-Za-z0-9_][A-Za-z0-9._+@-]*)', line)
            if not match:
                missing.append({'origin': recipe['origin'], 'reason': 'non-literal checksum entry', 'entry': line})
                continue
            digest, filename = match.groups()
            item = items.setdefault(digest, {'filename': filename, 'sha512': digest, 'urls': [], 'references': []})
            for branch, package in references.get((recipe['origin'], recipe['commit']), []):
                distfile = 'https://distfiles.alpinelinux.org/distfiles/v' + branch + '/' + quote(filename, safe='')
                aport = package['source_recipe_url'].rsplit('/', 1)[0] + '/' + quote(filename, safe='')
                urls = [distfile, aport] if any(x in filename for x in ['.tar.', '.tgz', '.zip', '.crate']) else [aport, distfile]
                for url in urls:
                    if url not in item['urls']: item['urls'].append(url)
                reference = {'origin': recipe['origin'], 'commit': recipe['commit'], 'branch': branch, 'filename': filename}
                if reference not in item['references']: item['references'].append(reference)
    return {'schema_version': 1, 'items': list(items.values()), 'unresolved_recipe_items': missing,
            'generated_inline_sources': generated, 'recipe_count': len(recipes)}


class DownloadBudget:
    def __init__(self, total, per_file):
        self.total, self.per_file, self.used, self.reserved = total, per_file, 0, 0
        self.condition = threading.Condition()

    def reserve(self):
        with self.condition:
            while self.reserved and self.total - self.used - self.reserved <= 0:
                self.condition.wait()
            allowed = min(self.per_file, self.total - self.used - self.reserved)
            if allowed <= 0: return 0
            self.reserved += allowed
            return allowed

    def release(self, reservation, received):
        with self.condition:
            self.reserved -= reservation
            self.used += received
            self.condition.notify_all()


def file_sha512(path):
    digest = hashlib.sha512()
    with path.open('rb') as file:
        while chunk := file.read(1024 * 1024): digest.update(chunk)
    return digest.hexdigest()


def collect(plan, output=DEFAULT, total_bytes=6 * 1024 ** 3, per_file_bytes=1024 ** 3):
    output.mkdir(parents=True, exist_ok=True)
    budget = DownloadBudget(total_bytes, per_file_bytes)
    previous = output / 'manifest.json'
    if previous.exists():
        budget.used = json.loads(previous.read_text()).get('network_bytes', 0)
        if budget.used > total_bytes:
            raise ValueError('previous downloads already exceed this run budget')
    results, progress_lock = [], threading.Lock()
    started = time.monotonic()

    def record(result):
        with progress_lock:
            results.append(result)
            report = {'schema_version': 1, 'completed': len(results), 'planned': len(plan['items']),
                      'network_bytes': budget.used, 'elapsed_seconds': time.monotonic() - started,
                      'items': results, 'unresolved_recipe_items': plan['unresolved_recipe_items'],
                      'generated_inline_sources': plan['generated_inline_sources']}
            temporary = output / 'manifest.partial.json'
            temporary.write_text(json.dumps(report, indent=2) + '\n')
            temporary.replace(output / 'manifest.json')
        return result

    def fetch(item):
        destination = output / (item['sha512'] + '--' + item['filename'])
        if destination.exists():
            if destination.stat().st_size > per_file_bytes or file_sha512(destination) != item['sha512']:
                return record({**item, 'retained': False, 'reason': 'cached source digest/size mismatch'})
            return record({**item, 'retained': True, 'path': str(destination), 'bytes': destination.stat().st_size, 'cached': True})
        attempts = []
        for url in item['urls']:
            reservation = budget.reserve()
            if not reservation:
                attempts.append({'url': url, 'reason': 'total download budget exhausted'})
                break
            temporary = destination.with_suffix(destination.suffix + '.partial')
            run = subprocess.run(['curl', '--http1.1', '--fail', '--location', '--silent', '--show-error',
                                  '--max-time', '300', '--max-filesize', str(reservation),
                                  '--write-out', '%{size_download}', url, '-o', str(temporary)],
                                 capture_output=True, text=True, check=False)
            try: received = int(float(run.stdout.strip()))
            except ValueError: received = temporary.stat().st_size if temporary.exists() else 0
            budget.release(reservation, received)
            if run.returncode == 0 and temporary.exists() and temporary.stat().st_size <= per_file_bytes:
                if file_sha512(temporary) == item['sha512']:
                    temporary.replace(destination)
                    return record({**item, 'retained': True, 'path': str(destination), 'bytes': destination.stat().st_size,
                                   'retrieved_url': url, 'cached': False})
                attempts.append({'url': url, 'reason': 'SHA512 mismatch'})
            else:
                attempts.append({'url': url, 'reason': 'download failed', 'curl_exit': run.returncode, 'received_bytes': received})
        return record({**item, 'retained': False, 'attempts': attempts})

    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        for _ in pool.map(fetch, plan['items']): pass
    final = json.loads((output / 'manifest.json').read_text())
    final['missing'] = [item for item in results if not item['retained']]
    final['all_literal_sources_retained'] = not final['missing'] and not plan['unresolved_recipe_items']
    final['bun_sources_included'] = False
    final['network_bytes'] = budget.used
    final['budget_bytes'] = total_bytes
    final['per_file_limit_bytes'] = per_file_bytes
    (output / 'manifest.json').write_text(json.dumps(final, indent=2) + '\n')
    return final
