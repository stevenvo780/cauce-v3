from __future__ import annotations

import hashlib
import importlib
import json
import os
import pathlib
import pwd
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT / 'ops/cli'), str(ROOT / 'ops/container-runtime')]

container = importlib.import_module('fleet_executor_container')
bundle_digest = importlib.import_module('cauce_container_base').bundle_digest
approve_agent = importlib.import_module('fleet_executor_policy').approve_agent
load_policy = importlib.import_module('fleet_executor_policy').load_policy

OWNER = 'b1-copia-imagen-1025'


def observed(policy: dict, raw: dict) -> dict:
    current = container.inspect_container(raw['container_name'])
    if current is None:
        raise RuntimeError('canary container disappeared')
    expected = container.expected_labels(policy, approve_agent(policy, raw))
    labels = current['Config']['Labels']
    if labels.get('cauce.e2e.owner') != OWNER or any(labels.get(key) != value for key, value in expected.items()):
        raise RuntimeError('canary ownership changed')
    return {'id': current['Id'], 'image': current['Image'], 'configured_image': current['Config']['Image'], 'started_at': current['State']['StartedAt'],
            'running': current['State']['Running'], 'pids_limit': current['HostConfig']['PidsLimit'],
            'release_mount': next(row['Source'] for row in current['Mounts'] if row['Destination'] == '/cauce/executor')}


def content_script() -> str:
    return ('import hashlib,json,pathlib,sys;root=pathlib.Path(sys.argv[1]);'
            'print(json.dumps({str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() '
            'for p in sorted(root.rglob("*")) if p.is_file()}))')


def inventory(raw: dict) -> dict:
    return json.loads(container.docker('exec', '-w', '/', '--user', raw['runtime_user'], raw['container_name'],
        '/usr/local/bin/python3', '-I', '-B', '-c', content_script(), raw['state_directory'] + '/space'))


def release_pair(directory: pathlib.Path, request: dict) -> tuple[pathlib.Path, pathlib.Path, dict]:
    versions = []
    source = {}
    for tree in ('ops/cli', 'ops/container-runtime', 'ops/scripts', 'ops/schemas'):
        for path in sorted((ROOT / tree).rglob('*')):
            if path.is_file() and '__pycache__' not in path.parts and path.suffix != '.pyc':
                source[str(path.relative_to(ROOT))] = hashlib.sha256(path.read_bytes()).hexdigest()
    fingerprint = hashlib.sha256(json.dumps(source, sort_keys=True).encode()).hexdigest()
    for image in (request['old_image'], request['new_image']):
        root = directory / 'releases' / hashlib.sha256((fingerprint + image).encode()).hexdigest()
        for tree in ('ops/cli', 'ops/container-runtime', 'ops/scripts', 'ops/schemas'):
            shutil.copytree(ROOT / tree, root / tree, ignore=shutil.ignore_patterns('__pycache__', '*.pyc'))
        for path in root.rglob('*'):
            path.chmod(0o755 if path.is_dir() or path.stat().st_mode & 0o111 else 0o644)
        versions.append(root)
    return versions[0], versions[1], source


