import hashlib
import json
import os
import pathlib
import re
import ssl
import stat
import subprocess
import sys
import time

alias = sys.argv[1]
key = sys.argv[2]
unit = 'cauce-v3-pty@' + key + '.service'
config = pathlib.Path.home() / '.config' / 'cauce-v3'
pki = config / 'pty-pki' / key
env = config / 'pty' / (key + '.env')
units = pathlib.Path.home() / '.config' / 'systemd' / 'user'
dropin = units / (unit + '.d')
wants = units / 'default.target.wants' / unit


def command(*args):
    result = subprocess.run(args, text=True, capture_output=True, check=False)
    return {'code': result.returncode, 'value': result.stdout.strip()}


def observed(path):
    if not os.path.lexists(path):
        return None
    info = path.lstat()
    return {'uid': info.st_uid, 'gid': info.st_gid, 'mode': stat.S_IMODE(info.st_mode),
            'symlink': stat.S_ISLNK(info.st_mode)}


fingerprint = None
runtime_key = None
certificate = pki / 'client.crt'
certificate_cn = None
if certificate.is_file():
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert(certificate.read_text())).hexdigest()
    subject = command('openssl', 'x509', '-in', str(certificate), '-noout', '-subject', '-nameopt', 'RFC2253', '-ext', 'subjectAltName')
    if subject['code'] != 0:
        raise RuntimeError('the physical PTY certificate could not be observed')
    certificate_cn = subject['value'].splitlines()[0]
    identity = re.search(r'URI:urn:cauce:runtime:([a-zA-Z0-9_-]+)', subject['value'])
    runtime_key = identity.group(1) if identity else None
files = {name: observed(pki / name) for name in ('client.crt', 'client.key', 'ca.crt', 'alias-key.hex')}
main_pid = command('systemctl', '--user', 'show', unit, '--property=MainPID', '--value')
pid = int(main_pid['value']) if main_pid['value'].isdigit() else 0


