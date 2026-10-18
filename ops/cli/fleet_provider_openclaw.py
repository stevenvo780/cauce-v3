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
from datetime import UTC, datetime

VERSION = '2026.7.1-2'
AUTH_LIST_SHA256 = '3ef2fa38f32ce786f0bc499bae897aba68ad9c7595ef3064994b1634d13d1373'
FIELDS = {'provider_id', 'method_id', 'version', 'auth_list_source', 'auth_list_sha256',
          'node_command', 'node_command_sha256', 'bridge', 'bridge_sha256'}
INSPECTION_ENV = {'OPENCLAW_AUTH_STORE_READONLY': '1'}
# API-key profiles cannot prove the paying identity; only account flows with
# an observed email and a model nonce may admit a runtime.
PROVIDER_FLOWS = {
    'openai': {'binding_provider': 'codex', 'version': VERSION, 'auth_list_sha256': AUTH_LIST_SHA256, 'methods': {'oauth', 'device-code'},
               'profile_types': {'oauth'}, 'expiry_required': True},
    'anthropic': {'binding_provider': 'claude', 'version': VERSION, 'auth_list_sha256': AUTH_LIST_SHA256, 'methods': {'setup-token'},
                  'profile_types': {'token'}, 'expiry_required': False},
    'xai': {'binding_provider': 'grok', 'version': VERSION, 'auth_list_sha256': AUTH_LIST_SHA256, 'methods': {'oauth', 'device-code'},
            'profile_types': {'oauth'}, 'expiry_required': True},
}
PROVIDER_BY_BINDING = {flow['binding_provider']: provider for provider, flow in PROVIDER_FLOWS.items()}
# Inventory stored `codex/<model>`; OpenClaw's measured id for that binding is `openai/<model>`.
HISTORICAL_MODEL_PREFIX = {'codex': 'openai'}


def canonical_model(model: object) -> str:
    if not isinstance(model, str) or re.fullmatch(
            r'[a-z][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9_.:-]{0,111}', model) is None:
        raise ValueError('OpenClaw activation requires an explicit measured provider model: <provider>/<model>')
    prefix, _, name = model.partition('/')
    prefix = HISTORICAL_MODEL_PREFIX.get(prefix, prefix)
    if PROVIDER_FLOWS.get(prefix) is None:
        raise ValueError('OpenClaw activation requires an explicit measured provider model: <provider>/<model>')
    return prefix + '/' + name


def provider_flow(provider: str) -> tuple[str, dict]:
    provider_id = PROVIDER_BY_BINDING.get(provider)
    if provider_id is None:
        raise ValueError(f'OpenClaw has no account flow for binding provider {provider!r}')
    flow = PROVIDER_FLOWS.get(provider_id)
    if flow is None:
        raise ValueError(f'OpenClaw {provider_id} flow has not been measured yet; refusing to declare it measured')
    return provider_id, flow


def validate_definition(value: dict, provider: str) -> None:
    from fleet_policy_paths import path
    provider_id, flow = provider_flow(provider)
    if not isinstance(value, dict) or set(value) != FIELDS \
            or value['provider_id'] != provider_id or value['method_id'] not in flow['methods'] \
            or value['version'] != flow['version'] or value['auth_list_sha256'] != flow['auth_list_sha256']:
        raise ValueError('OpenClaw provider driver has no measured independent account flow')
    for key, fingerprint in [('auth_list_source', 'auth_list_sha256'), ('node_command', 'node_command_sha256'), ('bridge', 'bridge_sha256')]:
        path(value[key])
        if not isinstance(value[fingerprint], str) or re.fullmatch(r'[0-9a-f]{64}', value[fingerprint]) is None:
            raise ValueError('OpenClaw driver command or source pin is invalid')


def validate_execution_selection(agent: dict) -> None:
    if agent.get('harness_id') != 'openclaw':
        return
    canonical_model(agent.get('model_id'))
    if agent.get('reasoning_effort') not in {None, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}:
        raise ValueError('OpenClaw reasoning effort is not supported by the measured driver')


