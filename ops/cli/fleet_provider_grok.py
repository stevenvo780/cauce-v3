from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import urllib.request

from fleet_provider_identity import (
    matching_identity,
    nonce_roundtrip,
    note_probe_exception,
    probe_failed,
    read_profile_json,
    validate_provider_binding,
    validate_provider_selection,
)

USERINFO_ENDPOINT = 'https://auth.x.ai/oauth2/userinfo'
VERSION = '1.0.41'


def environment(binding: dict, agent: dict) -> dict:
    root = validate_provider_binding(binding, agent, 'grok')
    validate_provider_selection(agent, 'grok', frozenset())
    values = {'GROK_HOME': str(root)}
    if agent.get('runtime_mode') == 'container':
        # The adapter seeds AGENTS.md where the harness runs (start_container's working directory).
        values['CAUCE_GROK_WORKSPACE'] = str(pathlib.Path(agent['state_directory']) / 'space' / 'projects')
        # Read-only container root: the adapter stages fd 0 under TMPDIR and grok writes temp files there.
        values['TMPDIR'] = str(root / 'tmp')
    return values


def validate_binding(binding: dict, agent: dict) -> None:
    environment(binding, agent)


def login_command(binding: dict) -> list[str]:
    return [binding['command'], 'login', '--device-auth']


def execution_arguments(agent: dict, prompt_file: str) -> list[str]:
    from fleet_policy_paths import path
    validate_provider_selection(agent, 'grok', frozenset())
    return ['--prompt-file', str(path(prompt_file)), '--output-format', 'json', '--verbatim',
            '--no-subagents', '--disable-web-search', '--tools', '', '--max-turns', '1',
            *(['--model', agent['model_id']] if agent.get('model_id') is not None else [])]


def authentication_supported() -> bool:
    return True


def direct_login(binding: dict) -> bool:
    login = binding.get('login')
    command = login.get('command') if isinstance(login, dict) else None
    return binding.get('provider') == 'grok' and 'openclaw' not in binding and isinstance(login, dict) \
        and login.get('method') == 'device' and isinstance(command, list) \
        and command[1:] == ['login', '--device-auth'] and command[0] == binding.get('command') \
        and login.get('sha256') == binding.get('command_sha256')


def measured_definition(binding: dict, *, strict: bool = False) -> bool:
    import tempfile

    from fleet_provider_identity import command_output, provider_command
    try:
        if not direct_login(binding):
            return False
        with tempfile.TemporaryDirectory(prefix='cauce-grok-capability-') as directory:
            home, state, profile = (directory + suffix for suffix in ('/home', '/state', '/profile'))
            for folder in (home, state, profile):
                os.mkdir(folder, 0o700)
            packet = {'profile_binding': {**binding, 'path': profile}, 'agent': {
                'harness_id': 'grok', 'runtime_user': binding['runtime_user'], 'runtime_key': 'capability-probe',
                'state_directory': state, 'home_directory': home, 'model_id': 'grok-4.7'}}
            version = command_output([provider_command(packet), '--version'], packet, timeout=20).decode().strip()
            return version == 'grok ' + VERSION or version.startswith('grok ' + VERSION + ' ')
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, UnicodeError):
        if strict:
            raise
        return False


def measured_container_definition(binding: dict, placement: dict, *, strict: bool = False) -> bool:
    from fleet_provider_capability_probe import container_probe

    try:
        if not direct_login(binding) or re.fullmatch(r'sha256:[a-f0-9]{64}', placement.get('image', '')) is None:
            return False
        return container_probe(binding, placement, 'grok', tmpfs_size='64m')
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        if strict:
            raise
        return False


def fetch_userinfo(access_token: str) -> dict:
    """Verified identity source: the provider itself, over TLS, for this token."""
    request = urllib.request.Request(USERINFO_ENDPOINT, headers={'Authorization': 'Bearer ' + access_token})
    opener = urllib.request.build_opener(type('NoRedirect', (urllib.request.HTTPRedirectHandler,),
                                               {'redirect_request': lambda self, *args, **kwargs: None}))
    with opener.open(request, timeout=10) as response:
        raw = response.read(16385)
    if len(raw) > 16384:
        raise ValueError('userinfo response exceeds limit')
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError('userinfo response is not an object')
    return value


def verified_identities(root: str) -> list[str]:
    document = read_profile_json(str(root) + '/auth.json')
    if not isinstance(document, dict) or not document:
        return []
    entry = next(iter(document.values()))
    token = entry.get('key') if isinstance(entry, dict) else None
    if not isinstance(token, str) or not token:
        return []
    try:
        userinfo = fetch_userinfo(token)
    except Exception:
        return []
    identities = []
    if isinstance(userinfo.get('sub'), str) and userinfo['sub']:
        identities.append(userinfo['sub'])
    if userinfo.get('email_verified') is True and isinstance(userinfo.get('email'), str) and userinfo['email']:
        identities.append(userinfo['email'])
    return identities


def reply_text(output: bytes):
    value = json.loads(output)
    if not isinstance(value, dict) or value.get('type') == 'error':
        return None
    if value.get('stopReason') not in (None, 'end_turn'):
        return None
    return value.get('text') if isinstance(value.get('text'), str) else None


def authenticated_identity(packet: dict) -> str | None:
    try:
        env = environment(packet['profile_binding'], packet['agent'])
    except Exception:
        probe_failed('config_scope')
        return None
    try:
        if 'TMPDIR' in env:
            os.makedirs(env['TMPDIR'], mode=0o700, exist_ok=True)
        # Grok renews its 6 h access token when it starts: run it first so userinfo sees a live token.
        if not nonce_roundtrip(packet, lambda prompt: execution_arguments(packet['agent'], prompt), reply_text):
            return None
        return matching_identity(packet['identity'], verified_identities(env['GROK_HOME']))
    except Exception as error:
        note_probe_exception(error)
        return None


def authenticated(packet: dict) -> bool:
    return authenticated_identity(packet) is not None


authenticated_grok = authenticated


def prepare_extensions(agent: dict, profile, state=None) -> dict:
    from fleet_provider_identity import prepare_extensions as prepare_shared
    if agent.get('harness_id') not in (None, 'grok'):
        raise ValueError('grok extension prepare refuses another harness')
    return prepare_shared({**agent, 'harness_id': 'grok'}, pathlib.Path(profile), None if state is None else pathlib.Path(state))
