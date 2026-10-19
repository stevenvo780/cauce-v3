from __future__ import annotations

import functools
import hashlib
import json
import pathlib
import re
import subprocess
import uuid

from fleet_executor_container import docker, inspect_container
from fleet_executor_policy import SafeFailure

NON_HARNESS_PROVIDERS = frozenset({'agy'})
# Quota-only providers have no harness descriptor or adapter executable: the
# runtime resolves their login and verification commands from this fixed argv
# table instead of a bundle descriptor. argv[0] stays under /usr/local/bin and
# every argument passes the same closed validation as descriptor provider argv.
QUOTA_ONLY_RECIPES: dict[str, dict[str, tuple[str, ...]]] = {
    'agy': {
        'authenticate_argv': ('/usr/local/bin/agy',),
        'verify_argv': ('/usr/local/bin/agy', 'models'),
    },
}
RETIRED_PROVIDERS = frozenset({'gemini'})
EXECUTOR_SOURCE = pathlib.Path(__file__).resolve().parent
LIFECYCLE_SOURCE = (EXECUTOR_SOURCE.parent / 'container-runtime').resolve()
CAPABILITIES = ('SETUID', 'SETGID', 'CHOWN', 'DAC_OVERRIDE', 'FOWNER', 'SYS_PTRACE')
TMPFS = {'/tmp': 'rw,nosuid,noexec,size=16m', '/run': 'rw,nosuid,noexec,size=16m'}
GROK_IDENTITY = re.compile(r'(?:grok|grok-local):[0-9a-f]{64}')


@functools.lru_cache(maxsize=8)
def _allowed_for_directories(directories: tuple) -> frozenset:
    from harness_operations import HarnessOperationFailure, descriptor_names, resolve_operation
    allowed = set(NON_HARNESS_PROVIDERS)
    for directory in directories:
        try:
            names = descriptor_names(directory)
        except (HarnessOperationFailure, OSError):
            continue
        for name in names:
            for operation in ('authenticate', 'quota'):
                try:
                    resolve_operation(name, operation, directory)
                except HarnessOperationFailure:
                    continue
                allowed.add(name)
                break
    return frozenset(allowed)


def allowed_providers(policy: dict) -> frozenset:
    """Quota providers derive from the descriptors inside the approved bundles
    (those declaring the authenticate or quota operation) plus non-harness
    providers. Computed once per bundle directory set; never called while
    loading the policy."""
    directories = tuple(sorted({bundle['directory'] for bundle in (policy.get('bundles') or {}).values()
                                 if isinstance(bundle, dict) and isinstance(bundle.get('directory'), str)}))
    return _allowed_for_directories(directories)


def configuration(policy: dict) -> dict:
    """Syntactic validation only: this runs on every policy load, so it must not
    read the filesystem; descriptor-derived allowance is enforced by
    capabilities() and packet() through allowed_providers()."""
    quota = policy.get('quota_environments')
    if not isinstance(quota, dict) or set(quota) != {'image', 'network', 'providers'} \
            or not isinstance(quota['image'], str) or re.fullmatch(r'sha256:[a-f0-9]{64}', quota['image']) is None \
            or not isinstance(quota['network'], str) or re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', quota['network']) is None \
            or not isinstance(quota['providers'], list) or not quota['providers'] \
            or len(set(quota['providers'])) != len(quota['providers']) \
            or any(not isinstance(value, str) or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', value) is None for value in quota['providers']):
        raise SafeFailure('quota environment policy is unavailable')
    return quota


