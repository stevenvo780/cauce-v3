from __future__ import annotations

import importlib
import json
import os
import pathlib
import pwd
import re
import subprocess
import sys
import time
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'ops/cli'), str(ROOT / 'ops/container-runtime'), str(ROOT / 'ops/scripts')]
container = importlib.import_module('fleet_executor_container')
approve_agent = importlib.import_module('fleet_executor_policy').approve_agent
OWNER = 'h8b-tui-v4-produccion-1025'
fleet_labels = container.expected_labels


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
    policy = {'schemaVersion': 1, 'host_id': 'zz-canary-h8b', 'executor_user': placement['systemd_user'],
              'roots': roots, 'native': [], 'containers': {request['name']: placement}, 'profiles': {}, 'hooks': {},
              'transport': {'network': 'host'}, 'bundles': {harness: {'directory': request['sdk_root'], 'shared_tui': harness != 'openclaw'}}}
    raw = {'company_id': str(uuid.uuid4()), 'tenant_id': 'Steven', 'alias': request['alias'], 'runtime_key': key,
           'host_id': policy['host_id'], 'harness_id': harness, 'container_name': request['name'],
           'runtime_mode': 'container', 'runtime_user': 'node', 'home_directory': '/home/node',
           'state_directory': state, 'systemd_user': placement['systemd_user'], 'primary_account_id': 'canary',
           'model_id': 'openai/gpt-5.5' if harness == 'openclaw' else None}
    agent = approve_agent(policy, raw)
    labels = {**container.expected_labels(policy, agent), 'cauce.e2e.owner': OWNER}
    for suffix, kind in (('state', None), ('provider-profiles', 'provider-profiles')):
        values = {**labels, **({'cauce.fleet.volume': kind} if kind else {})}
        container.docker('volume', 'create', *[part for name, value in values.items() for part in ('--label', name + '=' + value)], request['name'] + '-' + suffix)
    observed = container.ensure_container(policy, agent)
    identity = container.identity_for(agent, observed)
    uid, gid = container.user_identity(agent, identity)
    container.helper(agent, identity, 'prepare-state', '--mount', state_root, '--state', state, '--uid', uid, '--gid', gid)
    script = ('import os,pathlib,sys;root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True,mode=0o700);'
              '\nfor p in [root,*root.parents]:\n if str(p).startswith(sys.argv[2]):os.chown(p,1000,1000);os.chmod(p,0o700)')
    container.docker('exec', '--user', '0', request['name'], '/usr/bin/python3', '-I', '-B', '-c', script, profile, profile_root)
    def pin(path):
        return container.docker('exec', '--user', 'node', request['name'], '/usr/bin/sha256sum', path).decode().split()[0]
    binding = {'provider': 'codex' if harness == 'openclaw' else harness, 'runtime_user': 'node',
               'path': profile, 'identity': 'zz-canary-offline'}
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
        binding['muse'] = {'bridge': '/usr/local/bin/muse-cauce', 'bridge_sha256': pin('/usr/local/bin/muse-cauce')}
    policy['profiles']['canary'] = binding
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
    container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', base_dirs, state)
    provider_script = ('import importlib,json,sys;sys.path[:0]=["/cauce/executor","/cauce/lifecycle",sys.argv[2]+"/test-runtime/ops/scripts"];'
                       'policy,agent=json.loads(sys.argv[1]);print(json.dumps(importlib.import_module("fleet_executor_runtime").provider_base_environment(policy,agent)))')
    environment = json.loads(container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', provider_script, json.dumps([policy, agent]), bundle))
    environment.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/home/node', TERM='xterm-256color',
                       CAUCE_TENANT='Steven', CAUCE_TENANT_ID='Steven', CAUCE_ALIAS=request['alias'],
                       CAUCE_RUNTIME_KEY=key, CAUCE_ROOM=request['room'], CAUCE_INSTANCE_ID=str(uuid.uuid4()),
                       CAUCE_STATE_DIR=state, CAUCE_RELAY_URL=request['relay_url'], CAUCE_ENVIRONMENT='production',
                       CAUCE_TLS_CERT_FILE=request['cert'], CAUCE_TLS_KEY_FILE=request['key'], CAUCE_TLS_CA_FILE=request['ca'],
                       CAUCE_CONTAINER_ID=identity['container_id'], CAUCE_CONTAINER_GENERATION=identity['generation'],
                       CAUCE_BOOTSTRAP='0')
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
    container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', seed, json.dumps([dirs, files]))
    result = {'agent': raw, 'container_id': observed['Id'], 'image_id': observed['Image'], 'started_at': observed['State']['StartedAt'],
              'generation': identity['generation'], 'provider_environment_keys': sorted(environment),
              'command': environment['CAUCE_HARNESS_COMMAND'], 'files': json.loads(environment['CAUCE_HARNESS_COMMAND_FILES']),
              'native_command': binding['command'], 'state': state, 'profile': profile}
    if harness == 'openclaw':
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
        probe = ('import json,pathlib,subprocess,sys;env=json.loads(pathlib.Path(sys.argv[1]).read_text());'
                 'p=subprocess.run([sys.argv[2],"config","status"],env=env,capture_output=True,timeout=15);'
                 'print(json.dumps({"exit":p.returncode,"stdout":p.stdout.decode(errors="replace")[-4000:],"stderr":p.stderr.decode(errors="replace")[-4000:]}))')
        result['muse_config_probe'] = json.loads(container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', probe, state + '/adapter-env.json', binding['command']))
    (directory / 'binding.json').write_text(json.dumps(result))
    start = ('import json,os,pathlib,subprocess,sys;state=sys.argv[1];env=json.loads(pathlib.Path(state+"/adapter-env.json").read_text());'
             'out=open(state+"/adapter.log","w");p=subprocess.Popen(sys.argv[2:],env=env,cwd=state+"/space/projects",'
             'stdout=out,stderr=out,start_new_session=True);print(p.pid)')
    result['adapter_pid'] = int(container.docker('exec', '--user', 'node', request['name'], '/usr/bin/python3', '-I', '-B', '-c', start,
        state, '/usr/local/bin/node', bundle + '/dist/src/bin/' + harness + '.js').decode())
    return result


def discard(request: dict) -> dict:
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
        print(json.dumps(prepare(packet) if action == 'prepare' else discard(packet), sort_keys=True))
    except Exception as error:
        message = 'subprocess deadline exceeded' if isinstance(error, subprocess.TimeoutExpired) else str(error)
        message = re.sub(r'-----BEGIN [^-]+-----.*?-----END [^-]+-----', '[REDACTED synthetic PKI]', message, flags=re.S)
        print(type(error).__name__ + ': ' + message[-1600:], file=sys.stderr)
        raise SystemExit(1) from None
