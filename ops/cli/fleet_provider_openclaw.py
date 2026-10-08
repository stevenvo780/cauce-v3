from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone

VERSION = '2026.6.6'
AUTH_LIST_SHA256 = '31f4f35423fa6d909eaa448612f06a2030d43f91872f90c07d11e4638bff2c90'
FIELDS = {'provider_id', 'method_id', 'version', 'auth_list_source', 'auth_list_sha256',
          'node_command', 'node_command_sha256', 'bridge', 'bridge_sha256'}


def validate_definition(value: dict, provider: str) -> None:
    from fleet_executor_policy import path
    if not isinstance(value, dict) or set(value) != FIELDS or provider != 'codex' \
            or value['provider_id'] != 'openai' or value['method_id'] not in {'oauth', 'device-code'} \
            or value['version'] != VERSION or value['auth_list_sha256'] != AUTH_LIST_SHA256:
        raise ValueError('OpenClaw provider driver has no measured independent account flow')
    for key, fingerprint in [('auth_list_source', 'auth_list_sha256'), ('node_command', 'node_command_sha256'), ('bridge', 'bridge_sha256')]:
        path(value[key])
        if not isinstance(value[fingerprint], str) or re.fullmatch(r'[0-9a-f]{64}', value[fingerprint]) is None:
            raise ValueError('OpenClaw driver command or source pin is invalid')


def validate_execution_selection(agent: dict) -> None:
    if agent.get('harness_id') != 'openclaw':
        return
    model = agent.get('model_id')
    if not isinstance(model, str) or re.fullmatch(r'openai/[A-Za-z0-9][A-Za-z0-9_.:-]{0,111}', model) is None:
        raise ValueError('OpenClaw activation requires an explicit measured provider model: openai/<model>')
    if agent.get('reasoning_effort') not in {None, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}:
        raise ValueError('OpenClaw reasoning effort is not supported by the measured driver')


def environment(binding: dict, agent: dict) -> dict:
    validate_definition(binding['openclaw'], binding['provider'])
    root = pathlib.Path(binding['path'])
    key = agent['runtime_key']
    if re.fullmatch(r'[a-z][a-z0-9-]{0,63}', key) is None:
        raise ValueError('OpenClaw runtime identity is invalid')
    return {'OPENCLAW_HOME': str(root), 'OPENCLAW_STATE_DIR': str(root), 'OPENCLAW_CONFIG_PATH': str(root / 'openclaw.json'),
            'OPENCLAW_AGENT_DIR': str(root / 'agents' / key / 'agent'), 'CAUCE_OPENCLAW_AGENT_ID': key,
            'CAUCE_OPENCLAW_WORKSPACE': str(pathlib.Path(agent['state_directory']) / 'workspace'), 'CAUCE_OPENCLAW_LOCAL': '1', 'CAUCE_OPENCLAW_DIST_DIR': str(pathlib.Path(binding['openclaw']['auth_list_source']).parent),
            'CODEX_HOME': str(root / '.external-cli-disabled'), 'CLAUDE_CONFIG_DIR': str(root / '.external-cli-disabled')}


def profile_id(account: str) -> str:
    if not isinstance(account, str) or re.fullmatch(r'[a-z][a-z0-9_-]{0,63}', account) is None:
        raise ValueError('OpenClaw account identity is invalid')
    return 'cauce:' + account


