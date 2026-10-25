from __future__ import annotations

import hashlib
import json
import pathlib
import re
import subprocess
import tempfile
import time
import uuid

from fleet_executor_policy import (
    SafeFailure,
    agent_extensions,
    approve_agent,
    approve_extensions,
    extension_resources,
    path,
)
from fleet_executor_runtime import (
    HELPER,
    NamespaceMismatch,
    approved_bundle,
    lifecycle_arguments,
    namespace_proof,
    provider_environment,
    runtime_evidence,
    sdk_environment,
    sdk_environment_proof,
)
from fleet_executor_view import environment as credential_environment
from fleet_executor_view import payload_for
from fleet_model_fallback import VOLUME_KIND, adapter_environment, pairing


def sidecar_effect(action: str, policy: dict, agent: dict) -> dict:
    rows = [row for row in agent.get('extensions', [])
            if row['type'] == 'docker' or row['type'] == 'browser' and row.get('mode') == 'sidecar']
    if not rows:
        return {}
    agent = {**agent, 'extensions': rows}
    if action == 'validate_sidecars' and agent.get('_teardown'):
        allowed = {**policy.get('extensions_allowed', {}), 'types': [row['type'] for row in rows]}
        docker_row = next((row for row in rows if row.get('type') == 'docker'), None)
        if isinstance(docker_row, dict):
            allowed['docker_access'] = ['read', 'control'] if docker_row.get('access') == 'control' else ['read']
            allowed['docker_daemon_dedicated'] = True
        policy = {**policy, 'extensions_allowed': allowed}
    try:
        from importlib import import_module
        module = import_module('fleet_executor_sidecars')
    except ModuleNotFoundError as error:
        if error.name != 'fleet_executor_sidecars':
            raise
        raise SafeFailure('approved sidecar implementation is unavailable') from None
    if action == 'purge_sidecars' and agent.get('_operation_id'):
        filters = [item for key, value in expected_labels(policy, agent).items() for item in ('--filter', f'label={key}={value}')]
        if not docker('ps', '-aq', '--filter', 'label=cauce.fleet.sidecar', *filters).strip() \
                and not docker('network', 'ls', '-q', '--filter', 'label=cauce.fleet.sidecar', *filters).strip():
            return {}
    result = getattr(module, action)(policy, agent)
    return module.public_result(module.sidecar_plan(policy, agent)) if action == 'validate_sidecars' and result is None else result


def ensure_sidecars(policy: dict, agent: dict) -> dict:
    return sidecar_effect('ensure_sidecars', policy, agent)


def validate_sidecars(policy: dict, agent: dict) -> dict:
    return sidecar_effect('validate_sidecars', policy, agent)


def purge_sidecars(policy: dict, agent: dict) -> dict:
    return sidecar_effect('purge_sidecars', policy, agent)

DOCKER = '/usr/bin/docker'
HELPER_DESTINATION = '/cauce/lifecycle'
EXECUTOR_SOURCE = pathlib.Path(__file__).resolve().parent
EXECUTOR_DESTINATION = '/cauce/executor'
RELEASE_ROOT = EXECUTOR_SOURCE.parents[1]
BASE_CAPABILITIES = ['SETUID', 'SETGID', 'CHOWN', 'SYS_PTRACE', 'DAC_OVERRIDE', 'FOWNER']
EXTENSIONS_LABEL = 'cauce.fleet.extensions'


DIAGNOSTIC_LIMIT = 400


def diagnostic(stderr: bytes) -> str:
    """The tail of a failed command's stderr as one bounded printable line for the host journal."""
    text = re.sub(r'[\x00-\x1f\x7f]+', ' ', stderr.decode('utf-8', 'replace')).strip()
    return text[-DIAGNOSTIC_LIMIT:] or 'no stderr'


def checked_command(command: list[str], *, environment: dict | None = None, timeout: float = 30, input_data: bytes | None = None) -> bytes:
    """Run one Docker effect; a failure keeps why it failed (Docker's or the in-container helper's stderr)."""
    result = subprocess.run(command, input=input_data, capture_output=True, env=environment, timeout=timeout, check=False)
    if result.returncode:
        raise SafeFailure(f'runtime effect or observation failed (exit {result.returncode}): {diagnostic(result.stderr)}')
    return result.stdout


def docker(*arguments: str) -> bytes:
    return checked_command([DOCKER, *arguments], timeout=40)


def isolated_python(python: str, script: str, *arguments: str, cwd: str = '/') -> list[str]:
    program = ('import os,runpy,sys;sys.path[:0] = ["/cauce/executor","/cauce/lifecycle"];'
               'os.chdir(sys.argv.pop(1));runpy.run_path(sys.argv.pop(1),run_name="__main__")')
    return [python, '-I', '-B', '-c', program, cwd, script, *arguments]


def expected_labels(policy: dict, agent: dict) -> dict:
    labels = {'cauce.fleet.runtime_key': agent['runtime_key'], 'cauce.fleet.tenant': agent['tenant_id'],
            'cauce.fleet.alias': agent['alias'], 'cauce.fleet.host': policy['host_id'], 'cauce.fleet.owner': policy['executor_user']}
    if agent.get('_operation_id'):
        labels[OPERATION_LABEL] = agent['_operation_id']
    return labels


