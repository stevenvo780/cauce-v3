from __future__ import annotations

import hashlib
import json
import pathlib
import re
import time

from fleet_executor_policy import SafeFailure, approve_agent, path
from fleet_executor_runtime import (
    HELPER,
    NamespaceMismatch,
    approved_bundle,
    checked_command,
    lifecycle_arguments,
    namespace_proof,
    provider_environment,
    runtime_evidence,
    sdk_environment,
    sdk_environment_proof,
)
from fleet_executor_view import environment as credential_environment
from fleet_executor_view import payload_for

DOCKER = '/usr/bin/docker'
HELPER_DESTINATION = '/cauce/lifecycle'
EXECUTOR_SOURCE = pathlib.Path(__file__).resolve().parent
EXECUTOR_DESTINATION = '/cauce/executor'
RELEASE_ROOT = EXECUTOR_SOURCE.parents[1]


def docker(*arguments: str) -> bytes:
    return checked_command([DOCKER, *arguments], timeout=40)


def expected_labels(policy: dict, agent: dict) -> dict:
    return {'cauce.fleet.runtime_key': agent['runtime_key'], 'cauce.fleet.tenant': agent['tenant_id'],
            'cauce.fleet.alias': agent['alias'], 'cauce.fleet.host': policy['host_id'], 'cauce.fleet.owner': policy['executor_user']}


def inspect_container(name: str) -> dict | None:
    names = docker('ps', '-a', '--format', '{{.Names}}').decode().splitlines()
    if name not in names:
        return None
    items = json.loads(docker('inspect', name))
    if not isinstance(items, list) or len(items) != 1:
        raise SafeFailure('container observation is ambiguous')
    return items[0]


def rebased(value: str, release: pathlib.Path, root: pathlib.Path) -> str:
    candidate = pathlib.PurePosixPath(value)
    return str(root / candidate.relative_to(release)) if candidate.is_relative_to(release) else value


def runtime_mounts(policy: dict, agent: dict, root: pathlib.Path | None = None, release: pathlib.Path | None = None) -> dict:
    root, release = root or RELEASE_ROOT, release or RELEASE_ROOT
    bundle = rebased(policy['bundles'][agent['harness_id']]['directory'], release, root)
    return {HELPER_DESTINATION: str(root / 'ops/container-runtime'), EXECUTOR_DESTINATION: str(root / 'ops/cli'), bundle: bundle}


def observe_container(policy: dict, agent: dict) -> dict | None:
    observed = inspect_container(agent['container_name'])
    if observed is None or agent['_placement'].get('ownership') == 'shared':
        return observed
    from fleet_executor_rebind import bound_release, rebind
    previous = bound_release(observed, RELEASE_ROOT)
    return observed if previous is None else rebind(policy, agent, observed, previous, RELEASE_ROOT)


def validate_container(policy: dict, agent: dict, observed: dict, binds: dict | None = None) -> None:
    placement = agent['_placement']
    if placement.get('ownership') == 'shared':
        from fleet_executor_legacy import validate_shared_observation
        validate_shared_observation(policy, agent, observed)
        return
    if observed.get('Image') != placement['image'] or not all(observed['Config']['Labels'].get(key) == value
        for key, value in expected_labels(policy, agent).items()):
        raise SafeFailure('container image or ownership labels differ')
    if observed['HostConfig'].get('ReadonlyRootfs') is not True or observed['HostConfig'].get('Privileged') is not False \
            or observed['HostConfig'].get('PidMode') == 'host' \
            or observed['HostConfig'].get('NetworkMode') != policy.get('transport', {}).get('network', 'none'):
        raise SafeFailure('container isolation differs from the approved shape')
    binds = runtime_mounts(policy, agent) if binds is None else binds
    mounts = {row['Destination']: row for row in observed['Mounts']}
    state = mounts.get(placement['state_root'])
    profile_root = placement.get('profile_root')
    profiles = mounts.get(profile_root) if profile_root else None
    if not state or state.get('Type') != 'volume' or state.get('Name') != agent['container_name'] + '-state' \
            or any(not mounts.get(destination) or mounts[destination].get('Source') != source or mounts[destination].get('RW') is not False
                   for destination, source in binds.items()) \
            or len(mounts) != len(binds) + (2 if profile_root else 1) or profile_root and (not profiles or profiles.get('Type') != 'volume' \
                or profiles.get('Name') != agent['container_name'] + '-provider-profiles' or profiles.get('RW') is not True):
        raise SafeFailure('container runtime mounts differ')


