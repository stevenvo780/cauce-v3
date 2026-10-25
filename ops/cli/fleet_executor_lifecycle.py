from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import stat

from fleet_executor_policy import SafeFailure, open_absolute_directory, open_regular_at

MODULES = ('cauce_container_base', 'cauce_container_proc', 'cauce_container_tree', 'cauce_container_adoption')
SOURCE_ROOT = pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'
MAX_SOURCE = 262144

EXECUTABLE_DIGEST = '''import hashlib,os,stat,sys
descriptor=os.open(os.path.realpath(sys.argv[1]),os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
try:
    before=os.fstat(descriptor)
    if not stat.S_ISREG(before.st_mode) or before.st_uid!=0 or before.st_nlink!=1 or before.st_mode&0o022 or before.st_size>268435456:
        raise RuntimeError('approved executable ownership, mode or size differs')
    fingerprint=hashlib.sha256()
    while chunk:=os.read(descriptor,1048576):
        fingerprint.update(chunk)
    after=os.fstat(descriptor)
    if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):
        raise RuntimeError('approved executable changed during measurement')
    print(fingerprint.hexdigest())
finally:
    os.close(descriptor)
'''

BOOTSTRAP = '''import base64,hashlib,json,sys,types
raw=sys.stdin.buffer.read(1048577)
if len(raw)>1048576 or hashlib.sha256(raw).hexdigest()!=sys.argv.pop(1):
    raise SystemExit('current lifecycle payload differs')
packet=json.loads(raw)
names=('cauce_container_base','cauce_container_proc','cauce_container_tree','cauce_container_adoption')
if set(packet)!={'modules','entry'} or list(packet['modules'])!=list(names):
    raise SystemExit('current lifecycle modules differ')
for name in names:
    module=types.ModuleType(name)
    module.__file__='<current-lifecycle/'+name+'.py>'
    sys.modules[name]=module
    exec(compile(base64.b64decode(packet['modules'][name],validate=True),module.__file__,'exec'),module.__dict__)
exec(compile(base64.b64decode(packet['entry'],validate=True),'<current-lifecycle/entry.py>','exec'),{'__name__':'__main__'})
'''

OBSERVATION = '''import json,os,sys
from cauce_container_base import open_control_directory
from cauce_container_proc import descendants,matched_fs_credentials,read_metadata,require_current_generation,verify_adapter,verify_controller
expected=json.loads(sys.argv[1])
control=open_control_directory(expected['controlDirectory'])
try:
    document,_=read_metadata(control)
    if document is None or any(document.get(name)!=value for name,value in expected.items()):
        raise RuntimeError('previous adapter lifecycle identity differs')
    require_current_generation(document,expected['containerId'],expected['containerGeneration'])
    verify_adapter(document,expected['alias'],expected['stateDirectory'])
    verify_controller(document)
    if document['pid'] not in descendants(document['controllerPid']):
        raise RuntimeError('previous adapter controller ancestry differs')
    wanted={'CAUCE_BOOTSTRAP','CAUCE_FLEET_OPERATION_ID','CAUCE_ROOM','CAUCE_INSTANCE_ID','CAUCE_SPACE_ROOT',
        'CAUCE_RELAY_URL','CAUCE_MODEL_ID','CAUCE_REASONING_EFFORT','CAUCE_SHARED_HUMAN_IDS',
        'CAUCE_SHARED_SESSION','CAUCE_SHARED_SESSION_WORKSPACE','TMUX_TMPDIR','CAUCE_ALIAS',
        'CAUCE_RUNTIME_KEY','CAUCE_TENANT_ID','CAUCE_TENANT','CAUCE_STATE_DIR','CAUCE_CONTROL_DIR',
        'CAUCE_CONTAINER_ID','CAUCE_CONTAINER_GENERATION'}
    with matched_fs_credentials(document['runtimeUid'],document['runtimeGid']):
        raw=open('/proc/'+str(document['pid'])+'/environ','rb').read()
    environment={}
    for item in raw.split(b'\\0'):
        name,separator,value=item.partition(b'=')
        if not separator:
            continue
        name=name.decode('utf-8')
        if name in wanted:
            if name in environment:
                raise RuntimeError('previous adapter environment contains a duplicate identity variable')
            environment[name]=value.decode('utf-8')
    verify_adapter(document,expected['alias'],expected['stateDirectory'])
    verify_controller(document)
    if read_metadata(control)[0]!=document:
        raise RuntimeError('previous adapter lifecycle changed during observation')
    print(json.dumps({'metadata':document,'environment':environment}))
finally:
    os.close(control)
'''


def source(filename: str) -> bytes:
    if filename not in {name + '.py' for name in MODULES} | {'cauce-container-runtime.py'}:
        raise SafeFailure('current lifecycle source is outside its allowlist')
    for directory in (SOURCE_ROOT.parent.parent, SOURCE_ROOT.parent, SOURCE_ROOT):
        descriptor = open_absolute_directory(directory)
        try:
            details = os.fstat(descriptor)
            if details.st_uid not in {0, os.geteuid()} or details.st_mode & 0o022:
                raise SafeFailure('current lifecycle source directory ownership or mode differs')
        finally:
            os.close(descriptor)
    parent = open_absolute_directory(SOURCE_ROOT)
    try:
        descriptor = open_regular_at(parent, filename, os.O_RDONLY)
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_uid not in {0, os.geteuid()} \
                    or details.st_nlink != 1 or details.st_mode & 0o022 or details.st_size > MAX_SOURCE:
                raise SafeFailure('current lifecycle source ownership, mode or size differs')
            with os.fdopen(descriptor, 'rb', closefd=False) as stream:
                raw = stream.read(MAX_SOURCE + 1)
            after = os.fstat(descriptor)
            if len(raw) != details.st_size or (details.st_ino, details.st_size, details.st_mtime_ns, details.st_ctime_ns) \
                    != (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise SafeFailure('current lifecycle source changed during observation')
            return raw
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def current_program(*, observe: bool = False) -> tuple[str, bytes]:
    modules = {name: base64.b64encode(source(name + '.py')).decode('ascii') for name in MODULES}
    entry = OBSERVATION.encode() if observe else source('cauce-container-runtime.py')
    raw = json.dumps({'modules': modules, 'entry': base64.b64encode(entry).decode('ascii')}, separators=(',', ':')).encode()
    if len(raw) > 1048576:
        raise SafeFailure('current lifecycle sources exceed their bound')
    return hashlib.sha256(raw).hexdigest(), raw


def command(python: str, *arguments: str, observe: bool = False) -> tuple[list[str], bytes]:
    pin, raw = current_program(observe=observe)
    return [python, '-I', '-B', '-c', BOOTSTRAP, pin, *arguments], raw
