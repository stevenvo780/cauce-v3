from __future__ import annotations

import json
import os
import select
import subprocess
import time
import uuid

from fleet_executor_policy import SafeFailure, approve_agent, bounded_text

TTL = 30
LIMIT = 1048576
REASONS = frozenset({'pending_deliveries', 'provider_login', 'composer_busy', 'turn_active',
                     'tui_unreadable', 'preflight_unavailable'})


class PreflightUnavailable(SafeFailure):
    pass


MAINTENANCE_ENTRY = r'''import json,os,socket,stat,struct,sys,time
from cauce_container_adoption import mutation_guard
from cauce_container_base import PermanentError,open_control_directory
from cauce_container_proc import lock_control,matched_fs_credentials,read_metadata,remove_metadata,require_current_generation,verify_adapter
from cauce_container_tree import terminate_from_metadata

class Aborted(Exception):
    pass

def emit(value):
    print(json.dumps(value,separators=(',',':')),flush=True)

def execute(spec):
    control=open_control_directory(spec['control'])
    listener=None
    mutation=None
    lifecycle=None
    created=None
    name='m-'+spec['guard_id'][:16]
    try:
        os.fchdir(control)
        if spec['action']!='hold':
            with socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET) as client:
                client.settimeout(5)
                client.connect(name)
                client.sendall(json.dumps({key:spec[key] for key in ('operation_id','guard_id','action')}).encode())
            return
        mutation=mutation_guard(control,exclusive=True)
        document,original=read_metadata(control)
        if document is None or any(document.get(key)!=value for key,value in spec['expected'].items()):
            raise PermanentError('maintenance lifecycle identity differs')
        require_current_generation(document,spec['container_id'],spec['generation'])
        os.umask(0o077)
        listener=socket.socket(socket.AF_UNIX,socket.SOCK_SEQPACKET)
        listener.bind(name)
        os.chmod(name,0o600,dir_fd=control,follow_symlinks=False)
        created=os.stat(name,dir_fd=control,follow_symlinks=False)
        listener.listen(1)
        committed=False

        def unchanged():
            if read_metadata(control)[1]!=original:
                raise PermanentError('maintenance lifecycle changed before teardown')
            with matched_fs_credentials(document['runtimeUid'],document['runtimeGid']):
                with open('/proc/'+str(document['pid'])+'/environ','rb') as stream:
                    raw=stream.read(262145)
            values={}
            if len(raw)>262144:
                raise PermanentError('maintenance environment exceeds its bound')
            for row in raw.split(b'\0'):
                key,separator,value=row.partition(b'=')
                key=key.decode('utf-8')
                if separator and key in spec['environment']:
                    if key in values:
                        raise PermanentError('maintenance environment is ambiguous')
                    values[key]=value.decode('utf-8')
            if values!=spec['environment']:
                raise PermanentError('maintenance SDK identity changed')

        def before_signal():
            nonlocal committed
            unchanged()
            if committed:
                return
            verify_adapter(document,spec['alias'],spec['state'])
            deadline=time.monotonic()+30
            emit({'state':'ready','operation_id':spec['operation_id'],'guard_id':spec['guard_id'],
                  'container_id':spec['container_id'],'generation':spec['generation']})
            listener.settimeout(max(0.001,deadline-time.monotonic()))
            try:
                client,_=listener.accept()
                with client:
                    client.settimeout(max(0.001,deadline-time.monotonic()))
                    _,uid,_=struct.unpack('3i',client.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12))
                    command=json.loads(client.recv(1025))
                expected={'operation_id':spec['operation_id'],'guard_id':spec['guard_id'],'action':'commit'}
                if uid!=os.geteuid() or time.monotonic()>=deadline or command!=expected:
                    raise Aborted()
            except (TimeoutError,ValueError,OSError):
                raise Aborted() from None
            unchanged()
            committed=True

        def claim_lock():
            nonlocal lifecycle
            lifecycle=lock_control(control)

        terminate_from_metadata(document,spec['alias'],spec['state'],2,2,
            before_signal=before_signal,claim_lifecycle_lock=claim_lock)
        current,raw=read_metadata(control)
        if current is not None:
            if raw!=original:
                raise PermanentError('maintenance lifecycle changed after teardown')
            remove_metadata(control)
    finally:
        if listener is not None:
            listener.close()
        if created is not None:
            current=os.stat(name,dir_fd=control,follow_symlinks=False)
            if (current.st_dev,current.st_ino)!=(created.st_dev,created.st_ino) or not stat.S_ISSOCK(current.st_mode):
                raise PermanentError('maintenance socket identity changed')
            os.unlink(name,dir_fd=control)
        if lifecycle is not None:
            os.close(lifecycle)
        if mutation is not None:
            os.close(mutation)
        os.close(control)

spec=json.loads(sys.argv[1])
try:
    execute(spec)
except Aborted:
    emit({'state':'aborted'})
except PermanentError as error:
    code=str(error)
    if code.startswith('RESTART_HOLD_'):
        busy={'RESTART_HOLD_COMPOSER_NOT_EMPTY','RESTART_HOLD_COMPOSER_ATTACHMENT_PENDING'}
        reason='composer_busy' if code in busy else 'turn_active' if code=='RESTART_HOLD_TURN_OR_PASTE_ACTIVE' else 'tui_unreadable'
        emit({'state':'deferred','reason':reason})
    else:
        emit({'state':'failed'})
        raise SystemExit(2) from None
else:
    if spec['action']=='hold':
        emit({'state':'stopped'})
'''


