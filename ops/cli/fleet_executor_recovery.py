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
    'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'TMPDIR', 'NODE_COMPILE_CACHE', 'CAUCE_ALIAS', 'CAUCE_RUNTIME_KEY',
    'CAUCE_TENANT_ID', 'CAUCE_TENANT', 'CAUCE_STATE_DIR', 'CAUCE_CONTAINER_ID', 'CAUCE_CONTAINER_GENERATION',
    'CAUCE_INSTANCE_ID', 'CAUCE_SHARED_SESSION', 'CAUCE_SHARED_SESSION_WORKSPACE', 'CAUCE_MODEL_ID',
    'CAUCE_REASONING_EFFORT', 'CAUCE_HARNESS_COMMAND', 'CAUCE_HARNESS_COMMAND_SHA256', 'CAUCE_HARNESS_COMMAND_FILES'})


def fingerprint(value) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def validate_parameters(parameters: dict) -> None:
    if parameters == {'action': 'probe'}:
        return
    if set(parameters) != {'action', 'expected_fingerprint', 'force', 'identity'} or parameters['action'] != 'apply' \
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
        from fleet_executor_container import docker, identity_for, inspect_container, process_proof, validate_container
        observed = inspect_container(agent['container_name'])
        if observed is None or observed.get('State', {}).get('Running') is not True:
            raise SafeFailure('recovery requires the approved container to remain running')
        validate_container(policy, agent, observed)
        runtime = identity_for(agent, observed)
        process_proof(policy, agent, runtime, bundle)
        metadata = json.loads(docker('exec', '--user', '0', runtime['container_id'], '/bin/cat',
            str(runtime['control'] / 'cauce-v3-adapter.json')))
        values = process_environment(docker('exec', '--user', '0', runtime['container_id'], '/bin/cat',
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


def run_helper(agent: dict, identity: dict, values: dict, bundle: dict, action: str, parameters: dict | None = None) -> dict:
    entries = [pathlib.Path(value) for value in bundle['argv'] if isinstance(value, str)
        and value.endswith('/bin/' + agent['harness_id'] + '.js')]
    if len(entries) != 1 or not entries[0].is_relative_to(pathlib.Path(bundle['directory'])):
        raise SafeFailure('approved adapter bundle has no exact shared recovery helper')
    workspace = values.get('CAUCE_SHARED_SESSION_WORKSPACE')
    if not isinstance(workspace, str) or workspace != str(pathlib.Path(agent['state_directory']) / 'space/projects'):
        raise SafeFailure('recovery workspace differs from the approved agent workspace')
    expires_at = int(time.time() * 1000) + 7500
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
            time.sleep(min(0.05, (expires_at + 1200 - time.time() * 1000) / 1000))
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGKILL)
        child.wait(timeout=3)
        child.stdout.close()


def preview(policy: dict, context: dict) -> dict:
    agent = approve_agent(policy, target_agent(context))
    identity, values, bundle = observe(policy, agent)
    if agent['harness_id'] not in HARNESSES or values.get('CAUCE_SHARED_SESSION') != '1':
        session = {'type': 'session', 'state': 'unsupported', 'resumable': False, 'fingerprint': None,
            'reason': 'Este adaptador necesita activar su TUI compartida antes de recuperarla; no se detuvo ni modificó el runtime.'}
    else:
        session = run_helper(agent, identity, values, bundle, 'recovery-preview')
    return {'identity': identity, 'session': session, 'strategy': 'shared_tui',
        'preserves_conversation': True, 'recreates_container': False}


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
    if step == 'compensate':
        return {'evidence': {}}
    if parameters['action'] == 'probe':
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
    current = preview(policy, context)
    if current['identity'] != parameters['identity']:
        raise SafeFailure('recovery runtime identity changed after confirmation')
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
    journal['attempted'] = True
    atomic_write(filename, json.dumps(journal, sort_keys=True).encode(), mode=0o600)
    identity, values, bundle = observe(policy, agent)
    if identity != parameters['identity']:
        raise SafeFailure('recovery runtime changed before the physical effect')
    result = run_helper(agent, identity, values, bundle, 'recovery-apply', parameters)
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
