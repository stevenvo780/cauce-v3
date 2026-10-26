from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import re
import signal
import subprocess
import sys
import time
import uuid

from fleet_executor_policy import SafeFailure, approve_agent, private_directory, target_agent
from fleet_executor_runtime import approved_bundle

HARNESSES = frozenset({'claude', 'codex', 'grok', 'muse'})
STATES = frozenset({'present', 'absent', 'resumed', 'recreated', 'unsupported', 'conflict', 'failed'})
SHA = re.compile(r'[a-f0-9]{64}')
ENVIRONMENT = frozenset({'PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'CODEX_HOME',
    'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'NODE_COMPILE_CACHE', 'CAUCE_ALIAS', 'CAUCE_RUNTIME_KEY',
    'CAUCE_TENANT_ID', 'CAUCE_TENANT', 'CAUCE_STATE_DIR', 'CAUCE_CONTAINER_ID', 'CAUCE_CONTAINER_GENERATION',
    'CAUCE_INSTANCE_ID', 'CAUCE_SHARED_SESSION', 'CAUCE_SHARED_SESSION_WORKSPACE', 'CAUCE_MODEL_ID',
    'CAUCE_REASONING_EFFORT', 'CAUCE_HARNESS_COMMAND', 'CAUCE_HARNESS_COMMAND_SHA256', 'CAUCE_HARNESS_COMMAND_FILES'})
REASONS = {
    'runtime_mounts_differ': 'Esta ejecución usa los montajes de una versión anterior. Actualiza la ejecución antes de reiniciar su TUI; la consulta no modificó el contenedor.',
    'shared_tui_disabled': 'La política de esta computadora no habilita una TUI compartida para este agente. Puedes usar Detener y Arrancar.',
    'harness_unsupported': 'Este tipo de agente no ofrece una TUI compartida compatible con el reinicio. Puedes usar Detener y Arrancar.',
    'runtime_without_shared_tui': 'La ejecución actual no inició la TUI compartida que habilita la política actual. Actualiza la ejecución antes de reiniciar su TUI.',
}


class RecoveryFailure(SafeFailure):
    def __init__(self, reason_code: str):
        if reason_code not in REASONS:
            raise ValueError('unknown recovery failure reason')
        self.reason_code = reason_code
        super().__init__(REASONS[reason_code])


def failure_reason(error: Exception) -> str | None:
    return error.reason_code if isinstance(error, RecoveryFailure) else None


def unsupported_reason(agent: dict, bundle: dict, values: dict | None = None) -> str | None:
    if agent['harness_id'] not in HARNESSES:
        return 'harness_unsupported'
    if bundle.get('shared_tui') is not True:
        return 'shared_tui_disabled'
    if values is not None and values.get('CAUCE_SHARED_SESSION') != '1':
        return 'runtime_without_shared_tui'
    return None


def validate_recovery_container(policy: dict, agent: dict, observed: dict) -> None:
    from fleet_executor_container import RELEASE_ROOT, runtime_mounts, validate_container
    try:
        validate_container(policy, agent, observed)
    except SafeFailure as error:
        if str(error) != 'container runtime mounts differ':
            raise
        from fleet_executor_rebind import bound_release
        previous = bound_release(observed, RELEASE_ROOT)
        if previous is None:
            raise
        validate_container(policy, agent, observed, runtime_mounts(policy, agent, previous, RELEASE_ROOT))
        raise RecoveryFailure('runtime_mounts_differ') from None


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_parameters(parameters: dict) -> None:
    if parameters == {'action': 'probe'}:
        return
    if set(parameters) - {'strategy'} != {'action', 'expected_fingerprint', 'force', 'identity'} or parameters['action'] != 'apply' \
            or parameters.get('strategy', 'relaunch') != 'relaunch' \
            or not isinstance(parameters['expected_fingerprint'], str) \
            or SHA.fullmatch(parameters['expected_fingerprint']) is None or type(parameters['force']) is not bool:
        raise SafeFailure('invalid exact recovery confirmation')
    identity = parameters['identity']
    if not isinstance(identity, dict) or set(identity) != {'generation', 'container_id', 'writer_instance_id'} \
            or any(not isinstance(identity[key], str) or SHA.fullmatch(identity[key]) is None
                   for key in ('generation', 'container_id')) \
            or not isinstance(identity['writer_instance_id'], str) \
            or str(uuid.UUID(identity['writer_instance_id'])) != identity['writer_instance_id']:
        raise SafeFailure('invalid recovery runtime identity')


