from __future__ import annotations

import re

from fleet_provider_identity import validate_provider_binding, validate_provider_selection

EFFORTS = frozenset({'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'})


def validate_definition(value: dict, provider: str) -> None:
    from fleet_executor_policy import path
    if provider != 'muse' or not isinstance(value, dict) or set(value) != {'bridge', 'bridge_sha256'} \
            or not isinstance(value['bridge_sha256'], str) or re.fullmatch(r'[a-f0-9]{64}', value['bridge_sha256']) is None:
        raise ValueError('Muse bridge has no exact approved definition')
    path(value['bridge'])


def environment(binding: dict, agent: dict) -> dict:
    root = validate_provider_binding(binding, agent, 'muse')
    validate_provider_selection(agent, 'muse', EFFORTS)
    validate_definition(binding.get('muse'), binding['provider'])
    return {'XDG_CONFIG_HOME': str(root / 'config'), 'XDG_DATA_HOME': str(root / 'data'), 'MUSE_NO_AUTO_UPDATE': '1',
            'CAUCE_MUSE_CLI_COMMAND': binding['command'], 'CAUCE_MUSE_CLI_SHA256': binding['command_sha256']}


def login_command(binding: dict) -> list[str]:
    return [binding['command'], 'login']


def execution_arguments(agent: dict, prompt_file: str) -> list[str]:
    from fleet_executor_policy import path
    validate_provider_selection(agent, 'muse', EFFORTS)
    return ['exec', '--json', '--provider', 'meta', '--prompt-file', str(path(prompt_file)),
            '--disable-web-tools', '--disable-reminders', '--no-foreign-personal-context', '--no-session-log',
            '--disable-write', '--disable-shell', '--max-model-steps', '1',
            *(['--model', agent['model_id']] if agent.get('model_id') is not None else []),
            *(['--reasoning-effort', agent['reasoning_effort']] if agent.get('reasoning_effort') is not None else [])]


def authentication_supported() -> bool:
    return False


def authenticated_muse(packet: dict) -> bool:
    environment(packet['profile_binding'], packet['agent'])
    return False
