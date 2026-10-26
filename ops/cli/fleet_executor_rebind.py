from __future__ import annotations

import json
import os
import pathlib
import re
import stat

from fleet_executor_container import (
    EXTENSIONS_LABEL,
    HELPER_DESTINATION,
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

RELEASE = re.compile(r'(?:[0-9a-f]{40}|[0-9a-f]{64})')
HELPER_TREE = '/ops/container-runtime'
TREES = ('ops/cli', 'ops/container-runtime')


def trusted(details: os.stat_result) -> bool:
    return details.st_uid in {0, os.geteuid()} and not details.st_mode & 0o022


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


def trusted_bundle(directory: pathlib.Path) -> None:
    """Every entry is a trusted directory or regular file, or a link that stays inside the bundle."""
    try:
        details = os.lstat(directory)
        if not stat.S_ISDIR(details.st_mode) or not trusted(details):
            raise SafeFailure('sibling release bundle is not a trusted directory')
        inside = os.path.realpath(directory) + os.sep
        for base, directories, files in os.walk(directory, onerror=raise_error):
            for name in directories + files:
                entry = os.path.join(base, name)
                details = os.lstat(entry)
                if stat.S_ISLNK(details.st_mode):
                    if not os.path.realpath(entry).startswith(inside):
                        raise SafeFailure('sibling release bundle links outside itself')
                elif not (stat.S_ISDIR(details.st_mode) or stat.S_ISREG(details.st_mode)) or not trusted(details):
                    raise SafeFailure('sibling release bundle entry is not trusted')
    except OSError:
        raise SafeFailure('sibling release bundle is unavailable') from None


def sibling_bundle(policy: dict, agent: dict, observed: dict, bundle: dict, release: pathlib.Path) -> dict | None:
    """The approved bundle as shipped by the installed sibling release a preserved container still binds.

    A restoration that must not recreate its container can only start the adapter from the bundle that container
    mounts. That release is trusted like its executor and lifecycle trees already are (exact revision name, sibling of
    the current release, owner and mode), it finished the verified install of its signed archive, and every other part
    of the container shape is still the approved one. Its digest is measured here and re-verified by the lifecycle
    helper inside the container before launch and on every check, so no other bundle can be started.
    """
    root = bound_release(observed, release)
    if root is None:
        return None
    marker = root / '.verified'
    try:
        details = os.lstat(marker)
        if not stat.S_ISREG(details.st_mode) or details.st_uid not in {0, os.geteuid()} \
                or marker.read_text(encoding='ascii') != root.name + '\n':
            return None
    except (OSError, UnicodeError):
        return None
    directory = pathlib.Path(rebased(bundle['directory'], release, root))
    if not directory.is_relative_to(root):
        return None
    validate_container(policy, agent, observed, runtime_mounts(policy, agent, root, release))
    trusted_bundle(directory)
    if 'descriptor_sha256' in bundle:
        from harness_operations import HarnessOperationFailure, read_descriptor
        try:
            read_descriptor(str(directory), agent['harness_id'])
        except HarnessOperationFailure as error:
            raise SafeFailure('sibling release harness descriptor is invalid') from error
    from cauce_container_base import bundle_digest
    return {**bundle, 'directory': str(directory), 'digest': bundle_digest(str(directory))}


def rebind(policy: dict, agent: dict, observed: dict, previous: pathlib.Path, release: pathlib.Path) -> dict:
    if agent['_placement'].get('ownership') == 'shared':
        raise SafeFailure('shared containers are never recreated')
    from fleet_executor_image import refresh_image
    return refresh_image(policy, agent, observed, release)


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
    try:
        extensions = json.loads(labels.get(EXTENSIONS_LABEL, '[]'))
    except (TypeError, ValueError):
        raise SafeFailure('container extension declaration is invalid') from None
    return approve_agent(policy, {'tenant_id': tenant, 'alias': alias, 'runtime_key': key, 'harness_id': harnesses[0],
        'host_id': policy['host_id'], 'runtime_mode': 'container', 'container_name': name,
        'runtime_user': placement['runtime_user'], 'home_directory': placement['home_directory'],
        'state_directory': str(pathlib.Path(placement['state_root']) / key), 'systemd_user': placement.get('systemd_user'),
        'extensions': extensions})


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
        observed = None
        try:
            observed = inspect_container(name)
            if observed is None or 'cauce.fleet.sidecar' in (observed['Config'].get('Labels') or {}):
                continue
            if name in policy.get('shared_containers', {}):
                receipt['shared'].append(name)
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
        elif observed['State']['Running'] is True and not (previous / 'ops/cli/fleet_executor_image.py').is_file():
            receipt['deferred'].append({'container': name, 'release': previous.name, 'reason': 'login_guard_unavailable'})
        elif observed['State']['Running'] is True and not include_running and (dry_run or not adapter_stopped(agent, observed)):
            receipt['deferred'].append({'container': name, 'release': previous.name})
        else:
            planned.append((agent, observed, previous))
    for agent, observed, previous in planned:
        if not dry_run:
            rebind(policy, agent, observed, previous, release)
        receipt['rebound'].append({'container': agent['container_name'], 'release': previous.name})
    return receipt