def _quota_only_operation(provider: str, operation: str, *, command: bool = False):
    from harness_operations import HarnessOperationFailure, validate_argv
    recipe = QUOTA_ONLY_RECIPES[provider]
    if operation == 'install':
        if command:
            raise HarnessOperationFailure('operations.install: operation has no provider command')
        return {'provider': provider, 'operation': 'install', 'recipe': 'runtime-package'}
    if operation == 'authenticate':
        argv = recipe.get('authenticate_argv')
        if argv is None:
            raise HarnessOperationFailure(
                'provider.authenticate_argv: required when operations.authenticate is declared')
        validated = validate_argv('provider.authenticate_argv', list(argv))
        if command:
            return validated
        return {'provider': provider, 'operation': 'authenticate', 'recipe': 'provider-login'}
    if operation in ('quota', 'update', 'execute'):
        raise HarnessOperationFailure(
            f'operations.{operation}: operation is not declared by this quota-only provider')
    raise HarnessOperationFailure(f'operations.{operation}: unknown lifecycle operation')


def provider_operation(policy: dict, provider: str, operation: str, *, command: bool = False):
    from cauce_container_base import PermanentError
    from fleet_executor_runtime import approved_bundle
    from harness_operations import HarnessOperationFailure, provider_command, resolve_operation
    if provider in QUOTA_ONLY_RECIPES:
        try:
            return _quota_only_operation(provider, operation, command=command)
        except HarnessOperationFailure as error:
            raise SafeFailure('quota provider operation or pinned descriptor is unavailable') from error
    try:
        bundle = approved_bundle(policy, {'harness_id': provider, 'runtime_mode': 'container'})
        arguments = {'expected_sha256': bundle.get('descriptor_sha256')}
        result = provider_command(provider, operation, bundle['directory'], **arguments) if command \
            else resolve_operation(provider, operation, bundle['directory'], **arguments)
        approved_bundle(policy, {'harness_id': provider, 'runtime_mode': 'container'})
        return result
    except (HarnessOperationFailure, PermanentError, OSError, KeyError, TypeError, ValueError) as error:
        raise SafeFailure('quota provider operation or pinned descriptor is unavailable') from error


def descriptor_verify_command(policy: dict, provider: str):
    from cauce_container_base import PermanentError
    from fleet_executor_runtime import approved_bundle
    from harness_operations import HarnessOperationFailure, provider_verify_command, validate_argv
    if provider in QUOTA_ONLY_RECIPES:
        try:
            verify = QUOTA_ONLY_RECIPES[provider].get('verify_argv')
            if verify is None:
                return None
            return validate_argv('provider.verify_argv', list(verify))
        except HarnessOperationFailure as error:
            raise SafeFailure('quota provider operation or pinned descriptor is unavailable') from error
    try:
        bundle = approved_bundle(policy, {'harness_id': provider, 'runtime_mode': 'container'})
        result = provider_verify_command(provider, bundle['directory'],
                                         expected_sha256=bundle.get('descriptor_sha256'))
        approved_bundle(policy, {'harness_id': provider, 'runtime_mode': 'container'})
        return result
    except (HarnessOperationFailure, PermanentError, OSError, KeyError, TypeError, ValueError) as error:
        raise SafeFailure('quota provider operation or pinned descriptor is unavailable') from error


QUOTA_ACTIONS = (('create', 'install', False), ('authenticate', 'authenticate', True),
                 ('query', 'quota', True), ('update_cli', 'update', True), ('delete', 'install', False))


def provider_actions(policy: dict, provider: str) -> tuple:
    """Available quota actions for one provider, with the descriptor field and
    reason (the underlying HarnessOperationFailure) for each missing one."""
    from harness_operations import HarnessOperationFailure
    available = []
    unavailable = {}
    resolved = {}
    for action, operation, command in QUOTA_ACTIONS:
        if operation not in resolved:
            try:
                provider_operation(policy, provider, operation, command=command)
                resolved[operation] = None
            except SafeFailure as error:
                cause = error.__cause__
                resolved[operation] = str(cause) if isinstance(cause, HarnessOperationFailure) \
                    else f'operations.{operation}: {error}'
        if resolved[operation] is None:
            available.append(action)
        else:
            unavailable[action] = resolved[operation]
    return available, unavailable