def process_environment(raw: bytes) -> dict:
    if len(raw) > 262144:
        raise SafeFailure('runtime environment exceeds its observation bound')
    values = {}
    for row in raw.split(b'\0'):
        key, separator, value = row.partition(b'=')
        name = key.decode('utf-8', 'strict')
        if separator and name in ENVIRONMENT:
            if name in values:
                raise SafeFailure('runtime environment is ambiguous')
            values[name] = value.decode('utf-8', 'strict')
    return values


def observe(policy: dict, agent: dict) -> tuple[dict, dict, dict]:
    bundle = approved_bundle(policy, agent)
    if agent['runtime_mode'] == 'container':
        from fleet_executor_container import docker, identity_for, inspect_container, process_proof
        observed = inspect_container(agent['container_name'])
        if observed is None or observed.get('State', {}).get('Running') is not True:
            raise SafeFailure('recovery requires the approved container to remain running')
        validate_recovery_container(policy, agent, observed)
        runtime = identity_for(agent, observed)
        process_proof(policy, agent, runtime, bundle)
        metadata = json.loads(docker('exec', '--user', '0', runtime['container_id'], '/bin/cat',
            str(runtime['control'] / 'cauce-v3-adapter.json')))
        values = process_environment(docker('exec', '--user', agent['runtime_user'], runtime['container_id'], '/bin/cat',
            f'/proc/{metadata["pid"]}/environ'))
        process_proof(policy, agent, runtime, bundle)
    else:
        from cauce_container_proc import matched_fs_credentials
        from fleet_executor_runtime import native_identity, native_proof
        runtime = native_identity(policy, agent)
        metadata = native_proof(policy, agent, runtime, bundle)
        if metadata is None:
            raise SafeFailure('recovery requires the approved adapter process to remain running')
        user = pwd.getpwnam(agent['runtime_user'])
        with matched_fs_credentials(user.pw_uid, user.pw_gid):
            values = process_environment(pathlib.Path(f'/proc/{metadata["pid"]}/environ').read_bytes())
        if native_proof(policy, agent, runtime, bundle) != metadata:
            raise SafeFailure('runtime changed during recovery observation')
    expected = {'HOME': agent['home_directory'], 'CAUCE_ALIAS': agent['alias'],
        'CAUCE_RUNTIME_KEY': agent['runtime_key'], 'CAUCE_STATE_DIR': agent['state_directory'],
        'CAUCE_CONTAINER_ID': runtime['container_id'], 'CAUCE_CONTAINER_GENERATION': runtime['generation']}
    if any(values.get(key) != value for key, value in expected.items()) \
            or values.get('CAUCE_TENANT_ID', values.get('CAUCE_TENANT')) != agent['tenant_id']:
        raise SafeFailure('recovery process differs from its approved runtime identity')
    instance = values.get('CAUCE_INSTANCE_ID')
    if not isinstance(instance, str) or str(uuid.UUID(instance)) != instance:
        raise SafeFailure('recovery adapter instance identity is unavailable')
    identity = {'container_id': runtime['container_id'], 'generation': runtime['generation'], 'writer_instance_id': instance}
    return identity, values, bundle