def validate_binding(binding: dict, agent: dict) -> None:
    validate_definition(binding.get('openclaw'), binding.get('provider'))
    provider_id = PROVIDER_BY_BINDING[binding['provider']]
    if not canonical_model(agent.get('model_id')).startswith(provider_id + '/'):
        raise ValueError('OpenClaw model provider differs from its binding provider')


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
    from fleet_executor_view import open_directory
    from fleet_policy_paths import path
    path(str(value))
    if value == pathlib.Path('/') or create and value.parent == pathlib.Path('/'):
        raise ValueError
    if create:
        parent = open_directory(value.parent)
        try:
            try:
                os.mkdir(value.name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
        finally:
            os.close(parent)
    descriptor = open_directory(value)
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
        else:
            _write_openclaw(target, binding, agent, env)
            os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_openclaw(target: int, binding: dict, agent: dict, env: dict) -> None:
    try:
        model = canonical_model(agent['model_id']) if agent.get('model_id') is not None else None
        config = {'agents': {'list': [{'id': agent['runtime_key'], 'default': True, 'workspace': env['CAUCE_OPENCLAW_WORKSPACE'],
                                      'agentDir': env['OPENCLAW_AGENT_DIR'], **({'model': model} if model is not None else {})}]},
                  'auth': {'order': {binding['openclaw']['provider_id']: [profile_id(agent['primary_account_id'])]}}}
        body = json.dumps(config, sort_keys=True, separators=(',', ':')).encode()
        if os.write(target, body) != len(body):
            raise ValueError('OpenClaw public configuration write was incomplete')
        os.fsync(target)
    finally:
        os.close(target)


def prepare_extensions(agent: dict, profile, state=None) -> dict:
    from fleet_provider_identity import prepare_extensions as prepare_shared
    if agent.get('harness_id') not in (None, 'openclaw'):
        raise ValueError('openclaw extension prepare refuses another harness')
    return prepare_shared({**agent, 'harness_id': 'openclaw'}, pathlib.Path(profile), None if state is None else pathlib.Path(state))


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
            return version in {VERSION, 'OpenClaw ' + VERSION, 'OpenClaw ' + VERSION + ' (0790d9f)'}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return False


def measured_container_definition(binding: dict, placement: dict) -> bool:
    from fleet_provider_identity import provider_command

    name = 'cauce-openclaw-probe-' + uuid.uuid4().hex
    try:
        validate_definition(binding.get('openclaw'), binding.get('provider'))
        if re.fullmatch(r'sha256:[a-f0-9]{64}', placement.get('image', '')) is None:
            return False
        driver = binding['openclaw']
        bridge = provider_command({'profile_binding': {'command': driver['bridge'], 'command_sha256': driver['bridge_sha256']}})
        if ':' in bridge or ':' in str(pathlib.Path(__file__).resolve().parent):
            return False
        program = ('import json,sys;sys.path.insert(0,"/cauce/executor");'
                   'from fleet_provider_openclaw import measured_definition;'
                   'sys.exit(0 if measured_definition(json.load(sys.stdin)) else 1)')
        result = subprocess.run(['/usr/bin/docker', 'run', '--rm', '--pull=never', '--name', name, '-i',
            '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
            '--tmpfs', '/tmp:rw,nosuid,nodev,size=32m', '--user', placement['runtime_user'],
            '--volume', f'{pathlib.Path(__file__).resolve().parent}:/cauce/executor:ro,z',
            '--volume', f'{bridge}:{bridge}:ro,z',
            '--entrypoint', placement['python'], placement['image'], '-I', '-B', '-c', program],
            input=json.dumps(binding).encode(), capture_output=True, timeout=15, check=False)
        return result.returncode == 0
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return False
    finally:
        try:
            subprocess.run(['/usr/bin/docker', 'rm', '-f', name], capture_output=True, timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            pass


def authenticated_identity(packet: dict) -> str | None:
    from fleet_provider_identity import command_output, provider_command, select_account_identity
    try:
        binding, agent = packet['profile_binding'], packet['agent']
        if agent['harness_id'] != 'openclaw' or binding['identity'] != packet['identity'] or agent['primary_account_id'] != packet['account_id']:
            return None
        if not isinstance(packet['nonce'], str) or re.fullmatch(r'[0-9a-f]{64}', packet['nonce']) is None \
                or agent.get('reasoning_effort') not in {None, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}:
            return None
        validate_execution_selection(agent)
        validate_definition(binding['openclaw'], binding['provider'])
        read_config(binding, agent)
        driver = binding['openclaw']
        command = provider_command(pinned_packet(packet))
        prefix = [driver['node_command'], command]
        version = command_output([*prefix, '--version'], packet).decode().strip()
        if version not in {VERSION, 'OpenClaw ' + VERSION, 'OpenClaw ' + VERSION + ' (0790d9f)'}:
            return None
        meta = json.loads(command_output([*prefix, 'models', 'auth', 'list', '--agent', agent['runtime_key'],
                                          '--provider', binding['openclaw']['provider_id'], '--json'], packet))
        if not isinstance(meta, dict):
            return None
        profiles = meta.get('profiles')
        if meta.get('agentId') != agent['runtime_key'] or meta.get('provider') != binding['openclaw']['provider_id'] \
                or not isinstance(profiles, list) or len(profiles) != 1:
            return None
        selected = profiles[0]
        if not isinstance(selected, dict):
            return None
        _, flow = provider_flow(binding['provider'])
        identity = select_account_identity(packet['identity'], [selected.get('email')])
        if selected.get('id') != profile_id(packet['account_id']) or selected.get('provider') != binding['openclaw']['provider_id'] \
                or selected.get('type') not in flow['profile_types'] or identity is None:
            return None
        if any(selected.get(field) for field in ('cooldownUntil', 'disabledUntil')):
            return None
        if 'expiresAt' in selected or flow['expiry_required']:
            if not isinstance(selected.get('expiresAt'), str):
                return None
            expires = datetime.fromisoformat(selected['expiresAt'].replace('Z', '+00:00'))
            if expires <= datetime.now(UTC):
                return None
        model = canonical_model(agent.get('model_id'))
        if not model.startswith(driver['provider_id'] + '/'):
            return None
        expected = 'CAUCE_BOOTSTRAP_' + packet['nonce']
        args = [*prefix, 'agent', '--local', '--agent', agent['runtime_key'], '--model', model, '--session-key',
                'agent:' + agent['runtime_key'] + ':cauce-auth-' + str(uuid.uuid4()), '--json', '--timeout', '25',
                '--message', 'Responde únicamente ' + expected + '. No uses herramientas ni envíes mensajes.']
        if agent.get('reasoning_effort') is not None:
            args += ['--thinking', agent['reasoning_effort']]
        reply = json.loads(command_output(args, packet, timeout=30))
        if not isinstance(reply, dict):
            return None
        result = reply.get('result', reply)
        if not isinstance(result, dict) or not isinstance(result.get('payloads'), list):
            return None
        texts = [value.get('text') for value in result.get('payloads', []) if isinstance(value, dict)]
        return identity if reply.get('status', 'ok') == 'ok' and texts == [expected] else None
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        return None


def authenticated_openclaw(packet: dict) -> bool:
    return authenticated_identity(packet) is not None


authenticated = authenticated_openclaw


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