def owned_volumes(policy: dict, agent: dict) -> tuple[dict, list]:
    labels = expected_labels(policy, agent)
    volumes = {agent['container_name'] + '-state': labels}
    if agent['_placement'].get('profile_root'):
        volumes[agent['container_name'] + '-provider-profiles'] = {**labels, 'cauce.fleet.volume': 'provider-profiles'}
    existing = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    for name, expected in volumes.items():
        if name in existing:
            info = json.loads(docker('volume', 'inspect', name))[0]
            if not all((info.get('Labels') or {}).get(key) == value for key, value in expected.items()):
                raise SafeFailure('existing runtime volume has another owner')
    return volumes, existing


def create_container(policy: dict, agent: dict, binds: dict | None = None) -> dict:
    placement = agent['_placement']
    image = json.loads(docker('image', 'inspect', placement['image']))[0]
    if image['Id'] != placement['image']:
        raise SafeFailure('approved image digest is unavailable')
    volumes, existing = owned_volumes(policy, agent)
    for name, labels in volumes.items():
        if name not in existing:
            docker('volume', 'create', *[value for key, value in labels.items() for value in ('--label', f'{key}={value}')], name)
    volume = agent['container_name'] + '-state'
    label_arguments = [value for key, value in expected_labels(policy, agent).items() for value in ('--label', f'{key}={value}')]
    profile_arguments = ['--mount', f'type=volume,source={agent["container_name"]}-provider-profiles,destination={placement["profile_root"]}'] \
        if placement.get('profile_root') else []
    bind_arguments = [value for destination, source in (runtime_mounts(policy, agent) if binds is None else binds).items()
                      for value in ('--mount', f'type=bind,source={source},destination={destination},readonly')]
    docker('create', '--name', agent['container_name'], *label_arguments, '--network', policy.get('transport', {}).get('network', 'none'), '--read-only',
           '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN', '--cap-add', 'SYS_PTRACE', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER',
           '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--tmpfs', '/run:rw,nosuid,noexec,size=16m',
           '--mount', f'type=volume,source={volume},destination={placement["state_root"]}',
           *bind_arguments, *profile_arguments,
           '--user', '0', '--entrypoint', '/bin/sleep', placement['image'], 'infinity')
    created = inspect_container(agent['container_name'])
    if created is None:
        raise SafeFailure('container creation was not observed')
    return created


def ensure_container(policy: dict, agent: dict) -> dict:
    placement = agent['_placement']
    if not isinstance(placement.get('image'), str) or re.fullmatch(r'sha256:[0-9a-f]{64}', placement['image']) is None:
        raise SafeFailure('container image must be approved by its exact digest')
    if placement.get('ownership') == 'shared':
        observed = inspect_container(agent['container_name'])
        validate_container(policy, agent, observed)
        if not observed['State']['Running'] or observed['State']['Pid'] <= 0:
            raise SafeFailure('shared container must already be observed running')
        return observed
    observed = observe_container(policy, agent)
    if observed is None:
        observed = create_container(policy, agent)
    validate_container(policy, agent, observed)
    if not observed['State']['Running']:
        docker('start', observed['Id'])
        observed = inspect_container(agent['container_name'])
        validate_container(policy, agent, observed)
    if not observed['State']['Running'] or observed['State']['Pid'] <= 0:
        raise SafeFailure('container is not observed running')
    return observed


def identity_for(agent: dict, observed: dict) -> dict:
    generation = hashlib.sha256((observed['Id'] + '\0' + observed['State']['StartedAt']).encode()).hexdigest()
    return {'container_id': observed['Id'], 'generation': generation,
            'control': pathlib.Path(agent['_placement'].get('control_root', '/run/cauce-fleet')) / agent['runtime_key']}


