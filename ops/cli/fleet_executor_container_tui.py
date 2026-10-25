from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import stat

from fleet_executor_lifecycle import source as lifecycle_source
from fleet_executor_policy import SafeFailure, open_absolute_directory, open_regular_at

SOURCE_ROOT = pathlib.Path(__file__).resolve().parent
MODULES = ('cauce_container_base', 'cauce_container_proc', 'cauce_container_tree', 'fleet_policy_paths', 'secure_path')
BOOTSTRAP = '''import base64,hashlib,io,json,sys,types
raw=sys.stdin.buffer.read(1048577)
if len(raw)>1048576 or hashlib.sha256(raw).hexdigest()!=sys.argv.pop(1):
    raise SystemExit('current canonical TUI payload differs')
packet=json.loads(raw)
names=('cauce_container_base','cauce_container_proc','cauce_container_tree','fleet_policy_paths','secure_path')
if set(packet)!={'modules','entry','request'} or list(packet['modules'])!=list(names):
    raise SystemExit('current canonical TUI modules differ')
for name in names:
    module=types.ModuleType(name)
    module.__file__='<current-canonical-tui/'+name+'.py>'
    sys.modules[name]=module
    exec(compile(base64.b64decode(packet['modules'][name],validate=True),module.__file__,'exec'),module.__dict__)
sys.stdin=io.TextIOWrapper(io.BytesIO(json.dumps(packet['request']).encode()),encoding='utf-8')
exec(compile(base64.b64decode(packet['entry'],validate=True),'<current-canonical-tui/entry.py>','exec'),{'__name__':'__main__'})
'''


def current_source(filename: str) -> bytes:
    if filename not in {'fleet_executor_tui.py', 'fleet_policy_paths.py', 'secure_path.py'}:
        raise SafeFailure('canonical TUI source is outside its allowlist')
    directory = SOURCE_ROOT.parent / 'scripts' if filename == 'secure_path.py' else SOURCE_ROOT
    for parent in (SOURCE_ROOT.parent.parent, SOURCE_ROOT.parent, directory):
        descriptor = open_absolute_directory(parent)
        try:
            details = os.fstat(descriptor)
            if details.st_uid not in {0, os.geteuid()} or details.st_mode & 0o022:
                raise SafeFailure('canonical TUI source directory ownership or mode differs')
        finally:
            os.close(descriptor)
    parent = open_absolute_directory(directory)
    try:
        descriptor = open_regular_at(parent, filename, os.O_RDONLY)
        try:
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_uid not in {0, os.geteuid()} \
                    or before.st_nlink != 1 or before.st_mode & 0o022 or before.st_size > 262144:
                raise SafeFailure('canonical TUI source ownership, mode or size differs')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                raw = stream.read(262145)
            after = os.fstat(descriptor)
            fields = ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_uid', 'st_gid', 'st_mode', 'st_nlink')
            if len(raw) != before.st_size or any(getattr(before, name) != getattr(after, name) for name in fields):
                raise SafeFailure('canonical TUI source changed during observation')
            return raw
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def helper_program(python: str, request: dict) -> tuple[list[str], bytes]:
    modules = {name: base64.b64encode(lifecycle_source(name + '.py') if name.startswith('cauce_container_')
        else current_source(name + '.py')).decode('ascii') for name in MODULES}
    raw = json.dumps({'modules': modules, 'entry': base64.b64encode(current_source('fleet_executor_tui.py')).decode('ascii'),
        'request': request}, separators=(',', ':')).encode()
    if len(raw) > 1048576:
        raise SafeFailure('canonical TUI sources exceed their bound')
    return [python, '-I', '-B', '-c', BOOTSTRAP, hashlib.sha256(raw).hexdigest()], raw


