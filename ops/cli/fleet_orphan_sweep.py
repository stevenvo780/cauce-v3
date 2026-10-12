#!/usr/bin/env python3
"""Report Docker resources labelled cauce.fleet.* that have no agent row, and rows whose container is missing.

Rows come from a JSON file (a list of {"runtime_key", "container_name", "runtime_mode"} objects). Exit 1 when anything is orphaned.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys

DOCKER = '/usr/bin/docker'
PREFIX = 'cauce.fleet.'


def docker_json(kind: str, *listing: str) -> list[dict]:
    names = subprocess.run([DOCKER, *listing], capture_output=True, text=True, check=True).stdout.split()
    if not names:
        return []
    return json.loads(subprocess.run([DOCKER, kind, 'inspect', *names], capture_output=True, text=True, check=True).stdout)


def fleet_resources() -> list[dict]:
    found = []
    for item in docker_json('container', 'ps', '-a', '-q'):
        labels = item['Config'].get('Labels') or {}
        if any(key.startswith(PREFIX) for key in labels):
            found.append({'kind': 'container', 'name': item['Name'].lstrip('/'), 'runtime_key': labels.get(PREFIX + 'runtime_key')})
    for item in docker_json('volume', 'volume', 'ls', '-q'):
        labels = item.get('Labels') or {}
        if any(key.startswith(PREFIX) for key in labels):
            found.append({'kind': 'volume', 'name': item['Name'], 'runtime_key': labels.get(PREFIX + 'runtime_key')})
    return found


def sweep(rows: list[dict], resources: list[dict]) -> dict:
    keys = {row['runtime_key'] for row in rows}
    containers = {resource['name'] for resource in resources if resource['kind'] == 'container'}
    return {'orphan_resources': [resource for resource in resources if resource['runtime_key'] not in keys],
            'orphan_rows': [row for row in rows if row.get('runtime_mode') == 'container' and row['container_name'] not in containers]}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rows', required=True, help='JSON file with the agent/placement rows')
    parser.add_argument('--runtime-key-prefix', default='', help='limit the sweep to runtime keys starting with this prefix')
    arguments = parser.parse_args(argv)
    with open(arguments.rows) as handle:
        rows = [row for row in json.load(handle) if row['runtime_key'].startswith(arguments.runtime_key_prefix)]
    resources = [row for row in fleet_resources() if (row['runtime_key'] or '').startswith(arguments.runtime_key_prefix)]
    report = sweep(rows, resources)
    report['clean'] = not report['orphan_resources'] and not report['orphan_rows']
    print(json.dumps(report, sort_keys=True))
    return 0 if report['clean'] else 1


if __name__ == '__main__':
    sys.exit(main())
