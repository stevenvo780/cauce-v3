from __future__ import annotations

import json

from fleet_provider_identity import (
    nonce_roundtrip,
    profile_identity_candidates,
    validate_provider_binding,
    validate_provider_selection,
)


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
        if packet['identity'] not in profile_identity_candidates(str(root) + '/auth.json'):
            return False
        return nonce_roundtrip(packet, lambda prompt: execution_arguments(packet['agent'], prompt), reply_text)
    except Exception:
        return False


authenticated_grok = authenticated
