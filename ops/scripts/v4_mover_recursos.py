from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import re
import sys
import uuid

LEGACY_LIMITS = {'Memory': 1073741824, 'MemorySwap': 1073741824, 'NanoCpus': 1000000000}


def checkpoint_file(policy, agent, operation):
    directory = pathlib.Path(policy['roots']['runtime']) / 'migration-shape-repairs'
    return directory / (agent['tenant_id'] + '-' + agent['alias'] + '-' + operation + '.json')


def save_checkpoint(filename, result):
    filename.parent.mkdir(mode=0o700, exist_ok=True)
    details = filename.parent.lstat()
    if filename.parent.is_symlink() or details.st_uid != os.geteuid() or details.st_mode & 0o077:
        raise ValueError('repair checkpoint directory is unsafe')
    descriptor = os.open(filename.parent.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    temporary = filename.with_suffix('.' + uuid.uuid4().hex + '.tmp')
    with temporary.open('x') as stream:
        os.chmod(temporary, 0o600)
        json.dump(result, stream)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, filename)
    descriptor = os.open(filename.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def finish_replacement(container, policy, agent, request, result, filename):
    volumes = result['volumes_before']
    if volume_metadata(container, policy, agent) != volumes or policy_digest(pathlib.Path(request['policy'])) != result['policy_sha256']:
        raise ValueError('approved policy or preserved volumes changed before replacement')
    replacement = container.inspect_container(agent['container_name'])
    if replacement is None:
        replacement = container.create_container(policy, agent, operation_id=request['operation_id'])
    if replacement['Config'].get('Labels', {}).get(container.OPERATION_LABEL) != request['operation_id']:
        raise ValueError('replacement belongs to another operation')
    container.validate_container(policy, agent, replacement)
    result.update(phase='created', after=public_container(replacement))
    save_checkpoint(filename, result)
    if not replacement['State']['Running']:
        container.docker('start', replacement['Id'])
        replacement = container.inspect_container(agent['container_name'])
        if replacement is None or not replacement['State']['Running'] or replacement['State']['Pid'] <= 0:
            raise ValueError('replacement container is not running')
    container.validate_container(policy, agent, replacement)
    after = volume_metadata(container, policy, agent)
    if after != volumes:
        raise ValueError('state or provider profile volume metadata changed')
    stopped_adapter = container.stop_container(policy, agent)
    if stopped_adapter.get('stopped_verified') is not True:
        raise ValueError('canonical login stop was not confirmed')
    from fleet_executor_hooks import container_binding
    container_binding(policy, agent)
    result.update(executed=True, phase='completed', after=public_container(replacement), volumes_after=after,
                  volumes_preserved=True, canonical_login_stop=stopped_adapter, physical_login_binding_verified=True,
                  authenticated=False, installed_executor_modified=False)
    save_checkpoint(filename, result)
    return result


def policy_digest(filename):
    details = filename.lstat()
    if filename.is_symlink() or details.st_uid != os.geteuid() or details.st_mode & 0o022:
        raise ValueError('repair requires the installed executor policy owned by its user')
    return hashlib.sha256(filename.read_bytes()).hexdigest()


def installed_executor(filename):
    raw = json.loads(filename.read_text())
    roots = {pathlib.Path(row['directory']).parent for row in raw['bundles'].values()}
    if len(roots) != 1:
        raise ValueError('repair requires one installed executor release')
    root = roots.pop()
    if root.parent != filename.parent / 'release' or re.fullmatch(r'[a-f0-9]{40,64}', root.name) is None \
            or root.resolve(strict=True) != root:
        raise ValueError('repair executor is outside the installed release')
    for source in (root / 'ops/cli', root / 'ops/cli/fleet_executor_container.py'):
        details = source.stat()
        if details.st_uid not in {0, os.geteuid()} or details.st_mode & 0o022:
            raise ValueError('installed executor ownership or mode is unsafe')
    sys.path.insert(0, str(root / 'ops/cli'))
    from fleet_executor_policy import load_policy
    return root, load_policy(filename)


def volume_metadata(container, policy, agent):
    expected, existing = container.owned_volumes(policy, agent)
    if len(expected) != 2 or not set(expected) <= set(existing):
        raise ValueError('repair requires both existing state and provider profile volumes')
    result = {}
    for name in expected:
        row = json.loads(container.docker('volume', 'inspect', name))[0]
        result[name] = {key: row.get(key) for key in ('Name', 'CreatedAt', 'Driver', 'Mountpoint', 'Labels', 'Options')}
    return result


def public_container(row):
    return {'container_id': row['Id'], 'image': row['Image'], 'running': row['State']['Running'],
            'resources': {key: row['HostConfig'].get(key) for key in (*LEGACY_LIMITS, 'PidsLimit')},
            'volumes': sorted(mount['Name'] for mount in row['Mounts'] if mount['Type'] == 'volume')}


def repair_shape(request):
    filename = pathlib.Path(request['policy'])
    pin = policy_digest(filename)
    root, policy = installed_executor(filename)
    import fleet_executor_container as container
    from fleet_executor_policy import approve_agent
    raw = request['agent']
    if raw.get('alias') not in {'teseo', 'perseo', 'gaia'} \
            or raw.get('extensions') != [] or raw.get('lifecycle_state') != 'auth_pending':
        raise ValueError('repair only accepts an unauthenticated migration with no extensions')
    agent = approve_agent(policy, raw)
    if agent['_placement'].get('ownership') == 'shared' or agent['runtime_mode'] != 'container' \
            or not agent['_placement'].get('profile_root'):
        raise ValueError('repair requires a dedicated container with a separate profile volume')
    operation = request['operation_id']
    if not isinstance(operation, str) or re.fullmatch(r'[a-f0-9-]{36}', operation) is None:
        raise ValueError('repair requires the original pending operation')
    checkpoint = checkpoint_file(policy, agent, operation)
    observed = container.inspect_container(agent['container_name'])
    if request.get('execute') and checkpoint.exists():
        if checkpoint.is_symlink() or checkpoint.stat().st_uid != os.geteuid() or checkpoint.stat().st_mode & 0o077:
            raise ValueError('repair checkpoint is unsafe')
        saved = json.loads(checkpoint.read_text())
        if saved.get('policy_sha256') != pin or saved.get('approved_image') != agent['_placement']['image'] \
                or saved.get('operation_id') != operation or saved.get('before', {}).get('container_id') != request['container_id'] \
                or saved['before'].get('image') != request['previous_image'] \
                or pin != request.get('policy_sha256') or saved['approved_image'] != request.get('approved_image'):
            raise ValueError('repair checkpoint differs from the approved preview')
        if observed is None or observed['Id'] != request['container_id']:
            return finish_replacement(container, policy, agent, request, saved, checkpoint)
    if observed is None or observed['Id'] != request['container_id'] \
            or observed['Image'] != request['previous_image'] \
            or observed['Config'].get('Labels', {}).get(container.OPERATION_LABEL) != operation:
        raise ValueError('repair physical identity differs from the pinned migration')
    legacy_limits = {**LEGACY_LIMITS, 'NanoCpus': 1500000000 if agent['alias'] == 'gaia' else 1000000000}
    if {key: observed['HostConfig'].get(key) for key in LEGACY_LIMITS} != legacy_limits:
        raise ValueError('repair only accepts the diagnosed legacy migration resource limits')
    previous = [mount['Source'] for mount in observed['Mounts'] if mount['Destination'] == container.HELPER_DESTINATION]
    if len(previous) != 1 or not previous[0].endswith('/ops/container-runtime'):
        raise ValueError('repair requires the original installed runtime mounts')
    previous_root = pathlib.Path(previous[0]).parents[1]
    if previous_root.parent != root.parent or re.fullmatch(r'[a-f0-9]{40,64}', previous_root.name) is None \
            or previous_root.resolve(strict=True) != previous_root:
        raise ValueError('previous runtime release is outside the installed executor')
    binds = container.runtime_mounts(policy, agent, previous_root, root)
    normalized = copy.deepcopy(observed)
    normalized['Image'] = agent['_placement']['image']
    normalized['HostConfig'].update({key: 0 for key in LEGACY_LIMITS})
    # Only the diagnosed image and resource drift may differ before reconstruction.
    container.validate_container(policy, agent, normalized, binds)
    volumes = volume_metadata(container, policy, agent)
    image = json.loads(container.docker('image', 'inspect', agent['_placement']['image']))[0]
    if image['Id'] != agent['_placement']['image']:
        raise ValueError('current approved image is not present')
    current_binds = container.runtime_mounts(policy, agent)
    if any(not pathlib.Path(source).exists() for source in current_binds.values()):
        raise ValueError('current approved runtime bind source is unavailable')
    result = {'verified': True, 'executed': False, 'policy_sha256': pin,
              'approved_image': agent['_placement']['image'], 'operation_id': operation,
              'before': public_container(observed), 'volumes_before': volumes}
    if not request.get('execute'):
        return result
    if pin != request.get('policy_sha256') or result['approved_image'] != request.get('approved_image') \
            or policy_digest(filename) != pin:
        raise ValueError('installed executor policy changed after repair preview')
    fresh = container.inspect_container(agent['container_name'])
    if fresh is None:
        raise ValueError('runtime disappeared after repair validation')
    changed = [key for key in ('Id', 'Image', 'Config', 'HostConfig') if fresh.get(key) != observed.get(key)]
    changed += ['State.' + key for key in ('Running', 'Pid', 'StartedAt') if fresh['State'].get(key) != observed['State'].get(key)]
    if sorted(fresh['Mounts'], key=lambda row: row['Destination']) != sorted(observed['Mounts'], key=lambda row: row['Destination']):
        changed.append('Mounts')
    if fresh.get('NetworkSettings', {}).get('Networks') != observed.get('NetworkSettings', {}).get('Networks'):
        changed.append('Networks')
    if changed:
        raise ValueError('runtime changed after repair validation: ' + ', '.join(changed))
    result['phase'] = 'prepared'
    if checkpoint.exists():
        result['before']['running'] = saved['before']['running']
    save_checkpoint(checkpoint, result)
    if observed['State']['Running']:
        container.stop_running_adapter(agent, observed)
        container.docker('stop', observed['Id'])
    stopped = container.inspect_container(agent['container_name'])
    if stopped is None or stopped['Id'] != observed['Id'] or stopped['State']['Running']:
        raise ValueError('previous container stop was not verified')
    if volume_metadata(container, policy, agent) != volumes or policy_digest(filename) != pin:
        raise ValueError('approved policy or preserved volumes changed before replacement')
    result['phase'] = 'stopped'
    save_checkpoint(checkpoint, result)
    container.docker('rm', observed['Id'])
    if container.inspect_container(agent['container_name']) is not None:
        raise ValueError('previous container removal was not observed')
    result['phase'] = 'removed'
    save_checkpoint(checkpoint, result)
    return finish_replacement(container, policy, agent, request, result, checkpoint)
