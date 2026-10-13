#!/usr/bin/env python3
"""Report labelled cauce.fleet.* resources without a row, container rows without a container, and declared state or ownership that differs from Docker.

Rows come from a JSON file. A container row is orphaned only when no container of that name exists, labelled or not. Declared docker_state, docker_health and image are compared to Running, Health.Status and the exact image digest. Omitted ownership treats an unlabelled container as shared or legacy. ownership owned, and any cauce.fleet.* label when ownership is omitted, require cauce.fleet.runtime_key to equal the row; cauce.fleet.host must equal host_id when both are present. shared and legacy rows do not require labels, but a fleet runtime_key that names another row is a divergence. Native rows are not compared to a container. Exit 1 when the report is not clean. Exit 2 when a declaration is outside the admitted values.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys

DOCKER = '/usr/bin/docker'
PREFIX = 'cauce.fleet.'
STATES = frozenset({'running', 'stopped'})
HEALTH = frozenset({'none', 'starting', 'healthy', 'unhealthy'})
OWNERSHIPS = frozenset({'owned', 'shared', 'legacy'})


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
            found.append({'kind': 'container', 'name': item['Name'].lstrip('/'), 'runtime_key': labels.get(PREFIX + 'runtime_key'),
                          'host_id': labels.get(PREFIX + 'host')})
    for item in docker_json('volume', 'volume', 'ls', '-q'):
        labels = item.get('Labels') or {}
        if any(key.startswith(PREFIX) for key in labels):
            found.append({'kind': 'volume', 'name': item['Name'], 'runtime_key': labels.get(PREFIX + 'runtime_key'),
                          'host_id': labels.get(PREFIX + 'host')})
    return found


def container_observations(names: set[str]) -> dict[str, dict]:
    if not names:
        return {}
    observed = {}
    name_filter = 'name=^/(' + '|'.join(re.escape(name) for name in sorted(names)) + ')$'
    for item in docker_json('container', 'ps', '-a', '-q', '--filter', name_filter):
        labels = (item.get('Config') or {}).get('Labels') or {}
        state = item.get('State') or {}
        observed[item['Name'].lstrip('/')] = {'running': bool(state.get('Running')), 'labels': labels,
            'docker_health': (state.get('Health') or {}).get('Status') or 'none', 'image': item.get('Image')}
    return observed


def divergence(row: dict, kind: str, expected, actual) -> dict:
    return {'kind': kind, 'expected': expected, 'actual': actual, 'runtime_key': row.get('runtime_key'),
            'container_name': row.get('container_name'), 'ownership': row.get('ownership') or 'legacy'}


def row_divergences(row: dict, observed: dict) -> list[dict]:
    labels = observed.get('labels') or {}
    ownership = row.get('ownership')
    found = []
    state = row.get('docker_state')
    if state is not None:
        actual = 'running' if observed.get('running') else 'stopped'
        if state not in STATES or actual != state:
            found.append(divergence(row, 'docker_state', state, actual if state in STATES else None))
    for field in ('docker_health', 'image'):
        if field in row and row[field] != observed.get(field):
            found.append(divergence(row, field, row[field], observed.get(field)))
    labelled_key = labels.get(PREFIX + 'runtime_key')
    labelled_host = labels.get(PREFIX + 'host')
    fleet = any(key.startswith(PREFIX) for key in labels)
    if ownership not in (None, *OWNERSHIPS):
        found.append(divergence(row, 'ownership', ownership, labelled_key))
    elif ownership in ('shared', 'legacy'):
        if labelled_key is not None and labelled_key != row['runtime_key']:
            found.append(divergence(row, 'ownership', row['runtime_key'], labelled_key))
    elif ownership == 'owned' or fleet:
        if labelled_key != row['runtime_key']:
            found.append(divergence(row, 'ownership', row['runtime_key'], labelled_key))
        elif row.get('host_id') and labelled_host is not None and labelled_host != row['host_id']:
            found.append(divergence(row, 'ownership', row['host_id'], labelled_host))
    return found


def sweep(rows: list[dict], resources: list[dict], containers: dict[str, dict]) -> dict:
    keys = {row['runtime_key'] for row in rows}
    orphan_rows = []
    divergences = []
    for row in rows:
        if row.get('runtime_mode') != 'container':
            continue
        observed = containers.get(row['container_name'])
        if observed is None:
            orphan_rows.append(row)
            continue
        divergences.extend(row_divergences(row, observed))
    return {'orphan_resources': [resource for resource in resources if resource['runtime_key'] not in keys],
            'orphan_rows': orphan_rows, 'divergences': divergences}


def rejected_declaration(rows: list[dict]) -> str | None:
    for row in rows:
        if 'docker_state' in row and row.get('docker_state') not in STATES:
            return 'invalid docker_state'
        if 'docker_health' in row and row.get('docker_health') not in HEALTH:
            return 'invalid docker_health'
        if 'image' in row and (not isinstance(row['image'], str) or re.fullmatch(r'sha256:[0-9a-f]{64}', row['image']) is None):
            return 'invalid image'
        if 'ownership' in row and row.get('ownership') not in OWNERSHIPS:
            return 'invalid ownership'
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rows', required=True, help='JSON file with the agent/placement rows')
    parser.add_argument('--runtime-key-prefix', default='', help='limit the sweep to runtime keys starting with this prefix')
    parser.add_argument('--host-id', default='', help='limit rows (host_id) and resources (cauce.fleet.host label) to this host')
    arguments = parser.parse_args(argv)
    with open(arguments.rows) as handle:
        rows = [row for row in json.load(handle) if row['runtime_key'].startswith(arguments.runtime_key_prefix)
                and (not arguments.host_id or row.get('host_id') == arguments.host_id)]
    problem = rejected_declaration(rows)
    if problem:
        print(problem, file=sys.stderr)
        return 2
    resources = [row for row in fleet_resources() if (row['runtime_key'] or '').startswith(arguments.runtime_key_prefix)
                 and (not arguments.host_id or row['host_id'] == arguments.host_id)]
    names = {row['container_name'] for row in rows if row.get('runtime_mode') == 'container'}
    report = sweep(rows, resources, container_observations(names))
    report['clean'] = not report['orphan_resources'] and not report['orphan_rows'] and not report['divergences']
    print(json.dumps(report, sort_keys=True))
    return 0 if report['clean'] else 1


if __name__ == '__main__':
    sys.exit(main())