def capabilities(policy: dict) -> dict:
    approved = configuration(policy)
    allowed = allowed_providers(policy)
    actions = {}
    for provider in approved['providers']:
        if provider in RETIRED_PROVIDERS:
            continue
        if provider not in allowed:
            if provider in (policy.get('bundles') or {}):
                continue
            raise SafeFailure('quota provider has no quota descriptor in its approved bundles')
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
    if environment['provider'] in RETIRED_PROVIDERS:
        raise SafeFailure('quota provider has no executor')
    if str(identity) != environment['id'] or str(operation) != document['operation_id'] \
            or environment['container_name'] != 'cauce-quota-' + identity.hex \
            or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', environment['company_id']) is None \
            or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', environment['account_id']) is None \
            or environment['host_id'] != policy['host_id'] or environment['provider'] not in configuration(policy)['providers'] \
            or environment['provider'] not in allowed_providers(policy) \
            or document['action'] == 'authenticate' and not document['consent']:
        raise SafeFailure('quota operation escapes its approved scope')
    return environment


def labels(policy: dict, environment: dict) -> dict:
    return {'cauce.quota.environment': environment['id'], 'cauce.quota.company': environment['company_id'],
            'cauce.quota.host': policy['host_id'], 'cauce.quota.owner': policy['executor_user']}


def normalized_capabilities(values) -> set:
    """Docker >= 20.10 reports added capabilities with a CAP_ prefix."""
    return {value.removeprefix('CAP_') if isinstance(value, str) else value for value in values or []}


RELEASE_BIND_DRIFT = frozenset({'helper_source', 'life_source'})


def _mount_map(observed: dict) -> dict:
    return {row['Destination']: row for row in observed.get('Mounts', [])}


def spec_mismatches(policy: dict, environment: dict, observed: dict) -> set[str]:
    approved = configuration(policy)
    expected = labels(policy, environment)
    mounts = _mount_map(observed)
    state = mounts.get('/home/node') or {}
    helper = mounts.get('/cauce/executor') or {}
    lifecycle = mounts.get('/cauce/lifecycle') or {}
    host = observed.get('HostConfig')
    config = observed.get('Config')
    if not isinstance(host, dict) or not isinstance(config, dict):
        return {'unreadable'}
    failed: set[str] = set()
    if observed['Image'] != approved['image']:
        failed.add('image')
    if config.get('User') != '1000:1000':
        failed.add('user')
    if not all((config.get('Labels') or {}).get(key) == value for key, value in expected.items()):
        failed.add('labels')
    if host.get('ReadonlyRootfs') is not True:
        failed.add('readonly')
    if host.get('Privileged') is not False:
        failed.add('privileged')
    if host.get('NetworkMode') != approved['network']:
        failed.add('network')
    if host.get('PidMode') == 'host':
        failed.add('pidmode')
    if host.get('Memory') != 512 * 1024 * 1024:
        failed.add('memory')
    if host.get('PidsLimit') != 128:
        failed.add('pids')
    if host.get('Tmpfs') != TMPFS:
        failed.add('tmpfs')
    if normalized_capabilities(host.get('CapDrop')) != {'ALL'}:
        failed.add('capdrop')
    if normalized_capabilities(host.get('CapAdd')) != set(CAPABILITIES):
        failed.add('capadd')
    if not any(value.startswith('no-new-privileges') for value in host.get('SecurityOpt') or []):
        failed.add('nnp')
    if len(mounts) != 3:
        failed.add('mounts')
    if state.get('Type') != 'volume' or state.get('Name') != environment['container_name'] + '-profile' or state.get('RW') is not True:
        failed.add('profile')
    if helper.get('Type') != 'bind' or helper.get('RW') is not False:
        failed.add('helper_bind')
    elif helper.get('Source') != str(EXECUTOR_SOURCE):
        failed.add('helper_source')
    if lifecycle.get('Type') != 'bind' or lifecycle.get('RW') is not False:
        failed.add('lifecycle_bind')
    elif lifecycle.get('Source') != str(LIFECYCLE_SOURCE):
        failed.add('life_source')
    return failed


