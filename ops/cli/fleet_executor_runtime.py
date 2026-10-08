from __future__ import annotations

import hashlib
import json
import os
import pathlib
import pwd
import re
import subprocess
import sys
import time
import uuid
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'))
from cauce_container_base import bundle_digest, open_control_directory, prepare_state
from cauce_container_proc import (
    lock_is_held,
    matched_fs_credentials,
    read_metadata,
    validate_metadata,
    verify_adapter,
    verify_controller,
)
from fleet_executor_policy import SafeFailure, approve_agent, digest, path
from fleet_executor_view import environment as credential_environment
from fleet_executor_view import install, payload_for

HELPER = pathlib.Path(__file__).resolve().parents[1] / 'container-runtime/cauce-container-runtime.py'


def checked_command(command: list[str], *, environment: dict | None = None, timeout: float = 30, input_data: bytes | None = None) -> bytes:
    result = subprocess.run(command, input=input_data, capture_output=True, env=environment, timeout=timeout, check=False)
    if result.returncode:
        raise SafeFailure('runtime effect or observation failed')
    return result.stdout


def approved_bundle(policy: dict, agent: dict) -> dict:
    bundle = policy['bundles'][agent['harness_id']]
    if set(bundle) != {'directory', 'digest', 'executable', 'executable_sha256', 'argv'} \
            or not isinstance(bundle['argv'], list) or not all(isinstance(value, str) for value in bundle['argv']):
        raise SafeFailure('invalid approved runtime bundle')
    if bundle_digest(str(path(bundle['directory']))) != bundle['digest'] \
            or (agent['runtime_mode'] == 'native' and digest(path(bundle['executable'])) != bundle['executable_sha256']):
        raise SafeFailure('approved runtime bundle or executable changed')
    return bundle


def native_identity(policy: dict, agent: dict) -> dict:
    boot = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
    host = hashlib.sha256(('host:' + policy['host_id']).encode()).hexdigest()
    generation = hashlib.sha256((host + '\0' + boot + '\0' + agent['state_directory']).encode()).hexdigest()
    return {'container_id': host, 'generation': generation,
            'control': pathlib.Path(policy['roots']['runtime']) / '.control' / agent['runtime_key']}


def lifecycle_arguments(agent: dict, identity: dict) -> list[str]:
    return ['--alias', agent['runtime_key'], '--state', agent['state_directory'], '--control-dir', str(identity['control']),
            '--container-id', identity['container_id'], '--generation', identity['generation'],
            '--term-seconds', '2', '--kill-seconds', '2']


def provider_environment(policy: dict, agent: dict) -> dict:
    from fleet_executor_templates import resolve_profile
    binding = resolve_profile(policy, agent)
    if binding is None:
        return {}
    if not isinstance(binding, dict) or binding.get('runtime_user') != agent['runtime_user'] \
            or (agent['runtime_mode'] == 'container' and binding.get('container_name', agent['container_name']) != agent['container_name']):
        raise SafeFailure('runtime provider binding differs from its execution identity')
    if agent['harness_id'] == 'openclaw':
        from fleet_provider_openclaw import environment
        values = environment(binding, agent)
        driver = binding['openclaw']
        files = {**binding.get('command_files', {}), binding['command']: binding['command_sha256'],
            driver['auth_list_source']: driver['auth_list_sha256'], driver['bridge']: driver['bridge_sha256']}
        if agent['runtime_mode'] == 'native' and (digest(path(driver['node_command'])) != driver['node_command_sha256']
                or any(digest(path(filename)) != value for filename, value in files.items())):
            raise SafeFailure('OpenClaw runtime command or bridge pin changed')
        values.update(CAUCE_HARNESS_COMMAND=driver['node_command'], CAUCE_HARNESS_COMMAND_SHA256=driver['node_command_sha256'],
            CAUCE_HARNESS_BRIDGE=driver['bridge'], CAUCE_HARNESS_COMMAND_FILES=json.dumps(files, sort_keys=True, separators=(',', ':')))
        return values
    variable = {'codex': 'CODEX_HOME', 'claude': 'CLAUDE_CONFIG_DIR', 'gemini': 'GEMINI_CLI_HOME'}.get(binding.get('provider'))
    if variable is None:
        raise SafeFailure('runtime provider environment is not approved')
    values = {variable: str(path(binding['path']))}
    if binding.get('command') is not None:
        executable = str(path(binding['command']))
        fingerprint = binding.get('command_sha256')
        files = binding.get('command_files', {})
        if not isinstance(fingerprint, str) or re.fullmatch(r'[0-9a-f]{64}', fingerprint) is None \
                or not isinstance(files, dict) or len(files) > 32 or any(not isinstance(value, str) \
                    or re.fullmatch(r'[0-9a-f]{64}', value) is None for value in files.values()):
            raise SafeFailure('provider command pins are not approved')
        for filename in files:
            path(filename)
        if agent['runtime_mode'] == 'native' and (digest(path(executable)) != fingerprint \
                or any(digest(path(filename)) != value for filename, value in files.items())):
            raise SafeFailure('provider command executable or file pin changed')
        values.update(CAUCE_HARNESS_COMMAND=executable, CAUCE_HARNESS_COMMAND_SHA256=fingerprint,
            CAUCE_HARNESS_COMMAND_FILES=json.dumps(files, sort_keys=True, separators=(',', ':')))
    return values