def helper(agent: dict, identity: dict, action: str, *extra: str) -> bytes:
    python = str(path(agent['_placement']['python']))
    return docker('exec', '--user', '0', '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'],
                  python, f'{HELPER_DESTINATION}/{HELPER.name}', action, *extra)


def user_identity(agent: dict, identity: dict) -> tuple[str, str]:
    row = docker('exec', '--user', '0', identity['container_id'], '/usr/bin/getent', 'passwd', agent['runtime_user']).decode().strip().split(':')
    if len(row) != 7 or row[0] != agent['runtime_user'] or row[5] != agent['home_directory'] or not row[2].isdigit() \
            or not row[3].isdigit() or int(row[2]) <= 0 or int(row[3]) <= 0:
        raise SafeFailure('container execution user or home differs')
    if agent['_placement'].get('ownership') == 'shared' and (int(row[2]), int(row[3])) != \
            (agent['_placement']['runtime_uid'], agent['_placement']['runtime_gid']):
        raise SafeFailure('shared runtime UID or GID changed')
    return row[2], row[3]


def process_proof(policy: dict, agent: dict, identity: dict, bundle: dict, *, bootstrap: bool | None = None, operation_id: str | None = None) -> dict:
    helper(agent, identity, 'check', *lifecycle_arguments(agent, identity), '--bundle', bundle['directory'], '--bundle-digest', bundle['digest'])
    observed = json.loads(docker('exec', '--user', '0', identity['container_id'], '/bin/cat', str(identity['control'] / 'cauce-v3-adapter.json')))
    uid, gid = user_identity(agent, identity)
    if observed.get('alias') != agent['runtime_key'] or observed.get('wireAlias') != agent['alias'] \
            or observed.get('tenantId') != agent['tenant_id'] or observed.get('runtimeUid') != int(uid) or observed.get('runtimeGid') != int(gid):
        raise SafeFailure('container process identity differs')
    if bundle['executable_sha256'] is not None and observed['executable']['sha256'] != 'sha256:' + bundle['executable_sha256']:
        raise SafeFailure('container runtime executable hash differs')
    if bootstrap is not None:
        raw = docker('exec', '--user', '0', identity['container_id'], '/bin/cat', f'/proc/{observed["pid"]}/environ')
        environment = {item.split(b'=', 1)[0].decode(): item.split(b'=', 1)[1].decode()
                       for item in raw.split(b'\0') if item.startswith((b'CAUCE_BOOTSTRAP=', b'CAUCE_FLEET_OPERATION_ID=',
                           b'CAUCE_ROOM=', b'CAUCE_INSTANCE_ID=', b'CAUCE_RELAY_URL=', b'CAUCE_MODEL_ID=', b'CAUCE_REASONING_EFFORT='))}
        namespace_proof(environment, bootstrap, operation_id)
        sdk_environment_proof(policy, agent, environment, bootstrap, operation_id)
    observed['imageDigest'] = agent['_placement']['image']
    return runtime_evidence(observed)


