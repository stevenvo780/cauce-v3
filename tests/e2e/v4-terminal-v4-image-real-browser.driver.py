from __future__ import annotations

import datetime
import hashlib
import importlib
import inspect
import json
import os
import pathlib
import pwd
import re
import subprocess
import sys
import threading
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'ops/cli'), str(ROOT / 'ops/container-runtime'), str(ROOT / 'ops/scripts')]
container = importlib.import_module('fleet_executor_container')
approve_agent = importlib.import_module('fleet_executor_policy').approve_agent
OWNER = 'h8b-tui-v4-produccion-1025'
fleet_labels = container.expected_labels
PHASE = 'initialization'
TRACE = None


def phase(name: str) -> None:
    global PHASE
    PHASE = name


def public_text(raw) -> str:
    text = raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw or '')
    text = re.sub(r'-----BEGIN [^-]+-----.*?-----END [^-]+-----', '[REDACTED PEM]', text, flags=re.S)
    text = re.sub(r'(?i)(bearer\s+|(?:token|password|api[_-]?key|secret)["\s]*[:=]["\s]*)[^\s,}\"]+', r'\1[REDACTED]', text)
    text = re.sub(r'(https?://[^\s?#]+)[?#][^\s]+', r'\1[REDACTED query]', text)
    if re.search(r'(?i)device.?code|user.?code|paste code|approve in your browser', text):
        return '[authorization interaction omitted]'
    try:
        def scrub(value):
            if isinstance(value, dict):
                return {key: '[REDACTED field]' if re.search(r'(?i)^(env|environment|body|input|payload)$|password|token|secret|api_key', key)
                        else scrub(item) for key, item in value.items()}
            return [scrub(item) for item in value] if isinstance(value, list) else value
        text = json.dumps(scrub(json.loads(text)))
    except (ValueError, TypeError):
        pass
    return text[-8000:]


def public_output(raw) -> str:
    if PHASE == 'provider-environment':
        return f'[environment output omitted; bytes={len(raw or b"")}]'
    return public_text(raw)


def public_command(command) -> list[str]:
    result = []
    hide_next = False
    for raw in command:
        value = str(raw)
        if hide_next:
            result.append('[REDACTED argument]')
            hide_next = False
            continue
        if value.startswith(('--env=', '-e=')):
            result.append(value.split('=', 1)[0] + '=[REDACTED argument]')
            continue
        if value in ('--env', '-e', '--token', '--password', '--api-key', '--authorization'):
            result.append(value)
            hide_next = True
            continue
        if not value.lstrip().startswith(('{', '[')):
            result.append(public_text(value))
            continue
        try:
            json.loads(value)
            result.append(f'[JSON argument bytes={len(value.encode())} sha256={hashlib.sha256(value.encode()).hexdigest()}]')
        except (ValueError, TypeError):
            result.append(public_text(value))
    return result


def record(event: dict) -> None:
    if TRACE is not None:
        with TRACE.open('a') as stream:
            stream.write(json.dumps({'at': datetime.datetime.now(datetime.UTC).isoformat(), 'phase': PHASE, **event}) + '\n')
            stream.flush()
            os.fsync(stream.fileno())