def extensions_label(agent: dict) -> str | None:
    rows = agent_extensions(agent)
    return json.dumps(rows, sort_keys=True, separators=(',', ':')) if rows else None


def inspect_container(name: str) -> dict | None:
    names = docker('ps', '-a', '--filter', 'name=^/' + re.escape(name) + '$', '--format', '{{.Names}}').decode().splitlines()
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
    root = root or pathlib.Path(policy.get('_runtime_release', RELEASE_ROOT))
    release = release or RELEASE_ROOT
    bundle = rebased(policy['bundles'][agent['harness_id']]['directory'], release, root)
    return {HELPER_DESTINATION: str(root / 'ops/container-runtime'), EXECUTOR_DESTINATION: str(root / 'ops/cli'), bundle: bundle}


def observe_container(policy: dict, agent: dict) -> dict | None:
    from fleet_executor_image import recover_image, refresh_image
    if agent['_placement'].get('ownership') != 'shared':
        recover_image(policy, agent)
    observed = inspect_container(agent['container_name'])
    if observed is None or agent['_placement'].get('ownership') == 'shared':
        return observed
    if observed.get('Image') != agent['_placement']['image']:
        return refresh_image(policy, agent, observed)
    from fleet_executor_rebind import bound_release, rebind
    previous = bound_release(observed, RELEASE_ROOT)
    return observed if previous is None else rebind(policy, agent, observed, previous, RELEASE_ROOT)


def extension_shape(policy: dict, agent: dict, binds: dict, *, teardown: bool = False) -> dict:
    rows = agent_extensions(agent) if teardown else approve_extensions(policy, agent)
    placement = agent['_placement']
    protected = [path(value) for value in [*binds, placement['state_root'], '/run', '/proc', '/sys', '/dev']]
    if placement.get('profile_root'):
        protected.append(path(placement['profile_root']))
    mounts, networks, memory, cpus, pids = {}, set(), 0, 0, 128
    for row in rows:
        if row['type'] == 'mount':
            target = path(row['target'])
            if any(target.is_relative_to(base) or base.is_relative_to(target) for base in protected):
                raise SafeFailure('mount extension overlaps a protected container path')
            if any(target.is_relative_to(path(other)) or path(other).is_relative_to(target) for other in mounts):
                raise SafeFailure('mount extensions overlap')
            mounts[row['target']] = row
        elif row['type'] == 'network':
            networks.add(row['name'])
        elif row['type'] == 'resources':
            memory, cpus, pids = extension_resources(row)
    base_network = policy.get('transport', {}).get('network', 'none')
    if networks and base_network in {'none', 'host'}:
        raise SafeFailure('network extensions require an isolated base Docker network')
    fallback = pairing(agent)
    if fallback is not None and any(path(fallback['destination']).is_relative_to(path(target)) or path(target).is_relative_to(path(fallback['destination']))
                                    for target in mounts):
        raise SafeFailure('mount extension overlaps the model fallback socket')
    return {'mounts': mounts, 'networks': {base_network, *networks}, 'memory': memory, 'cpus': cpus, 'pids': pids,
            'full_control': any(row['type'] == 'full_control' for row in rows), 'gpu': any(row['type'] == 'gpu' for row in rows),
            'fallback': fallback}


def fallback_labels(policy: dict, agent: dict) -> dict:
    """The socket volume belongs to the Muse server; its client only checks who owns it."""
    fallback = pairing(agent)
    if fallback is None:
        return {}
    if fallback['server']:
        return {**expected_labels(policy, {**agent, '_operation_id': None}), 'cauce.fleet.volume': VOLUME_KIND}
    return {'cauce.fleet.tenant': agent['tenant_id'], 'cauce.fleet.alias': fallback['server_alias'], 'cauce.fleet.host': policy['host_id'],
            'cauce.fleet.owner': policy['executor_user'], 'cauce.fleet.volume': VOLUME_KIND}


def fallback_volume_ready(policy: dict, agent: dict) -> None:
    """A client is never (re)created before its server's socket volume exists."""
    fallback = pairing(agent)
    if fallback is None or fallback['server']:
        return
    existing = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    if fallback['volume'] not in existing:
        raise SafeFailure('model fallback socket volume is unavailable: create and start its Muse agent first')
    labels = json.loads(docker('volume', 'inspect', fallback['volume']))[0].get('Labels') or {}
    if any(labels.get(key) != value for key, value in fallback_labels(policy, agent).items()):
        raise SafeFailure('existing runtime volume has another owner')


def sidecar_shape(result: dict | None) -> tuple[set[str], dict]:
    result = result or {}
    if not isinstance(result, dict):
        raise SafeFailure('sidecar runtime shape is invalid')
    network = result.get('network')
    networks, environment = result.get('networks', [network] if network else []), result.get('environment', {})
    if not isinstance(networks, list) or any(not isinstance(name, str) for name in networks) \
            or not isinstance(environment, dict) or set(environment) - {'DOCKER_HOST', 'CAUCE_BROWSER_CDP_URL'} \
            or any(not isinstance(value, str) or '\x00' in value for value in environment.values()):
        raise SafeFailure('sidecar runtime shape is invalid')
    return set(networks), environment