def terminal_process():
    result = {'euid': os.geteuid(), 'monotonic_us': time.monotonic_ns() // 1000}
    stage = 'unit_before'
    properties = '--property=ActiveState,MainPID,InvocationID,ExecMainStartTimestampMonotonic'
    try:
        result['boot_id'] = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
        before = command('systemctl', '--user', 'show', unit, properties)
        if before['code'] != 0:
            raise RuntimeError('unit observation failed')
        result['unit_before'] = dict(line.split('=', 1) for line in before['value'].splitlines())
        expected_version = None
        if len(sys.argv) > 5 and re.fullmatch(r'[a-f0-9-]{36}', sys.argv[5]):
            stage = 'provision_record'
            effects = pathlib.Path(sys.argv[4]) / 'operations' / sys.argv[5] / 'effects.json'
            entry = json.loads(effects.read_text()).get('terminal_provision', {}).get(key, {})
            if entry.get('operation_id') != sys.argv[5] or entry.get('identity', {}).get('runtime_key') != key \
                    or entry.get('identity', {}).get('alias') != alias:
                raise ValueError('terminal journal identity differs')
            expected_version = entry.get('source_sha256')
            if not isinstance(expected_version, str) or re.fullmatch(r'[a-f0-9]{64}', expected_version) is None:
                raise ValueError('terminal journal source pin is unavailable')
        result['expected_version_available'] = expected_version is not None
        selected = result['unit_before']['MainPID']
        if selected.isdigit() and int(selected) > 0:
            stage = 'process_stat'
            process = pathlib.Path('/proc') / selected
            before_stat = (process / 'stat').read_text().rsplit(')', 1)[1].split()
            result.update(pid=int(selected), uid=process.stat().st_uid, starttime=int(before_stat[19]))
            if result['uid'] != os.geteuid():
                raise PermissionError('terminal process belongs to another user')
            stage = 'process_environment'
            entries = [row.split(b'=', 1) for row in (process / 'environ').read_bytes().split(bytes([0])) if row]
            if any(len(row) != 2 for row in entries):
                raise ValueError('terminal process environment is malformed')
            for name, wanted in (('CAUCE_PTY_AGENT_VERSION', expected_version), ('INVOCATION_ID', result['unit_before']['InvocationID'])):
                values = [value for field, value in entries if field == name.encode()]
                result[name] = {'name_count': len(values), 'matches': len(values) == 1 and wanted is not None and values[0] == wanted.encode()}
            stage = 'process_after'
            after_stat = (process / 'stat').read_text().rsplit(')', 1)[1].split()
            result['process_stable'] = before_stat[19] == after_stat[19] and after_stat[0] not in ('Z', 'X') \
                and process.stat().st_uid == result['uid']
        stage = 'unit_after'
        after = command('systemctl', '--user', 'show', unit, properties)
        if after['code'] != 0:
            raise RuntimeError('unit observation failed')
        result['unit_after'] = dict(line.split('=', 1) for line in after['value'].splitlines())
        result['unit_stable'] = result['unit_before'] == result['unit_after']
    except Exception as error:
        result['observation_error'] = {'stage': stage, 'type': type(error).__name__, 'errno': getattr(error, 'errno', None)}
    return result


metadata_script = '''import hashlib,json,os,pathlib,stat,sys
stage='control_open'
sys.excepthook=lambda kind,error,trace: print(json.dumps({'observer_error':{'stage':stage,'type':kind.__name__,'errno':getattr(error,'errno',None)}}),file=sys.stderr)
key,alias,container,generation=sys.argv[1:];metadata=None;digest=None
try:
 fd=os.open(pathlib.Path('/run/cauce-fleet')/key/'cauce-v3-adapter.json',os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW)
except FileNotFoundError: pass
else:
 try:
  stage='control_read';details=os.fstat(fd)
  if not stat.S_ISREG(details.st_mode) or details.st_size>65536: raise ValueError('invalid lifecycle metadata file')
  raw=os.read(fd,65537)
 finally: os.close(fd)
 stage='control_identity'
 if len(raw)>65536: raise ValueError('lifecycle metadata exceeds its size bound')
 d=json.loads(raw)
 if not isinstance(d,dict) or d.get('schemaVersion')!=2 or d.get('phase')!='running': raise ValueError('invalid lifecycle metadata phase')
 if d.get('alias')!=key or d.get('wireAlias')!=alias or d.get('containerId')!=container or d.get('containerGeneration')!=generation: raise ValueError('lifecycle metadata identity differs')
 if any(type(d.get(name)) is not int or d[name]<=0 for name in ('pid','starttime','runtimeUid','runtimeGid')): raise ValueError('invalid lifecycle metadata process')
 metadata={name:d[name] for name in ('pid','starttime','runtimeUid','runtimeGid','phase')};digest=hashlib.sha256(raw).hexdigest()
print(json.dumps({'metadata':metadata,'sha256':digest}))
'''
sdk_script = '''import errno,json,os,pathlib,sys
stage='process_input'
sys.excepthook=lambda kind,error,trace: print(json.dumps({'observer_error':{'stage':stage,'type':kind.__name__,'errno':getattr(error,'errno',None)}}),file=sys.stderr)
control=json.load(sys.stdin);record=control['metadata'];metadata=None;metadata_alive=False
key=sys.argv[1];normal=[];uid=os.getuid();wanted=(b'CAUCE_RUNTIME_KEY',b'CAUCE_BOOTSTRAP')
if record is not None:
 if record['runtimeUid']!=uid or record['runtimeGid']!=os.getgid() or record['phase']!='running': raise ValueError('lifecycle metadata runtime user differs')
 metadata={name:record[name] for name in ('pid','starttime')}
stage='process_list'
for base in pathlib.Path('/proc').iterdir():
 if not base.name.isdigit(): continue
 try:
  stage='process_uid'
  if base.stat().st_uid!=uid: continue
  stage='process_stat'
  before=(base/'stat').read_text().rsplit(')',1)[1].split()
  if before[0] in ('Z','X'): continue
  stage='process_environment'
  entries=[row.split(b'=',1) for row in (base/'environ').read_bytes().split(bytes([0])) if row]
  if any(len(row)!=2 for row in entries): raise ValueError('malformed process environment')
  if any(sum(row[0]==name for row in entries)>1 for name in wanted): raise ValueError('duplicate runtime process identity')
  env=dict(entries)
  if env.get(b'CAUCE_RUNTIME_KEY')!=key.encode() or env.get(b'CAUCE_BOOTSTRAP')!=b'0': continue
  stage='process_generation'
  after=(base/'stat').read_text().rsplit(')',1)[1].split()
  if before[19]!=after[19]: raise ValueError('process generation changed during observation')
  if after[0] in ('Z','X'): continue
  normal.append({'pid':int(base.name),'starttime':int(after[19])})
 except OSError as error:
  if error.errno not in (errno.ENOENT,errno.ESRCH): raise
if metadata is not None:
 try:
  stage='metadata_process'
  base=pathlib.Path('/proc')/str(metadata['pid']);raw=(base/'stat').read_text().rsplit(')',1)[1].split()
  metadata_alive=int(raw[19])==metadata['starttime'] and raw[0] not in ('Z','X')
  if metadata_alive and (base.stat().st_uid!=uid or metadata not in normal): raise ValueError('live metadata escaped the normal process observation')
 except OSError as error:
  if error.errno not in (errno.ENOENT,errno.ESRCH): raise
  metadata_alive=False
print(json.dumps({'normal_processes':normal,'normal_process_count':len(normal),'metadata':metadata,
 'metadata_alive':metadata_alive,'metadata_matches':metadata_alive and metadata in normal}))
'''


def docker(*args, stage, input_data=None):
    result = subprocess.run(['docker', *args], input=input_data, text=True, capture_output=True, check=False)
    if result.returncode != 0:
        detail = {'stage': stage, 'type': 'DockerCommandError', 'errno': None, 'exit_code': result.returncode}
        try:
            inner = json.loads(result.stderr)['observer_error'] if len(result.stderr) <= 1024 else {}
            if isinstance(inner, dict) and re.fullmatch(r'[a-z_]{1,40}', inner.get('stage', '')) \
                    and re.fullmatch(r'[A-Za-z]{1,40}', inner.get('type', '')) \
                    and (inner.get('errno') is None or type(inner['errno']) is int):
                detail.update({name: inner.get(name) for name in ('stage', 'type', 'errno')})
        except (ValueError, KeyError, TypeError):
            pass
        raise RuntimeError('the physical runtime observation failed: ' + json.dumps(detail))
    return result.stdout


containers = docker('container', 'ls', '--all', '--no-trunc', '--format', '{{.ID}}', '--filter', 'name=^/' + sys.argv[3] + '$', stage='container_list').split()
sdk_observed = {'observation': 'absent', 'container_id': None, 'normal_processes': [], 'normal_process_count': 0,
                'metadata': None, 'metadata_alive': False, 'metadata_matches': False}
if containers:
    if len(containers) != 1 or re.fullmatch(r'[a-f0-9]{64}', containers[0]) is None:
        raise RuntimeError('the physical runtime container identity is ambiguous')
    container = json.loads(docker('inspect', containers[0], stage='container_before'))[0]
    if container['Id'] != containers[0] or container['Config']['Labels'].get('cauce.fleet.runtime_key') != key \
            or container['Config']['Labels'].get('cauce.fleet.alias') != alias:
        raise RuntimeError('the physical runtime container identity differs')
    status = container['State']
    if status['Running']:
        if status['Paused'] or type(status['Pid']) is not int or status['Pid'] <= 0:
            raise RuntimeError('the physical runtime container cannot be observed running')
        generation = hashlib.sha256((containers[0] + '\0' + status['StartedAt']).encode()).hexdigest()
        metadata_args = ('exec', '--user', '0', containers[0], 'python3', '-I', '-B', '-c', metadata_script,
                         key, alias, containers[0], generation)
        control = json.loads(docker(*metadata_args, stage='control_before'))
        scanned = json.loads(docker('exec', '-i', '--user', 'cauce', containers[0], 'python3', '-I', '-B', '-c', sdk_script, key,
                                    stage='process_scan', input_data=json.dumps(control)))
        control_after = json.loads(docker(*metadata_args, stage='control_after'))
        after = json.loads(docker('inspect', containers[0], stage='container_after'))[0]['State']
        if control_after != control or any(after[field] != status[field] for field in ('Running', 'Paused', 'Pid', 'StartedAt')):
            raise RuntimeError('the physical runtime generation changed during its process scan')
        sdk_observed = {**scanned, 'observation': 'running', 'container_id': containers[0]}
    elif status['Paused'] or status['Pid'] != 0 or status['Status'] not in ('exited', 'created'):
        raise RuntimeError('the physical runtime container is neither observed running nor stopped')
    else:
        sdk_observed.update(observation='stopped', container_id=containers[0])
state = pathlib.Path(sys.argv[4])
applied_generation = None
applied_contains_runtime = False
if (state / 'applied-fleet.json').is_file():
    applied_generation = json.loads((state / 'applied-fleet.json').read_text())['generation']
    fleet = json.loads((state / 'generations' / applied_generation / 'flota.json').read_text())
    applied_contains_runtime = key in fleet.get('fleet', {})
print(json.dumps({'uid': os.getuid(), 'gid': os.getgid(), 'unit': unit, 'alias': alias, 'runtime_key': key,
                  'active': command('systemctl', '--user', 'is-active', unit),
                  'enabled': command('systemctl', '--user', 'is-enabled', unit),
                  'main_pid': pid, 'process_alive': pid > 0 and pathlib.Path('/proc', str(pid)).is_dir(),
                  'pki': observed(pki), 'env': observed(env), 'dropin': observed(dropin),
                  'wants': observed(wants), 'alias_unit': observed(units / unit), 'files': files,
                  'fingerprint': fingerprint, 'certificate_cn': certificate_cn, 'certificate_runtime_key': runtime_key, 'sdk': sdk_observed,
                  'terminal_process': terminal_process(),
                  'applied_generation': applied_generation, 'applied_contains_runtime': applied_contains_runtime}))
