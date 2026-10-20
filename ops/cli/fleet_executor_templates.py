from __future__ import annotations

import hashlib
import json
import pathlib
import re
import unicodedata

from fleet_executor_policy import SafeFailure, bounded_text, path

USER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,63}')
HASH = re.compile(r'[0-9a-f]{64}')
CONTAINER = re.compile(r'[a-z][a-z0-9-]{0,127}')
PREFIX = re.compile(r'[a-z][a-z0-9-]{0,47}-')


def descriptor_login_arguments(policy: dict, harness: str):
    """Login arguments declared by the harness descriptor in its bundle, if any."""
    bundle = (policy.get('bundles') or {}).get(harness)
    directory = bundle.get('directory') if isinstance(bundle, dict) else None
    if not isinstance(directory, str):
        return None
    try:
        from harness_operations import read_descriptor
        descriptor, _ = read_descriptor(directory, harness, expected_sha256=bundle.get('descriptor_sha256'))
    except (OSError, ValueError, KeyError, TypeError):
        return None
    argv = (descriptor.get('provider') or {}).get('authenticate_argv')
    return argv[1:] if argv else None


def validate_login(row: dict, policy: dict | None = None):
    login = row['login']
    if not isinstance(login, dict) or set(login) - {'files', 'env'} != {'method', 'command', 'sha256'} \
            or login['method'] not in ('device', 'terminal') or not isinstance(login['sha256'], str) \
            or HASH.fullmatch(login['sha256']) is None:
        raise SafeFailure('invalid approved provider login')
    command = login['command']
    if not isinstance(command, list) or not 1 <= len(command) <= 32 or any(not isinstance(value, str)
            or len(value) > 4096 or any(unicodedata.category(char) == 'Cc' for char in value) for value in command):
        raise SafeFailure('invalid approved provider login command')
    path(command[0])
    pins = login.get('files', {})
    if not isinstance(pins, dict) or len(pins) > 32:
        raise SafeFailure('invalid approved provider login pins')
    for filename, fingerprint in pins.items():
        path(filename)
        if not isinstance(fingerprint, str) or HASH.fullmatch(fingerprint) is None:
            raise SafeFailure('invalid approved provider login pin')
    if any(value.startswith('/') and value not in pins for value in command[1:]):
        raise SafeFailure('provider login argument has no exact file pin')
    env = login.get('env', {})
    if not isinstance(env, dict) or len(env) > 32 or any(not isinstance(key, str)
            or key not in {'LANG', 'LC_ALL', 'TERM', 'NO_COLOR'} or not isinstance(value, str)
            or not 1 <= len(value) <= 4096 or any(unicodedata.category(char) == 'Cc' for char in value)
            for key, value in env.items()):
        raise SafeFailure('invalid approved provider login environment')
    driver = row.get('openclaw')
    if driver is None:
        legacy = ['login', '--device-auth'] if row['provider'] in {'codex', 'grok'} and login['method'] == 'device' else \
            ['login'] if row['provider'] == 'muse' and login['method'] == 'device' else \
            ['login'] if row['provider'] == 'codex' else ['auth', 'login'] if row['provider'] == 'claude' and login['method'] == 'terminal' else None
        declared = descriptor_login_arguments(policy, row['provider']) if policy else None
        arguments = declared if declared is not None and login['method'] == 'device' else legacy
        valid = arguments is not None and command[0] == row['command'] and login['sha256'] == row['command_sha256'] and command[1:] == arguments
    elif driver.get('method_id') == 'cli':
        # Anthropic `cli`: the Claude Code login itself, isolated in the account profile by the gateway.
        valid = command == [driver.get('claude_command'), 'auth', 'login'] and login['sha256'] == driver.get('claude_command_sha256') \
            and login['method'] == 'terminal'
    else:
        valid = command[0] == driver['node_command'] and login['sha256'] == driver['node_command_sha256'] \
            and command[1:] == [row['command'], 'models', 'auth', 'login'] and login['method'] == 'device' \
            and pins.get(row['command']) == row['command_sha256']
    if not valid:
        raise SafeFailure('provider login differs from the approved functional command')


def template_matches(row: dict, provider: str, user: str, harness: str, mode: str, name: str | None,
                     prefix: str | None = None) -> bool:
    if row['provider'] != provider or row['runtime_user'] != user or ('openclaw' in row) != (harness == 'openclaw') \
            or row.get('runtime_mode', mode) != mode:
        return False
    if 'container_name' in row:
        return name == row['container_name'] if prefix is None else row['container_name'].startswith(prefix)
    if 'container_prefix' in row:
        return isinstance(name, str) and name.startswith(row['container_prefix']) if prefix is None else \
            prefix.startswith(row['container_prefix']) or row['container_prefix'].startswith(prefix)
    return True


