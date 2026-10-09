from __future__ import annotations

import os
import pathlib
import re
import stat

from fleet_executor_container import (
    HELPER_DESTINATION,
    create_container,
    docker,
    helper,
    identity_for,
    inspect_container,
    owned_volumes,
    rebased,
    runtime_mounts,
    validate_container,
)
from fleet_executor_policy import SafeFailure, approve_agent, open_absolute_directory
from fleet_executor_runtime import lifecycle_arguments
from secure_path import InvalidAbsolutePath

RELEASE = re.compile(r'[0-9a-f]{40}')
HELPER_TREE = '/ops/container-runtime'
TREES = ('ops/cli', 'ops/container-runtime')
OWNER = 0


def trusted(details: os.stat_result) -> bool:
    return details.st_uid == OWNER and not details.st_mode & 0o022


def raise_error(error: OSError):
    raise error


def installed_release(root: pathlib.Path) -> pathlib.Path:
    if RELEASE.fullmatch(root.name) is None:
        raise SafeFailure('release tree is not named by its exact revision')
    try:
        for directory in (root, root / 'ops', *(root / tree for tree in TREES)):
            descriptor = open_absolute_directory(directory)
            try:
                if not trusted(os.fstat(descriptor)):
                    raise SafeFailure('release tree ownership or mode is unsafe')
            finally:
                os.close(descriptor)
        for tree in TREES:
            for base, directories, files in os.walk(root / tree, onerror=raise_error):
                for name in directories + files:
                    details = os.lstat(os.path.join(base, name))
                    if not (stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)) or not trusted(details):
                        raise SafeFailure('release tree entry is not a trusted regular file or directory')
    except (OSError, InvalidAbsolutePath):
        raise SafeFailure('release tree is unavailable or contains a symlink') from None
    return root


def helper_root(observed: dict) -> pathlib.Path | None:
    sources = [row.get('Source') for row in observed.get('Mounts') or [] if row.get('Destination') == HELPER_DESTINATION]
    if len(sources) != 1 or not isinstance(sources[0], str) or not sources[0].endswith(HELPER_TREE):
        return None
    root = pathlib.Path(sources[0][:-len(HELPER_TREE)])
    return root if str(root) + HELPER_TREE == sources[0] and RELEASE.fullmatch(root.name) else None


def bound_release(observed: dict, release: pathlib.Path) -> pathlib.Path | None:
    root = helper_root(observed)
    if root is None or RELEASE.fullmatch(release.name) is None or root == release or root.parent != release.parent:
        return None
    return installed_release(root)


def rebind(policy: dict, agent: dict, observed: dict, previous: pathlib.Path, release: pathlib.Path) -> dict:
    if agent['_placement'].get('ownership') == 'shared':
        raise SafeFailure('shared containers are never recreated')
    validate_container(policy, agent, observed, runtime_mounts(policy, agent, previous, release))
    owned_volumes(policy, agent)
    running = observed['State']['Running'] is True
    if running:
        identity = identity_for(agent, observed)
        helper(agent, identity, 'stop', *lifecycle_arguments(agent, identity))
        helper(agent, identity, 'stopped', *lifecycle_arguments(agent, identity))
    docker('rm', '-f', observed['Id'])
    if inspect_container(agent['container_name']) is not None:
        raise SafeFailure('previous container removal was not observed')
    binds = runtime_mounts(policy, agent, release, release)
    replacement = create_container(policy, agent, binds)
    if running:
        docker('start', replacement['Id'])
        replacement = inspect_container(agent['container_name'])
        if replacement is None or replacement['State']['Running'] is not True or replacement['State']['Pid'] <= 0:
            raise SafeFailure('recreated container is not observed running')
    validate_container(policy, agent, replacement, binds)
    return replacement


def owned_agent(policy: dict, name: str, observed: dict, root: pathlib.Path, release: pathlib.Path) -> dict:
    labels = observed['Config'].get('Labels') or {}
    key, tenant, alias = (labels.get('cauce.fleet.' + field) for field in ('runtime_key', 'tenant', 'alias'))
    templates = [row for row in policy.get('container_templates', []) if isinstance(key, str) and name == row['prefix'] + key]
    placement = policy['containers'].get(name) or (templates[0] if len(templates) == 1 else None)
    if not isinstance(key, str) or placement is None:
        raise SafeFailure('container has no approved runtime placement')
    if not isinstance(tenant, str) or re.fullmatch(r'[A-Za-z][A-Za-z0-9_-]{0,63}', tenant) is None \
            or not isinstance(alias, str) or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', alias) is None:
        raise SafeFailure('container has no approved tenant and alias identity')
    destinations = {row.get('Destination') for row in observed.get('Mounts') or []}
    harnesses = [templates[0]['harness_id']] if name not in policy['containers'] else \
        [harness for harness, bundle in sorted(policy['bundles'].items()) if rebased(bundle['directory'], release, root) in destinations]
    if not harnesses:
        raise SafeFailure('container mounts no approved runtime bundle')
    return approve_agent(policy, {'tenant_id': tenant, 'alias': alias, 'runtime_key': key, 'harness_id': harnesses[0],
        'host_id': policy['host_id'], 'runtime_mode': 'container', 'container_name': name,
        'runtime_user': placement['runtime_user'], 'home_directory': placement['home_directory'],
        'state_directory': str(pathlib.Path(placement['state_root']) / key), 'systemd_user': placement.get('systemd_user')})


def adapter_stopped(agent: dict, observed: dict) -> bool:
    identity = identity_for(agent, observed)
    try:
        helper(agent, identity, 'stopped', *lifecycle_arguments(agent, identity))
    except SafeFailure:
        return False
    return True


def rebind_all(policy: dict, release: pathlib.Path, *, include_running: bool = False, dry_run: bool = False) -> dict:
    receipt = {'release': release.name, 'rebound': [], 'deferred': [], 'current': [], 'refused': [], 'shared': []}
    names = docker('ps', '-a', '--filter', 'label=cauce.fleet.owner=' + policy['executor_user'],
                   '--filter', 'label=cauce.fleet.host=' + policy['host_id'], '--format', '{{.Names}}').decode().split()
    planned = []
    for name in sorted(set(names)):
        if name in policy.get('shared_containers', {}):
            receipt['shared'].append(name)
            continue
        observed = None
        try:
            observed = inspect_container(name)
            if observed is None:
                continue
            previous = bound_release(observed, release)
            agent = owned_agent(policy, name, observed, previous or release, release)
            validate_container(policy, agent, observed, runtime_mounts(policy, agent, previous or release, release))
            if previous is not None:
                owned_volumes(policy, agent)
        except SafeFailure as error:
            root = helper_root(observed) if observed else None
            receipt['refused'].append({'container': name, 'release': root.name if root else None, 'reason': str(error)})
            continue
        if previous is None:
            receipt['current'].append(name)
        elif observed['State']['Running'] is True and not include_running and (dry_run or not adapter_stopped(agent, observed)):
            receipt['deferred'].append({'container': name, 'release': previous.name})
        else:
            planned.append((agent, observed, previous))
    for agent, observed, previous in planned:
        if not dry_run:
            rebind(policy, agent, observed, previous, release)
        receipt['rebound'].append({'container': agent['container_name'], 'release': previous.name})
    return receipt