def start_container(policy: dict, raw_agent: dict, *, bootstrap: bool = True, operation_id: str | None = None) -> dict:
    agent = approve_agent(policy, raw_agent)
    if agent['_placement'].get('ownership') == 'shared':
        from fleet_executor_legacy import assert_shared_start
        assert_shared_start(policy, agent)
    bundle = approved_bundle(policy, agent)
    observed = ensure_container(policy, agent)
    identity = identity_for(agent, observed)
    uid, gid = user_identity(agent, identity)
    try:
        return process_proof(policy, agent, identity, bundle, bootstrap=bootstrap, operation_id=operation_id)
    except NamespaceMismatch:
        raise
    except SafeFailure:
        helper(agent, identity, 'stopped', *lifecycle_arguments(agent, identity))
    helper(agent, identity, 'prepare-state', '--mount', agent['_placement']['state_root'], '--state', agent['state_directory'], '--uid', uid, '--gid', gid)
    from fleet_executor_profiles import prepare_profile
    prepare_profile(policy, agent)
    helper(agent, identity, 'prepare-control', '--base', str(identity['control'].parent), '--alias', agent['runtime_key'])
    view = pathlib.Path('/run/cauce-credentials') / agent['runtime_key'] / ('bootstrap' if bootstrap else 'normal')
    checked_command([DOCKER, 'exec', '-i', '--user', '0', '--env', 'PYTHONDONTWRITEBYTECODE=1', identity['container_id'],
        agent['_placement']['python'], f'{EXECUTOR_DESTINATION}/fleet_executor_view.py', '--root', str(view), '--uid', uid, '--gid', gid],
        input_data=json.dumps(payload_for(policy, agent, bootstrap)).encode())
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': agent['home_directory'], 'CAUCE_ALIAS': agent['alias'], 'CAUCE_RUNTIME_KEY': agent['runtime_key'], 'CAUCE_TENANT_ID': agent['tenant_id'],
                   'CAUCE_TENANT': agent['tenant_id'], 'CAUCE_STATE_DIR': agent['state_directory'], 'CAUCE_CONTROL_DIR': str(identity['control']),
                   'CAUCE_CONTAINER_ID': identity['container_id'], 'CAUCE_CONTAINER_GENERATION': identity['generation'],
                   'CAUCE_BOOTSTRAP': '1' if bootstrap else '0', 'PYTHONDONTWRITEBYTECODE': '1'}
    environment.update(credential_environment(view, policy, bootstrap))
    environment.update(sdk_environment(policy, agent, bootstrap, operation_id))
    environment.update(provider_environment(policy, agent))
    if operation_id is not None:
        environment['CAUCE_FLEET_OPERATION_ID'] = operation_id
    arguments = [f'{key}={value}' for key, value in environment.items()]
    try:
        docker('exec', '-d', '--user', '0', identity['container_id'], '/usr/bin/env', '-i', *arguments, agent['_placement']['python'],
               f'{HELPER_DESTINATION}/{HELPER.name}', 'run', *lifecycle_arguments(agent, identity),
               '--wire-alias', agent['alias'], '--tenant', agent['tenant_id'], '--runtime-uid', uid, '--runtime-gid', gid,
               '--bundle', bundle['directory'], '--bundle-digest', bundle['digest'], bundle['executable'], *bundle['argv'])
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            try:
                return process_proof(policy, agent, identity, bundle, bootstrap=bootstrap, operation_id=operation_id)
            except SafeFailure:
                time.sleep(0.1)
        raise SafeFailure('container adapter identity was not observed')
    except BaseException:
        helper(agent, identity, 'stop', *lifecycle_arguments(agent, identity))
        raise


def stop_container(policy: dict, raw_agent: dict) -> dict:
    agent = approve_agent(policy, raw_agent)
    observed = observe_container(policy, agent)
    if agent['_placement'].get('ownership') == 'shared' and observed is None:
        raise SafeFailure('approved shared container is not observed')
    if observed is None:
        return {'stopped_verified': True}
    validate_container(policy, agent, observed)
    if not observed['State']['Running'] and observed['State']['Pid'] == 0:
        return {'stopped_verified': True}
    identity = identity_for(agent, observed)
    user_identity(agent, identity)
    helper(agent, identity, 'stop', *lifecycle_arguments(agent, identity))
    helper(agent, identity, 'stopped', *lifecycle_arguments(agent, identity))
    return {'stopped_verified': True}


def purge_container(policy: dict, raw_agent: dict):
    agent = approve_agent(policy, raw_agent)
    stop_container(policy, agent)
    observed = inspect_container(agent['container_name'])
    if agent['_placement'].get('ownership') == 'shared':
        from fleet_executor_legacy import purge_shared
        purge_shared(policy, agent, observed)
        return
    if observed is not None:
        validate_container(policy, agent, observed)
        docker('rm', '-f', observed['Id'])
    volume = agent['container_name'] + '-state'
    volumes = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    if volume in volumes:
        labels = json.loads(docker('volume', 'inspect', volume))[0].get('Labels') or {}
        if not all(labels.get(key) == value for key, value in expected_labels(policy, agent).items()):
            raise SafeFailure('runtime volume belongs to another owner')
        docker('volume', 'rm', volume)
    if inspect_container(agent['container_name']) is not None:
        raise SafeFailure('container removal was not observed')