def matching_templates(policy: dict, provider: str, user: str, harness: str, mode: str, name: str | None,
                       prefix: str | None = None) -> list:
    return [row for row in policy.get('profile_templates', [])
            if template_matches(row, provider, user, harness, mode, name, prefix)]


def resolved_template(policy: dict, agent: dict, provider: str) -> dict:
    rows = matching_templates(policy, provider, agent['runtime_user'], agent['harness_id'],
                             agent['runtime_mode'], agent.get('container_name'))
    if len(rows) != 1:
        raise SafeFailure('provider account has no unique approved profile template')
    return rows[0]


def validate_accounts(rows):
    fields = {'id', 'provider', 'external_account_id', 'payer_tenant_id', 'shared_with_pool', 'enabled'}
    if not isinstance(rows, list) or len(rows) > 1000:
        raise SafeFailure('trusted accounts exceed their bound')
    identities = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != fields or not bounded_text(row['id'], 128) \
                or not isinstance(row['provider'], str) or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', row['provider']) is None \
                or not bounded_text(row['external_account_id'], 256) \
                or not bounded_text(row['payer_tenant_id'], 64) or type(row['shared_with_pool']) is not bool \
                or type(row['enabled']) is not bool or row['id'] in identities:
            raise SafeFailure('invalid or duplicate trusted account')
        identities.add(row['id'])


def validate_templates(policy: dict):
    rows = policy.get('container_templates', [])
    fields = {'harness_id', 'prefix', 'image', 'runtime_user', 'systemd_user', 'home_directory',
              'state_root', 'profile_root', 'python'}
    if not isinstance(rows, list) or len(rows) > 100:
        raise SafeFailure('invalid bounded container templates')
    identities = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != fields or row['harness_id'] not in policy['bundles'] \
                or not isinstance(row['prefix'], str) or re.fullmatch(r'[a-z][a-z0-9-]{0,47}-', row['prefix']) is None \
                or re.fullmatch(r'sha256:[0-9a-f]{64}', row.get('image', '')) is None \
                or any(not isinstance(row[key], str) or USER.fullmatch(row[key]) is None for key in ('runtime_user', 'systemd_user')):
            raise SafeFailure('invalid approved container template')
        for key in ('home_directory', 'state_root', 'profile_root', 'python'):
            path(row[key])
        state, profile = path(row['state_root']), path(row['profile_root'])
        if state.is_relative_to(profile) or profile.is_relative_to(state):
            raise SafeFailure('provider profile root must survive runtime state purge')
        identity = (row['harness_id'], row['prefix'])
        if identity in identities:
            raise SafeFailure('ambiguous approved container template')
        identities.add(identity)
    profiles = policy.get('profile_templates', [])
    fields = {'provider', 'runtime_user', 'path_root', 'command', 'command_sha256'}
    if not isinstance(profiles, list) or len(profiles) > 100:
        raise SafeFailure('invalid bounded provider profile templates')
    identities = set()
    for row in profiles:
        if not isinstance(row, dict) or set(row) - {'command_files', 'openclaw', 'muse', 'runtime_mode', 'container_name', 'container_prefix', 'login'} != fields \
                or not isinstance(row['provider'], str) or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', row['provider']) is None \
                or not isinstance(row['runtime_user'], str) or USER.fullmatch(row['runtime_user']) is None \
                or not isinstance(row['command_sha256'], str) or HASH.fullmatch(row['command_sha256']) is None:
            raise SafeFailure('invalid approved provider profile template')
        for key in ('path_root', 'command'):
            path(row[key])
        pins = row.get('command_files', {})
        if not isinstance(pins, dict) or len(pins) > 32:
            raise SafeFailure('invalid approved provider argument pins')
        for filename, fingerprint in pins.items():
            path(filename)
            if not isinstance(fingerprint, str) or HASH.fullmatch(fingerprint) is None:
                raise SafeFailure('invalid approved provider argument pin')
        if 'openclaw' in row:
            from fleet_provider_openclaw import validate_definition
            validate_definition(row['openclaw'], row['provider'])
        if (row['provider'] == 'muse') != ('muse' in row):
            raise SafeFailure('Muse profile requires its exact approved bridge')
        if 'muse' in row:
            from fleet_provider_muse import validate_definition
            validate_definition(row['muse'], row['provider'])
        selectors = [key for key in ('container_name', 'container_prefix') if key in row]
        if 'runtime_mode' in row and row['runtime_mode'] not in ('native', 'container') \
                or selectors and row.get('runtime_mode') != 'container' \
                or row.get('runtime_mode') == 'container' and len(selectors) != 1:
            raise SafeFailure('invalid approved provider placement selector')
        if 'container_name' in row and (not isinstance(row['container_name'], str) or CONTAINER.fullmatch(row['container_name']) is None) \
                or 'container_prefix' in row and (not isinstance(row['container_prefix'], str) or PREFIX.fullmatch(row['container_prefix']) is None):
            raise SafeFailure('invalid approved provider container selector')
        if 'login' in row:
            validate_login(row, policy)
        identity = (row['provider'], row['runtime_user'], 'openclaw' in row,
                    row.get('runtime_mode'), row.get('container_name'), row.get('container_prefix'))
        if identity in identities:
            raise SafeFailure('ambiguous approved provider profile template')
        identities.add(identity)