def validate_isolation(policy: dict, agent: dict, observed: dict, shape: dict, *, teardown: bool = False) -> None:
    host = observed['HostConfig']
    def normalize(values):
        return {value.removeprefix('CAP_') for value in values or []}
    if host.get('ReadonlyRootfs') is not (not shape['full_control']) or host.get('Privileged') is not False \
            or host.get('PidMode') != '' or host.get('NetworkMode') != policy.get('transport', {}).get('network', 'none') \
            or normalize(host.get('CapAdd')) != set(BASE_CAPABILITIES) \
            or set(host.get('CapDrop') or []) != (set() if shape['full_control'] else {'ALL'}) \
            or host.get('SecurityOpt') != ['no-new-privileges'] \
            or host.get('Tmpfs') != {'/run': 'rw,nosuid,noexec,size=16m'}:
        raise SafeFailure('container isolation differs from the approved shape')
    if any(host.get(key) != value for key, value in {'Memory': shape['memory'], 'MemorySwap': shape['memory'] * 2,
            'NanoCpus': shape['cpus'], 'PidsLimit': shape['pids']}.items()) \
            or any(host.get(key, 0) != 0 for key in ('CpuShares', 'CpuPeriod', 'CpuQuota', 'CpuRealtimePeriod', 'CpuRealtimeRuntime', 'MemoryReservation', 'BlkioWeight')) \
            or any(host.get(key, '') != '' for key in ('CpusetCpus', 'CpusetMems')):
        raise SafeFailure('container resource limits differ from the approved shape')
    expected_gpu = [{'Driver': '', 'Count': -1, 'DeviceIDs': None, 'Capabilities': [['gpu']], 'Options': {}}] if shape['gpu'] else []
    if (host.get('DeviceRequests') or []) != expected_gpu or host.get('Devices'):
        raise SafeFailure('container GPU or device access differs from the approved shape')
    sidecar_networks, environment = sidecar_shape(validate_sidecars(policy, {**agent, '_teardown': teardown}))
    if set(observed.get('NetworkSettings', {}).get('Networks') or {}) != shape['networks'] | sidecar_networks:
        raise SafeFailure('container networks differ from the approved shape')
    current_env = dict(value.split('=', 1) for value in observed['Config'].get('Env', []) if '=' in value)
    if any(current_env.get(key) != value for key, value in environment.items()):
        raise SafeFailure('container sidecar environment differs from the approved shape')


def validate_container(policy: dict, agent: dict, observed: dict, binds: dict | None = None, *, teardown: bool = False) -> None:
    placement = agent['_placement']
    if placement.get('ownership') == 'shared':
        approve_extensions(policy, agent)
        from fleet_executor_legacy import validate_shared_observation
        validate_shared_observation(policy, agent, observed)
        return
    if observed.get('Image') != placement['image'] or not all(observed['Config']['Labels'].get(key) == value
        for key, value in expected_labels(policy, agent).items()):
        raise SafeFailure('container image or ownership labels differ')
    if observed['Config']['Labels'].get(EXTENSIONS_LABEL) != extensions_label(agent):
        raise SafeFailure('container declared extensions differ')
    if teardown and binds is None:
        from fleet_executor_rebind import bound_release
        previous = bound_release(observed, RELEASE_ROOT)
        binds = runtime_mounts(policy, agent, previous, RELEASE_ROOT) if previous is not None else None
    binds = runtime_mounts(policy, agent) if binds is None else binds
    shape = extension_shape(policy, agent, binds, teardown=teardown)
    validate_isolation(policy, agent, observed, shape, teardown=teardown)
    mounts = {row['Destination']: row for row in observed['Mounts']}
    fallback = shape['fallback']
    socket = mounts.get(fallback['destination']) if fallback else None
    if fallback and (not socket or socket.get('Type') != 'volume' or socket.get('Name') != fallback['volume']
                     or socket.get('RW') is not fallback['server']):
        raise SafeFailure('container runtime mounts differ')
    state = mounts.get(placement['state_root'])
    profile_root = placement.get('profile_root')
    profiles = mounts.get(profile_root) if profile_root else None
    if len(mounts) != len(observed['Mounts']) or not state or state.get('Type') != 'volume' or state.get('Name') != agent['container_name'] + '-state' or state.get('RW') is not True \
            or any(not mounts.get(destination) or mounts[destination].get('Type') != 'bind' or mounts[destination].get('Source') != source or mounts[destination].get('RW') is not False
                   for destination, source in binds.items()) \
            or len(mounts) != len(binds) + len(shape['mounts']) + (2 if profile_root else 1) + (1 if fallback else 0) or profile_root and (not profiles or profiles.get('Type') != 'volume' \
                or profiles.get('Name') != agent['container_name'] + '-provider-profiles' or profiles.get('RW') is not True) \
            or any(not mounts.get(destination) or mounts[destination].get('Type') != 'bind' or mounts[destination].get('Source') != row['source']
                   or mounts[destination].get('RW') is not (row['mode'] == 'rw') or mounts[destination].get('Propagation') != 'rprivate'
                   or set(mounts[destination].get('Mode', '').split(',')) != {row['mode'], 'z'} for destination, row in shape['mounts'].items()):
        raise SafeFailure('container runtime mounts differ')