def profile_owned(policy: dict, environment: dict, observed: dict) -> bool:
    expected = labels(policy, environment)
    state = _mount_map(observed).get('/home/node') or {}
    if not all((observed['Config'].get('Labels') or {}).get(key) == value for key, value in expected.items()):
        return False
    if state.get('Type') != 'volume' or state.get('Name') != environment['container_name'] + '-profile':
        return False
    try:
        volume = json.loads(docker('volume', 'inspect', state['Name']))[0]
    except (SafeFailure, ValueError, TypeError, KeyError):
        return False
    return all((volume.get('Labels') or {}).get(key) == value for key, value in expected.items())


def validate(policy: dict, environment: dict, observed: dict) -> None:
    if spec_mismatches(policy, environment, observed):
        raise SafeFailure('quota container isolation or ownership differs')
    if not profile_owned(policy, environment, observed):
        raise SafeFailure('quota profile volume ownership differs')


def replace_release_binds(policy: dict, environment: dict) -> None:
    # The profile volume is the provider session. Replacing the container
    # retargets the release binds and must not remove that volume.
    volume = environment['container_name'] + '-profile'
    if not EXECUTOR_SOURCE.is_dir() or not LIFECYCLE_SOURCE.is_dir():
        raise SafeFailure('runtime_release_stale')
    provider_operation(policy, environment['provider'], 'install')
    approved = configuration(policy)
    try:
        image_id = json.loads(docker('image', 'inspect', approved['image']))[0]['Id']
    except (SafeFailure, ValueError, TypeError, KeyError, IndexError):
        raise SafeFailure('runtime_release_stale') from None
    if image_id != approved['image']:
        raise SafeFailure('runtime_release_stale')
    try:
        docker('rm', '-f', environment['container_name'])
        if inspect_container(environment['container_name']) is not None \
                or volume not in docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines():
            raise SafeFailure('runtime_release_stale')
        create_runtime(policy, environment, None)
    except SafeFailure:
        raise SafeFailure('runtime_release_stale') from None


def require_current_runtime(policy: dict, environment: dict) -> dict:
    observed = inspect_container(environment['container_name'])
    if observed is None or observed['State']['Running'] is not True:
        raise SafeFailure('quota environment is not running')
    mismatches = spec_mismatches(policy, environment, observed)
    if mismatches and mismatches <= RELEASE_BIND_DRIFT and profile_owned(policy, environment, observed):
        replace_release_binds(policy, environment)
        observed = inspect_container(environment['container_name'])
        if observed is None or observed['State']['Running'] is not True:
            raise SafeFailure('runtime_release_stale')
    elif 'image' in mismatches and profile_owned(policy, environment, observed):
        raise SafeFailure('runtime_image_stale')
    validate(policy, environment, observed)
    return observed


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


def provider_login_executable(environment: dict) -> str:
    executable = provider_executable(environment)
    if environment['provider'] != 'codex':
        return executable
    prefix = '/home/node/.local' if executable.startswith('/home/node/.local/') else '/usr/local'
    script = ('import pathlib,platform,sys;root=pathlib.Path(sys.argv[1]);'
              'arch={"x86_64":"x64","aarch64":"arm64"}[platform.machine()];'
              'triple={"x64":"x86_64","arm64":"aarch64"}[arch]+"-unknown-linux-musl";'
              'package=root/"lib/node_modules/@openai/codex";'
              'candidates=[package/"node_modules/@openai"/("codex-linux-"+arch)/"vendor"/triple/"bin/codex",'
              'package/"vendor"/triple/"bin/codex"];'
              'found=[p.resolve() for p in candidates if p.is_file()];'
              'valid=[p for p in found if p.is_relative_to(root) and p.read_bytes()[:4]==b"\\x7fELF"];'
              'sys.exit(2) if len(valid)!=1 else print(valid[0])')
    native = docker('exec', '-w', '/', '--user', '1000:1000', environment['container_name'], '/usr/bin/python3', '-I', '-B', '-c', script, prefix).decode().strip()
    pattern = re.escape(prefix) + r'/lib/node_modules/@openai/codex/(?:node_modules/@openai/codex-linux-(?:x64|arm64)/)?vendor/(?:x86_64|aarch64)-unknown-linux-musl/bin/codex'
    if re.fullmatch(pattern, native) is None:
        raise SafeFailure('native quota login executable escapes its provider package')
    return native


