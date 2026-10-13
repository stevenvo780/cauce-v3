#!/usr/bin/env python3
"""Create and compensate disposable fleet containers for the purge browser walkthrough."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[2]
OPS = ROOT / 'ops'
sys.path.insert(0, str(OPS / 'cli'))
sys.path.insert(0, str(OPS / 'container-runtime'))
from cauce_container_base import bundle_digest  # noqa: E402
from fleet_executor_container import create_container, discard_operation  # noqa: E402
from fleet_executor_policy import SafeFailure, approve_agent  # noqa: E402

sys.path.insert(0, str(ROOT / 'ops/tests'))
import test_fleet_executor_container as reports  # noqa: E402

STATE_ROOT = '/tmp/cauce-state'


def image_id() -> str:
    result = subprocess.run(['docker', 'image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'], capture_output=True, text=True)
    if result.returncode or not result.stdout.strip().startswith('sha256:'):
        raise SystemExit('python:3.12-slim is unavailable for the disposable purge walkthrough')
    return result.stdout.strip()


def sweep(rows: pathlib.Path, prefix: str, host: str) -> tuple[dict, int]:
    report, code, _attempts = reports.sweep_report(rows, prefix, host)
    return report, code


def listed(*arguments: str) -> list[str]:
    result = subprocess.run(['docker', *arguments], capture_output=True, text=True)
    if result.returncode:
        raise SystemExit(f'docker {arguments[0]} failed: {result.stderr.strip()}')
    return [line for line in result.stdout.splitlines() if line]


def remove(name: str) -> None:
    """Remove the run's container and volumes, then prove by listing that none of them is left."""
    volumes = (name + '-state', name + '-provider-profiles')
    if listed('ps', '-aq', '--filter', f'name=^/{name}$'):
        listed('rm', '-f', name)
    present = [volume for volume in listed('volume', 'ls', '--format', '{{.Name}}') if volume in volumes]
    if present:
        listed('volume', 'rm', *present)
    if listed('ps', '-aq', '--filter', f'name=^/{name}$') or set(listed('volume', 'ls', '--format', '{{.Name}}')) & set(volumes):
        raise SystemExit(f'disposable purge resources of {name} are still present')


def build(root: pathlib.Path, host: str) -> tuple[dict, pathlib.Path, str]:
    user = pwd.getpwuid(os.geteuid()).pw_name
    roots = {name: root / name for name in ('state', 'runtime', 'pki', 'tokens', 'identities')}
    for directory in roots.values():
        directory.mkdir(mode=0o700)
    bundle = root / 'bundle'
    bundle.mkdir(mode=0o700)
    (bundle / 'worker.py').write_text('import time\ntime.sleep(60)\n')
    shutil.copytree(ROOT / 'packages/adapter-sdk/descriptors', bundle / 'packages/adapter-sdk/dist/descriptors')
    executable = pathlib.Path(sys.executable).resolve()
    driver = root / 'revoke.py'
    driver.write_text('import json,sys\np=json.load(sys.stdin)\n'
                      'r={k:p[k] for k in ("nonce","account_id","identity")}\n'
                      'r.update({k:p["agent"][k] for k in ("tenant_id","alias","runtime_key")})\n'
                      'r["revocation_verified"]=True\nprint(json.dumps(r))\n')
    policy = {'schemaVersion': 1, 'host_id': host, 'executor_user': user,
              'roots': {name: str(path) for name, path in roots.items()},
              'native': [{'runtime_user': user, 'systemd_user': user, 'home_directory': str(root), 'state_root': str(roots['runtime'])}],
              'containers': {}, 'profiles': {},
              'hooks': {'revoke': {'executable': str(executable), 'sha256': hashlib.sha256(executable.read_bytes()).hexdigest(),
                                   'argv': [str(driver)], 'files': {str(driver): hashlib.sha256(driver.read_bytes()).hexdigest()}, 'user': user}},
              'bundles': {'codex': {'directory': str(bundle), 'digest': bundle_digest(str(bundle)), 'executable': str(executable),
                                    'executable_sha256': hashlib.sha256(executable.read_bytes()).hexdigest(), 'argv': [str(bundle / 'worker.py')]}}}
    policy_file = root / 'policy.json'
    return policy, policy_file, user