class JsonLines:
    def __init__(self, stream):
        self.stream, self.buffer = stream, b''

    def read(self, deadline: float) -> dict | None:
        while b'\n' not in self.buffer:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([self.stream], [], [], remaining)[0]:
                raise TimeoutError('maintenance input deadline expired')
            chunk = os.read(self.stream.fileno(), 65536)
            if not chunk:
                if self.buffer:
                    raise SafeFailure('maintenance input ended without a complete line')
                return None
            self.buffer += chunk
            if len(self.buffer) > LIMIT:
                raise SafeFailure('maintenance input exceeds its bound')
        line, self.buffer = self.buffer.split(b'\n', 1)
        try:
            value = json.loads(line)
        except (UnicodeError, ValueError):
            raise SafeFailure('maintenance input is not valid JSON') from None
        if not isinstance(value, dict):
            raise SafeFailure('maintenance input must be an object')
        return value


def request_agent(policy: dict, document: dict) -> dict:
    from fleet_executor_templates import validate_accounts
    if set(document) != {'operation_id', 'agent', 'trusted_accounts', 'claim'}:
        raise SafeFailure('invalid maintenance request')
    claim = document['claim']
    try:
        if str(uuid.UUID(document['operation_id'])) != document['operation_id'] \
                or not isinstance(claim, dict) or set(claim) != {'claim_token', 'consumer_epoch'} \
                or str(uuid.UUID(claim['claim_token'])) != claim['claim_token'] \
                or type(claim['consumer_epoch']) is not int or claim['consumer_epoch'] < 0:
            raise ValueError
    except (ValueError, TypeError, AttributeError):
        raise SafeFailure('invalid maintenance operation claim') from None
    agent = document['agent']
    required = {'tenant_id', 'alias', 'runtime_key', 'harness_id', 'host_id', 'runtime_mode', 'container_name',
                'runtime_user', 'home_directory', 'state_directory', 'primary_room_id', 'primary_account_id', 'model_id'}
    if not isinstance(agent, dict) or not required <= set(agent) or any(key.startswith('_') for key in agent):
        raise SafeFailure('maintenance requires a complete canonical agent identity')
    if any(agent[key] is None for key in ('primary_room_id', 'primary_account_id', 'model_id')):
        raise PreflightUnavailable('maintenance selection identity is unavailable')
    if any(not bounded_text(agent[key], 256) for key in required):
        raise SafeFailure('maintenance requires a complete canonical agent identity')
    validate_accounts(document['trusted_accounts'])
    return approve_agent(policy, {**agent, '_trusted_accounts': document['trusted_accounts'], '_trusted_accounts_present': True})


def emit(stream, document: dict) -> None:
    stream.write(json.dumps(document, separators=(',', ':')) + '\n')
    stream.flush()


def remote_command(agent: dict, spec: dict) -> tuple[list[str], bytes]:
    from fleet_executor_container import DOCKER
    from fleet_executor_lifecycle import command
    arguments, raw = command(agent['_placement']['python'], json.dumps(spec, separators=(',', ':')), maintenance=True)
    return [DOCKER, 'exec', '-i', '-w', '/', '--user', '0', spec['container_id'], *arguments], raw


def send_command(agent: dict, spec: dict, action: str) -> None:
    from fleet_executor_container import checked_command
    arguments, raw = remote_command(agent, {**spec, 'action': action})
    checked_command(arguments, input_data=raw, timeout=8)


