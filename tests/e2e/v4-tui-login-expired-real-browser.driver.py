from __future__ import annotations

import importlib
import importlib.util
import json
import os
import pathlib
import pwd
import re
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'tests/e2e'), str(ROOT / 'ops/cli'), str(ROOT / 'ops/container-runtime'), str(ROOT / 'ops/scripts')]
spec = importlib.util.spec_from_file_location('h8b_driver', ROOT / 'tests/e2e/v4-terminal-v4-image-real-browser.driver.py')
assert spec is not None and spec.loader is not None
base = importlib.util.module_from_spec(spec)
spec.loader.exec_module(base)
base.OWNER = 'h8c-tui-login-caducado-1025'
container = base.container


def prepare(request: dict) -> dict:
    directory = pathlib.Path(request['directory'])
    roots = {name: str(directory / name) for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
    for value in roots.values():
        pathlib.Path(value).mkdir(mode=0o700)
    key, name, bundle = request['runtime_key'], request['name'], request['sdk']
    state_root, profile_root = '/home/node/.cauce', '/home/node/.local/share/cauce-v3/accounts'
    state, profile = state_root + '/' + key, profile_root + '/canary'
    placement = {'image': request['image_id'], 'runtime_user': 'node', 'home_directory': '/home/node',
                 'state_root': state_root, 'profile_root': profile_root, 'python': '/usr/bin/python3',
                 'systemd_user': pwd.getpwuid(os.geteuid()).pw_name}
    policy = {'schemaVersion': 1, 'host_id': 'zz-canary-h8c', 'executor_user': placement['systemd_user'], 'roots': roots,
              'native': [], 'containers': {name: placement}, 'profiles': {}, 'hooks': {},
              'transport': {'network': 'host'}, 'bundles': {'claude': {'directory': request['sdk_root'], 'shared_tui': True}}}
    raw = {'company_id': str(uuid.uuid4()), 'tenant_id': 'Steven', 'alias': request['alias'], 'runtime_key': key,
           'host_id': policy['host_id'], 'harness_id': 'claude', 'container_name': name, 'runtime_mode': 'container',
           'runtime_user': 'node', 'home_directory': '/home/node', 'state_directory': state,
           'systemd_user': placement['systemd_user'], 'primary_account_id': 'canary'}
    agent = base.approve_agent(policy, raw)
    labels = container.expected_labels(policy, agent)
    for suffix, kind in (('state', None), ('provider-profiles', 'provider-profiles')):
        values = {**labels, **({'cauce.fleet.volume': kind} if kind else {})}
        container.docker('volume', 'create', *[part for k, value in values.items() for part in ('--label', k + '=' + value)], name + '-' + suffix)
    observed = container.ensure_container(policy, agent)
    identity = container.identity_for(agent, observed)
    uid, gid = container.user_identity(agent, identity)
    container.helper(agent, identity, 'prepare-state', '--mount', state_root, '--state', state, '--uid', uid, '--gid', gid)
    script = ('import os,pathlib,sys;root=pathlib.Path(sys.argv[1]);root.mkdir(parents=True,exist_ok=True,mode=0o700);'
              '\nfor p in [root,*root.parents]:\n if str(p).startswith(sys.argv[2]):os.chown(p,1000,1000);os.chmod(p,0o700)')
    container.docker('exec', '--user', '0', name, 'python3', '-I', '-B', '-c', script, profile, profile_root)
    command = bundle + '/test-runtime/claude'
    def pin(path):
        return container.docker('exec', '--user', 'node', name, 'sha256sum', path).decode().split()[0]
    interpreter = container.docker('exec', '--user', 'node', name, 'readlink', '-f', '/usr/bin/python3').decode().strip()
    files = {command: pin(command), interpreter: pin(interpreter)}
    policy['profiles']['canary'] = {'provider': 'claude', 'runtime_user': 'node', 'path': profile,
        'identity': 'zz-canary-offline-double', 'command': command, 'command_sha256': files[command], 'command_files': files}
    inventory = importlib.import_module('fleet_runtime_materialization')
    row = {'enabled': True, 'tenant': 'Steven', 'room': request['room'], 'alias': request['alias'], 'container': name,
           'user': 'node', 'home': '/home/node', 'runtimeStateDirectory': state, 'harness': 'claude', 'role': 'agent'}
    overlay = {key: {'systemdUser': placement['systemd_user']}}
    snapshot = {'schemaVersion': 1, 'fleet': {key: row}, 'placement': overlay}
    entry = importlib.import_module('fleet_derive').alias_entry(key, row, overlay[key])
    artifacts = {'flota.json': json.dumps(snapshot).encode(), 'container-aliases.json': json.dumps({
        'schemaVersion': 2, 'systemPrincipals': {}, 'historicalAliases': {}, 'aliases': {key: entry}}).encode(),
        'generated/fleet.json': b'{}', 'schemas/alias-manifest.schema.json': (ROOT / 'ops/schemas/alias-manifest.schema.json').read_bytes()}
    receipt = inventory._receipt(artifacts)
    inventory._publish_generation(directory / 'inventory', receipt, artifacts)
    for label in ('applied', 'desired'):
        (directory / ('inventory/' + label + '-fleet.json')).write_text(json.dumps(receipt))
    policy['roots']['state'] = str(directory / 'inventory')
    policy['transport']['gateway_url'] = request['relay_url'].replace('wss:', 'https:').removesuffix('/v3/ws')
    environment = importlib.import_module('fleet_executor_runtime').provider_base_environment(policy, agent)
    environment.update(PATH='/usr/local/bin:/usr/bin:/bin', HOME='/home/node', TERM='xterm-256color',
        CAUCE_TENANT='Steven', CAUCE_TENANT_ID='Steven', CAUCE_ALIAS=request['alias'], CAUCE_RUNTIME_KEY=key,
        CAUCE_ROOM=request['room'], CAUCE_STATE_DIR=state, CAUCE_ENVIRONMENT='production',
        CAUCE_CONTAINER_ID=identity['container_id'], CAUCE_CONTAINER_GENERATION=identity['generation'], CAUCE_BOOTSTRAP='0')
    environment['CAUCE_OWNER_HUMAN_ID'] = str(uuid.UUID(request['owner_human_id']))
    environment.update(importlib.import_module('fleet_executor_runtime').sdk_environment(policy, agent, False, None))
    contents = {profile + '/double-mode': 'expired'}
    for field, variable in (('cert', 'CAUCE_TLS_CERT_FILE'), ('key', 'CAUCE_TLS_KEY_FILE'), ('ca', 'CAUCE_TLS_CA_FILE')):
        target = state + '/pki/' + field
        contents[target] = pathlib.Path(request[field]).read_text()
        environment[variable] = target
    contents[state + '/adapter-env.json'] = json.dumps(environment)
    dirs = [profile, state + '/pki', state + '/space/projects', state + '/space/tmp', state + '/space/config']
    seed = ('import json,os,pathlib,sys;dirs,files=json.loads(sys.argv[1]);'
        '\nfor p in dirs:pathlib.Path(p).mkdir(parents=True,exist_ok=True,mode=0o700);os.chmod(p,0o700)'
        '\nfor name,body in files.items():p=pathlib.Path(name);p.write_text(body);p.chmod(0o600)')
    container.docker('exec', '--user', 'node', name, 'python3', '-I', '-B', '-c', seed, json.dumps([dirs, contents]))
    start = ('import json,pathlib,subprocess,sys;state=sys.argv[1];env=json.loads(pathlib.Path(state+"/adapter-env.json").read_text());'
        'out=open(state+"/adapter.log","w");p=subprocess.Popen(sys.argv[2:],env=env,cwd=state+"/space/projects",stdout=out,stderr=out,start_new_session=True);print(p.pid)')
    pid = int(container.docker('exec', '--user', 'node', name, 'python3', '-I', '-B', '-c', start,
        state, '/usr/local/bin/node', bundle + '/dist/src/bin/claude.js').decode())
    return {'agent': raw, 'container_id': observed['Id'], 'image_id': observed['Image'], 'started_at': observed['State']['StartedAt'],
            'generation': identity['generation'], 'state': state, 'profile': profile, 'adapter_pid': pid,
            'command': command, 'native_command': command, 'files': files, 'tui_double': True,
            'owner_human_id': request['owner_human_id']}


if __name__ == '__main__':
    packet = json.loads(pathlib.Path(sys.argv[2]).read_text())
    try:
        print(json.dumps(prepare(packet) if sys.argv[1] == 'prepare' else base.discard(packet)))
    except Exception as error:
        message = re.sub(r'-----BEGIN [^-]+-----.*?-----END [^-]+-----', '[synthetic PKI omitted]', str(error), flags=re.S)
        print(type(error).__name__ + ': ' + message[-1200:], file=sys.stderr)
        raise SystemExit(1) from None