def placement_fingerprint(agent: dict) -> str:
    fields = ('tenant_id', 'alias', 'runtime_key', 'harness_id', 'runtime_mode', 'container_name',
              'runtime_user', 'home_directory', 'state_directory', 'host_id', 'model_id', 'reasoning_effort')
    value = {field: agent.get(field) for field in fields}
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def helper_request(policy: dict, agent: dict, observed: dict, action: str, witness: dict | None = None) -> tuple[list[str], bytes]:
    import fleet_executor_container as container
    previous = container.teardown_agent(policy, agent, observed)
    identity = container.identity_for(previous, observed)
    uid, gid = container.user_identity(previous, identity)
    environment = container.provider_environment(policy, previous)
    request = {'runtime_key': previous['runtime_key'], 'harness_id': previous['harness_id'],
        'state_directory': previous['state_directory'], 'workspace': str(pathlib.Path(previous['state_directory']) / 'space/projects'),
        'uid': int(uid), 'gid': int(gid), 'command': environment.get('CAUCE_HARNESS_COMMAND'),
        'command_sha256': environment.get('CAUCE_HARNESS_COMMAND_SHA256'), 'action': action}
    if witness is not None:
        request['witness'] = witness
    arguments, payload = helper_program(previous['_placement']['python'], request)
    return [container.DOCKER, 'exec', '-i', '-w', '/', '--user', uid + ':' + gid, observed['Id'], *arguments], payload


def observe_canonical_tui(policy: dict, raw_agent: dict) -> dict:
    import fleet_executor_container as container
    agent = container.approve_agent(policy, raw_agent)
    receipt = {'version': 1, 'placement_sha256': placement_fingerprint(agent),
        'container_id': None, 'generation': None, 'witness': None}
    if agent.get('runtime_mode') != 'container' or agent['harness_id'] not in {'codex', 'claude', 'grok', 'muse'}:
        return receipt
    observed = container.inspect_container(agent['container_name'])
    if observed is None:
        return receipt
    container.teardown_agent(policy, agent, observed)
    identity = container.identity_for(agent, observed)
    receipt.update(container_id=identity['container_id'], generation=identity['generation'])
    if not observed['State']['Running'] and observed['State']['Pid'] == 0:
        return receipt
    if not observed['State']['Running'] or observed['State']['Pid'] <= 0:
        raise SafeFailure('canonical TUI container state is ambiguous')
    command, payload = helper_request(policy, agent, observed, 'observe')
    receipt['witness'] = json.loads(container.checked_command(command,
        input_data=payload, timeout=20))
    if not isinstance(receipt['witness'], dict) or set(receipt['witness']) != {'socket', 'directories', 'server', 'pane'}:
        raise SafeFailure('canonical TUI observation did not return an exact witness')
    return receipt


def stop_canonical_tui(policy: dict, raw_agent: dict, receipt: dict) -> dict:
    import fleet_executor_container as container
    agent = container.approve_agent(policy, raw_agent)
    if not isinstance(receipt, dict) or set(receipt) != {'version', 'placement_sha256', 'container_id', 'generation', 'witness'} \
            or receipt['version'] != 1 or receipt['placement_sha256'] != placement_fingerprint(agent):
        raise SafeFailure('canonical TUI shutdown changed its witnessed placement')
    if agent.get('runtime_mode') != 'container' or agent['harness_id'] not in {'codex', 'claude', 'grok', 'muse'}:
        if receipt['container_id'] is not None or receipt['witness'] is not None:
            raise SafeFailure('canonical TUI witness belongs to another runtime')
        return {'canonical_tui_stopped': True}
    observed = container.inspect_container(agent['container_name'])
    if observed is None:
        return {'canonical_tui_stopped': True}
    container.teardown_agent(policy, agent, observed)
    identity = container.identity_for(agent, observed)
    if identity['container_id'] != receipt['container_id'] or identity['generation'] != receipt['generation']:
        raise SafeFailure('canonical TUI container generation changed; replacement preserved')
    if not observed['State']['Running'] and observed['State']['Pid'] == 0:
        return {'canonical_tui_stopped': True}
    if not observed['State']['Running'] or observed['State']['Pid'] <= 0 or receipt['witness'] is None:
        raise SafeFailure('canonical TUI appeared after the container absence witness')
    command, payload = helper_request(policy, agent, observed, 'close', receipt['witness'])
    result = json.loads(container.checked_command(command,
        input_data=payload, timeout=20))
    if result != {'canonical_tui_stopped': True}:
        raise SafeFailure('canonical TUI exact shutdown was not observed')
    return result
