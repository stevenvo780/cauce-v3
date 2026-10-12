from __future__ import annotations

import hashlib
import json
import pathlib
import re
import subprocess
import uuid

from fleet_executor_container import docker, inspect_container
from fleet_executor_policy import SafeFailure

NON_HARNESS_PROVIDERS = frozenset({'gemini'})
EXECUTOR_SOURCE = pathlib.Path(__file__).resolve().parent
CAPABILITIES = ('SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SYS_PTRACE')


def allowed_providers(policy: dict) -> frozenset:
    """Quota providers derive from the descriptors inside the approved bundles
    (those declaring the quota operation) plus non-harness providers."""
    from harness_operations import HarnessOperationFailure, descriptor_names, resolve_operation
    allowed = set(NON_HARNESS_PROVIDERS)
    directories = {bundle['directory'] for bundle in (policy.get('bundles') or {}).values()
                   if isinstance(bundle, dict) and isinstance(bundle.get('directory'), str)}
    for directory in directories:
        try:
            names = descriptor_names(directory)
        except (HarnessOperationFailure, OSError):
            continue
        for name in names:
            try:
                resolve_operation(name, 'quota', directory)
            except HarnessOperationFailure:
                continue
            allowed.add(name)
    return frozenset(allowed)


def configuration(policy: dict) -> dict:
    quota = policy.get('quota_environments')
    if not isinstance(quota, dict) or set(quota) != {'image', 'network', 'providers'} \
            or not isinstance(quota['image'], str) or re.fullmatch(r'sha256:[a-f0-9]{64}', quota['image']) is None \
            or not isinstance(quota['network'], str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', quota['network']) is None \
            or not isinstance(quota['providers'], list) or not quota['providers'] \
            or len(set(quota['providers'])) != len(quota['providers']) or any(value not in allowed_providers(policy) for value in quota['providers']):
        raise SafeFailure('quota environment policy is unavailable')
    return quota


def provider_operation(policy: dict, provider: str, operation: str, *, command: bool = False):
    from cauce_container_base import PermanentError
    from fleet_executor_runtime import approved_bundle
    from harness_operations import HarnessOperationFailure, provider_command, resolve_operation
    try:
        bundle = approved_bundle(policy, {'harness_id': provider, 'runtime_mode': 'container'})
        result = provider_command(provider, operation, bundle['directory']) if command \
            else resolve_operation(provider, operation, bundle['directory'])
        approved_bundle(policy, {'harness_id': provider, 'runtime_mode': 'container'})
        return result
    except (HarnessOperationFailure, PermanentError, OSError, KeyError, TypeError, ValueError) as error:
        raise SafeFailure('quota provider operation or pinned descriptor is unavailable') from error


QUOTA_ACTIONS = (('create', 'install', False), ('authenticate', 'authenticate', True),
                 ('query', 'quota', True), ('update_cli', 'update', True), ('delete', 'install', False))


def provider_actions(policy: dict, provider: str) -> tuple:
    """Available quota actions for one provider, with the reason for each missing one."""
    available = []
    unavailable = {}
    resolved = {}
    for action, operation, command in QUOTA_ACTIONS:
        if operation not in resolved:
            try:
                provider_operation(policy, provider, operation, command=command)
                resolved[operation] = None
            except SafeFailure as error:
                resolved[operation] = str(error)
        if resolved[operation] is None:
            available.append(action)
        else:
            unavailable[action] = f'operations.{operation}: {resolved[operation]}'
    return available, unavailable


def capabilities(policy: dict) -> dict:
    approved = configuration(policy)
    actions = {}
    for provider in approved['providers']:
        available, _unavailable = provider_actions(policy, provider)
        if available:
            actions[provider] = available
    return {'providers': list(actions), 'actions': actions}


def packet(policy: dict, document: dict) -> dict:
    if not isinstance(document, dict) or set(document) != {'operation_id', 'action', 'consent', 'environment'} \
            or document['action'] not in {'create', 'authenticate', 'query', 'update_cli', 'delete'} \
            or type(document['consent']) is not bool:
        raise SafeFailure('invalid typed quota operation')
    environment = document['environment']
    fields = {'id', 'company_id', 'account_id', 'host_id', 'provider', 'container_name'}
    if not isinstance(environment, dict) or set(environment) != fields or not all(isinstance(value, str) for value in environment.values()):
        raise SafeFailure('invalid quota environment identity')
    try:
        identity = uuid.UUID(environment['id'])
        operation = uuid.UUID(document['operation_id'])
    except (ValueError, TypeError, AttributeError) as error:
        raise SafeFailure('invalid quota operation identity') from error
    if str(identity) != environment['id'] or str(operation) != document['operation_id'] \
            or environment['container_name'] != 'cauce-quota-' + identity.hex \
            or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', environment['company_id']) is None \
            or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', environment['account_id']) is None \
            or environment['host_id'] != policy['host_id'] or environment['provider'] not in configuration(policy)['providers'] \
            or document['action'] == 'authenticate' and not document['consent']:
        raise SafeFailure('quota operation escapes its approved scope')
    return environment