def run_helper(agent: dict, identity: dict, values: dict, bundle: dict, action: str, parameters: dict | None = None,
               *, expires_at: int | None = None) -> dict:
    entries = [pathlib.Path(value) for value in bundle['argv'] if isinstance(value, str)
        and value.endswith('/bin/' + agent['harness_id'] + '.js')]
    if len(entries) != 1 or not entries[0].is_relative_to(pathlib.Path(bundle['directory'])):
        raise SafeFailure('approved adapter bundle has no exact shared recovery helper')
    workspace = values.get('CAUCE_SHARED_SESSION_WORKSPACE')
    if not isinstance(workspace, str) or workspace != str(pathlib.Path(agent['state_directory']) / 'space/projects'):
        raise SafeFailure('recovery workspace differs from the approved agent workspace')
    if expires_at is None:
        expires_at = int(time.time() * 1000) + 7500
    if type(expires_at) is not int or not 0 < expires_at - time.time() * 1000 <= 7500:
        raise SafeFailure('recovery helper authorization expired before launch')
    command = [bundle['executable'], str(entries[0].with_name('shared-session.js')), action,
        '--alias', agent['alias'], '--harness', agent['harness_id'], '--state', agent['state_directory'], '--workspace', workspace]
    command.extend(['--expires-at', str(expires_at)])
    if parameters is not None:
        command.extend(['--expected-fingerprint', parameters['expected_fingerprint'],
            '--force', '1' if parameters['force'] else '0'])
    if agent['runtime_mode'] == 'container':
        from fleet_executor_container import DOCKER, isolated_python
        payload = json.dumps({'command': command, 'environment': values, 'expires_at': expires_at}).encode()
        command = [DOCKER, 'exec', '-i', '-w', '/', '--user', agent['runtime_user'], identity['container_id'],
            *isolated_python(agent['_placement']['python'], '/cauce/executor/fleet_executor_recovery_process.py')]
        credentials = {}
    else:
        user = pwd.getpwnam(agent['runtime_user'])
        if os.geteuid() != 0 and os.geteuid() != user.pw_uid:
            raise SafeFailure('recovery cannot execute as the approved runtime user')
        credentials = {'user': user.pw_uid, 'group': user.pw_gid, 'extra_groups': []} if os.geteuid() == 0 else {}
        payload = json.dumps({'command': command, 'environment': values, 'expires_at': expires_at}).encode()
        command = [sys.executable, '-I', '-B', str(pathlib.Path(__file__).with_name('fleet_executor_recovery_process.py'))]
    child = subprocess.Popen(command,
        cwd='/', stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        start_new_session=True, **credentials)
    cleanup_confirmed = False
    try:
        raw, _ = child.communicate(input=payload, timeout=10)
        if len(raw) > 32768:
            raise SafeFailure('recovery helper response exceeds its bound')
        supervised = json.loads(raw)
        if not isinstance(supervised, dict) or set(supervised) != {'result', 'exit_code', 'stopped_verified'} \
                or supervised['stopped_verified'] is not True or child.returncode:
            raise SafeFailure('recovery helper cleanup was not physically verified')
        cleanup_confirmed = True
        result = supervised['result']
        if not isinstance(result, dict) or set(result) != {'type', 'state', 'resumable', 'fingerprint', 'reason'} \
                or result['type'] != 'session' or result['state'] not in STATES or type(result['resumable']) is not bool \
                or not isinstance(result['reason'], str) or not 1 <= len(result['reason']) <= 500 \
                or any(ord(char) < 32 for char in result['reason']) \
                or result['fingerprint'] is not None and (not isinstance(result['fingerprint'], str)
                    or SHA.fullmatch(result['fingerprint']) is None) \
                or supervised['exit_code'] != 0 and result['state'] in {'present', 'absent', 'resumed', 'recreated'}:
            raise SafeFailure('recovery helper did not publish a verified result')
        return result
    finally:
        # A lost docker client cannot cancel the remote supervisor. Its absolute deadline keeps
        # this executor call alive until the remote helper can no longer launch another effect.
        while not cleanup_confirmed and time.time() * 1000 < expires_at + 1200:
            time.sleep(max(0, min(0.05, (expires_at + 1200 - time.time() * 1000) / 1000)))
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
        child.stdout.close()


def observed_preview(agent: dict, identity: dict, values: dict, bundle: dict) -> dict:
    unsupported = unsupported_reason(agent, bundle, values)
    if unsupported is not None:
        session = {'type': 'session', 'state': 'unsupported', 'resumable': False, 'fingerprint': None,
            'reason': REASONS[unsupported]}
    else:
        session = run_helper(agent, identity, values, bundle, 'recovery-preview')
    return {'identity': identity, 'session': session, 'strategy': 'shared_tui',
        'preserves_conversation': True, 'recreates_container': False}