def owned_volumes(policy: dict, agent: dict) -> tuple[dict, list]:
    labels = expected_labels(policy, agent)
    volumes = {agent['container_name'] + '-state': labels}
    if agent['_placement'].get('profile_root'):
        volumes[agent['container_name'] + '-provider-profiles'] = {**labels, 'cauce.fleet.volume': 'provider-profiles'}
    fallback = pairing(agent)
    if fallback is not None and fallback['server']:
        volumes[fallback['volume']] = fallback_labels(policy, agent)
    existing = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    for name, expected in volumes.items():
        if name in existing:
            info = json.loads(docker('volume', 'inspect', name))[0]
            if not all((info.get('Labels') or {}).get(key) == value for key, value in expected.items()):
                raise SafeFailure('existing runtime volume has another owner')
    return volumes, existing


OPERATION_LABEL = 'cauce.fleet.operation'


def create_container(policy: dict, agent: dict, binds: dict | None = None, operation_id: str | None = None) -> dict:
    placement = agent['_placement']
    mounts = runtime_mounts(policy, agent) if binds is None else binds
    shape = extension_shape(policy, agent, mounts)
    for name in shape['networks'] - {policy.get('transport', {}).get('network', 'none')}:
        network = json.loads(docker('network', 'inspect', name))
        if len(network) != 1 or network[0].get('Name') != name:
            raise SafeFailure('network extension is not an existing named Docker network')
    image = json.loads(docker('image', 'inspect', placement['image']))[0]
    if image['Id'] != placement['image']:
        raise SafeFailure('approved image digest is unavailable')
    fallback_volume_ready(policy, agent)
    volumes, existing = owned_volumes(policy, agent)
    operation_labels = {OPERATION_LABEL: operation_id} if operation_id else {}
    for name, labels in volumes.items():
        if name not in existing:
            docker('volume', 'create', *[value for key, value in {**labels, **operation_labels}.items() for value in ('--label', f'{key}={value}')], name)
    volume = agent['container_name'] + '-state'
    extension_labels = {EXTENSIONS_LABEL: extensions_label(agent)} if agent.get('extensions') else {}
    label_arguments = [value for key, value in {**expected_labels(policy, agent), **operation_labels, **extension_labels}.items() for value in ('--label', f'{key}={value}')]
    profile_arguments = ['--mount', f'type=volume,source={agent["container_name"]}-provider-profiles,destination={placement["profile_root"]}'] \
        if placement.get('profile_root') else []
    fallback = shape['fallback']
    if fallback:
        profile_arguments += ['--mount', f'type=volume,source={fallback["volume"]},destination={fallback["destination"]}'
                              + ('' if fallback['server'] else ',readonly')]
    if any(not pathlib.Path(source).exists() for source in mounts.values()):
        raise SafeFailure('runtime bind source is unavailable')
    # Volume syntax with the shared relabel (never Z): several containers share one release tree.
    bind_arguments = [value for destination, source in mounts.items()
                      for value in ('--volume', f'{source}:{destination}:ro,z')]
    bind_arguments.extend(value for row in shape['mounts'].values() for value in ('--volume', f'{row["source"]}:{row["target"]}:{row["mode"]},z'))
    isolation = [] if shape['full_control'] else ['--read-only', '--cap-drop', 'ALL']
    limits = []
    for row in agent.get('extensions', []):
        if row['type'] == 'resources':
            limits = [value for key, flag in (('memory', '--memory'), ('cpus', '--cpus')) if key in row for value in (flag, str(row[key]))]
    if policy.get('transport', {}).get('network', 'none') in {'none', 'host'} and any(
            row['type'] == 'docker' or row['type'] == 'browser' and row.get('mode') == 'sidecar' for row in agent.get('extensions', [])):
        raise SafeFailure('sidecars require an isolated base Docker network')
    sidecar_networks, environment = sidecar_shape(ensure_sidecars(policy, {**agent, '_operation_id': operation_id}))
    if sidecar_networks and policy.get('transport', {}).get('network', 'none') in {'none', 'host'}:
        raise SafeFailure('sidecars require an isolated base Docker network')
    docker('create', '--name', agent['container_name'], *label_arguments, '--network', policy.get('transport', {}).get('network', 'none'), *isolation,
           *[value for cap in BASE_CAPABILITIES for value in ('--cap-add', cap)],
           '--security-opt', 'no-new-privileges', '--pids-limit', str(shape['pids']), '--tmpfs', '/run:rw,nosuid,noexec,size=16m',
           '--mount', f'type=volume,source={volume},destination={placement["state_root"]}',
           *bind_arguments, *profile_arguments, *limits, *(['--gpus', 'all'] if shape['gpu'] else []),
           *[value for key, item in environment.items() for value in ('--env', f'{key}={item}')],
           '--user', '0', '--entrypoint', '/bin/sleep', placement['image'], 'infinity')
    for name in sorted((shape['networks'] | sidecar_networks) - {policy.get('transport', {}).get('network', 'none')}):
        docker('network', 'connect', name, agent['container_name'])
    created = inspect_container(agent['container_name'])
    if created is None:
        raise SafeFailure('container creation was not observed')
    return created


