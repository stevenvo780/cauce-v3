"""Space of one alias and its company on the host where its data lives, for the V4 pre-cut copy.

The versioned alias config says which container, company and paths an alias has; Docker says where those
paths live on the host. A copy source is accepted only inside that space, and never when it holds a volume
of another container or a path of another alias that shares the container, whatever its company.
"""
from __future__ import annotations

import json
import os
import re
import subprocess

ALIAS_PATHS = ('stateDirectory', 'workspace')


class ScopeFailure(ValueError):
    pass


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix.rstrip('/') + '/')


def host_containers() -> dict[str, list[tuple[str, str]]]:
    """Host source -> container destination of every mount of every container on this Docker host."""
    def docker(*arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(['docker', *arguments], capture_output=True, text=True, timeout=300, check=False)
    listed = docker('ps', '-aq')
    if listed.returncode:
        raise subprocess.CalledProcessError(listed.returncode, listed.args, listed.stdout, listed.stderr)
    ids = listed.stdout.split()
    if not ids:
        return {}
    inspected = docker('container', 'inspect', *ids)
    # A container removed between `ps` and `inspect` holds no mount any more; Docker still prints every other one.
    vanished = all(re.match(r'Error(?: response from daemon)?: No such (?:object|container): ', line)
                   for line in inspected.stderr.splitlines() if line.strip())
    if inspected.returncode and not (vanished and inspected.stdout.strip()):
        raise subprocess.CalledProcessError(inspected.returncode, inspected.args, inspected.stdout, inspected.stderr)
    return {item['Name'].lstrip('/'): [(os.path.realpath(mount['Source']), mount['Destination'].rstrip('/') or '/')
                                       for mount in item.get('Mounts') or []
                                       if mount.get('Source') and mount.get('Destination')]
            for item in json.loads(inspected.stdout)}


def alias_paths(alias: str, entry: dict) -> list[str]:
    paths = [entry[key] for key in ALIAS_PATHS if entry.get(key)]
    return paths + [f"{entry['home'].rstrip('/')}/.local/share/cauce-v3/config/{alias}"]


def to_host(path: str, mounts: list[tuple[str, str]]) -> str | None:
    holders = [(source, destination) for source, destination in mounts if under(path, destination)]
    if not holders:
        return None
    source, destination = max(holders, key=lambda pair: len(pair[1]))
    return source + path[len(destination.rstrip('/')):] if destination != '/' else source.rstrip('/') + path


def tenant_scope(config: dict, alias: str, tenant: str, containers: dict[str, list[tuple[str, str]]]) -> dict:
    entries = config.get('aliases') if isinstance(config, dict) else None
    entry = entries.get(alias) if isinstance(entries, dict) else None
    if not isinstance(entry, dict):
        raise ScopeFailure(f'alias not in the alias config: {alias}')
    if entry.get('tenant') != tenant:
        raise ScopeFailure(f'{alias} does not belong to company {tenant}')
    container, host = entry['container'], entry.get('dockerHost', 'local')
    if container not in containers:
        raise ScopeFailure(f'container {container} of {alias} is not on this Docker host')
    mounts = containers[container]
    siblings = sorted(other for other, item in entries.items() if other != alias and isinstance(item, dict)
                      and item.get('container') == container and item.get('dockerHost', 'local') == host)
    foreign = sorted({source for name, items in containers.items() if name != container for source, _ in items})
    allowed = [path for path in (to_host(item, mounts) for item in alias_paths(alias, entry)) if path]
    if not siblings:
        allowed += [source for source, _ in mounts if not any(under(other, source) for other in foreign)]
    sibling_paths = sorted({path for other in siblings for path in
                            (to_host(item, mounts) for item in alias_paths(other, entries[other])) if path})
    return {'alias': alias, 'tenant': tenant, 'container': container, 'siblings': siblings,
            'allowed': sorted(set(allowed)), 'foreign': foreign, 'siblingPaths': sibling_paths}


def check_sources(roots: dict[str, str], scope: dict) -> None:
    for name, path in roots.items():
        if not any(under(path, root) for root in scope['allowed']):
            raise ScopeFailure(f'source {name} is outside the space of {scope["alias"]} ({scope["tenant"]})')
        if any(under(other, path) for other in scope['foreign']):
            raise ScopeFailure(f'source {name} holds a volume of another container')
        if any(under(other, path) or under(path, other) for other in scope['siblingPaths']):
            raise ScopeFailure(f'source {name} overlaps another alias of container {scope["container"]}')
