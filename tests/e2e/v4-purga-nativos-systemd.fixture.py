from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys


def run(*args: str) -> str:
    result = subprocess.run(['systemctl', '--user', *args], capture_output=True, text=True, check=True)
    return result.stdout.strip()


def prepare(install: pathlib.Path, tenant: str, alias: str, key: str, foreign: bool) -> dict:
    filename = next(install.glob('*/*/executor-policy.json'))
    policy = json.loads(filename.read_text())
    root = pathlib.Path(policy['roots']['runtime'])
    control = root / '.control' / key
    state = root / key
    for directory in (control.parent, control, state):
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
    (state / 'zz-canary-state.txt').write_text('native purge E2E\n')
    environment = control / 'native-executor-environment.json'
    environment.write_text(json.dumps({'schemaVersion': 1, 'target': {'tenant_id': tenant, 'alias': alias},
                                      'runtime_key': key, 'environment': None}))
    environment.chmod(0o600)
    unit_name = ('zz-canary-foreign-' if foreign else 'cauce-v3-alias-') + key + '.service'
    unit = pathlib.Path.home() / '.config/systemd/user' / unit_name
    unit.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    unit.write_text('[Unit]\nDescription=zz-canary native purge E2E\n[Service]\n'
                    'ExecStart=/bin/sleep infinity\n'
                    f'Environment=CAUCE_NATIVE_EXECUTOR_ENVIRONMENT={environment}\n'
                    '[Install]\nWantedBy=default.target\n')
    unit.chmod(0o600)
    dropin_dir = unit.parent / (unit_name + '.d')
    dropin_dir.mkdir(mode=0o700)
    dropin = dropin_dir / 'zz-canary.conf'
    dropin.write_text('[Service]\nRestart=no\n')
    dropin.chmod(0o600)
    files = {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in (unit, dropin)}
    placement = {'host_id': policy['host_id'], 'mode': 'native', 'runtime_user': policy['executor_user'],
                 'systemd_user': policy['executor_user'], 'home_directory': str(pathlib.Path.home()),
                 'state_directory': str(state)}
    adoption = root / (key + '-adoption-policy.json')
    bundle = policy['bundles']['codex']
    executable = str(pathlib.Path(bundle['executable']).resolve())
    command_pin = hashlib.sha256(pathlib.Path(executable).read_bytes()).hexdigest()
    entry = bundle['argv'][0]
    entry_pin = hashlib.sha256(pathlib.Path(entry).read_bytes()).hexdigest()
    adoption.write_text(json.dumps({'schemaVersion': 1, 'host_id': policy['host_id'], 'targets': [{
        'target': {'tenant_id': tenant, 'alias': alias}, 'runtime_key': key, 'harness_id': 'codex',
        'placement': placement, 'account': None,
        'supervisor': {'socket': str(control / 'cauce-v3-adoption.sock'), 'command': executable,
                       'command_sha256': command_pin},
        'observation': {'transport': 'local', 'control_directory': str(control),
                        'lifecycle_directory': str(pathlib.Path(bundle['directory']).parent / 'ops/container-runtime'),
                        'pins': files, 'bundle_directory': bundle['directory'], 'bundle_digest': bundle['digest'],
                        'node_command': executable, 'node_sha256': command_pin, 'provider_command': '/bin/sleep',
                        'provider_sha256': hashlib.sha256(pathlib.Path('/bin/sleep').read_bytes()).hexdigest(),
                        'adapter_entry': entry, 'adapter_sha256': entry_pin}}]}))
    adoption.chmod(0o600)
    policy['native'].append({'runtime_key': key, 'runtime_user': policy['executor_user'],
                             'systemd_user': policy['executor_user'], 'home_directory': str(pathlib.Path.home()),
                             'state_root': str(root), 'manager': {'unit': unit_name, 'files': files,
                                                                 'adoption_policy': str(adoption)}})
    filename.write_text(json.dumps(policy))
    filename.chmod(0o600)
    run('daemon-reload')
    run('enable', '--now', unit_name)
    return {'key': key, 'unit': unit_name, 'files': list(files), 'state': str(state), 'control': str(control),
            'adoption': str(adoption), 'home': str(pathlib.Path.home()), 'user': policy['executor_user'],
            'host': policy['host_id'], 'active': run('is-active', unit_name), 'enabled': run('is-enabled', unit_name)}


def observe(manifest: dict) -> dict:
    result = subprocess.run(['systemctl', '--user', 'show', manifest['unit'],
                             '--property=LoadState,ActiveState,FragmentPath,UnitFileState,MainPID'],
                            capture_output=True, text=True, check=False)
    enabled = pathlib.Path.home() / '.config/systemd/user/default.target.wants' / manifest['unit']
    return {'properties': dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line),
            'paths': {name: pathlib.Path(name).exists() or pathlib.Path(name).is_symlink()
                      for name in [*manifest['files'], manifest['state'], manifest['control'],
                                   str(pathlib.Path.home() / '.config/systemd/user' / (manifest['unit'] + '.d'))]},
            'enabled_link': enabled.exists() or enabled.is_symlink(),
            'file_hashes': {name: hashlib.sha256(pathlib.Path(name).read_bytes()).hexdigest()
                            for name in manifest['files'] if pathlib.Path(name).is_file()},
            'adoption_policy_preserved': pathlib.Path(manifest['adoption']).is_file()}


def alter_dropin(manifest: dict, restore: bool) -> dict:
    filename = pathlib.Path(manifest['files'][1])
    filename.write_text('[Service]\nRestart=' + ('no' if restore else 'on-failure') + '\n')
    run('daemon-reload')
    return observe(manifest)


def obstruct_views(manifest: dict, release: bool) -> dict:
    root = pathlib.Path(manifest['state']).parent
    view = root / '.credential-views' / manifest['key']
    target = root / (manifest['key'] + '-untouched')
    marker = target / 'zz-canary-preserved.txt'
    if release:
        view.unlink()
        view.mkdir(mode=0o700)
    else:
        view.parent.mkdir(mode=0o700, exist_ok=True)
        target.mkdir(mode=0o700)
        marker.write_text('preserved\n')
        view.symlink_to(target)
    return {'view': str(view), 'symlink': view.is_symlink(), 'target_preserved': marker.read_text() == 'preserved\n'}


if sys.argv[1] == 'prepare':
    print(json.dumps(prepare(pathlib.Path(sys.argv[2]), *sys.argv[3:6], sys.argv[6] == 'foreign')))
elif sys.argv[1] == 'observe':
    print(json.dumps(observe(json.loads(sys.argv[2]))))
elif sys.argv[1] in {'drift', 'restore'}:
    print(json.dumps(alter_dropin(json.loads(sys.argv[2]), sys.argv[1] == 'restore')))
elif sys.argv[1] in {'obstruct', 'release'}:
    print(json.dumps(obstruct_views(json.loads(sys.argv[2]), sys.argv[1] == 'release')))