def place(policy: dict, name: str, image: str, user: str) -> None:
    policy['containers'][name] = {'image': image, 'runtime_user': 'nobody', 'systemd_user': user, 'home_directory': '/nonexistent',
                                  'state_root': STATE_ROOT, 'python': '/usr/local/bin/python3.12', 'profile_root': '/tmp/provider-profiles'}


def agent(policy: dict, tenant: str, alias: str, key: str, user: str) -> dict:
    return approve_agent(policy, {'tenant_id': tenant, 'alias': alias, 'harness_id': 'codex', 'enabled': False, 'fleet_baseline': False,
                                  'runtime_key': key, 'lifecycle_state': 'retired', 'host_id': policy['host_id'], 'runtime_mode': 'container',
                                  'container_name': key, 'runtime_user': 'nobody', 'home_directory': '/nonexistent',
                                  'state_directory': f'{STATE_ROOT}/{key}', 'systemd_user': user})


def save(policy: dict, policy_file: pathlib.Path) -> None:
    policy_file.write_text(json.dumps(policy))
    policy_file.chmod(0o600)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=('prepare', 'cleanup'))
    parser.add_argument('--root', required=True)
    parser.add_argument('--tenant', default='')
    parser.add_argument('--alias', default='')
    parser.add_argument('--runtime-key', default='')
    parser.add_argument('--fail-key', default='')
    arguments = parser.parse_args()
    root = pathlib.Path(arguments.root)
    manifest_path = root / 'manifest.json'
    if arguments.command == 'cleanup':
        if manifest_path.exists():
            manifest = json.loads(manifest_path.read_text())
            for name in (manifest.get('runtime_key'), manifest.get('fail_key')):
                if isinstance(name, str) and name.startswith('zz-canary-'):
                    remove(name)
        return 0
    root.mkdir(mode=0o700, exist_ok=True)
    host = arguments.runtime_key
    image = image_id()
    policy, policy_file, user = build(root, host)
    place(policy, arguments.fail_key, image, user)
    place(policy, arguments.runtime_key, image, user)
    save(policy, policy_file)
    rows = root / 'rows.json'
    rows.write_text('[]')
    failed = agent(policy, arguments.tenant, arguments.alias + 'fail', arguments.fail_key, user)
    operation = str(uuid.uuid4())
    try:
        create_container(policy, failed, {'/cauce/missing': '/nonexistent/' + arguments.fail_key}, operation_id=operation)
    except SafeFailure:
        pass
    else:
        raise SystemExit('failed create unexpectedly succeeded')
    report, code = sweep(rows, arguments.fail_key, host)
    if code != 1 or report.get('clean') is not False:
        raise SystemExit('failed create left no scoped orphan: ' + json.dumps(report))
    discard_operation(policy, failed, str(uuid.uuid4()))
    discard_operation(policy, failed, operation)
    report, code = sweep(rows, arguments.fail_key, host)
    if code != 0 or report.get('clean') is not True:
        raise SystemExit('failed create compensation left orphans: ' + json.dumps(report))
    created = agent(policy, arguments.tenant, arguments.alias, arguments.runtime_key, user)
    create_container(policy, created, operation_id=str(uuid.uuid4()))
    manifest = {'policy': str(policy_file), 'python': sys.executable, 'host_id': host, 'tenant_id': arguments.tenant,
                'alias': arguments.alias, 'runtime_key': arguments.runtime_key, 'fail_key': arguments.fail_key,
                'container_name': arguments.runtime_key, 'runtime_user': 'nobody', 'home_directory': '/nonexistent',
                'state_directory': f'{STATE_ROOT}/{arguments.runtime_key}', 'systemd_user': user, 'fail_clean': True}
    manifest_path.write_text(json.dumps(manifest))
    print(json.dumps(manifest))
    return 0


if __name__ == '__main__':
    sys.exit(main())