def hold(agent: dict, spec: dict, incoming: JsonLines, output) -> None:
    arguments, raw = remote_command(agent, spec)
    child = subprocess.Popen(arguments, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             start_new_session=True)
    ready, terminal = False, False
    try:
        child.stdin.write(raw)
        child.stdin.close()
        child.stdin = None
        lines = JsonLines(child.stdout)
        receipt = lines.read(time.monotonic() + 45)
        if receipt is None:
            raise SafeFailure('maintenance guard did not return a receipt')
        if receipt.get('state') == 'ready':
            expected = {key: spec[key] for key in ('operation_id', 'container_id', 'generation', 'guard_id')}
            if receipt != {'state': 'ready', **expected}:
                raise SafeFailure('maintenance guard returned another runtime identity')
            ready = True
            deadline = time.monotonic() + TTL
            emit(output, receipt)
            try:
                instruction = incoming.read(deadline)
            except (TimeoutError, SafeFailure):
                instruction = None
            action = 'abort'
            if instruction == {'operation_id': spec['operation_id'], 'guard_id': spec['guard_id'], 'action': 'commit'} \
                    and time.monotonic() < deadline:
                action = 'commit'
            try:
                send_command(agent, spec, action)
            except (SafeFailure, OSError, subprocess.TimeoutExpired):
                pass
            receipt = lines.read(time.monotonic() + 20)
        if receipt is None or receipt.get('state') not in {'stopped', 'aborted', 'deferred'} \
                or receipt.get('state') == 'deferred' and receipt.get('reason') not in REASONS:
            raise SafeFailure('maintenance teardown or input restoration is unverified')
        if child.wait(timeout=10) != 0:
            raise SafeFailure('maintenance guard exited without confirmed restoration')
        if receipt['state'] == 'stopped' and (not ready or action != 'commit'):
            raise SafeFailure('maintenance guard stopped without a committed request')
        terminal = True
        emit(output, receipt)
    finally:
        if not terminal:
            if ready and child.poll() is None:
                try:
                    send_command(agent, spec, 'abort')
                except (SafeFailure, OSError, subprocess.TimeoutExpired):
                    pass
            try:
                child.wait(timeout=40)
            except subprocess.TimeoutExpired:
                child.terminate()
                child.wait(timeout=5)
        for stream in (child.stdin, child.stdout):
            if stream is not None:
                stream.close()


def run(policy: dict, input_stream, output) -> None:
    from fleet_executor_container import identity_for, inspect_container, observe_adapter_state, validate_container
    from fleet_executor_image import assert_no_login, assert_persistent_profile, image_guard, validate_previous
    from fleet_executor_runtime import approved_bundle, provider_base_environment, sdk_environment_proof
    incoming = JsonLines(input_stream)
    document = incoming.read(time.monotonic() + TTL)
    if document is None:
        raise SafeFailure('maintenance request is absent')
    try:
        agent = request_agent(policy, document)
    except PreflightUnavailable:
        emit(output, {'state': 'deferred', 'reason': 'preflight_unavailable'})
        return
    if agent['runtime_mode'] != 'container' or agent['_placement'].get('ownership') == 'shared':
        emit(output, {'state': 'deferred', 'reason': 'preflight_unavailable'})
        return
    observed = inspect_container(agent['container_name'])
    if observed is None:
        emit(output, {'state': 'stopped'})
        return
    try:
        with image_guard(observed['Id']):
            try:
                assert_no_login(agent, observed)
            except SafeFailure:
                emit(output, {'state': 'deferred', 'reason': 'provider_login'})
                return
            previous = validate_previous(policy, agent, observed)
            bundle = approved_bundle(policy, agent)
            if bundle.get('shared_tui') is not True or agent['harness_id'] not in {'claude', 'codex', 'grok', 'muse'}:
                emit(output, {'state': 'deferred', 'reason': 'preflight_unavailable'})
                return
            assert_persistent_profile(policy, agent)
            state, environment = observe_adapter_state(previous, observed)
            if not state['adapter_running']:
                emit(output, {'state': 'stopped'})
                return
            sdk_environment_proof(policy, agent, environment, state['adapter_bootstrap'], state['adapter_operation_id'])
            profile = provider_base_environment(policy, agent)
            profile_keys = {'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GROK_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'}
            if environment.get('HOME') != agent['home_directory'] or not profile_keys.intersection(profile) \
                    or any(environment.get(key) != profile[key] for key in profile_keys.intersection(profile)):
                raise SafeFailure('maintenance provider profile differs from its approved account')
            try:
                validate_container(policy, agent, observed)
            except SafeFailure as error:
                if str(error) != 'container runtime mounts differ' and previous['_placement']['image'] == agent['_placement']['image']:
                    raise
            else:
                if state.get('adapter_bundle_digest') == bundle['digest']:
                    emit(output, {'state': 'runtime_current'})
                    return
            identity = identity_for(previous, observed)
            from fleet_executor_container import user_identity
            uid, gid = user_identity(previous, identity)
            expected = {'alias': agent['runtime_key'], 'wireAlias': agent['alias'], 'tenantId': agent['tenant_id'],
                'stateDirectory': agent['state_directory'], 'controlDirectory': str(identity['control']),
                'containerId': identity['container_id'], 'containerGeneration': identity['generation'],
                'runtimeUid': int(uid), 'runtimeGid': int(gid), 'phase': 'running'}
            spec = {'action': 'hold', 'operation_id': document['operation_id'], 'guard_id': uuid.uuid4().hex,
                'container_id': identity['container_id'], 'generation': identity['generation'],
                'control': str(identity['control']), 'alias': agent['runtime_key'], 'state': agent['state_directory'],
                'expected': expected, 'environment': environment}
            hold(previous, spec, incoming, output)
    except SafeFailure as error:
        if str(error) != 'provider login session is open or unverified; image refresh refused':
            raise
        emit(output, {'state': 'deferred', 'reason': 'provider_login'})