def prepare(request: dict) -> dict:
    directory = pathlib.Path(request['directory'])
    directory.chmod(0o755)
    (directory / 'canary.json').write_text(json.dumps({'name': request['container_name']}))
    roots = {name: str(directory / name) for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
    for value in roots.values():
        pathlib.Path(value).mkdir(mode=0o700)
    previous_release, current_release, release_source = ROOT, ROOT, {}
    if request['harness_id'] == 'openclaw':
        previous_release, current_release, release_source = release_pair(directory, request)
    bundles = [directory / 'bundle'] if previous_release == ROOT else [previous_release / 'adapter', current_release / 'adapter']
    for bundle in bundles:
        bundle.mkdir(mode=0o755)
        (bundle / 'adapter.py').write_text('import time\ntime.sleep(900)\n')
    bundle = bundles[0]
    placement = {'image': request['old_image'], 'runtime_user': 'nobody', 'home_directory': '/nonexistent',
                 'state_root': '/tmp/cauce-state', 'python': '/usr/local/bin/python3',
                 'systemd_user': pwd.getpwuid(os.geteuid()).pw_name}
    policy = {'schemaVersion': 1, 'host_id': request['host_id'], 'executor_user': placement['systemd_user'],
              'roots': roots, 'native': [], 'containers': {request['container_name']: placement},
              'profiles': {}, 'hooks': {}, 'bundles': {request['harness_id']: {
                  'directory': str(bundle), 'digest': bundle_digest(str(bundle)),
                  'executable': '/usr/local/bin/python3', 'executable_sha256': None,
                  'argv': [str(bundle / 'adapter.py')]}}}
    raw = {field: request[field] for field in ('company_id', 'tenant_id', 'alias', 'runtime_key', 'host_id', 'harness_id', 'container_name')}
    raw.update(runtime_mode='container', runtime_user=placement['runtime_user'], home_directory=placement['home_directory'],
               state_directory=placement['state_root'] + '/' + raw['runtime_key'], systemd_user=placement['systemd_user'])
    policy_file = directory / 'policy.json'
    policy_file.write_text(json.dumps(policy))
    policy_file.chmod(0o600)
    previous_policy_sha256 = hashlib.sha256(policy_file.read_bytes()).hexdigest()
    policy = load_policy(policy_file)
    agent = approve_agent(policy, raw)
    labels = {**container.expected_labels(policy, agent), 'cauce.e2e.owner': OWNER}
    container.docker('volume', 'create', *[value for key, item in labels.items() for value in ('--label', key + '=' + item)], raw['container_name'] + '-state')
    current = container.ensure_container({**policy, '_runtime_release': str(previous_release)}, agent)
    identity = container.identity_for(agent, current)
    uid, gid = container.user_identity(agent, identity)
    container.helper(agent, identity, 'prepare-state', '--mount', placement['state_root'], '--state', raw['state_directory'], '--uid', uid, '--gid', gid)
    files = {'context/readme.md': 'Synthetic recoverable context\n', 'directives/rules.md': 'Synthetic owner instructions\n',
             'projects/source.txt': 'Synthetic project contents\n' * 800, 'data/records.json': '[1,2,3]\n',
             'config/context-state.json': json.dumps({key: raw[key] for key in ('company_id', 'tenant_id', 'alias', 'runtime_key')})}
    script = ('import json,pathlib,sys;root=pathlib.Path(sys.argv[1])/"space";root.mkdir(mode=0o700);'
              '\nfor name,body in json.loads(sys.argv[2]).items():\n p=root/name;p.parent.mkdir(parents=True,exist_ok=True,mode=0o700);p.write_text(body);p.chmod(0o600)')
    container.docker('exec', '-w', '/', '--user', raw['runtime_user'], raw['container_name'],
                     placement['python'], '-I', '-B', '-c', script, raw['state_directory'], json.dumps(files))
    before = observed(policy, raw)
    policy['containers'][raw['container_name']]['image'] = request['new_image']
    approved_bundle = policy['bundles'][request['harness_id']]
    approved_bundle.update(directory=str(bundles[-1]), digest=bundle_digest(str(bundles[-1])), argv=[str(bundles[-1] / 'adapter.py')])
    policy_file.write_text(json.dumps(policy))
    policy_file.chmod(0o600)
    result = {'agent': raw, 'policy_file': str(policy_file), 'before': before, 'approved_image': request['new_image'],
              'policy_sha256': hashlib.sha256(policy_file.read_bytes()).hexdigest(), 'source_files': inventory(raw),
              'previous_policy_sha256': previous_policy_sha256, 'project_root': str(current_release),
              'runtime_release': str(previous_release), 'release_source': release_source}
    (directory / 'binding.json').write_text(json.dumps(result))
    (directory / 'binding.json').chmod(0o600)
    return result


def run(action: str, request: dict) -> dict:
    if action == 'prepare':
        return prepare(request)
    directory = pathlib.Path(request['directory'])
    if action == 'cleanup' and not (directory / 'binding.json').exists():
        return discard(json.loads((directory / 'canary.json').read_text())['name'])
    binding = json.loads((directory / 'binding.json').read_text())
    policy = json.loads(pathlib.Path(binding['policy_file']).read_text())
    raw = binding['agent']
    current = observed(policy, raw)
    if current['id'] != binding['before']['id']:
        raise RuntimeError('canary container identity changed')
    if action == 'observe':
        return {'observed': current, 'source_files': inventory(raw)}
    if action in {'fault', 'recover'}:
        container.docker('update', '--pids-limit', '64' if action == 'fault' else '128', current['id'])
        return {'observed': observed(policy, raw)}
    if action != 'cleanup':
        raise ValueError('unknown canary action')
    return discard(raw['container_name'])


def discard(name: str) -> dict:
    if not name.startswith('zz-canary-' + OWNER + '-'):
        raise RuntimeError('canary cleanup name differs')
    current = container.inspect_container(name)
    if current is not None:
        if current['Config']['Labels'].get('cauce.e2e.owner') != OWNER:
            raise RuntimeError('canary cleanup owner differs')
        container.docker('rm', '-f', current['Id'])
    volume = name + '-state'
    existing = container.docker('volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}').decode().strip()
    if existing:
        labels = json.loads(container.docker('volume', 'inspect', volume))[0]['Labels']
        if labels.get('cauce.e2e.owner') != OWNER:
            raise RuntimeError('canary volume ownership changed')
        container.docker('volume', 'rm', volume)
    absent = container.inspect_container(name) is None
    remaining = container.docker('volume', 'ls', '--filter', 'name=^' + volume + '$', '--format', '{{.Name}}').decode().strip()
    if not absent or remaining:
        raise RuntimeError('canary cleanup was not verified')
    return {'container_id': current['Id'] if current else None, 'volume': volume, 'all_absent': True}


if __name__ == '__main__':
    packet = json.loads(pathlib.Path(sys.argv[2]).read_text())
    print(json.dumps(run(sys.argv[1], packet), sort_keys=True))