def preview_agent(policy: dict, agent: dict) -> dict:
    from fleet_executor_recovery_relaunch import observe as relaunch
    relaunched = relaunch(policy, agent)
    return relaunched[0] if relaunched is not None else observed_preview(agent, *observe(policy, agent))


def preview(policy: dict, context: dict) -> dict:
    return preview_agent(policy, approve_agent(policy, target_agent(context)))


def preflight(policy: dict, document: dict) -> dict:
    fields = {'tenant_id', 'alias', 'runtime_key', 'agent'}
    if not isinstance(document, dict) or set(document) - {'trusted_accounts'} != fields:
        raise SafeFailure('invalid recovery preflight request')
    for key, pattern in (('tenant_id', r'[A-Za-z][A-Za-z0-9_-]{0,63}'), ('alias', r'[a-z][a-z0-9_-]{0,63}'),
                         ('runtime_key', r'[a-z][a-z0-9-]{0,63}')):
        if not isinstance(document[key], str) or re.fullmatch(pattern, document[key]) is None:
            raise SafeFailure('invalid recovery preflight identity')
    raw_agent = document['agent']
    if not isinstance(raw_agent, dict) or len(raw_agent) > 100 \
            or any(not isinstance(key, str) or key.startswith('_') for key in raw_agent) \
            or any(raw_agent.get(key) != document[key] for key in ('tenant_id', 'alias', 'runtime_key')):
        raise SafeFailure('recovery preflight target differs from its authorized placement')
    for key in ('harness_id', 'host_id', 'runtime_mode', 'runtime_user', 'home_directory', 'state_directory'):
        if not isinstance(raw_agent.get(key), str) or not raw_agent[key]:
            raise SafeFailure('recovery preflight placement is incomplete')
    if raw_agent['runtime_mode'] == 'container' and (not isinstance(raw_agent.get('container_name'), str)
            or not raw_agent['container_name']):
        raise SafeFailure('recovery preflight container placement is incomplete')
    from fleet_executor_templates import validate_accounts
    validate_accounts(document.get('trusted_accounts', []))
    agent = approve_agent(policy, {**raw_agent, '_trusted_accounts': document.get('trusted_accounts', []),
                                  '_trusted_accounts_present': 'trusted_accounts' in document})
    bundle = approved_bundle(policy, agent)
    unsupported = unsupported_reason(agent, bundle)
    if unsupported is None:
        from fleet_executor_recovery_relaunch import observe as relaunch
        relaunched = relaunch(policy, agent)
        if relaunched is not None:
            return {'status': 'ready', 'recovery': relaunched[0]}
        try:
            identity, values, bundle = observe(policy, agent)
        except RecoveryFailure as error:
            if error.reason_code != 'runtime_mounts_differ':
                raise
            return {'status': 'update_required', 'reason_code': error.reason_code,
                    'reason': REASONS[error.reason_code], 'next_action': 'update'}
        if unsupported_reason(agent, bundle, values) == 'runtime_without_shared_tui':
            return {'status': 'update_required', 'reason_code': 'runtime_without_shared_tui',
                    'reason': REASONS['runtime_without_shared_tui'], 'next_action': 'update'}
        recovery = observed_preview(agent, identity, values, bundle)
        return {'status': 'ready', 'recovery': recovery}
    return {'status': 'unsupported', 'reason_code': unsupported, 'reason': REASONS[unsupported], 'next_action': 'stop_start'}