def resolve_profile(policy: dict, agent: dict) -> dict | None:
    account = agent.get('primary_account_id')
    if account is None:
        return None
    matches = [row for row in agent.get('_trusted_accounts', []) if row['id'] == account]
    if account in policy['profiles'] and not agent.get('_trusted_accounts_present'):
        return policy['profiles'][account]
    # Binding derivation needs payer consent, not an enabled account: a pending registration
    # must mount its profile so preparation can pause at authenticate.
    if len(matches) != 1 or not (
            matches[0]['payer_tenant_id'] == agent['tenant_id'] or matches[0]['shared_with_pool'] is True):
        raise SafeFailure('provider account has no current authorized durable binding')
    trusted = matches[0]
    if account in policy['profiles']:
        binding = policy['profiles'][account]
        from fleet_provider_identity import valid_account_identity
        if binding.get('identity') == 'unverified:' + account and valid_account_identity(trusted['external_account_id']):
            binding = {**binding, 'identity': trusted['external_account_id']}
        if binding.get('provider') != trusted['provider'] or binding.get('identity') != trusted['external_account_id']:
            raise SafeFailure('static provider binding differs from the current durable account')
        if (agent['harness_id'] == 'openclaw') != ('openclaw' in binding):
            raise SafeFailure('static provider driver differs from the requested harness')
        return binding
    if agent['harness_id'] != 'openclaw' and trusted['provider'] != agent['harness_id']:
        raise SafeFailure('provider account differs from the requested harness')
    template = resolved_template(policy, agent, trusted['provider'])
    profile_root = path(template['path_root'])
    if agent['runtime_mode'] == 'container' and str(profile_root) != agent['_placement'].get('profile_root'):
        raise SafeFailure('provider profile template differs from the dedicated mount')
    if agent['runtime_mode'] == 'native' and profile_root.is_relative_to(path(agent['_placement']['state_root'])):
        raise SafeFailure('provider profile template must survive runtime state purge')
    result = {'provider': trusted['provider'], 'identity': trusted['external_account_id'], 'runtime_user': agent['runtime_user'],
        'path': str(profile_root / agent['runtime_key'] / hashlib.sha256(account.encode()).hexdigest()),
        'command': template['command'], 'command_sha256': template['command_sha256']}
    if 'command_files' in template:
        result['command_files'] = template['command_files']
    if 'openclaw' in template:
        result['openclaw'] = dict(template['openclaw'])
    if 'muse' in template:
        result['muse'] = dict(template['muse'])
    if agent['runtime_mode'] == 'container':
        result['container_name'] = agent['container_name']
    return result


def fleet_harnesses(policy: dict) -> dict:
    """Fleet-eligible harnesses derive from each bundle descriptor: a harness is
    eligible only while its descriptor declares install, execute and authenticate."""
    import fleet_executor_runtime  # noqa: F401  (places the container runtime on sys.path)
    from cauce_container_base import PermanentError
    from harness_operations import HarnessOperationFailure, fleet_module, resolve_operation
    eligible = {}
    for harness, bundle in policy['bundles'].items():
        directory = bundle.get('directory') if isinstance(bundle, dict) else None
        if not isinstance(directory, str):
            continue
        try:
            if 'digest' in bundle:
                from fleet_executor_runtime import approved_bundle
                approved_bundle(policy, {'harness_id': harness, 'runtime_mode': 'container'})
            for operation in ('install', 'execute', 'authenticate'):
                resolve_operation(harness, operation, directory, expected_sha256=bundle.get('descriptor_sha256'))
            module = fleet_module(harness, directory, expected_sha256=bundle.get('descriptor_sha256'))
            if module is not None and not (pathlib.Path(__file__).resolve().parent / f'{module}.py').is_file():
                continue
            eligible[harness] = module
        except (HarnessOperationFailure, SafeFailure, OSError, PermanentError):
            continue
    return eligible