class NamespaceMismatch(SafeFailure):
    pass


def namespace_proof(environment: dict, bootstrap: bool, operation_id: str | None = None):
    if environment.get('CAUCE_BOOTSTRAP') != ('1' if bootstrap else '0') \
            or (operation_id is not None and environment.get('CAUCE_FLEET_OPERATION_ID') != operation_id):
        raise NamespaceMismatch('running runtime has another credential namespace')


def sdk_environment(policy: dict, agent: dict, bootstrap: bool, operation_id: str | None) -> dict:
    from fleet_executor_pki import checked_file
    from fleet_runtime_materialization import load_desired_fleet
    state = pathlib.Path(policy['roots']['state'])
    receipt = load_desired_fleet(state)
    snapshot = json.loads(checked_file(state / 'generations' / receipt['generation'] / 'flota.json', False))
    row = snapshot.get('bootstrap' if bootstrap else 'fleet', {}).get(agent['runtime_key'])
    if not isinstance(row, dict) or row.get('tenant') != agent['tenant_id'] or row.get('alias', agent['runtime_key']) != agent['alias'] \
            or row.get('user') != agent['runtime_user'] or row.get('runtimeStateDirectory') != agent['state_directory'] \
            or row.get('enabled') is not (not bootstrap):
        raise SafeFailure('SDK identity differs from its durable materialized fleet')
    room = row.get('room')
    if not isinstance(room, str) or not 1 <= len(room) <= 128 or any(ord(char) < 32 for char in room) \
            or (agent.get('primary_room_id') is not None and room != agent['primary_room_id']):
        raise SafeFailure('SDK primary room differs from its durable fleet')
    transport = policy.get('transport')
    if not isinstance(transport, dict):
        raise SafeFailure('SDK requires an approved verified TLS gateway transport')
    gateway = urlsplit(transport['gateway_url'])
    instance = str(uuid.uuid5(uuid.NAMESPACE_URL, '\0'.join((operation_id or receipt['generation'], agent['tenant_id'], agent['runtime_key']))))
    values = {'CAUCE_ROOM': room, 'CAUCE_INSTANCE_ID': instance,
              'CAUCE_RELAY_URL': urlunsplit(('wss', gateway.netloc, '/v3/ws', '', ''))}
    model = agent.get('model_id')
    if model is not None:
        if not isinstance(model, str) or not 1 <= len(model) <= 128 or any(ord(char) < 32 for char in model) \
                or row.get('modelId') != model:
            raise SafeFailure('model selection differs from the durable fleet')
        values['CAUCE_MODEL_ID'] = model
    effort = agent.get('reasoning_effort')
    if effort is not None:
        compatible = {'minimal', 'low', 'medium', 'high', 'xhigh', 'max'} if agent['harness_id'] in {'codex', 'openclaw'} else \
            {'low', 'medium', 'high', 'xhigh', 'max'} if agent['harness_id'] == 'claude' else set()
        if effort not in compatible or row.get('reasoningEffort') != effort:
            raise SafeFailure('reasoning effort is not approved')
        values['CAUCE_REASONING_EFFORT'] = effort
    return values


