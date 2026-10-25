from __future__ import annotations

import base64
import hashlib
import json
import pathlib
import re
import zlib

from fleet_executor_policy import SafeFailure, digest, path

MODULES = ('space_archive_stream', 'space_archive', 'space_backup_validate', 'space_backup_local')
BOOTSTRAP = '''import base64,json,os,pwd,sys,types,zlib
packet=json.loads(zlib.decompress(base64.b64decode(sys.argv.pop(1),validate=True)))
user=pwd.getpwuid(os.geteuid())
if os.geteuid()<=0 or os.getegid()<=0 or user.pw_name!=packet['user'] or user.pw_dir!=packet['home']:
    raise SystemExit('legacy backup execution user or home differs')
os.environ['HOME']=user.pw_dir
os.chdir('/')
for name,source in packet['modules']:
    module=types.ModuleType(name)
    module.__file__='<approved-backup/'+name+'.py>'
    sys.modules[name]=module
    exec(compile(source,module.__file__,'exec'),module.__dict__)
raise SystemExit(sys.modules['space_backup_local'].main())
'''


def approve(policy: dict, snapshot: dict, row: dict) -> tuple[dict, dict]:
    from fleet_executor_container import inspect_container
    if policy['host_id'] != snapshot.get('host_id') or snapshot.get('runtime_user') != row['runtime_user'] \
            or any(snapshot.get(field) not in (None, row[field]) for field in ('home_directory', 'systemd_user')):
        raise SafeFailure('legacy backup execution user or home differs')
    home, state = path(row['home_directory']), path(snapshot['state_directory'])
    if not state.is_relative_to(home) or state == home or state.name != snapshot['runtime_key']:
        raise SafeFailure('legacy backup state is outside its approved home or runtime key')
    observed = inspect_container(snapshot['container_name'])
    if not isinstance(observed, dict) or observed.get('State', {}).get('Running') is not True:
        raise SafeFailure('approved backup container is not observed running')
    configuration = observed.get('HostConfig', {})
    from quota_runtime import normalized_capabilities
    if configuration.get('Privileged') is not False or configuration.get('PidMode') == 'host' \
            or 'SYS_ADMIN' in normalized_capabilities(configuration.get('CapAdd')):
        raise SafeFailure('legacy backup container isolation differs')
    if re.fullmatch('[a-f0-9]{64}', observed.get('Id', '')) is None \
            or re.fullmatch('sha256:[a-f0-9]{64}', observed.get('Image', '')) is None:
        raise SafeFailure('legacy backup container identity is unavailable')
    fields = {field: observed[field] for field in ('Id', 'Image', 'State', 'RestartCount', 'Mounts', 'HostConfig')}
    # Health status may change without replacing the runtime generation.
    fields['State'] = {key: observed['State'][key] for key in ('Running', 'Pid', 'StartedAt')}
    generation = hashlib.sha256(json.dumps(fields, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    agent = {**snapshot, 'runtime_mode': 'container', 'home_directory': str(home), 'systemd_user': row['systemd_user'],
             '_placement': {**row, 'ownership': 'backup-only', 'python': '/usr/bin/python3'}}
    return agent, {'container_id': observed['Id'], 'generation': generation}


def command(agent: dict, binding: dict, *arguments: str) -> list[str]:
    directory = pathlib.Path(__file__).resolve().parent
    sources = []
    for name in MODULES:
        filename = directory / (name + '.py')
        expected = digest(filename)
        raw = filename.read_bytes()
        if len(raw) > 262144 or hashlib.sha256(raw).hexdigest() != expected or digest(filename) != expected:
            raise SafeFailure('approved backup source changed or exceeds its bound')
        sources.append((name, raw.decode('utf-8')))
    packet = {'user': agent['runtime_user'], 'home': agent['home_directory'], 'modules': sources}
    encoded = base64.b64encode(zlib.compress(json.dumps(packet).encode())).decode('ascii')
    if len(encoded) > 98304:
        raise SafeFailure('approved backup program exceeds its bound')
    return ['/usr/bin/docker', 'exec', '-i', '-w', '/', '--user', agent['runtime_user'], binding['container_id'],
            '/usr/bin/python3', '-I', '-B', '-c', BOOTSTRAP, encoded, *arguments]
