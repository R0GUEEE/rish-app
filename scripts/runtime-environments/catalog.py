#!/usr/bin/env python3
"""Make a catalog only from verified artifacts and explicit published HTTPS URLs."""
import argparse
import json
from pathlib import Path
from urllib.parse import urlsplit
import package


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--publication', type=Path, required=True,
                        help='JSON entries with package_path, url, and matching successful execution evidence')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    entries = []
    seen = set()
    for item in json.loads(args.publication.read_text()):
        parsed = urlsplit(item['url'])
        if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError('catalog URL must be explicit credential-free HTTPS')
        verified = package.verify(Path(item['package_path']))
        evidence = json.loads(Path(item['execution_evidence']).read_text())
        if evidence.get('execution_verified') is not True or evidence.get('source_disk_sha256') != verified['manifest']['disk_sha256']:
            raise ValueError('catalog entry lacks matching successful real runtime evidence')
        identifier = verified['manifest']['environment_id']
        if identifier in seen:
            raise ValueError('duplicate catalog environment')
        seen.add(identifier)
        entries.append({**verified, 'url': item['url']})
    args.output.write_text(json.dumps({'schema_version': 1, 'environments': entries}, indent=2) + '\n')