def create(policy: dict, environment: dict) -> dict:
    provider_operation(policy, environment['provider'], 'install')
    existing = inspect_container(environment['container_name'])
    if existing is not None:
        return create_runtime(policy, environment, existing)
    volume = environment['container_name'] + '-profile'
    retained_volume = volume in docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
    try:
        return create_runtime(policy, environment, None)
    except Exception as error:
        if isinstance(error, SafeFailure) and str(error) == 'quota provider operation or pinned descriptor is unavailable':
            raise
        if retained_volume:
            observed = inspect_container(environment['container_name'])
            if observed is not None:
                validate(policy, environment, observed)
                docker('rm', '-f', environment['container_name'])
            if inspect_container(environment['container_name']) is not None:
                raise SafeFailure('failed quota environment removal was not observed') from None
        else:
            remove(policy, environment)
        raise


def create_runtime(policy: dict, environment: dict, existing: dict | None) -> dict:
    provider_operation(policy, environment['provider'], 'install')
    approved = configuration(policy)
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
               *[value for destination, options in TMPFS.items() for value in ('--tmpfs', destination + ':' + options)],
               '--mount', f'type=volume,source={volume},target=/home/node',
               '--volume', f'{EXECUTOR_SOURCE}:/cauce/executor:ro,z',
               '--volume', f'{LIFECYCLE_SOURCE}:/cauce/lifecycle:ro,z',
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
    try:
        docker('exec', '--user', '0', environment['container_name'], '/usr/bin/chown', '1000:1000', '/home/node')
    except SafeFailure as error:
        raise SafeFailure('quota profile volume is not owned by its runtime user') from error
    return {'runtime_verified': True, 'container_name': environment['container_name'], 'cli_version': provider_version(environment)}


def remove(policy: dict, environment: dict) -> dict:
    existing = inspect_container(environment['container_name'])
    if existing is not None:
        mismatches = spec_mismatches(policy, environment, existing)
        if not (mismatches and mismatches <= RELEASE_BIND_DRIFT and profile_owned(policy, environment, existing)):
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
    observed = require_current_runtime(policy, environment)
    command = provider_operation(policy, environment['provider'], 'authenticate', command=True)
    if pathlib.PurePosixPath(command[0]).name != environment['provider']:
        raise SafeFailure('descriptor login executable differs from the quota provider')
    command[0] = provider_login_executable(environment)
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


def verify_command_observation(policy: dict, environment: dict, command: list) -> tuple:
    response = subprocess.run(['/usr/bin/docker', 'exec', '--user', '1000:1000', environment['container_name'],
                               *command], capture_output=True, timeout=60, check=False)
    if len(response.stdout) > 65536:
        raise SafeFailure('quota verification exceeds its output limit')
    return response.returncode, response.stdout