def sdk_environment_proof(policy: dict, agent: dict, observed: dict, bootstrap: bool, operation_id: str | None):
    expected = sdk_environment(policy, agent, bootstrap, operation_id)
    if any(observed.get(key) != value for key, value in expected.items()):
        raise NamespaceMismatch('running runtime has another SDK identity or transport')


def native_proof(policy: dict, agent: dict, identity: dict, bundle: dict, *, bootstrap: bool | None = None, operation_id: str | None = None) -> dict | None:
    if not identity['control'].exists():
        return None
    control = open_control_directory(str(identity['control']))
    try:
        document, _ = read_metadata(control)
        if document is None:
            if lock_is_held(control):
                raise SafeFailure('runtime is starting without observed process identity')
            return None
        validate_metadata(document)
        if document['phase'] != 'running' or document['alias'] != agent['runtime_key'] \
                or document.get('wireAlias') != agent['alias'] or document.get('tenantId') != agent['tenant_id'] \
                or document['containerId'] != identity['container_id'] or document['containerGeneration'] != identity['generation'] \
                or document['bundleDigest'] != bundle['digest']:
            raise SafeFailure('runtime lifecycle identity differs')
        user = pwd.getpwnam(agent['runtime_user'])
        if document['runtimeUid'] != user.pw_uid or document['runtimeGid'] != user.pw_gid:
            raise SafeFailure('runtime execution user differs')
        verify_controller(document)
        verify_adapter(document, agent['runtime_key'], agent['state_directory'])
        if bootstrap is not None:
            with matched_fs_credentials(user.pw_uid, user.pw_gid):
                raw = pathlib.Path(f'/proc/{document["pid"]}/environ').read_bytes()
            environment = {item.split(b'=', 1)[0].decode(): item.split(b'=', 1)[1].decode()
                           for item in raw.split(b'\0') if item.startswith((b'CAUCE_BOOTSTRAP=', b'CAUCE_FLEET_OPERATION_ID=',
                               b'CAUCE_ROOM=', b'CAUCE_INSTANCE_ID=', b'CAUCE_RELAY_URL=', b'CAUCE_MODEL_ID=', b'CAUCE_REASONING_EFFORT='))}
            namespace_proof(environment, bootstrap, operation_id)
            sdk_environment_proof(policy, agent, environment, bootstrap, operation_id)
        return document
    finally:
        os.close(control)