def labels(policy: dict, environment: dict) -> dict:
    return {'cauce.quota.environment': environment['id'], 'cauce.quota.company': environment['company_id'],
            'cauce.quota.host': policy['host_id'], 'cauce.quota.owner': policy['executor_user']}


def validate(policy: dict, environment: dict, observed: dict) -> None:
    approved = configuration(policy)
    expected = labels(policy, environment)
    mounts = {row['Destination']: row for row in observed.get('Mounts', [])}
    state = mounts.get('/home/node') or {}
    helper = mounts.get('/cauce/executor') or {}
    host = observed['HostConfig']
    if observed['Image'] != approved['image'] or observed['Config'].get('User') != '1000:1000' \
            or not all((observed['Config'].get('Labels') or {}).get(key) == value for key, value in expected.items()) \
            or host.get('ReadonlyRootfs') is not True or host.get('Privileged') is not False \
            or host.get('NetworkMode') != approved['network'] or host.get('PidMode') == 'host' \
            or host.get('Memory') != 512 * 1024 * 1024 or host.get('PidsLimit') != 128 \
            or set(host.get('CapDrop') or []) != {'ALL'} or set(host.get('CapAdd') or []) != set(CAPABILITIES) \
            or not any(value.startswith('no-new-privileges') for value in host.get('SecurityOpt') or []) \
            or len(mounts) != 2 or state.get('Type') != 'volume' or state.get('Name') != environment['container_name'] + '-profile' \
            or state.get('RW') is not True or helper.get('Type') != 'bind' or helper.get('Source') != str(EXECUTOR_SOURCE) \
            or helper.get('RW') is not False:
        raise SafeFailure('quota container isolation or ownership differs')
    volume = json.loads(docker('volume', 'inspect', state['Name']))[0]
    if not all((volume.get('Labels') or {}).get(key) == value for key, value in expected.items()):
        raise SafeFailure('quota profile volume ownership differs')


def provider_executable(environment: dict) -> str:
    updated = '/home/node/.local/bin/' + environment['provider']
    probe = subprocess.run(['/usr/bin/docker', 'exec', '--user', '1000:1000', environment['container_name'],
                            '/usr/bin/test', '-x', updated], capture_output=True, timeout=15, check=False)
    if probe.returncode not in (0, 1):
        raise SafeFailure('quota CLI executable cannot be inspected')
    return updated if probe.returncode == 0 else '/usr/local/bin/' + environment['provider']


def provider_version(environment: dict, *, updated: bool = False) -> str:
    executable = '/home/node/.local/bin/' + environment['provider'] if updated else provider_executable(environment)
    try:
        version = docker('exec', '--user', '1000:1000', environment['container_name'], executable, '--version').decode().strip()
    except UnicodeError as error:
        raise SafeFailure('quota CLI version receipt is invalid') from error
    if not 1 <= len(version) <= 256 or any(ord(character) < 32 for character in version):
        raise SafeFailure('quota CLI version receipt is invalid')
    return version