def ensure_container(policy: dict, agent: dict, operation_id: str | None = None) -> dict:
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
        observed = create_container(policy, agent, operation_id=operation_id)
    validate_container(policy, agent, observed)
    if not observed['State']['Running']:
        docker('start', observed['Id'])
        observed = inspect_container(agent['container_name'])
        validate_container(policy, agent, observed)
    if not observed['State']['Running'] or observed['State']['Pid'] <= 0:
        raise SafeFailure('container is not observed running')
    return observed


def recreate_extensions(policy: dict, previous: dict, desired: dict) -> None:
    previous, desired = approve_agent(policy, previous), approve_agent(policy, desired)
    approve_extensions(policy, desired)
    fallback_volume_ready(policy, desired)
    if previous.get('runtime_mode') != 'container' or desired.get('runtime_mode') != 'container' \
            or any(previous.get(field) != desired.get(field) for field in ('tenant_id', 'alias', 'runtime_key', 'container_name', 'host_id')) \
            or previous['_placement'].get('ownership') == 'shared':
        raise SafeFailure('extension recreation requires the same dedicated runtime identity')
    observed = inspect_container(previous['container_name'])
    if observed is None:
        return
    try:
        validate_container(policy, desired, observed)
        return
    except SafeFailure:
        pass
    stop_container(policy, previous)
    owned_volumes(policy, previous)
    observed = inspect_container(previous['container_name'])
    if observed is None:
        return
    docker('rm', '-f', observed['Id'])
    purge_sidecars(policy, previous)
    if inspect_container(previous['container_name']) is not None:
        raise SafeFailure('previous container removal was not observed')
    before, after = pairing(previous), pairing(desired)
    if before and before['server'] and not (after and after['server'] and after['volume'] == before['volume']):
        retire_fallback_volume(policy, previous)


def retire_fallback_volume(policy: dict, agent: dict) -> list[dict]:
    """The server's socket volume goes with its extension or its agent, but never while a client still mounts it."""
    fallback = pairing(agent)
    if fallback is None or not fallback['server'] or fallback['volume'] not in docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines() \
            or docker('ps', '-a', '-q', '--filter', 'volume=' + fallback['volume']).strip():
        return []
    labels = json.loads(docker('volume', 'inspect', fallback['volume']))[0].get('Labels') or {}
    if any(labels.get(key) != value for key, value in fallback_labels(policy, agent).items()):
        raise SafeFailure('existing runtime volume has another owner')
    docker('volume', 'rm', fallback['volume'])
    return [{'type': 'volume', 'name': fallback['volume']}]


def identity_for(agent: dict, observed: dict) -> dict:
    generation = hashlib.sha256((observed['Id'] + '\0' + observed['State']['StartedAt']).encode()).hexdigest()
    login_generation = generation
    if agent['_placement'].get('ownership') == 'shared':
        from fleet_executor_legacy import shared_generation
        generation = shared_generation(observed, agent['_placement']['python'])
    return {'container_id': observed['Id'], 'generation': generation, 'login_generation': login_generation,
            'control': pathlib.Path(agent['_placement'].get('control_root', '/run/cauce-fleet')) / agent['runtime_key']}


def helper(agent: dict, identity: dict, action: str, *extra: str) -> bytes:
    from fleet_executor_lifecycle import command
    python = str(path(agent['_placement']['python']))
    arguments, source = command(python, action, *extra)
    return checked_command([DOCKER, 'exec', '-i', '-w', '/', '--user', '0', identity['container_id'], *arguments],
                           input_data=source, timeout=40)


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
        raw = docker('exec', '--user', agent['runtime_user'], identity['container_id'], '/bin/cat', f'/proc/{observed["pid"]}/environ')
        environment = {item.split(b'=', 1)[0].decode(): item.split(b'=', 1)[1].decode()
                       for item in raw.split(b'\0') if item.startswith((b'CAUCE_BOOTSTRAP=', b'CAUCE_FLEET_OPERATION_ID=',
                           b'CAUCE_ROOM=', b'CAUCE_INSTANCE_ID=', b'CAUCE_SPACE_ROOT=', b'CAUCE_RELAY_URL=', b'CAUCE_MODEL_ID=', b'CAUCE_REASONING_EFFORT=',
                           b'CAUCE_SHARED_HUMAN_IDS=', b'CAUCE_SHARED_SESSION=', b'CAUCE_SHARED_SESSION_WORKSPACE=', b'TMUX_TMPDIR='))}
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
    observed = ensure_container(policy, agent, operation_id)
    return start_existing_adapter(policy, agent, observed, bundle, bootstrap=bootstrap, operation_id=operation_id)


def assert_idle_command(observed: dict) -> None:
    configuration = observed.get('Config') or {}
    if configuration.get('Entrypoint') != ['/bin/sleep'] or configuration.get('Cmd') != ['infinity'] \
            or configuration.get('User') != '0':
        raise SafeFailure('preserved container does not have the approved idle command')