def start_native(policy: dict, raw_agent: dict, *, bootstrap: bool = True, operation_id: str | None = None) -> dict:
    agent = approve_agent(policy, raw_agent)
    bundle = approved_bundle(policy, agent)
    if agent['systemd_user'] != policy['executor_user']:
        raise SafeFailure('missing verified systemd manager hook')
    identity = native_identity(policy, agent)
    existing = native_proof(policy, agent, identity, bundle, bootstrap=bootstrap, operation_id=operation_id)
    if existing is not None:
        return runtime_evidence(existing)
    user = pwd.getpwnam(agent['runtime_user'])
    if user.pw_uid == 0 or (os.geteuid() != 0 and user.pw_uid != os.geteuid()):
        raise SafeFailure('runtime user cannot be launched by this executor')
    root = path(agent['_placement']['state_root'])
    prepare_state(str(root), agent['state_directory'], user.pw_uid, user.pw_gid)
    view = pathlib.Path(agent['state_directory']) / '.cauce-credentials' / ('bootstrap' if bootstrap else 'normal')
    install(view, payload_for(policy, agent, bootstrap), user.pw_uid, user.pw_gid)
    from fleet_executor_profiles import prepare_profile
    prepare_profile(policy, agent)
    identity['control'].parent.mkdir(mode=0o700, exist_ok=True)
    identity['control'].mkdir(mode=0o700, exist_ok=True)
    environment = {'PATH': '/usr/bin:/bin', 'HOME': agent['home_directory'], 'CAUCE_ALIAS': agent['alias'],
        'CAUCE_RUNTIME_KEY': agent['runtime_key'], 'CAUCE_TENANT_ID': agent['tenant_id'], 'CAUCE_TENANT': agent['tenant_id'],
        'CAUCE_STATE_DIR': agent['state_directory'], 'CAUCE_CONTROL_DIR': str(identity['control']),
        'CAUCE_CONTAINER_ID': identity['container_id'], 'CAUCE_CONTAINER_GENERATION': identity['generation'],
        'CAUCE_BOOTSTRAP': '1' if bootstrap else '0'}
    environment.update(credential_environment(view, policy, bootstrap))
    environment.update(sdk_environment(policy, agent, bootstrap, operation_id))
    environment.update(provider_environment(policy, agent))
    if operation_id is not None:
        environment['CAUCE_FLEET_OPERATION_ID'] = operation_id
    command = [str(pathlib.Path(sys.executable).resolve()), str(HELPER), 'run', *lifecycle_arguments(agent, identity),
        '--wire-alias', agent['alias'], '--tenant', agent['tenant_id'], '--runtime-uid', str(user.pw_uid),
        '--runtime-gid', str(user.pw_gid), '--bundle', bundle['directory'], '--bundle-digest', bundle['digest'],
        bundle['executable'], *bundle['argv']]
    controller = subprocess.Popen(command, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                  start_new_session=True)
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if controller.poll() is not None:
                raise SafeFailure('runtime exited before identity was observed')
            try:
                observed = native_proof(policy, agent, identity, bundle)
            except SafeFailure:
                observed = None
            if observed is not None:
                return runtime_evidence(observed)
            time.sleep(0.05)
        raise SafeFailure('runtime identity observation timed out')
    except BaseException:
        try:
            checked_command([str(pathlib.Path(sys.executable).resolve()), str(HELPER), 'stop', *lifecycle_arguments(agent, identity)])
        finally:
            controller.wait(timeout=10)
        raise


def runtime_evidence(observed: dict) -> dict:
    return {'runtime_digest': hashlib.sha256(json.dumps(observed, sort_keys=True, separators=(',', ':')).encode()).hexdigest()}


def stop_native(policy: dict, raw_agent: dict) -> dict:
    agent = approve_agent(policy, raw_agent)
    if agent['systemd_user'] != policy['executor_user']:
        raise SafeFailure('missing verified systemd manager hook')
    identity = native_identity(policy, agent)
    if identity['control'].exists():
        checked_command([str(pathlib.Path(sys.executable).resolve()), str(HELPER), 'stop', *lifecycle_arguments(agent, identity)])
    checked_command([str(pathlib.Path(sys.executable).resolve()), str(HELPER), 'stopped', *lifecycle_arguments(agent, identity)])
    if identity['control'].exists():
        descriptor = open_control_directory(str(identity['control']))
        try:
            document, _ = read_metadata(descriptor)
            if document is not None or lock_is_held(descriptor):
                raise SafeFailure('stopped state is not observed')
        finally:
            os.close(descriptor)
    return {'stopped_verified': True}


def start(policy: dict, agent: dict, *, bootstrap: bool = True, operation_id: str | None = None) -> dict:
    from fleet_provider_openclaw import validate_execution_selection
    validate_execution_selection(agent)
    if agent['runtime_mode'] == 'native':
        return start_native(policy, agent, bootstrap=bootstrap, operation_id=operation_id)
    from fleet_executor_container import start_container
    return start_container(policy, agent, bootstrap=bootstrap, operation_id=operation_id)


def stop(policy: dict, agent: dict) -> dict:
    if agent['runtime_mode'] == 'native':
        return stop_native(policy, agent)
    from fleet_executor_container import stop_container
    return stop_container(policy, agent)
