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
# The Anthropic `cli` method runs OpenClaw through its claude-cli runtime with a Claude Code login kept
# in the account's own profile (`<profile>/claude`); `claude auth status` exposes the paying email.
CLI_FIELDS = {'claude_command', 'claude_command_sha256'}
INSPECTION_ENV = {'OPENCLAW_AUTH_STORE_READONLY': '1'}
# API-key profiles cannot prove the paying identity; only account flows with
# an observed email and a model nonce may admit a runtime.
PROVIDER_FLOWS = {
    'openai': {'binding_provider': 'codex', 'version': VERSION, 'auth_list_sha256': AUTH_LIST_SHA256, 'methods': {'oauth', 'device-code'},
               'profile_types': {'oauth'}, 'expiry_required': True},
    'anthropic': {'binding_provider': 'claude', 'version': VERSION, 'auth_list_sha256': AUTH_LIST_SHA256, 'methods': {'setup-token', 'cli'},
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


def claude_cli(driver: dict) -> bool:
    return driver.get('provider_id') == 'anthropic' and driver.get('method_id') == 'cli'


def validate_definition(value: dict, provider: str) -> None:
    from fleet_policy_paths import path
    provider_id, flow = provider_flow(provider)
    if not isinstance(value, dict) or set(value) != FIELDS | (CLI_FIELDS if claude_cli(value) else set()) \
            or value['provider_id'] != provider_id or value['method_id'] not in flow['methods'] \
            or value['version'] != flow['version'] or value['auth_list_sha256'] != flow['auth_list_sha256']:
        raise ValueError('OpenClaw provider driver has no measured independent account flow')
    pins = [('auth_list_source', 'auth_list_sha256'), ('node_command', 'node_command_sha256'), ('bridge', 'bridge_sha256')]
    for key, fingerprint in pins + ([('claude_command', 'claude_command_sha256')] if claude_cli(value) else []):
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
            'CODEX_HOME': str(root / '.external-cli-disabled'),
            'CLAUDE_CONFIG_DIR': str(root / ('claude' if claude_cli(binding['openclaw']) else '.external-cli-disabled')),
            'TMPDIR': str(root / 'tmp'), 'NODE_COMPILE_CACHE': str(root / 'tmp' / 'node-compile-cache')}


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


def read_config(binding: dict, agent: dict, runtime: bool = True) -> dict:
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
    if runtime and (agents.get('defaults') != runtime_defaults(binding, agent, env) or ('model' in rows[0]) != (agent_model(agent) is not None)
                    or config.get('models') != model_catalog(binding, agent)):
        raise ValueError('OpenClaw configuration runtime differs from the approved login method')
    return config


# OpenClaw 2026.7.1-2 ships no catalog entry for these ChatGPT (Codex OAuth) models: without one the run fails with
# "Unknown model". Limits measured from the legacy Argos catalog; the API is the one OpenClaw 2026.7.1-2 accepts for
# an OAuth ChatGPT profile (an `openai-responses` catalog would demand an API key).
CHATGPT_MODELS = {'gpt-6.1-sol': ('GPT-6.1 Sol', 872000), 'gpt-6-sol': ('GPT-6 Sol', 1050000),
                  'gpt-6-luna': ('GPT-6 Luna', 1050000), 'gpt-6-astra': ('GPT-6 Astra', 1050000)}


# OpenClaw has no `max` level of its own for a catalog model; declared here it is sent upstream as `xhigh` (measured on
# server2), so the durable effort `max` stays as configured end to end.
CHATGPT_THINKING = {'off': 'none', 'minimal': 'minimal', 'low': 'low', 'medium': 'medium', 'high': 'high', 'xhigh': 'xhigh', 'max': 'xhigh'}


def model_catalog(binding: dict, agent: dict) -> dict | None:
    if binding['openclaw']['provider_id'] != 'openai' or agent.get('model_id') is None:
        return None
    name = canonical_model(agent['model_id']).partition('/')[2]
    if name not in CHATGPT_MODELS:
        return None
    label, window = CHATGPT_MODELS[name]
    return {'mode': 'merge', 'providers': {'openai': {'api': 'openai-chatgpt-responses', 'models': [
        {'id': name, 'name': label, 'reasoning': True, 'input': ['text', 'image'], 'contextWindow': window, 'maxTokens': 128000,
         'thinkingLevelMap': CHATGPT_THINKING, 'compat': {'supportsReasoningEffort': True,
                                                          'supportedReasoningEfforts': ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']}}]}}}



# `openclaw models auth login` rewrites the Cauce-owned file: it adds its own agents.defaults (default model), a
# top-level provider model catalog and `meta`. Those additions alone are reverted, atomically, before the identity
# probe; anything Cauce wrote (agent entry, auth order, model catalog, extensions such as mcp) stays as it is.
LOGIN_ADDED_KEYS = ('models', 'meta')


def restore_after_login(binding: dict, agent: dict) -> bool:
    config = read_config(binding, agent, runtime=False)
    defaults = runtime_defaults(binding, agent, environment(binding, agent))
    catalog = model_catalog(binding, agent)
    if config['agents'].get('defaults') == defaults and config.get('models') == catalog and 'meta' not in config:
        return False
    config['agents']['defaults'] = defaults
    for key in LOGIN_ADDED_KEYS:
        config.pop(key, None)
    if catalog is not None:
        config['models'] = catalog
    descriptor = owned_directory(pathlib.Path(binding['path']))
    try:
        staged = 'openclaw.json.cauce-new'
        try:
            os.unlink(staged, dir_fd=descriptor)
        except FileNotFoundError:
            pass
        target = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        try:
            body = json.dumps(config, sort_keys=True, separators=(',', ':')).encode()
            if os.write(target, body) != len(body):
                raise ValueError('OpenClaw configuration restore was incomplete')
            os.fsync(target)
        finally:
            os.close(target)
        os.replace(staged, 'openclaw.json', src_dir_fd=descriptor, dst_dir_fd=descriptor)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return True


def runtime_defaults(binding: dict, agent: dict, env: dict) -> dict:
    from fleet_model_fallback import BACKEND, openclaw_backend, pairing
    driver = binding['openclaw']
    # Cauce owns the workspace documents (the adapter writes the alias profile there; a move brings the legacy
    # ones). Without skipBootstrap the first `openclaw agent` —the identity probe itself— seeds OpenClaw's
    # templates and BOOTSTRAP.md into an empty workspace, and the model answers with its first-run onboarding
    # instead of the nonce (Argos, 21-oct).
    defaults = {'skipBootstrap': True}
    if claude_cli(driver):
        defaults.update({'models': {canonical_model(agent.get('model_id')): {'agentRuntime': {'id': 'claude-cli'}}},
                         'cliBackends': {'claude-cli': {'command': driver['claude_command'],
                                                        'env': {'CLAUDE_CONFIG_DIR': env['CLAUDE_CONFIG_DIR']}}}})
    paired = pairing(agent)
    if paired is not None:
        if paired['server']:
            raise ValueError('OpenClaw can only be the client of a model fallback')
        # An agent's own model is strict in OpenClaw 2026.7.1-2: the chain lives on the configured default only.
        defaults['model'] = {'primary': canonical_model(agent.get('model_id')), 'fallbacks': [BACKEND + '/' + paired['model']]}
        defaults.setdefault('cliBackends', {})[BACKEND] = openclaw_backend(agent)
    return defaults


def agent_model(agent: dict) -> str | None:
    from fleet_model_fallback import pairing
    if agent.get('model_id') is None or pairing(agent) is not None:
        return None
    return canonical_model(agent['model_id'])


def prepare(binding: dict, agent: dict) -> None:
    env = environment(binding, agent)
    root = pathlib.Path(binding['path'])
    prepare_temporary(root)
    for directory in [root / 'agents', root / 'agents' / agent['runtime_key'], pathlib.Path(env['OPENCLAW_AGENT_DIR']),
                      root / '.external-cli-disabled', pathlib.Path(env['CLAUDE_CONFIG_DIR']), pathlib.Path(env['CAUCE_OPENCLAW_WORKSPACE'])]:
        os.close(owned_directory(directory, create=True))
    descriptor = owned_directory(root)
    try:
        try:
            target = os.open('openclaw.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor)
        except FileExistsError:
            config = read_config(binding, agent, runtime=False)
            if config['agents'].get('defaults') != runtime_defaults(binding, agent, env) \
                    or ('model' in config['agents']['list'][0]) != (agent_model(agent) is not None) \
                    or config.get('models') != model_catalog(binding, agent):
                # Switching the login method (setup-token <-> cli) or the model fallback rewrites only this Cauce-owned file, atomically.
                staged = 'openclaw.json.cauce-new'
                try:
                    os.unlink(staged, dir_fd=descriptor)
                except FileNotFoundError:
                    pass
                _write_openclaw(os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=descriptor),
                                binding, agent, env)
                os.replace(staged, 'openclaw.json', src_dir_fd=descriptor, dst_dir_fd=descriptor)
                os.fsync(descriptor)
        else:
            _write_openclaw(target, binding, agent, env)
            os.fsync(descriptor)
    finally:
        os.close(descriptor)
    retire_seeded_bootstrap(binding, agent)


WORKSPACE_STATE = 'openclaw-workspace-state.json'
BOOTSTRAP_DOCUMENT = 'BOOTSTRAP.md'


def retire_seeded_bootstrap(binding: dict, agent: dict) -> bool:
    """Remove the BOOTSTRAP.md OpenClaw seeded while its first-run setup is still pending.

    That file drives OpenClaw's onboarding («¿Cómo quieres llamarme?»): with it the identity probe gets a greeting
    instead of the nonce and the agent forgets who it is. OpenClaw records a file it seeded as `bootstrapSeededAt`
    and its completion as `setupCompletedAt`; only that pending pair is retired, so a document the agent's owner put
    there by hand, or an already finished setup, stays as it is. OpenClaw itself marks the setup complete once the
    seeded file is gone.
    """
    descriptor = owned_directory(pathlib.Path(environment(binding, agent)['CAUCE_OPENCLAW_WORKSPACE']))
    try:
        try:
            source = os.open(WORKSPACE_STATE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        except OSError:
            return False
        try:
            body = os.read(source, 65537) if stat.S_ISREG(os.fstat(source).st_mode) else b''
        finally:
            os.close(source)
        try:
            state = json.loads(body) if 0 < len(body) <= 65536 else None
        except ValueError:
            return False
        if not isinstance(state, dict):
            return False
        seeded, completed = state.get('bootstrapSeededAt'), state.get('setupCompletedAt')
        if not (isinstance(seeded, str) and seeded.strip()) or isinstance(completed, str) and completed.strip():
            return False
        try:
            details = os.stat(BOOTSTRAP_DOCUMENT, dir_fd=descriptor, follow_symlinks=False)
        except FileNotFoundError:
            return False
        if not stat.S_ISREG(details.st_mode):
            return False
        os.unlink(BOOTSTRAP_DOCUMENT, dir_fd=descriptor)
        os.fsync(descriptor)
        return True
    finally:
        os.close(descriptor)


def prepare_temporary(root: pathlib.Path) -> None:
    os.close(owned_directory(root))
    for directory in (root / 'tmp', root / 'tmp' / 'node-compile-cache'):
        os.close(owned_directory(directory, create=True))


def _write_openclaw(target: int, binding: dict, agent: dict, env: dict) -> None:
    try:
        model = agent_model(agent)
        config = {'agents': {'list': [{'id': agent['runtime_key'], 'default': True, 'workspace': env['CAUCE_OPENCLAW_WORKSPACE'],
                                      'agentDir': env['OPENCLAW_AGENT_DIR'], **({'model': model} if model is not None else {})}]},
                  'auth': {'order': {binding['openclaw']['provider_id']: [profile_id(agent['primary_account_id'])]}}}
        config['agents']['defaults'] = runtime_defaults(binding, agent, env)
        catalog = model_catalog(binding, agent)
        if catalog is not None:
            config['models'] = catalog
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
    if claude_cli(driver):
        pins[driver['claude_command']] = driver['claude_command_sha256']
    return {**packet, 'profile_binding': {**binding, 'command_files': pins}}


def measured_definition(binding: dict, *, strict: bool = False) -> bool:
    import tempfile

    from fleet_provider_identity import command_output, provider_command
    try:
        with tempfile.TemporaryDirectory(prefix='cauce-openclaw-capability-') as directory:
            prepare_temporary(pathlib.Path(directory))
            packet = {'profile_binding': {**binding, 'path': directory}, 'agent': {'harness_id': 'openclaw',
                'runtime_key': 'capability-probe', 'state_directory': directory, 'home_directory': directory}}
            command = provider_command(pinned_packet(packet))
            version = command_output([binding['openclaw']['node_command'], command, '--version'], packet, timeout=5).decode().strip()
            return version in {VERSION, 'OpenClaw ' + VERSION, 'OpenClaw ' + VERSION + ' (0790d9f)'}
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        if strict:
            raise
        return False


def measured_container_definition(binding: dict, placement: dict, *, strict: bool = False) -> bool:
    from fleet_provider_capability_probe import container_probe
    from fleet_provider_identity import provider_command

    try:
        validate_definition(binding.get('openclaw'), binding.get('provider'))
        if re.fullmatch(r'sha256:[a-f0-9]{64}', placement.get('image', '')) is None:
            return False
        driver = binding['openclaw']
        bridge = provider_command({'profile_binding': {'command': driver['bridge'], 'command_sha256': driver['bridge_sha256']}})
        if ':' in bridge or ':' in str(pathlib.Path(__file__).resolve().parent):
            return False
        return container_probe(binding, placement, 'openclaw', tmpfs_size='32m', volumes=(f'{bridge}:{bridge}:ro,z',))
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        if strict:
            raise
        return False


def claude_identity(packet: dict) -> str | None:
    from fleet_provider_identity import command_output, matching_identity, probe_failed, provider_command
    driver = packet['profile_binding']['openclaw']
    command = provider_command({'profile_binding': {'command': driver['claude_command'], 'command_sha256': driver['claude_command_sha256']}})
    status = json.loads(command_output([command, 'auth', 'status', '--json'], packet))
    if not isinstance(status, dict) or status.get('loggedIn') is not True:
        probe_failed('identity_unavailable')
        return None
    return matching_identity(packet['identity'], [status.get('email')])


def profile_identity(packet: dict, prefix: list) -> str | None:
    from fleet_provider_identity import command_output, matching_identity, probe_failed
    binding, agent = packet['profile_binding'], packet['agent']
    meta = json.loads(command_output([*prefix, 'models', 'auth', 'list', '--agent', agent['runtime_key'],
                                      '--provider', binding['openclaw']['provider_id'], '--json'], packet))
    if not isinstance(meta, dict):
        probe_failed('probe_bad_json')
        return None
    profiles = meta.get('profiles')
    if meta.get('agentId') != agent['runtime_key'] or meta.get('provider') != binding['openclaw']['provider_id'] \
            or not isinstance(profiles, list) or len(profiles) != 1:
        probe_failed('identity_unavailable')
        return None
    selected = profiles[0]
    if not isinstance(selected, dict):
        probe_failed('identity_unavailable')
        return None
    _, flow = provider_flow(binding['provider'])
    if selected.get('id') != profile_id(packet['account_id']) or selected.get('provider') != binding['openclaw']['provider_id'] \
            or selected.get('type') not in flow['profile_types']:
        probe_failed('identity_unavailable')
        return None
    identity = matching_identity(packet['identity'], [selected.get('email')])
    if identity is None:
        return None
    for field in ('cooldownUntil', 'disabledUntil'):
        until = selected.get(field)
        if until and (not isinstance(until, str) or datetime.fromisoformat(until.replace('Z', '+00:00')) > datetime.now(UTC)):
            probe_failed('profile_unusable')
            return None
    # A past expiresAt is only the access token's: OpenClaw refreshes it on the next turn without persisting the new
    # expiry, so the nonce turn below, not this timestamp, decides whether the login still works.
    if ('expiresAt' in selected or flow['expiry_required']) and not isinstance(selected.get('expiresAt'), str):
        probe_failed('profile_unusable')
        return None
    return identity


def authenticated_identity(packet: dict) -> str | None:
    """The proven identity, or None after recording one bounded reason (fleet_provider_identity.last_probe_failure)."""
    from fleet_provider_identity import note_probe_exception
    try:
        return _authenticated_identity(packet)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        note_probe_exception(error)
        return None


def _authenticated_identity(packet: dict) -> str | None:
    from fleet_provider_identity import command_output, probe_failed, provider_command
    binding, agent = packet['profile_binding'], packet['agent']
    try:
        if agent['harness_id'] != 'openclaw' or binding['identity'] != packet['identity'] or agent['primary_account_id'] != packet['account_id']:
            raise ValueError('OpenClaw probe packet is outside its account scope')
        if not isinstance(packet['nonce'], str) or re.fullmatch(r'[0-9a-f]{64}', packet['nonce']) is None \
                or agent.get('reasoning_effort') not in {None, 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'}:
            raise ValueError('OpenClaw probe packet is invalid')
        validate_execution_selection(agent)
        validate_definition(binding['openclaw'], binding['provider'])
        read_config(binding, agent)
        driver = binding['openclaw']
        model = canonical_model(agent.get('model_id'))
        if not model.startswith(driver['provider_id'] + '/'):
            raise ValueError('OpenClaw model provider differs from its driver')
    except (OSError, ValueError, KeyError, TypeError):
        probe_failed('config_scope')
        return None
    command = provider_command(pinned_packet(packet))
    prefix = [driver['node_command'], command]
    version = command_output([*prefix, '--version'], packet).decode().strip()
    if version not in {VERSION, 'OpenClaw ' + VERSION, 'OpenClaw ' + VERSION + ' (0790d9f)'}:
        probe_failed('version_mismatch')
        return None
    identity = claude_identity(packet) if claude_cli(driver) else profile_identity(packet, prefix)
    if identity is None:
        return None
    # A cold Claude Code turn behind OpenClaw writes ~50k tokens of cache; 25 s left a valid login pending.
    # Grok 4.7 behind OpenClaw answered this probe in 36-50 s and once over 120 s; 60 s rejected valid logins. The chain
    # stays nested under the 150 s host step: probe 110 s < container exec 132 s < executor hook 140 s.
    expected = 'CAUCE_BOOTSTRAP_' + packet['nonce']
    args = [*prefix, 'agent', '--local', '--agent', agent['runtime_key'], '--model', model, '--session-key',
            'agent:' + agent['runtime_key'] + ':cauce-auth-' + str(uuid.uuid4()), '--json', '--timeout', '105',
            '--message', 'Responde únicamente ' + expected + '. No uses herramientas ni envíes mensajes.']
    if agent.get('reasoning_effort') is not None:
        args += ['--thinking', agent['reasoning_effort']]
    reply = json.loads(command_output(args, packet, timeout=110))
    result = reply.get('result', reply) if isinstance(reply, dict) else None
    if not isinstance(result, dict) or not isinstance(result.get('payloads'), list):
        probe_failed('probe_bad_json')
        return None
    texts = [value.get('text') for value in result.get('payloads', []) if isinstance(value, dict)]
    if reply.get('status', 'ok') != 'ok' or texts != [expected]:
        probe_failed('probe_nonce_mismatch')
        return None
    return identity


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