def module_sources() -> dict:
    result = {}
    for module in list(sys.modules.values()):
        filename = getattr(module, '__file__', None)
        if filename:
            path = pathlib.Path(filename).resolve()
            if path.is_relative_to(ROOT / 'ops') and path.suffix == '.py':
                result[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def vm_sample() -> dict:
    result = {}
    for name in ('stat', 'loadavg', 'meminfo', 'pressure/cpu', 'pressure/memory', 'pressure/io'):
        try:
            lines = pathlib.Path('/proc', name).read_text().splitlines()
            if name == 'stat':
                lines = lines[:1]
            if name == 'meminfo':
                lines = [line for line in lines if line.split(':')[0] in ('MemTotal', 'MemAvailable', 'Dirty', 'Writeback', 'SwapFree')]
            result[name] = lines
        except OSError as error:
            result[name] = {'error_type': type(error).__name__}
    return result


class TracedSubprocess:
    def __getattr__(self, name):
        return getattr(subprocess, name)

    def run(self, command, **options):
        callsites = []
        for frame in inspect.stack(context=0)[1:]:
            path = pathlib.Path(frame.filename)
            if path.is_relative_to(ROOT):
                callsites.append({'file': str(path.relative_to(ROOT)), 'line': frame.lineno, 'function': frame.function})
        started = time.monotonic()
        event = {'operation_id': str(uuid.uuid4()), 'command': public_command(command), 'callsites': callsites[:8],
                 'timeout_seconds': options.get('timeout'), 'stdin_present': options.get('input') is not None}
        record({**event, 'state': 'started', 'vm': vm_sample()})
        try:
            result = subprocess.run(command, **options)
        except subprocess.TimeoutExpired as error:
            record({**event, 'state': 'timed_out', 'elapsed_ms': (time.monotonic() - started) * 1000,
                    'stdout': public_output(error.stdout), 'stderr': public_text(error.stderr), 'vm': vm_sample()})
            raise
        except Exception as error:
            record({**event, 'state': 'failed', 'elapsed_ms': (time.monotonic() - started) * 1000,
                    'error_type': type(error).__name__, 'vm': vm_sample()})
            raise
        record({**event, 'state': 'finished', 'elapsed_ms': (time.monotonic() - started) * 1000,
                'exit_code': result.returncode, 'stdout_bytes': len(result.stdout or b''), 'stderr_bytes': len(result.stderr or b''),
                'stdout': public_output(result.stdout), 'stderr': public_text(result.stderr), 'vm': vm_sample()})
        return result


def configure(request: dict, action: str) -> None:
    global OWNER, TRACE
    OWNER = request.get('owner', OWNER)
    if OWNER not in ('h8b-tui-v4-produccion-1025', 'h8d-regresion-tui-1025', 'h8f-tiempos-muse-grok-1025'):
        raise ValueError('canary owner is not supported by this driver')
    if request.get('diagnostics'):
        directory = pathlib.Path(request['evidence']).resolve()
        if directory.parent != ROOT / '.delegados/v4/recibos' / OWNER or str(uuid.UUID(directory.name)) != directory.name:
            raise ValueError('diagnostic receipt namespace differs')
        TRACE = directory / (request['harness'] + '-driver-' + action + '.jsonl')
        container.subprocess = TracedSubprocess()
        record({'state': 'driver_started', 'action': action, 'pid': os.getpid(), 'loaded_module_sources': module_sources()})


def owned_labels(policy: dict, agent: dict) -> dict:
    return {**fleet_labels(policy, agent), 'cauce.e2e.owner': OWNER}


container.expected_labels = owned_labels


def prepare(request: dict) -> dict:
    directory = pathlib.Path(request['directory'])
    roots = {name: str(directory / name) for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
    for value in roots.values():
        pathlib.Path(value).mkdir(mode=0o700)
    harness, key = request['harness'], request['runtime_key']
    state_root = '/home/node/.cauce'
    profile_root = '/home/node/.local/share/cauce-v3/accounts'
    state, profile = state_root + '/' + key, profile_root + '/canary'
    placement = {'image': request['image_id'], 'runtime_user': 'node', 'home_directory': '/home/node',
                 'state_root': state_root, 'profile_root': profile_root, 'python': '/usr/bin/python3',
                 'systemd_user': pwd.getpwuid(os.geteuid()).pw_name}
    bundle = request['sdk']
    policy = {'schemaVersion': 1, 'host_id': 'zz-canary-' + OWNER.split('-')[0], 'executor_user': placement['systemd_user'],
              'roots': roots, 'native': [], 'containers': {request['name']: placement}, 'profiles': {}, 'hooks': {},
              'transport': {'network': 'host'}, 'bundles': {harness: {'directory': request['sdk_root'], 'shared_tui': harness != 'openclaw'}}}
    raw = {'company_id': str(uuid.uuid4()), 'tenant_id': 'Steven', 'alias': request['alias'], 'runtime_key': key,
           'host_id': policy['host_id'], 'harness_id': harness, 'container_name': request['name'],
           'runtime_mode': 'container', 'runtime_user': 'node', 'home_directory': '/home/node',
           'state_directory': state, 'systemd_user': placement['systemd_user'], 'primary_account_id': 'canary',
           'model_id': 'openai/gpt-5.5' if harness == 'openclaw' else None}
    agent = approve_agent(policy, raw)
    phase('create-volumes')
    labels = {**container.expected_labels(policy, agent), 'cauce.e2e.owner': OWNER}
    for suffix, kind in (('state', None), ('provider-profiles', 'provider-profiles')):
        values = {**labels, **({'cauce.fleet.volume': kind} if kind else {})}
        container.docker('volume', 'create', *[part for name, value in values.items() for part in ('--label', name + '=' + value)], request['name'] + '-' + suffix)
    phase('ensure-container')
    observed = container.ensure_container(policy, agent)
    phase('container-identity')
    identity = container.identity_for(agent, observed)
    phase('user-identity')
    uid, gid = container.user_identity(agent, identity)
    phase('prepare-state')
    container.helper(agent, identity, 'prepare-state', '--mount', state_root, '--state', state, '--uid', uid, '--gid', gid)
    script = ('import os,pathlib,sys;root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True,mode=0o700);'
              '\nfor p in [root,*root.parents]:\n if str(p).startswith(sys.argv[2]):os.chown(p,1000,1000);os.chmod(p,0o700)')
    phase('profile-permissions')
    container.docker('exec', '--user', '0', request['name'], '/usr/bin/python3', '-I', '-B', '-c', script, profile, profile_root)
    if TRACE is not None:
        fields = ('NanoCpus', 'CpuQuota', 'CpuPeriod', 'CpuShares', 'CpusetCpus', 'Memory', 'MemorySwap', 'BlkioWeight',
                  'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps', 'PidsLimit')
        record({'state': 'pin_container_limits', 'container_id': observed['Id'],
                'limits': {key: observed['HostConfig'].get(key) for key in fields}})
    def sample_pin(path, when):
        if TRACE is None:
            return
        sample = ('import json,os,pathlib,sys;out={"file_bytes":pathlib.Path(sys.argv[1]).stat().st_size,"clock_ticks":os.sysconf("SC_CLK_TCK")};'
                  '\nfor name in ["cpu.stat","cpu.max","io.stat","memory.max","pids.current","pids.events"]:\n'
                  ' try:out[name]=pathlib.Path("/sys/fs/cgroup",name).read_text()\n'
                  ' except OSError as e:out[name]={"error_type":type(e).__name__}\n'
                  'out["hash_processes"]=[]\n'
                  'for proc in pathlib.Path("/proc").iterdir():\n'
                  ' try:\n'
                  '  if not proc.name.isdigit() or (proc/"comm").read_text().strip()!="sha256sum":continue\n'
                  '  fields=(proc/"stat").read_text().split();row={"pid":int(proc.name),"state":fields[2],'
                  '"user_ticks":int(fields[13]),"system_ticks":int(fields[14]),"io":(proc/"io").read_text(),'
                  '"wchan":(proc/"wchan").read_text(),"fds":{}}\n'
                  '  try:row["syscall_number"]=(proc/"syscall").read_text().split()[0]\n'
                  '  except OSError as e:row["syscall_error"]=type(e).__name__\n'
                  '  for fd in (proc/"fd").iterdir():\n'
                  '   target=os.readlink(fd);row["fds"][fd.name]=target if target==sys.argv[1] or target.startswith(("socket:","pipe:","anon_inode:")) else "[other descriptor]"\n'
                  '  out["hash_processes"].append(row)\n'
                  ' except OSError:pass\n'
                  'print(json.dumps(out))')
        try:
            values = json.loads(container.checked_command([container.DOCKER, 'exec', '--user', 'node', request['name'],
                '/usr/bin/python3', '-I', '-B', '-c', sample, path], timeout=5))
            record({'state': 'pin_metrics', 'when': when, 'path': path, 'metrics': values})
            return values
        except Exception as error:
            record({'state': 'pin_metrics_failed', 'when': when, 'path': path, 'error_type': type(error).__name__})
    def pin(path):
        sample_pin(path, 'before')
        if TRACE is not None and OWNER == 'h8f-tiempos-muse-grok-1025' and path == '/usr/local/bin/muse':
            checkpoint = state + '/cauce-h8f-hash-' + uuid.uuid4().hex + '.json'
            script = (ROOT / 'tests/e2e/v4-terminal-v4-image-real-browser.hash.py').read_text()
            expected = 'decefc0fb33c48ee43419c3e72ac2dbc781743868611074c7292807f5960dfcf'
            started = time.monotonic()
            try:
                output = container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c',
                    script, '--path', path, '--mode', 'gnu', '--timeout', '40', '--expected-sha256', expected,
                    '--output-json', checkpoint)
                result = json.loads(output)
                if not result.get('benchmark_accepted'):
                    raise ValueError('native hash measurement did not complete within its original deadline')
                return result['result']['digest']
            finally:
                outer_elapsed_ms = (time.monotonic() - started) * 1000
                collect = ('import json,os,pathlib,stat,sys;p=pathlib.Path(sys.argv[1]);s=p.lstat();'
                           'assert stat.S_ISREG(s.st_mode) and s.st_uid==os.geteuid() and s.st_nlink==1 and s.st_size<=131072;'
                           'out=p.read_text();p.unlink();print(out)')
                try:
                    saved = json.loads(container.checked_command([container.DOCKER, 'exec', '--user', 'node', request['name'],
                        '/usr/bin/python3', '-I', '-B', '-c', collect, checkpoint], timeout=5))
                    record({'state': 'native_hash_child_measurement', 'path': path,
                            'outer_elapsed_ms': outer_elapsed_ms, 'measurement': saved})
                except Exception as error:
                    record({'state': 'native_hash_child_measurement_unavailable', 'path': path,
                            'error_type': type(error).__name__})
                sample_pin(path, 'after')
        timer = threading.Timer(3, sample_pin, args=(path, 'during')) if TRACE is not None else None
        if timer:
            timer.start()
        try:
            return container.docker('exec', '--user', 'node', request['name'], '/usr/bin/sha256sum', path).decode().split()[0]
        finally:
            if timer:
                timer.cancel()
                timer.join()
            sample_pin(path, 'after')
    binding = {'provider': 'codex' if harness == 'openclaw' else harness, 'runtime_user': 'node',
               'path': profile, 'identity': 'zz-canary-offline'}
    phase('pin-native-command')
    if harness == 'openclaw':
        dist = '/usr/local/lib/node_modules/openclaw/dist'
        command = dist + '/index.js'
        auth_list = dist + '/auth-list-DlV7Wk-6.js'
        bridge = bundle + '/dist/bridge/openclaw-stdin-bridge.mjs'
        binding['openclaw'] = {'provider_id': 'openai', 'method_id': 'oauth', 'version': '2026.7.1-2',
                              'auth_list_source': auth_list, 'auth_list_sha256': pin(auth_list),
                              'node_command': '/usr/local/bin/node', 'node_command_sha256': pin('/usr/local/bin/node'),
                              'bridge': bridge, 'bridge_sha256': pin(bridge)}
    else:
        command = container.docker('exec', '--user', 'node', request['name'], 'readlink', '-f', '/usr/local/bin/' + harness).decode().strip()
    binding.update(command=command, command_sha256=pin(command))
    if harness == 'muse':
        phase('pin-muse-bridge')
        binding['muse'] = {'bridge': '/usr/local/bin/muse-cauce', 'bridge_sha256': pin('/usr/local/bin/muse-cauce')}
    policy['profiles']['canary'] = binding
    phase('materialize-runtime')
    inventory = importlib.import_module('fleet_runtime_materialization')
    row = {'enabled': True, 'tenant': 'Steven', 'room': request['room'], 'alias': request['alias'],
           'container': request['name'], 'user': 'node', 'home': '/home/node', 'runtimeStateDirectory': state,
           'harness': harness, 'role': 'agent', **({'modelId': raw['model_id']} if raw['model_id'] else {})}
    overlay = {key: {'systemdUser': placement['systemd_user']}}
    snapshot = {'schemaVersion': 1, 'fleet': {key: row}, 'placement': overlay}
    entry = importlib.import_module('fleet_derive').alias_entry(key, row, overlay[key])
    artifacts = {'flota.json': json.dumps(snapshot).encode(),
                 'container-aliases.json': json.dumps({'schemaVersion': 2, 'systemPrincipals': {}, 'historicalAliases': {}, 'aliases': {key: entry}}).encode(),
                 'generated/fleet.json': b'{}', 'schemas/alias-manifest.schema.json': (ROOT / 'ops/schemas/alias-manifest.schema.json').read_bytes()}
    receipt = inventory._receipt(artifacts)
    inventory._publish_generation(directory / 'inventory', receipt, artifacts)
    (directory / 'inventory/applied-fleet.json').write_text(json.dumps(receipt))
    (directory / 'inventory/desired-fleet.json').write_text(json.dumps(receipt))
    policy['roots']['state'] = str(directory / 'inventory')
    policy['transport']['gateway_url'] = request['relay_url'].replace('wss:', 'https:').removesuffix('/v3/ws')
    base_dirs = ('import pathlib,sys;root=pathlib.Path(sys.argv[1]);'
                 '[(p.mkdir(parents=True,exist_ok=True,mode=0o700),p.chmod(0o700)) for p in [root/"space",root/"space/tmp"]]')
    phase('space-directories')
    container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', base_dirs, state)
    provider_script = ('import importlib,json,sys;sys.path[:0]=["/cauce/executor","/cauce/lifecycle",sys.argv[2]+"/test-runtime/ops/scripts"];'
                       'policy,agent=json.loads(sys.argv[1]);print(json.dumps(importlib.import_module("fleet_executor_runtime").provider_base_environment(policy,agent)))')
    phase('provider-environment')
    environment = json.loads(container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', provider_script, json.dumps([policy, agent]), bundle))
    environment.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/home/node', TERM='xterm-256color',
                       CAUCE_TENANT='Steven', CAUCE_TENANT_ID='Steven', CAUCE_ALIAS=request['alias'],
                       CAUCE_RUNTIME_KEY=key, CAUCE_ROOM=request['room'], CAUCE_INSTANCE_ID=str(uuid.uuid4()),
                       CAUCE_STATE_DIR=state, CAUCE_RELAY_URL=request['relay_url'], CAUCE_ENVIRONMENT='production',
                       CAUCE_TLS_CERT_FILE=request['cert'], CAUCE_TLS_KEY_FILE=request['key'], CAUCE_TLS_CA_FILE=request['ca'],
                       CAUCE_CONTAINER_ID=identity['container_id'], CAUCE_CONTAINER_GENERATION=identity['generation'],
                       CAUCE_BOOTSTRAP='0')
    phase('sdk-environment')
    environment.update(importlib.import_module('fleet_executor_runtime').sdk_environment(policy, agent, False, None))
    dirs = [profile + '/config', profile + '/data', profile + '/tmp/node-compile-cache', profile + '/.external-cli-disabled',
            state + '/space/projects', state + '/space/tmp', state + '/space/config']
    files = {}
    dirs += [state + '/pki']
    for field, variable in (('cert', 'CAUCE_TLS_CERT_FILE'), ('key', 'CAUCE_TLS_KEY_FILE'), ('ca', 'CAUCE_TLS_CA_FILE')):
        target = state + '/pki/' + field
        files[target] = pathlib.Path(request[field]).read_text()
        environment[variable] = target
    if harness == 'muse':
        dirs += [profile + '/config/muse']
        files[profile + '/config/muse/settings.json'] = json.dumps({'schema_version': 1, 'provider': 'echo'})
    if harness == 'grok':
        files[profile + '/config.toml'] = ('[auth]\npreferred_method="api_key"\n[model.canary]\nmodel="canary"\n'
            'base_url="http://127.0.0.1:9/v1"\napi_key="zz-canary-not-a-real-key"\n[models]\ndefault="canary"\n'
            '[endpoints]\nxai_api_base_url="http://127.0.0.1:9/v1"\nmodels_base_url="http://127.0.0.1:9"\n')
    if harness == 'openclaw':
        sessions = profile + '/agents/' + key + '/sessions'
        dirs += [profile + '/agents/' + key + '/agent', sessions]
        native = str(uuid.uuid4())
        transcript = sessions + '/' + native + '.jsonl'
        files[state + '/sessions.json'] = json.dumps({'version': 1, 'sessions': {
            'openclaw:' + request['alias'] + ':shared:' + request['alias']: {'native_id': 'agent:' + key + ':canary', 'initialized': True}}})
        files[sessions + '/sessions.json'] = json.dumps({'agent:' + key + ':canary': {
            'sessionId': native, 'updatedAt': int(time.time() * 1000), 'sessionFile': transcript, 'thinkingLevel': 'medium'}})
        stamp = '2026-10-25T00:00:00.000Z'
        files[transcript] = '\n'.join(json.dumps(row) for row in [
            {'type': 'session', 'version': 3, 'id': native, 'timestamp': stamp, 'cwd': state + '/space/projects'},
            {'type': 'message', 'id': 'canary-history', 'parentId': None, 'timestamp': stamp,
             'message': {'role': 'user', 'content': [{'type': 'text', 'text': 'CAUCE-CANARY-EXISTING-HISTORY'}], 'timestamp': int(time.time() * 1000)}}]) + '\n'
        files[profile + '/openclaw.json'] = '{}'
    files[state + '/adapter-env.json'] = json.dumps(environment)
    seed = ('import json,os,pathlib,sys;dirs,files=json.loads(sys.argv[1]);'
            '\nfor p in dirs:pathlib.Path(p).mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(p,0o700)'
            '\nfor name,body in files.items():p=pathlib.Path(name);p.write_text(body);p.chmod(0o600)')
    phase('seed-profile-and-pki')
    container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', seed, json.dumps([dirs, files]))
    result = {'agent': raw, 'container_id': observed['Id'], 'image_id': observed['Image'], 'started_at': observed['State']['StartedAt'],
              'generation': identity['generation'], 'provider_environment_keys': sorted(environment),
              'command': environment['CAUCE_HARNESS_COMMAND'], 'files': json.loads(environment['CAUCE_HARNESS_COMMAND_FILES']),
              'native_command': binding['command'], 'state': state, 'profile': profile}
    if harness == 'openclaw':
        phase('openclaw-help-probe')
        probe = ('import json,pathlib,subprocess,sys;env=json.loads(pathlib.Path(sys.argv[1]).read_text());out={};'
                 '\nfor label,values in [("legacy",{"PATH":env["PATH"],"HOME":env["HOME"]}),("measured",env)]:\n'
                 ' try:\n'
                 '  p=subprocess.run(["/usr/local/bin/node",sys.argv[2],"tui","--help"],env=values,capture_output=True,timeout=15);'
                 'text=p.stdout.decode(errors="replace");err=p.stderr.decode(errors="replace");'
                 'out[label]={"exit":p.returncode,"session_flag":"--session" in text,"history_limit_flag":"--history-limit" in text,"local_flag":"--local" in text,"read_only_error":"EROFS" in err or "read-only" in err.lower()}\n'
                 ' except subprocess.TimeoutExpired:out[label]={"timeout":True}\n'
                 'print(json.dumps(out))')
        result['openclaw_help'] = json.loads(container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', probe, state + '/adapter-env.json', binding['command']))
    if harness == 'muse':
        phase('muse-config-status-probe')
        probe = ('import json,pathlib,subprocess,sys;env=json.loads(pathlib.Path(sys.argv[1]).read_text());'
                 'p=subprocess.run([sys.argv[2],"config","status"],env=env,capture_output=True,timeout=15);'
                 'print(json.dumps({"exit":p.returncode,"stdout":p.stdout.decode(errors="replace")[-4000:],"stderr":p.stderr.decode(errors="replace")[-4000:]}))')
        result['muse_config_probe'] = json.loads(container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', probe, state + '/adapter-env.json', binding['command']))
    (directory / 'binding.json').write_text(json.dumps(result))
    start = ('import json,os,pathlib,subprocess,sys;state=sys.argv[1];env=json.loads(pathlib.Path(state+"/adapter-env.json").read_text());'
             'out=open(state+"/adapter.log","w");p=subprocess.Popen(sys.argv[2:],env=env,cwd=state+"/space/projects",'
             'stdout=out,stderr=out,start_new_session=True);print(p.pid)')
    phase('start-adapter-sdk')
    result['adapter_pid'] = int(container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', start,
        state, '/usr/local/bin/node', bundle + '/dist/src/bin/' + harness + '.js').decode())
    return result


def discard(request: dict) -> dict:
    phase('cleanup-runtime')
    name = request['name']
    if not name.startswith('zz-canary-' + OWNER + '-'):
        raise ValueError('canary namespace differs')
    observed = container.inspect_container(name)
    if observed:
        if observed['Config']['Labels'].get('cauce.e2e.owner') != OWNER:
            raise ValueError('canary owner differs')
        container.docker('rm', '-f', observed['Id'])
    for suffix in ('state', 'provider-profiles'):
        volume = name + '-' + suffix
        existing = container.docker('volume', 'ls', '--format', '{{.Name}}').decode().splitlines()
        if volume in existing:
            labels = json.loads(container.docker('volume', 'inspect', volume))[0]['Labels']
            if labels.get('cauce.e2e.owner') != OWNER:
                raise ValueError('canary volume owner differs')
            container.docker('volume', 'rm', volume)
        if container.docker('volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}').strip():
            raise ValueError('canary volume remains')
    if container.inspect_container(name):
        raise ValueError('canary container remains')
    return {'container': name, 'container_id': observed['Id'] if observed else None, 'all_absent': True}


if __name__ == '__main__':
    packet = json.loads(pathlib.Path(sys.argv[2]).read_text())
    try:
        action = sys.argv[1]
        configure(packet, action)
        result = prepare(packet) if action == 'prepare' else discard(packet)
        record({'state': 'driver_finished', 'action': action, 'loaded_module_sources': module_sources()})
        print(json.dumps(result, sort_keys=True))
    except Exception as error:
        record({'state': 'driver_failed', 'error_type': type(error).__name__, 'loaded_module_sources': module_sources()})
        message = f'phase={PHASE}; timeout={error.timeout}; command={json.dumps(public_command(error.cmd))}' if isinstance(error, subprocess.TimeoutExpired) else public_text(error)
        print(type(error).__name__ + ': ' + message[-8000:], file=sys.stderr)
        raise SystemExit(1) from None