def create(policy: dict, environment: dict) -> dict:
    provider_operation(policy, environment['provider'], 'install')
    approved = configuration(policy)
    existing = inspect_container(environment['container_name'])
    if existing is not None:
        validate(policy, environment, existing)
    else:
        if json.loads(docker('image', 'inspect', approved['image']))[0]['Id'] != approved['image']:
            raise SafeFailure('quota CLI image is unavailable')
        volume = environment['container_name'] + '-profile'
        expected = labels(policy, environment)
        names = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
        if volume in names:
            observed = json.loads(docker('volume', 'inspect', volume))[0]
            if not all((observed.get('Labels') or {}).get(key) == value for key, value in expected.items()):
                raise SafeFailure('quota volume has another owner')
        else:
            docker('volume', 'create', *[value for key, item in expected.items() for value in ('--label', key + '=' + item)], volume)
        docker('create', '--name', environment['container_name'], '--network', approved['network'], '--user', '1000:1000',
               '--read-only', '--cap-drop', 'ALL', *[value for capability in CAPABILITIES for value in ('--cap-add', capability)],
               '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '512m',
               '--tmpfs', '/tmp:rw,nosuid,noexec,size=16m', '--tmpfs', '/run:rw,nosuid,noexec,size=16m',
               '--mount', f'type=volume,source={volume},target=/home/node',
               '--mount', f'type=bind,source={EXECUTOR_SOURCE},target=/cauce/executor,readonly',
               *[value for key, item in expected.items() for value in ('--label', key + '=' + item)], approved['image'])
        existing = inspect_container(environment['container_name'])
        if existing is None:
            raise SafeFailure('quota environment creation was not observed')
        validate(policy, environment, existing)
    if existing['State']['Running'] is not True:
        docker('start', environment['container_name'])
    observed = inspect_container(environment['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('quota environment is not observed running')
    validate(policy, environment, observed)
    return {'runtime_verified': True, 'container_name': environment['container_name'], 'cli_version': provider_version(environment)}


def remove(policy: dict, environment: dict) -> dict:
    existing = inspect_container(environment['container_name'])
    if existing is not None:
        validate(policy, environment, existing)
        docker('rm', '-f', environment['container_name'])
    volume = environment['container_name'] + '-profile'
    names = docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    if volume in names:
        expected = labels(policy, environment)
        observed = json.loads(docker('volume', 'inspect', volume))[0]
        if not all((observed.get('Labels') or {}).get(key) == value for key, value in expected.items()):
            raise SafeFailure('quota volume has another owner')
        docker('volume', 'rm', volume)
    if inspect_container(environment['container_name']) is not None \
            or volume in docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines():
        raise SafeFailure('quota environment removal was not observed')
    return {'stopped_verified': True, 'profile_removed_verified': True}


def login_plan(policy: dict, document: dict) -> dict:
    environment = packet(policy, document)
    if document['action'] != 'authenticate':
        raise SafeFailure('provider device authentication is unavailable')
    observed = inspect_container(environment['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('quota environment is not running')
    validate(policy, environment, observed)
    command = provider_operation(policy, environment['provider'], 'authenticate', command=True)
    command[0] = provider_executable(environment)
    generation = hashlib.sha256((observed['Id'] + '\0' + observed['State']['StartedAt']).encode()).hexdigest()
    return {'operation_id': document['operation_id'], 'command': command, 'runtime_user': 'node',
            'home': '/home/node', 'cwd': '/home/node', 'env': {'PATH': '/home/node/.local/bin:/usr/local/bin:/usr/bin:/bin'},
            'backend': 'container', 'state_root': policy['roots']['runtime'] + '/quota-login',
            'account_scope': environment['account_id'], 'ttl_seconds': 600,
            'container_binding': {'container_id': observed['Id'], 'generation': generation, 'image_digest': observed['Image'],
                                  'python': '/usr/bin/python3', 'helper': '/cauce/executor/provider-login.py'}}


def query_observation(policy: dict, environment: dict) -> dict:
    # Own-session environments only: the reader may refresh and rewrite its credential.
    command = [*provider_operation(policy, environment['provider'], 'quota', command=True), '--refresh-own-session']
    response = subprocess.run(['/usr/bin/docker', 'exec', '--user', '1000:1000', environment['container_name'],
                               *command], capture_output=True, timeout=60, check=False)
    if len(response.stdout) > 65536:
        raise SafeFailure('quota reader exceeds its output limit')
    try:
        raw = json.loads(response.stdout)
    except (ValueError, UnicodeError) as error:
        raise SafeFailure('quota reader did not return a JSON observation') from error
    if not isinstance(raw, dict) or response.returncode not in (0, 1) \
            or response.returncode == 1 and not raw.get('error') and raw.get('ok') is not False:
        raise SafeFailure('quota reader did not return an observation')
    return raw


def verify_authentication(policy: dict, document: dict) -> dict:
    environment = packet(policy, document)
    if document['action'] != 'authenticate':
        raise SafeFailure('quota authentication verification requires a consented login operation')
    observed = inspect_container(environment['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('quota environment is not running')
    validate(policy, environment, observed)
    raw = query_observation(policy, environment)
    if environment['provider'] == 'codex':
        successful = raw.get('error') is None and raw.get('fuente') == 'wham-http'
        extra = raw.get('extra')
        identity = extra.get('account_id') if isinstance(extra, dict) else None
    else:
        successful = raw.get('ok') is True
        identity = raw.get('account_id')
    if not successful or not isinstance(identity, str) or not 1 <= len(identity) <= 256 \
            or any(ord(character) < 32 or ord(character) == 127 for character in identity):
        raise SafeFailure('quota login lacks a successful provider request and remote account identity')
    return {'authenticated_verified': True, 'account_identity': identity}


def perform(policy: dict, document: dict) -> dict:
    environment = packet(policy, document)
    action = document['action']
    if action == 'create':
        return create(policy, environment)
    if action == 'delete':
        return remove(policy, environment)
    observed = inspect_container(environment['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('quota environment is not running')
    validate(policy, environment, observed)
    if action == 'authenticate':
        return {'awaiting_auth': True, 'login_plan': login_plan(policy, document)}
    if action == 'query':
        raw = query_observation(policy, environment)
        from quota_snapshot import normalize_cli_snapshot
        return normalize_cli_snapshot(environment['provider'], raw, environment['account_id'])
    if action == 'update_cli':
        from fleet_executor_runtime import checked_command
        command = ['/usr/bin/docker', 'exec', '--user', '1000:1000', environment['container_name'],
                   *provider_operation(policy, environment['provider'], 'update', command=True)]
        checked_command(command, timeout=180)
        return {'cli_updated_verified': True, 'cli_version': provider_version(environment, updated=True)}
    raise SafeFailure('unsupported quota environment action')
