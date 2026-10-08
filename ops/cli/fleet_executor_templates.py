from __future__ import annotations

import hashlib
import re

from fleet_executor_policy import SafeFailure, bounded_text, path

USER = re.compile(r'[A-Za-z_][A-Za-z0-9_-]{0,63}')
HASH = re.compile(r'[0-9a-f]{64}')
PROVIDERS = {'codex', 'claude', 'gemini'}


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
        if not isinstance(row, dict) or set(row) - {'command_files'} != fields or row['provider'] not in PROVIDERS \
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
        identity = (row['provider'], row['runtime_user'])
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
    if len(matches) != 1 or matches[0]['enabled'] is not True or not (
            matches[0]['payer_tenant_id'] == agent['tenant_id'] or matches[0]['shared_with_pool'] is True):
        raise SafeFailure('provider account has no current authorized durable binding')
    trusted = matches[0]
    if account in policy['profiles']:
        binding = policy['profiles'][account]
        if binding.get('provider') != trusted['provider'] or binding.get('identity') != trusted['external_account_id']:
            raise SafeFailure('static provider binding differs from the current durable account')
        return binding
    if trusted['provider'] != agent['harness_id']:
        raise SafeFailure('provider account differs from the requested harness')
    templates = [row for row in policy.get('profile_templates', []) if row['provider'] == trusted['provider']
                 and row['runtime_user'] == agent['runtime_user']]
    if len(templates) != 1:
        raise SafeFailure('provider account has no unique approved profile template')
    template = templates[0]
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
    if agent['runtime_mode'] == 'container':
        result['container_name'] = agent['container_name']
    return result


def capabilities(policy: dict) -> dict:
    runtimes = []
    fields = ('runtime_user', 'systemd_user', 'home_directory', 'state_root')
    for mode, name, candidate in ([('native', None, row) for row in policy['native']] +
            [('container', name, row) for name, row in sorted(policy['containers'].items())] +
            [('container', None, row) for row in policy.get('container_templates', [])]):
        for harness in sorted(policy['bundles']):
            if harness not in {'codex', 'claude'} or candidate.get('harness_id', harness) != harness:
                continue
            templates = [row for row in policy.get('profile_templates', []) if row['provider'] == harness
                and row['runtime_user'] == candidate['runtime_user'] and (mode == 'native' or row['path_root'] == candidate.get('profile_root'))]
            profiles = [row for row in policy['profiles'].values() if row.get('provider') == harness
                and row.get('runtime_user') == candidate['runtime_user'] and row.get('command') and row.get('command_sha256')
                and (row.get('container_name') == name if mode == 'container' else 'container_name' not in row)]
            if not templates and not profiles:
                continue
            runtime = {key: candidate.get(key) for key in fields}
            runtime.update(mode=mode, harness_id=harness, provider=harness,
                reasoning_efforts=['minimal', 'low', 'medium', 'high', 'xhigh'] if harness == 'codex' else ['low', 'medium', 'high', 'xhigh', 'max'])
            if mode == 'container':
                runtime['container_name' if name else 'container_prefix'] = name or candidate['prefix']
            runtimes.append(runtime)
    enabled = bool(runtimes) and 'transport' in policy and all(key in policy['hooks'] for key in ('authenticate', 'profile', 'verify', 'revoke'))
    placement = {'host_id': policy['host_id'], 'modes': sorted({row['mode'] for row in runtimes}),
        'runtime_users': sorted({row['runtime_user'] for row in runtimes}),
        'systemd_users': sorted({row['systemd_user'] for row in runtimes if row['systemd_user'] is not None}),
        'home_roots': sorted({row['home_directory'] for row in runtimes}), 'state_roots': sorted({row['state_root'] for row in runtimes}),
        'runtimes': runtimes}
    if not enabled:
        return {'available': False, 'actions': [], 'placements': [], 'reason': 'executor_unconfigured'}
    return {'available': True, 'actions': ['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge'],
            'placements': [placement]}
