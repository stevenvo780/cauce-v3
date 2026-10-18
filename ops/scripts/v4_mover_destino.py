"""Inventory and remove idle destination residue after central revocation."""
from __future__ import annotations

import fcntl
import fnmatch
import hashlib
import json
import os
import pathlib
import pwd
import re
import stat
import sys
import time


def policy_for(request):
    from v4_copia_integral import directory
    root = pathlib.Path(request['install_directory'])
    descriptor = directory(str(root))
    try:
        fd = os.open('executor-policy.json', os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        with os.fdopen(fd) as reader:
            details = os.fstat(reader.fileno())
            if not stat.S_ISREG(details.st_mode) or details.st_uid != os.geteuid() or details.st_nlink != 1 \
                    or details.st_mode & 0o022 or details.st_size > 1024 * 1024:
                raise ValueError('unsafe destination executor policy')
            policy = json.loads(reader.read(1024 * 1024 + 1))
    finally:
        os.close(descriptor)
    if policy['host_id'] != request['placement']['host_id'] or policy['executor_user'] != pwd.getpwuid(os.geteuid()).pw_name \
            or policy['executor_user'] != request['placement']['systemd_user']:
        raise ValueError('destination cleanup policy belongs to another host or user')
    for name, location in policy['roots'].items():
        if pathlib.Path(location) != root / 'roots' / name:
            raise ValueError('destination cleanup roots differ from the enrolled installation')
    hook = pathlib.Path(policy['hooks']['revoke']['executable'])
    if not hook.is_relative_to(root) or re.fullmatch(r'release/[a-f0-9]{64}/ops/cli/fleet-provider-hook.py', str(hook.relative_to(root))) is None:
        raise ValueError('destination cleanup hook is outside the enrolled release')
    descriptor = directory(str(hook.parent))
    try:
        fd = os.open(hook.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=descriptor)
        with os.fdopen(fd, 'rb') as reader:
            details = os.fstat(reader.fileno())
            if details.st_uid != os.geteuid() or details.st_mode & 0o022 or details.st_nlink != 1 \
                    or hashlib.sha256(reader.read()).hexdigest() != policy['hooks']['revoke']['sha256']:
                raise ValueError('destination cleanup hook pin or ownership changed')
    finally:
        os.close(descriptor)
    sys.path.insert(0, str(hook.parent))
    from fleet_executor_policy import load_policy
    checked = load_policy(root / 'executor-policy.json')
    if checked != policy:
        raise ValueError('destination cleanup policy changed during validation')
    return policy


def metadata(path):
    details = path.lstat()
    if not (stat.S_ISREG(details.st_mode) or stat.S_ISDIR(details.st_mode)) or details.st_uid != os.geteuid() \
            or stat.S_ISREG(details.st_mode) and details.st_nlink != 1:
        raise ValueError('destination residue has unsafe type or owner')
    result = {'path': str(path), 'mode': stat.S_IMODE(details.st_mode), 'size': details.st_size,
              'device': details.st_dev, 'inode': details.st_ino, 'mtime_ns': details.st_mtime_ns}
    if path.is_dir():
        result['children'] = [metadata(child) for child in sorted(path.iterdir())]
    return result


def destination_inventory(request):
    from v4_mover_host import RemoteFailure, docker, observed_host
    policy = policy_for(request)
    if request['placement']['mode'] != 'container':
        raise ValueError('preventive cleanup requires an exclusive container destination')
    host = observed_host()
    if host['machineIdSha256'] != request['machine_id_sha256']:
        raise ValueError('destination cleanup physical identity changed')
    labels = {'cauce.fleet.' + key: value for key, value in {
        'runtime_key': request['runtime_key'], 'tenant': request['tenant'], 'alias': request['alias'],
        'host': request['placement']['host_id'], 'owner': request['placement']['systemd_user']}.items()}
    for attempt in range(5):
        names = docker('ps', '-a', '-q').decode().splitlines()
        try:
            containers = json.loads(docker('inspect', *names)) if names else []
            break
        except RemoteFailure as error:
            if 'no such object' not in error.remote_error['stderr'].lower() or attempt == 4:
                raise
            time.sleep(0.1)
    volumes = []
    pattern = 'cauce-*-' + request['alias'] + '-*'
    for name in docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines():
        if not fnmatch.fnmatchcase(name, pattern):
            continue
        info = json.loads(docker('volume', 'inspect', name))[0]
        owned = info.get('Labels') or {}
        volumes.append({'name': name, 'labels': owned,
                        'owned': all(owned.get(key) == value for key, value in labels.items()),
                        'users': [item['Id'] for item in containers
                                  if any(mount.get('Name') == name for mount in item.get('Mounts', []))]})
    candidates = []
    key = request['runtime_key']
    for phase in ('bootstrap', 'normal'):
        candidates += [pathlib.Path(policy['roots']['pki']) / phase / key,
                       pathlib.Path(policy['roots']['tokens']) / phase / (key + '.token')]
    candidates += [pathlib.Path(policy['roots']['runtime']) / '.credential-views' / key]
    paths = []
    for candidate in candidates:
        if candidate.exists() or candidate.is_symlink():
            paths.append(metadata(candidate))
    runtimes = [{'id': item['Id'], 'name': item['Name'].lstrip('/'), 'running': item['State']['Running']}
                for item in containers if item['Name'].lstrip('/') == request['placement']['container_name']
                or (item['Config'].get('Labels') or {}).get('cauce.fleet.runtime_key') == key
                or any(mount.get('Source') and any(pathlib.Path(mount['Source']).is_relative_to(candidate)
                    or candidate.is_relative_to(mount['Source']) for candidate in candidates) for mount in item.get('Mounts', []))]
    retained = []
    for phase in ('bootstrap', 'normal'):
        lock = pathlib.Path(policy['roots']['pki']) / phase / ('.' + key + '.authority.lock')
        if lock.exists():
            retained.append({'path': str(lock), 'reason': 'coordination_lock'})
    return {'host': host, 'alias': request['alias'], 'tenant': request['tenant'], 'runtime_key': key,
            'volumes': volumes, 'paths': paths, 'runtimes': runtimes, 'retained': retained,
            'central_state_changed': False}


def clean_destination(request):
    from v4_mover_host import docker
    proof = request['authority_absence']
    if proof.get('active_fleet_records') != 0 or proof.get('read_only') is not True \
            or not 0 <= time.time() - request['authority_observed_at'] <= 30 \
            or any(proof.get(field) != value for field, value in [('tenant', request['tenant']),
                ('alias', request['alias']), ('host_id', request['placement']['host_id']), ('runtime_key', request['runtime_key'])]):
        raise ValueError('destination cleanup requires fresh central credential absence')
    before = destination_inventory(request)
    if before != request['expected_inventory'] or before['runtimes'] \
            or any(volume['users'] for volume in before['volumes'] if volume['owned']):
        raise ValueError('destination cleanup inventory changed or a runtime still owns its resources')
    name = request['placement']['container_name']
    if any(volume['owned'] and volume['name'] not in {name + '-state', name + '-provider-profiles'}
           for volume in before['volumes']):
        raise ValueError('destination cleanup found an unrecognized owned volume')
    policy = policy_for(request)
    hook = pathlib.Path(policy['hooks']['revoke']['executable'])
    if hashlib.sha256(hook.read_bytes()).hexdigest() != policy['hooks']['revoke']['sha256']:
        raise ValueError('destination cleanup installed hook pin changed')
    sys.path.insert(0, str(hook.parent))
    from fleet_executor_retirement import remove_credentials, remove_tree
    locks = []
    try:
        for phase in ('bootstrap', 'normal'):
            parent = pathlib.Path(policy['roots']['pki']) / phase
            if parent.exists():
                fd = os.open(parent / ('.' + request['runtime_key'] + '.authority.lock'),
                             os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
                locks.append(fd)
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current = destination_inventory(request)
        if {key: value for key, value in current.items() if key != 'retained'} != \
                {key: value for key, value in before.items() if key != 'retained'}:
            raise ValueError('destination cleanup residue changed before removal')
        if not 0 <= time.time() - request['authority_observed_at'] <= 30:
            raise ValueError('central credential absence expired before removal')
        remove_credentials(policy, {'runtime_key': request['runtime_key']})
        views = pathlib.Path(policy['roots']['runtime']) / '.credential-views'
        if views.exists():
            remove_tree(views, request['runtime_key'])
        for volume in before['volumes']:
            if volume['owned']:
                docker('volume', 'rm', volume['name'])
    finally:
        for fd in locks:
            os.close(fd)
    after = destination_inventory(request)
    if after['paths'] or after['runtimes'] or any(volume['owned'] for volume in after['volumes']):
        raise ValueError('destination residue removal is unverified')
    return {'verified': True, 'removed_paths': [row['path'] for row in before['paths']],
            'removed_volumes': [row['name'] for row in before['volumes'] if row['owned']], 'after': after}


def prepare_destination(fleet, plan, target, remote, common, evidence):
    from v4_mover_agente import write_json
    from v4_mover_autoridad import inventory
    from v4_mover_flota import OPERATIONS
    if not plan.get('platform_gateway') or not plan.get('enrollment', {}).get('install_directory'):
        raise ValueError('preventive cleanup requires central authority and an enrolled installation')
    request = {**common, 'install_directory': plan['enrollment']['install_directory']}
    before = remote.call('inventory-destination', request)
    write_json(evidence / 'destino-inventario.json', before)
    history = fleet.request('GET', OPERATIONS + '?resource=agent&tenant_id=' + plan['tenant'] + '&alias=' + plan['alias'])
    if any(operation['status'] not in ('succeeded', 'failed', 'cancelled') for operation in history['operations']):
        raise ValueError('destination cleanup requires settled fleet operations')
    observed_at = time.time()
    central = inventory(plan['platform_gateway'], plan['tenant'], plan['alias'],
                        target['placement']['host_id'], target['runtime_key'])
    write_json(evidence / 'destino-autoridad.json', central)
    if central['active_fleet_records']:
        raise ValueError('destination credentials remain issued; complete canonical rollback before cleaning')
    request.update(expected_inventory=before, authority_absence=central, authority_observed_at=observed_at)
    cleaned = remote.call('clean-idle-destination', request)
    write_json(evidence / 'destino-limpieza.json', cleaned)
    return cleaned