def verify_authentication(policy: dict, document: dict) -> dict:
    environment = packet(policy, document)
    if document['action'] != 'authenticate':
        raise SafeFailure('quota authentication verification requires a consented login operation')
    require_current_runtime(policy, environment)
    verify = descriptor_verify_command(policy, environment['provider'])
    if verify is not None:
        code, stdout = verify_command_observation(policy, environment, verify)
        identity = None
        try:
            parsed = json.loads(stdout)
        except (ValueError, UnicodeError):
            parsed = None
        if isinstance(parsed, dict):
            if parsed.get('ok') is True and isinstance(parsed.get('account_id'), str):
                identity = parsed['account_id']
        elif code == 0 and stdout.strip():
            # Cheap liveness proof without a remote identity (agy models): bind a
            # local identity that never merges two Cauce accounts.
            identity = environment['provider'] + '-local:' + hashlib.sha256(environment['account_id'].encode()).hexdigest()
        if not isinstance(identity, str) or not 1 <= len(identity) <= 256 \
                or any(ord(character) < 32 or ord(character) == 127 for character in identity):
            raise SafeFailure('quota login lacks a successful provider request and remote account identity')
        return {'authenticated_verified': True, 'account_identity': identity}
    raw = query_observation(policy, environment)
    if environment['provider'] == 'codex':
        successful = raw.get('error') is None and raw.get('fuente') == 'wham-http'
        extra = raw.get('extra')
        identity = extra.get('account_id') if isinstance(extra, dict) else None
    else:
        successful = raw.get('ok') is True
        identity = raw.get('account_id')
    if not successful or not isinstance(identity, str) or not 1 <= len(identity) <= 256 \
            or any(ord(character) < 32 or ord(character) == 127 for character in identity) \
            or environment['provider'] == 'grok' and GROK_IDENTITY.fullmatch(identity) is None:
        raise SafeFailure('quota login lacks a successful provider request and remote account identity')
    return {'authenticated_verified': True, 'account_identity': identity}


# Failure texts the gateway already maps to a closed quota step reason; any other
# failure of an update leaves this one static code instead of raw installer output.
_UPDATE_KNOWN_FAILURES = frozenset({
    'cli_update_failed', 'cli_update_timed_out', 'runtime_release_stale', 'runtime_image_stale',
    'quota environment is not running', 'quota container isolation or ownership differs',
    'quota profile volume ownership differs',
})


def _update_cli_failure(error: SafeFailure) -> SafeFailure:
    return error if str(error) in _UPDATE_KNOWN_FAILURES else SafeFailure('cli_update_failed')


def perform(policy: dict, document: dict) -> dict:
    if isinstance(document, dict) and document.get('action') == 'query_agent':
        from fleet_executor_agent_quota import perform as query_agent
        return query_agent(policy, document)
    environment = packet(policy, document)
    action = document['action']
    if action == 'create':
        return create(policy, environment)
    if action == 'delete':
        return remove(policy, environment)
    if action == 'update_cli':
        try:
            require_current_runtime(policy, environment)
            # Under the host receipt budget (240s) so a timeout is reported instead of a killed process with no stderr.
            command = ['/usr/bin/docker', 'exec', '--user', '1000:1000', environment['container_name'],
                       *provider_operation(policy, environment['provider'], 'update', command=True)]
            try:
                result = subprocess.run(command, capture_output=True, timeout=200, check=False)
            except subprocess.TimeoutExpired as error:
                raise SafeFailure('cli_update_timed_out') from error
            except (OSError, subprocess.SubprocessError) as error:
                raise SafeFailure('cli_update_failed') from error
            if result.returncode:
                raise SafeFailure('cli_update_failed')
            return {'cli_updated_verified': True, 'cli_version': provider_version(environment, updated=True)}
        except SafeFailure as error:
            raise _update_cli_failure(error) from None
        except Exception:
            raise SafeFailure('cli_update_failed') from None
    require_current_runtime(policy, environment)
    if action == 'authenticate':
        return {'awaiting_auth': True, 'login_plan': login_plan(policy, document)}
    if action == 'query':
        raw = query_observation(policy, environment)
        from quota_snapshot import normalize_cli_snapshot
        return {**normalize_cli_snapshot(environment['provider'], raw, environment['account_id']),
                'cli_version': provider_version(environment)}
    raise SafeFailure('unsupported quota environment action')