def runtime_candidates(policy: dict) -> list[dict]:
    runtimes = []
    measured = {}
    eligible = fleet_harnesses(policy)
    fields = ('runtime_user', 'systemd_user', 'home_directory', 'state_root')
    for mode, name, candidate in ([('native', None, row) for row in policy['native']] +
            [('container', name, row) for name, row in sorted(policy['containers'].items())] +
            [('container', None, row) for row in policy.get('container_templates', [])]):
        for harness in sorted(policy['bundles']):
            if harness not in eligible or candidate.get('harness_id', harness) != harness:
                continue
            module = None
            if eligible[harness]:
                from importlib import import_module
                try:
                    module = import_module(eligible[harness])
                except ImportError:
                    continue
                if hasattr(module, 'authentication_supported') and not module.authentication_supported():
                    continue
            if harness == 'openclaw':
                providers = sorted({row['provider'] for row in policy.get('profile_templates', []) if 'openclaw' in row and row.get('provider')}
                    | {row['provider'] for row in policy.get('profiles', {}).values() if 'openclaw' in row and row.get('provider')}) or ['codex']
            else:
                providers = [harness]
            for provider in providers:
                prefix = candidate.get('prefix') if mode == 'container' and name is None else None
                templates = matching_templates(policy, provider, candidate['runtime_user'], harness, mode, name, prefix)
                if len(templates) > 1:
                    continue
                templates = [row for row in templates if (not path(row['path_root']).is_relative_to(path(candidate['state_root']))
                    if mode == 'native' else row['path_root'] == candidate.get('profile_root'))
                    and (prefix is None or 'container_name' not in row and prefix.startswith(row.get('container_prefix', prefix)))]
                profiles = [row for row in policy.get('profiles', {}).values() if row.get('provider') == provider
                    and prefix is None
                    and ('openclaw' in row) == (harness == 'openclaw')
                    and row.get('runtime_user') == candidate['runtime_user'] and row.get('command') and row.get('command_sha256')
                    and (row.get('container_name') == name if mode == 'container' else 'container_name' not in row)]
                if not templates and not profiles:
                    continue
                if module is not None and hasattr(module, 'measured_definition'):
                    approved = False
                    for row in templates + profiles:
                        key = json.dumps([row, candidate if mode == 'container' else None], sort_keys=True)
                        if key not in measured:
                            measure_container = getattr(module, 'measured_container_definition', None) if mode == 'container' else None
                            measured[key] = measure_container(row, candidate) if measure_container else module.measured_definition(row)
                        approved = approved or measured[key]
                    if not approved:
                        continue
                runtime = {key: candidate.get(key) for key in fields}
                from fleet_provider_muse import EFFORTS
                runtime.update(mode=mode, harness_id=harness, provider=provider,
                    reasoning_efforts=([] if harness == 'grok' else sorted(EFFORTS) if harness == 'muse' else
                        ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] if harness == 'openclaw' else
                        ['minimal', 'low', 'medium', 'high', 'xhigh'] if harness == 'codex' else ['low', 'medium', 'high', 'xhigh', 'max']))
                if mode == 'container':
                    runtime['container_name' if name else 'container_prefix'] = name or candidate['prefix']
                runtimes.append(runtime)
    return runtimes


def capabilities(policy: dict) -> dict:
    runtimes = runtime_candidates(policy)
    enabled = bool(runtimes) and 'transport' in policy and all(key in policy['hooks'] for key in ('authenticate', 'profile', 'verify', 'revoke'))
    placement = {'host_id': policy['host_id'], 'modes': sorted({row['mode'] for row in runtimes}),
        'runtime_users': sorted({row['runtime_user'] for row in runtimes}),
        'systemd_users': sorted({row['systemd_user'] for row in runtimes if row['systemd_user'] is not None}),
        'home_roots': sorted({row['home_directory'] for row in runtimes}), 'state_roots': sorted({row['state_root'] for row in runtimes}),
        'runtimes': runtimes}
    if 'extensions_allowed' in policy:
        placement['extensions_allowed'] = policy['extensions_allowed']
    if not enabled:
        return {'available': False, 'actions': [], 'placements': [], 'reason': 'executor_unconfigured'}
    from fleet_executor_authority import authority_ready
    if not authority_ready(policy):
        return {'available': False, 'actions': [], 'placements': [], 'reason': 'executor_unconfigured'}
    return {'available': True, 'actions': ['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge'],
            'placements': [placement]}
