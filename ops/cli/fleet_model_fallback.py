"""Pairing of an OpenClaw client with the Muse agent that answers when the client's model fails.

Both agents declare `{type:'model_fallback', agent:<the other alias>, model:<muse model>}`. They share only a
socket volume named after the pair; a one-sided or mismatched declaration names another volume and never connects.
"""
from __future__ import annotations

import hashlib
import json
import re

from fleet_policy_paths import SafeFailure

SOCKET_DIRECTORY = '/cauce/model-fallback'
SOCKET = SOCKET_DIRECTORY + '/muse.sock'
BRIDGE = '/cauce/executor/model_fallback.py'
CLIENT_PYTHON = '/usr/bin/python3'
BACKEND = 'muse-cli'
VOLUME_KIND = 'model-fallback'
ROLES = {'openclaw': 'client', 'muse': 'server'}
ALIAS = re.compile(r'[a-z][a-z0-9_-]{0,63}')
TENANT = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}')
MODEL = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,111}')


def validate_row(row) -> dict:
    if not isinstance(row, dict) or set(row) != {'type', 'agent', 'model'} or row['type'] != 'model_fallback' \
            or not isinstance(row['agent'], str) or ALIAS.fullmatch(row['agent']) is None \
            or not isinstance(row['model'], str) or MODEL.fullmatch(row['model']) is None:
        raise SafeFailure('invalid model_fallback extension fields')
    return row


def fallback_row(agent: dict) -> dict | None:
    rows = [row for row in agent.get('extensions') or [] if isinstance(row, dict) and row.get('type') == 'model_fallback']
    if not rows:
        return None
    if len(rows) > 1:
        raise SafeFailure('model fallback extension is ambiguous')
    row = validate_row(rows[0])
    if agent.get('harness_id') not in ROLES:
        raise SafeFailure('model fallback requires an OpenClaw client or its Muse server')
    if row['agent'] == agent.get('alias'):
        raise SafeFailure('model fallback must pair two distinct agents')
    return row


def pairing(agent: dict) -> dict | None:
    row = fallback_row(agent)
    if row is None:
        return None
    tenant, alias = agent.get('tenant_id'), agent.get('alias')
    if not isinstance(tenant, str) or TENANT.fullmatch(tenant) is None or not isinstance(alias, str) or ALIAS.fullmatch(alias) is None:
        raise SafeFailure('model fallback requires the exact agent identity')
    server = agent['harness_id'] == 'muse'
    client, served_by = (row['agent'], alias) if server else (alias, row['agent'])
    digest = hashlib.sha256('\0'.join((tenant, client, served_by)).encode()).hexdigest()
    return {'server': server, 'model': row['model'], 'client': client, 'server_alias': served_by,
            'volume': 'cauce-model-fallback-' + digest[:32], 'destination': SOCKET_DIRECTORY}


def serve_command(agent: dict) -> list[str] | None:
    paired = pairing(agent)
    if paired is None or not paired['server']:
        return None
    return [agent['_placement']['python'], '-I', '-B', BRIDGE, 'serve', '--socket', SOCKET, '--model', paired['model']]


def adapter_environment(agent: dict) -> dict:
    """The Muse adapter supervises the bridge server as its own child for as long as it runs."""
    command = serve_command(agent)
    return {} if command is None else {'CAUCE_MODEL_FALLBACK_SERVE': json.dumps(command, separators=(',', ':'))}


def client_arguments(agent: dict) -> list[str]:
    effort = agent.get('reasoning_effort')
    return ['-I', '-B', BRIDGE, 'client', '--socket', SOCKET, *(['--reasoning-effort', effort] if effort is not None else [])]


def openclaw_backend(agent: dict) -> dict:
    """The measured muse-cli contract: prompt on stdin, `--system-prompt`, `--session-id`, JSONL out, one turn at a time."""
    return {'command': CLIENT_PYTHON, 'args': client_arguments(agent), 'output': 'jsonl', 'input': 'stdin',
            'sessionArg': '--session-id', 'sessionMode': 'existing', 'sessionIdFields': ['session_id'],
            'systemPromptArg': '--system-prompt', 'systemPromptMode': 'append', 'systemPromptWhen': 'always', 'serialize': True}
