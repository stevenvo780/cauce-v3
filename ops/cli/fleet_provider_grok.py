from __future__ import annotations

import json
import os
import pathlib
import re
import subprocess
import urllib.request
import uuid

from fleet_provider_identity import (
    nonce_roundtrip,
    read_profile_json,
    validate_provider_binding,
    validate_provider_selection,
)

USERINFO_ENDPOINT = 'https://auth.x.ai/oauth2/userinfo'
VERSION = '1.0.41'


def environment(binding: dict, agent: dict) -> dict:
    root = validate_provider_binding(binding, agent, 'grok')
    validate_provider_selection(agent, 'grok', frozenset())
    return {'GROK_HOME': str(root)}


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


def measured_definition(binding: dict) -> bool:
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
        return False


def measured_container_definition(binding: dict, placement: dict) -> bool:
    name = 'cauce-grok-probe-' + uuid.uuid4().hex
    try:
        if not direct_login(binding) or re.fullmatch(r'sha256:[a-f0-9]{64}', placement.get('image', '')) is None:
            return False
        if ':' in str(pathlib.Path(__file__).resolve().parent):
            return False
        program = ('import json,sys;sys.path.insert(0,"/cauce/executor");'
                   'from fleet_provider_grok import measured_definition;'
                   'sys.exit(0 if measured_definition(json.load(sys.stdin)) else 1)')
        result = subprocess.run(['/usr/bin/docker', 'run', '--rm', '--pull=never', '--name', name, '-i',
            '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m', '--user', placement['runtime_user'],
            '--volume', f'{pathlib.Path(__file__).resolve().parent}:/cauce/executor:ro,z',
            '--entrypoint', placement['python'], placement['image'], '-I', '-B', '-c', program],
            input=json.dumps(binding).encode(), capture_output=True, timeout=40, check=False)
        return result.returncode == 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return False
    finally:
        try:
            subprocess.run(['/usr/bin/docker', 'rm', '-f', name], capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            pass


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


def verified_identities(root: str) -> set:
    # Exactly the active credential (the first auth entry, as the quota reader
    # selects it) may vouch for the identity; no other stored token is tried.
    document = read_profile_json(str(root) + '/auth.json')
    if not isinstance(document, dict) or not document:
        return set()
    entry = next(iter(document.values()))
    token = entry.get('key') if isinstance(entry, dict) else None
    if not isinstance(token, str) or not token:
        return set()
    try:
        userinfo = fetch_userinfo(token)
    except Exception:
        return set()
    identities = set()
    if isinstance(userinfo.get('sub'), str) and userinfo['sub']:
        identities.add(userinfo['sub'])
    if userinfo.get('email_verified') is True and isinstance(userinfo.get('email'), str) and userinfo['email']:
        identities.add(userinfo['email'])
    return identities


def reply_text(output: bytes):
    value = json.loads(output)
    if not isinstance(value, dict) or value.get('type') == 'error':
        return None
    if value.get('stopReason') not in (None, 'end_turn'):
        return None
    return value.get('text') if isinstance(value.get('text'), str) else None


def authenticated(packet: dict) -> bool:
    try:
        root = environment(packet['profile_binding'], packet['agent'])['GROK_HOME']
        if packet['identity'] not in verified_identities(root):
            return False
        return nonce_roundtrip(packet, lambda prompt: execution_arguments(packet['agent'], prompt), reply_text)
    except Exception:
        return False


authenticated_grok = authenticated


def prepare_extensions(agent: dict, profile, state=None) -> dict:
    from fleet_provider_identity import prepare_extensions as prepare_shared
    if agent.get('harness_id') not in (None, 'grok'):
        raise ValueError('grok extension prepare refuses another harness')
    return prepare_shared({**agent, 'harness_id': 'grok'}, pathlib.Path(profile), None if state is None else pathlib.Path(state))