def owned_directory(value: pathlib.Path, *, create: bool = False) -> int:
    from fleet_executor_policy import path
    from secure_path import open_absolute_directory
    path(str(value))
    if create:
        parent = open_absolute_directory(value.parent)
        try:
            try:
                os.mkdir(value.name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
        finally:
            os.close(parent)
    descriptor = open_absolute_directory(value)
    details = os.fstat(descriptor)
    if details.st_uid != os.geteuid() or details.st_mode & 0o077:
        os.close(descriptor)
        raise ValueError('OpenClaw owned directory identity or privacy changed')
    return descriptor


def read_config(binding: dict, agent: dict) -> dict:
    root = pathlib.Path(binding['path'])
    directory = owned_directory(root)
    try:
        descriptor = os.open('openclaw.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.geteuid() or details.st_mode & 0o077:
                raise ValueError('OpenClaw private configuration identity changed')
            body = os.read(descriptor, 262145)
            if len(body) > 262144:
                raise ValueError('OpenClaw private configuration exceeds bound')
            config = json.loads(body)
        finally:
            os.close(descriptor)
    finally:
        os.close(directory)
    env = environment(binding, agent)
    entry = {'id': agent['runtime_key'], 'workspace': env['CAUCE_OPENCLAW_WORKSPACE'], 'agentDir': env['OPENCLAW_AGENT_DIR']}
    agents = config.get('agents') if isinstance(config, dict) else None
    auth = config.get('auth') if isinstance(config, dict) else None
    rows = agents.get('list') if isinstance(agents, dict) else None
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict) \
            or any(rows[0].get(key) != value for key, value in entry.items()) or not isinstance(auth, dict) \
            or auth.get('order') != {binding['openclaw']['provider_id']: [profile_id(agent['primary_account_id'])]}:
        raise ValueError('OpenClaw configuration is outside the exact account and agent scope')
    return config


def prepare(binding: dict, agent: dict) -> None:
    env = environment(binding, agent)
    root = pathlib.Path(binding['path'])
    for directory in [root / 'agents', root / 'agents' / agent['runtime_key'], pathlib.Path(env['OPENCLAW_AGENT_DIR']),
                      root / '.external-cli-disabled', pathlib.Path(env['CAUCE_OPENCLAW_WORKSPACE'])]:
        os.close(owned_directory(directory, create=True))
    descriptor = owned_directory(root)
    try:
        try:
            target = os.open('openclaw.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        except FileExistsError:
            read_config(binding, agent)
            return
        try:
            model = agent.get('model_id')
            config = {'agents': {'list': [{'id': agent['runtime_key'], 'default': True, 'workspace': env['CAUCE_OPENCLAW_WORKSPACE'],
                                          'agentDir': env['OPENCLAW_AGENT_DIR'], **({'model': model} if model is not None else {})}]},
                      'auth': {'order': {binding['openclaw']['provider_id']: [profile_id(agent['primary_account_id'])]}}}
            body = json.dumps(config, sort_keys=True, separators=(',', ':')).encode()
            if os.write(target, body) != len(body):
                raise ValueError('OpenClaw public configuration write was incomplete')
            os.fsync(target)
        finally:
            os.close(target)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def pinned_packet(packet: dict) -> dict:
    binding = packet['profile_binding']
    driver = binding['openclaw']
    validate_definition(driver, binding['provider'])
    pins = {**binding.get('command_files', {}), driver['auth_list_source']: driver['auth_list_sha256'],
            driver['node_command']: driver['node_command_sha256'], driver['bridge']: driver['bridge_sha256']}
    return {**packet, 'profile_binding': {**binding, 'command_files': pins}}


def measured_definition(binding: dict) -> bool:
    import tempfile

    from fleet_provider_identity import command_output, provider_command
    try:
        with tempfile.TemporaryDirectory(prefix='cauce-openclaw-capability-') as directory:
            packet = {'profile_binding': {**binding, 'path': directory}, 'agent': {'harness_id': 'openclaw',
                'runtime_key': 'capability-probe', 'state_directory': directory, 'home_directory': directory}}
            command = provider_command(pinned_packet(packet))
            version = command_output([binding['openclaw']['node_command'], command, '--version'], packet, timeout=5).decode().strip()
            return version in {VERSION, 'OpenClaw ' + VERSION, 'OpenClaw ' + VERSION + ' (8c802aa)'}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return False


def authenticated_openclaw(packet: dict) -> bool:
    from fleet_provider_identity import command_output, provider_command
    try:
        binding, agent = packet['profile_binding'], packet['agent']
        if agent['harness_id'] != 'openclaw' or binding['identity'] != packet['identity'] or agent['primary_account_id'] != packet['account_id']:
            return False
        if not isinstance(packet['nonce'], str) or re.fullmatch(r'[0-9a-f]{64}', packet['nonce']) is None \
                or agent.get('reasoning_effort') not in {None, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}:
            return False
        validate_execution_selection(agent)
        validate_definition(binding['openclaw'], binding['provider'])
        read_config(binding, agent)
        driver = binding['openclaw']
        command = provider_command(pinned_packet(packet))
        prefix = [driver['node_command'], command]
        version = command_output([*prefix, '--version'], packet).decode().strip()
        if version not in {VERSION, 'OpenClaw ' + VERSION, 'OpenClaw ' + VERSION + ' (8c802aa)'}:
            return False
        meta = json.loads(command_output([*prefix, 'models', 'auth', 'list', '--agent', agent['runtime_key'],
                                          '--provider', binding['openclaw']['provider_id'], '--json'], packet))
        if not isinstance(meta, dict):
            return False
        profiles = meta.get('profiles')
        if meta.get('agentId') != agent['runtime_key'] or meta.get('provider') != binding['openclaw']['provider_id'] \
                or not isinstance(profiles, list) or len(profiles) != 1:
            return False
        selected = profiles[0]
        if not isinstance(selected, dict):
            return False
        if selected.get('id') != profile_id(packet['account_id']) or selected.get('provider') != binding['openclaw']['provider_id'] \
                or selected.get('type') != 'oauth' or selected.get('email') != packet['identity']:
            return False
        if any(selected.get(field) for field in ('cooldownUntil', 'disabledUntil')):
            return False
        if not isinstance(selected.get('expiresAt'), str):
            return False
        expires = datetime.fromisoformat(selected['expiresAt'].replace('Z', '+00:00'))
        if expires <= datetime.now(timezone.utc):
            return False
        model = agent.get('model_id')
        expected = 'CAUCE_BOOTSTRAP_' + packet['nonce']
        args = [*prefix, 'agent', '--local', '--agent', agent['runtime_key'], '--model', model, '--session-key',
                'agent:' + agent['runtime_key'] + ':cauce-auth-' + str(uuid.uuid4()), '--json', '--timeout', '25',
                '--message', 'Responde únicamente ' + expected + '. No uses herramientas ni envíes mensajes.']
        if agent.get('reasoning_effort') is not None:
            args += ['--thinking', agent['reasoning_effort']]
        reply = json.loads(command_output(args, packet, timeout=30))
        if not isinstance(reply, dict):
            return False
        result = reply.get('result', reply)
        if not isinstance(result, dict) or not isinstance(result.get('payloads'), list):
            return False
        texts = [value.get('text') for value in result.get('payloads', []) if isinstance(value, dict)]
        return reply.get('status', 'ok') == 'ok' and texts == [expected]
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return False


if __name__ == '__main__':
    try:
        parser = argparse.ArgumentParser()
        parser.add_argument('--prepare', action='store_true', required=True)
        parser.parse_args()
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('OpenClaw preparation packet exceeds bound')
        packet = json.loads(raw)
        prepare(packet['profile_binding'], packet['agent'])
    except Exception:
        raise SystemExit('OpenClaw private profile preparation was not verified') from None