def restore_existing_adapter(policy: dict, raw_agent: dict, *, was_running: bool = True,
                             bootstrap: bool = False, operation_id: str | None = None,
                             allow_refresh: bool = True) -> dict:
    from fleet_executor_image import recover_image, refresh_image, validate_previous
    agent = approve_agent(policy, raw_agent)
    bundle = approved_bundle(policy, agent)
    if allow_refresh:
        recover_image(policy, agent, preserve_only=True)
    observed = inspect_container(agent['container_name'])
    if observed is None:
        raise SafeFailure('original container is unavailable for adapter restoration')
    previous = validate_previous(policy, agent, observed)
    if not was_running:
        return stop_running_adapter(previous, observed)
    if not bootstrap:
        from fleet_executor_runtime import materialized_sdk_identity_absent
        if materialized_sdk_identity_absent(policy, agent):
            owned_volumes(policy, previous)
            return stop_running_adapter(previous, observed)
    restored = policy
    approved = agent
    if not allow_refresh:
        agent = previous
        restored = {**policy, 'containers': {**policy.get('containers', {}), agent['container_name']: agent['_placement']}}
    try:
        validate_container(restored, agent, observed)
    except SafeFailure:
        if not allow_refresh:
            raise SafeFailure('original container needs the current approved release; preserved without another refresh') from None
        replacement = refresh_image(policy, agent, observed,
                                    restore_adapter={'bootstrap': bootstrap, 'operation_id': operation_id})
        return replacement['_adapter_restored']
    if not allow_refresh and previous['_placement']['image'] != approved['_placement']['image'] and bundle['executable_sha256'] is None:
        bundle = {**bundle, 'executable_sha256': approved_executable_digest(policy, approved, bundle)}
    restart = adapter_restart_state(restored, agent, observed)
    if restart['adapter_running']:
        operation_id = restart['adapter_operation_id']
        namespace_proof({'CAUCE_BOOTSTRAP': '1' if restart['adapter_bootstrap'] else '0'}, bootstrap)
        if restart['adapter_bundle_digest'] == bundle['digest']:
            return process_proof(restored, agent, identity_for(agent, observed), bundle,
                                 bootstrap=bootstrap, operation_id=operation_id)
        stop_running_adapter(agent, observed)
    if not observed['State']['Running']:
        assert_idle_command(observed)
        docker('start', observed['Id'])
        current = inspect_container(agent['container_name'])
        if current is None or current['Id'] != observed['Id'] or not current['State']['Running'] or current['State']['Pid'] <= 0:
            raise SafeFailure('original container is not observed running for adapter restoration')
        observed = current
    return start_existing_adapter(restored, agent, observed, bundle, bootstrap=bootstrap, operation_id=operation_id)


def adapter_restart_state(policy: dict, agent: dict, observed: dict, release: pathlib.Path | None = None) -> dict:
    from fleet_executor_image import validate_previous
    from fleet_executor_lifecycle import command
    agent = validate_previous(policy, agent, observed, release)
    if not observed['State']['Running']:
        return {'adapter_running': False}
    identity = identity_for(agent, observed)
    try:
        helper(agent, identity, 'stopped', *lifecycle_arguments(agent, identity))
        return {'adapter_running': False}
    except SafeFailure:
        pass
    uid, gid = user_identity(agent, identity)
    expected = {'alias': agent['runtime_key'], 'wireAlias': agent['alias'], 'tenantId': agent['tenant_id'],
                'stateDirectory': agent['state_directory'], 'controlDirectory': str(identity['control']),
                'containerId': identity['container_id'], 'containerGeneration': identity['generation'],
                'runtimeUid': int(uid), 'runtimeGid': int(gid), 'phase': 'running'}
    arguments, source = command(agent['_placement']['python'], json.dumps(expected), observe=True)
    observation = json.loads(checked_command([DOCKER, 'exec', '-i', '-w', '/', '--user', '0', identity['container_id'],
                                             *arguments], input_data=source, timeout=40))
    environment = observation['environment']
    if environment.get('CAUCE_BOOTSTRAP') not in {'0', '1'}:
        raise SafeFailure('original adapter credential namespace is invalid')
    operation = environment.get('CAUCE_FLEET_OPERATION_ID', '')
    try:
        if operation and (not isinstance(operation, str) or str(uuid.UUID(operation)) != operation):
            raise ValueError
    except ValueError:
        raise SafeFailure('original adapter operation identity is invalid') from None
    bootstrap = environment['CAUCE_BOOTSTRAP'] == '1'
    namespace_proof(environment, bootstrap, operation or None)
    sdk_environment_proof(policy, agent, environment, bootstrap, operation or None)
    return {'adapter_running': True, 'adapter_bootstrap': bootstrap,
            'adapter_operation_id': operation or None, 'adapter_bundle_digest': observation['metadata']['bundleDigest']}


def executable_digest(raw: bytes) -> str:
    value = raw.decode('ascii').strip()
    if re.fullmatch(r'[0-9a-f]{64}', value) is None:
        raise SafeFailure('approved executable measurement has no exact digest')
    return value