def perform(policy: dict, context: dict, step: str) -> dict:
    from atomic_file import atomic_write
    from fleet_runtime_materialization import _destination
    if context['request']['kind'] != 'recover' or step not in {'runtime', 'verify', 'compensate'}:
        raise SafeFailure('exact recovery does not permit lifecycle replacement steps')
    scope = context.get('fleet_scope', {})
    if scope.get('host_id', policy['host_id']) != policy['host_id']:
        raise SafeFailure('recovery belongs to another fenced host')
    agent = approve_agent(policy, target_agent(context))
    parameters = context['request']['parameters']
    validate_parameters(parameters)
    if parameters['action'] == 'probe':
        if step == 'compensate':
            return {'evidence': {'recovery_compensated': True}}
        result = preview(policy, context)
        return {'evidence': {'runtime_digest': fingerprint(result), 'recovery': result}}
    directory = _destination(pathlib.Path(policy['roots']['state']), 'operations/' + context['operation_id'])
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    private_directory(str(directory))
    filename = _destination(directory, 'recovery.json')
    request_hash = fingerprint(context['request'])
    journal = json.loads(filename.read_bytes()) if filename.exists() else {'request_sha256': request_hash}
    if journal.get('request_sha256') != request_hash:
        raise SafeFailure('recovery replay changed its confirmed request')
    if parameters.get('strategy') == 'relaunch':
        from fleet_executor_recovery_relaunch import perform as relaunch
        return relaunch(policy, agent, parameters, journal,
                        lambda: atomic_write(filename, json.dumps(journal, sort_keys=True).encode(), mode=0o600), step)
    if step == 'compensate':
        if journal.get('attempted'):
            expires_at = journal.get('helper_expires_at')
            if type(expires_at) is not int or expires_at + 1200 - time.time() * 1000 > 8700:
                raise SafeFailure('recovery helper completion deadline is unavailable')
            until = time.monotonic() + 10
            while time.time() * 1000 < expires_at + 1200:
                if time.monotonic() >= until:
                    raise SafeFailure('recovery helper completion deadline was not observed')
                time.sleep(max(0, min(0.05, (expires_at + 1200 - time.time() * 1000) / 1000)))
            observed = preview(policy, context)
            if observed['identity'] != parameters['identity'] or observed['session']['state'] not in {'present', 'absent'} \
                    or observed['session']['resumable'] is not True:
                raise SafeFailure('recovery compensation could not observe the confirmed runtime conversation')
        return {'evidence': {'recovery_compensated': True}}
    current = preview(policy, context)
    if current['strategy'] != 'shared_tui':
        raise SafeFailure('recovery strategy changed after confirmation')
    if current['identity'] != parameters['identity']:
        raise SafeFailure('recovery runtime identity changed after confirmation')
    if current['session']['state'] == 'unsupported':
        raise RecoveryFailure(unsupported_reason(agent, policy['bundles'][agent['harness_id']]) or 'runtime_without_shared_tui')
    if 'receipt' in journal:
        if current['session']['state'] != 'present' or not current['session']['resumable'] \
                or current['session']['fingerprint'] != journal['post_fingerprint']:
            raise SafeFailure('recovered terminal changed before its receipt was verified')
        return {'evidence': journal['receipt']}
    if step != 'runtime' or journal.get('attempted'):
        raise SafeFailure('recovery has no verified receipt; a new explicit preview is required')
    session = current['session']
    if session['state'] not in {'present', 'absent'} or not session['resumable'] \
            or session['fingerprint'] != parameters['expected_fingerprint'] \
            or session['state'] == 'present' and not parameters['force']:
        raise SafeFailure('recovery conversation or terminal changed after confirmation')
    identity, values, bundle = observe(policy, agent)
    if identity != parameters['identity']:
        raise SafeFailure('recovery runtime changed before the physical effect')
    expires_at = int(time.time() * 1000) + 7500
    journal.update(attempted=True, helper_expires_at=expires_at)
    atomic_write(filename, json.dumps(journal, sort_keys=True).encode(), mode=0o600)
    result = run_helper(agent, identity, values, bundle, 'recovery-apply', parameters, expires_at=expires_at)
    if result['state'] != ('recreated' if session['state'] == 'absent' else 'resumed') \
            or result['resumable'] is not True or result['fingerprint'] != parameters['expected_fingerprint']:
        raise SafeFailure('recovery did not confirm the exact conversation restart')
    after = preview(policy, context)
    if after['identity'] != identity or after['session']['state'] != 'present' or not after['session']['resumable']:
        raise SafeFailure('recovery was not observed on the confirmed runtime')
    receipt = {**current, 'session': result}
    journal['post_fingerprint'] = after['session']['fingerprint']
    journal['receipt'] = {'runtime_digest': fingerprint(receipt), 'recovery': receipt}
    atomic_write(filename, json.dumps(journal, sort_keys=True).encode(), mode=0o600)
    return {'evidence': journal['receipt']}
