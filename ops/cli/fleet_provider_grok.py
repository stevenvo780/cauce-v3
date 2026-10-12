from __future__ import annotations

import json
import urllib.request

from fleet_provider_identity import (
    nonce_roundtrip,
    profile_values,
    read_profile_json,
    validate_provider_binding,
    validate_provider_selection,
)

USERINFO_ENDPOINT = 'https://auth.x.ai/oauth2/userinfo'


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
    document = read_profile_json(str(root) + '/auth.json')
    if document is None:
        return set()
    identities = set()
    for token in dict.fromkeys(profile_values(document, {'key'})):
        try:
            userinfo = fetch_userinfo(token)
        except Exception:
            continue
        for claim in ('email', 'sub'):
            if isinstance(userinfo.get(claim), str) and userinfo[claim]:
                identities.add(userinfo[claim])
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