def approved_executable_digest(policy: dict, agent: dict, bundle: dict) -> str:
    from fleet_executor_lifecycle import EXECUTABLE_DIGEST
    from fleet_executor_pki import checked_file
    image = agent['_placement']['image']
    if not isinstance(image, str) or re.fullmatch(r'sha256:[0-9a-f]{64}', image) is None:
        raise SafeFailure('executable measurement requires the current approved image digest')
    with tempfile.TemporaryDirectory(prefix='executable-pin-', dir=policy['roots']['state']) as directory:
        cidfile = pathlib.Path(directory) / 'container.id'
        labels = {**expected_labels(policy, agent), 'cauce.fleet.probe': 'executable-pin'}
        try:
            return executable_digest(docker('run', '--rm', '--pull=never', '--cidfile', str(cidfile), '-w', '/',
                '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                '--pids-limit', '16', '--memory', '256m', '--cpus', '1', '--user', '0',
                *[value for key, item in labels.items() for value in ('--label', key + '=' + item)],
                '--entrypoint', agent['_placement']['python'], image, '-I', '-B', '-c', EXECUTABLE_DIGEST, bundle['executable']))
        finally:
            if cidfile.exists():
                identity = checked_file(cidfile).decode('ascii').strip()
                if re.fullmatch(r'[0-9a-f]{64}', identity) is None:
                    raise SafeFailure('approved executable probe has no exact container identity')
                try:
                    docker('rm', '-f', identity)
                except SafeFailure:
                    if docker('ps', '-aq', '--no-trunc', '--filter', 'id=' + identity).strip():
                        raise SafeFailure('approved executable probe cleanup is unverified') from None


def verify_executable(agent: dict, observed: dict, bundle: dict) -> None:
    from fleet_executor_lifecycle import EXECUTABLE_DIGEST
    if bundle['executable_sha256'] is not None and executable_digest(docker('exec', '-w', '/', '--user', '0', observed['Id'],
            agent['_placement']['python'], '-I', '-B', '-c', EXECUTABLE_DIGEST, bundle['executable'])) != bundle['executable_sha256']:
        raise SafeFailure('approved executable differs before adapter launch')


def start_existing_adapter(policy: dict, agent: dict, observed: dict, bundle: dict, *,
                           bootstrap: bool, operation_id: str | None = None) -> dict:
    identity = identity_for(agent, observed)
    uid, gid = user_identity(agent, identity)
    try:
        return process_proof(policy, agent, identity, bundle, bootstrap=bootstrap, operation_id=operation_id)
    except NamespaceMismatch:
        raise
    except SafeFailure:
        helper(agent, identity, 'stopped', *lifecycle_arguments(agent, identity))
    verify_executable(agent, observed, bundle)
    helper(agent, identity, 'prepare-state', '--mount', agent['_placement']['state_root'], '--state', agent['state_directory'], '--uid', uid, '--gid', gid)
    workspace = str(pathlib.Path(agent['state_directory']) / 'space' / 'projects')
    managed = agent['_placement'].get('ownership') != 'shared'
    if managed:
        helper(agent, identity, 'prepare-state', '--mount', agent['_placement']['state_root'], '--state', workspace, '--uid', uid, '--gid', gid)
    if (fallback := pairing(agent)) is not None and fallback['server']:
        helper(agent, identity, 'prepare-state', '--mount', fallback['destination'], '--state', fallback['destination'], '--uid', uid, '--gid', gid)
    from fleet_executor_profiles import prepare_profile
    prepare_profile(policy, agent, operation_id=operation_id)
    helper(agent, identity, 'prepare-control', '--base', str(identity['control'].parent), '--alias', agent['runtime_key'])
    view = pathlib.Path('/run/cauce-credentials') / agent['runtime_key'] / ('bootstrap' if bootstrap else 'normal')
    checked_command([DOCKER, 'exec', '-i', '-w', '/', '--user', '0', identity['container_id'],
        *isolated_python(agent['_placement']['python'], f'{EXECUTOR_DESTINATION}/fleet_executor_view.py',
                         '--root', str(view), '--uid', uid, '--gid', gid)],
        input_data=json.dumps(payload_for(policy, agent, bootstrap)).encode())
    environment = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': agent['home_directory'], 'CAUCE_ALIAS': agent['alias'], 'CAUCE_RUNTIME_KEY': agent['runtime_key'], 'CAUCE_TENANT_ID': agent['tenant_id'],
                   'CAUCE_TENANT': agent['tenant_id'], 'CAUCE_STATE_DIR': agent['state_directory'], 'CAUCE_CONTROL_DIR': str(identity['control']),
                   'CAUCE_CONTAINER_ID': identity['container_id'], 'CAUCE_CONTAINER_GENERATION': identity['generation'],
                   'CAUCE_BOOTSTRAP': '1' if bootstrap else '0', 'PYTHONDONTWRITEBYTECODE': '1'}
    environment.update(credential_environment(view, policy, bootstrap))
    environment.update(sdk_environment(policy, agent, bootstrap, operation_id))
    environment.update(provider_environment(policy, agent))
    environment.update(sidecar_shape(validate_sidecars(policy, agent))[1])
    environment.update(adapter_environment(agent))
    if operation_id is not None:
        environment['CAUCE_FLEET_OPERATION_ID'] = operation_id
    arguments = [f'{key}={value}' for key, value in environment.items()]
    try:
        docker('exec', '-d', '-w', '/', '--user', '0', identity['container_id'], '/usr/bin/env', '-i', *arguments,
               *isolated_python(agent['_placement']['python'], f'{HELPER_DESTINATION}/{HELPER.name}', 'run', *lifecycle_arguments(agent, identity),
               '--wire-alias', agent['alias'], '--tenant', agent['tenant_id'], '--runtime-uid', uid, '--runtime-gid', gid,
               '--bundle', bundle['directory'], '--bundle-digest', bundle['digest'], bundle['executable'], *bundle['argv'],
               cwd=workspace if managed else observed.get('Config', {}).get('WorkingDir') or '/'))
        deadline = time.monotonic() + 10
        last: SafeFailure | None = None
        while time.monotonic() < deadline:
            try:
                return process_proof(policy, agent, identity, bundle, bootstrap=bootstrap, operation_id=operation_id)
            except SafeFailure as error:
                last = error
                time.sleep(0.1)
        raise SafeFailure(f'container adapter identity was not observed ({last}); see {agent["state_directory"]}/.cauce-adapter.log')
    except BaseException:
        helper(agent, identity, 'stop', *lifecycle_arguments(agent, identity))
        raise


