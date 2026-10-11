from __future__ import annotations

from fleet_provider_identity import validate_provider_binding, validate_provider_selection


def environment(binding: dict, agent: dict) -> dict:
    root = validate_provider_binding(binding, agent, 'grok')
    validate_provider_selection(agent, 'grok', frozenset())
    return {'GROK_HOME': str(root)}


def login_command(binding: dict) -> list[str]:
    return [binding['command'], 'login', '--device-auth']


def execution_arguments(agent: dict, prompt_file: str) -> list[str]:
    from fleet_policy_paths import path
    validate_provider_selection(agent, 'grok', frozenset())
    return ['--prompt-file', str(path(prompt_file)), '--output-format', 'json', '--verbatim',
            '--no-subagents', '--disable-web-search', '--tools', '', '--max-turns', '1',
            *(['--model', agent['model_id']] if agent.get('model_id') is not None else [])]


def authentication_supported() -> bool:
    return False


def authenticated_grok(packet: dict) -> bool:
    environment(packet['profile_binding'], packet['agent'])
    return False