def ownership_labels_match(policy: dict, agent: dict, observed: dict) -> bool:
    labels = (observed.get('Config') or {}).get('Labels') or {}
    return all(labels.get(key) == value for key, value in expected_labels(policy, agent).items())


def teardown_agent(policy: dict, agent: dict, observed: dict) -> dict:
    if agent['_placement'].get('ownership') == 'shared':
        validate_container(policy, agent, observed, teardown=True)
        return agent
    from fleet_executor_image import previous_agent
    from fleet_executor_rebind import bound_release
    previous = previous_agent(agent, observed.get('Image'))
    root = bound_release(observed, RELEASE_ROOT)
    binds = runtime_mounts(policy, agent, root, RELEASE_ROOT) if root is not None else None
    validate_container(policy, previous, observed, binds, teardown=True)
    owned_volumes(policy, previous)
    return previous


def stop_running_adapter(agent: dict, observed: dict) -> dict:
    if not observed['State']['Running'] and observed['State']['Pid'] == 0:
        return {'stopped_verified': True}
    identity = identity_for(agent, observed)
    user_identity(agent, identity)
    helper(agent, identity, 'stop', *lifecycle_arguments(agent, identity))
    helper(agent, identity, 'stopped', *lifecycle_arguments(agent, identity))
    return {'stopped_verified': True}


def stop_container(policy: dict, raw_agent: dict, *, login: bool = False) -> dict:
    agent = approve_agent(policy, raw_agent)
    observed = inspect_container(agent['container_name'])
    if agent['_placement'].get('ownership') == 'shared' and observed is None:
        raise SafeFailure('approved shared container is not observed')
    if observed is None:
        return {'stopped_verified': True}
    return stop_running_adapter(teardown_agent(policy, agent, observed), observed)


def purge_container(policy: dict, raw_agent: dict) -> dict:
    agent = approve_agent(policy, raw_agent)
    stop_container(policy, agent)
    observed = inspect_container(agent['container_name'])
    if agent['_placement'].get('ownership') == 'shared':
        from fleet_executor_legacy import purge_shared
        purge_shared(policy, agent, observed)
        return {'removed': []}
    removed = []
    if observed is not None:
        teardown_agent(policy, agent, observed)
        docker('rm', '-f', observed['Id'])
        removed.append({'type': 'container', 'name': agent['container_name']})
    sidecars = purge_sidecars(policy, agent) or {}
    removed.extend(sidecars.get('removed', []))
    existing = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    fallback = pairing(agent)
    for volume in owned_volumes(policy, agent)[0]:
        if fallback and volume == fallback['volume']:
            removed.extend(retire_fallback_volume(policy, agent))
        elif volume in existing:
            docker('volume', 'rm', volume)
            removed.append({'type': 'volume', 'name': volume})
    if inspect_container(agent['container_name']) is not None:
        raise SafeFailure('container removal was not observed')
    return {'removed': removed}


def discard_operation(policy: dict, raw_agent: dict, operation_id: str) -> None:
    """Remove only the container and volumes this operation created (labelled with its id and the agent owner labels)."""
    agent = approve_agent(policy, raw_agent)
    if agent['_placement'].get('ownership') == 'shared':
        return
    labels = {**expected_labels(policy, agent), OPERATION_LABEL: operation_id}
    observed = inspect_container(agent['container_name'])
    if observed is not None and all((observed['Config'].get('Labels') or {}).get(key) == value for key, value in labels.items()):
        docker('rm', '-f', observed['Id'])
    purge_sidecars(policy, {**agent, '_operation_id': operation_id})
    existing = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    fallback = pairing(agent)
    for name in (agent['container_name'] + '-state', agent['container_name'] + '-provider-profiles',
                 *([fallback['volume']] if fallback and fallback['server'] else [])):
        # A container recreated without this operation's label (older releases) still mounts the volume:
        # removing it fails forever ("volume is in use") and would drop a signed-in provider profile.
        if name in existing and docker('ps', '-a', '-q', '--filter', 'volume=' + name).strip():
            continue
        if name in existing and all((json.loads(docker('volume', 'inspect', name))[0].get('Labels') or {}).get(key) == value
                                    for key, value in labels.items()):
            docker('volume', 'rm', name)


def retire_replaced_container(policy: dict, previous: dict, receipt: dict | None = None, *, apply: bool = False) -> dict:
    from fleet_executor_replacement import retire_replaced
    return retire_replaced(policy, previous, receipt, apply=apply)
