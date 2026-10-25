from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import shlex
import subprocess
import sys
import time

HASH = re.compile(r'[a-f0-9]{64}')
BOUNDARY = 'B3P2_LAB_INJECTED_AFTER_CREDENTIALS'


def digest(path: pathlib.Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(arguments: list[str]) -> str:
    result = subprocess.run(arguments, capture_output=True, check=False, timeout=30)
    if result.returncode:
        raise RuntimeError('owned Lab boundary control failed')
    return result.stdout.decode().strip()


def private_json(path: pathlib.Path, value: dict) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        json.dump(value, stream, sort_keys=True)


def control() -> None:
    action, policy_file, host = sys.argv[2:5]
    policy = pathlib.Path(policy_file)
    root = policy.parent / 'b3p2-boundary'
    company = policy.parent.parent.name
    unit = f'cauce-v3-host-executor-{company}-{host}.service'
    if os.getuid() != 1500 or not company.startswith('zz-replace-') or not host.startswith(company + '-'):
        raise RuntimeError('owned Lab controller required')
    if run(['docker', 'info', '--format', '{{.Name}}']) != 'docker-lab':
        raise RuntimeError('Docker Lab daemon required')
    if action == 'install':
        mode, tenant, alias, runtime_key, container_name = sys.argv[5:10]
        if mode not in {'failure', 'cancel'} or not container_name.startswith('zz-canary-h9-contenedor-sustituido-1025-'):
            raise RuntimeError('bounded Lab scenario required')
        environment = dict(item.split('=', 1) for item in shlex.split(run([
            'systemctl', '--user', 'show', unit, '--property=Environment', '--value'])) if '=' in item)
        if environment.get('CAUCE_FLEET_POLICY_FILE') != str(policy):
            raise RuntimeError('owned unit policy differs')
        original = pathlib.Path(environment['CAUCE_FLEET_EXECUTABLE'])
        if original.name != 'fleet-executor.py' or not original.is_absolute():
            raise RuntimeError('original release executable required')
        root.mkdir(mode=0o700)
        wrapper = root / 'driver.py'
        source = sys.stdin.buffer.read(65537)
        if len(source) > 65536:
            raise RuntimeError('bounded driver source required')
        descriptor = os.open(wrapper, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'wb') as stream:
            stream.write(source)
        configuration = {'original': str(original), 'original_sha256': digest(original), 'mode': mode,
                         'tenant': tenant, 'alias': alias, 'runtime_key': runtime_key, 'container_name': container_name}
        private_json(root / 'configuration.json', configuration)
        dropin = pathlib.Path.home() / '.config/systemd/user' / (unit + '.d') / 'b3p2-boundary.conf'
        dropin.parent.mkdir(mode=0o700, exist_ok=True)
        descriptor = os.open(dropin, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as stream:
            stream.write('[Service]\nEnvironment=CAUCE_FLEET_EXECUTABLE=' + str(wrapper) + '\n')
        run(['systemctl', '--user', 'daemon-reload'])
        run(['systemctl', '--user', 'restart', unit])
    configuration = json.loads((root / 'configuration.json').read_bytes())
    original_sha = digest(pathlib.Path(configuration['original']))
    if original_sha != configuration['original_sha256']:
        raise RuntimeError('original release executable changed')
    if action == 'release':
        (root / 'release').touch(mode=0o600, exist_ok=True)
    marker = root / 'credentials.json'
    print(json.dumps({'boundary': BOUNDARY, 'mode': configuration['mode'], 'unit': unit,
                      'original_sha256': original_sha, 'driver_sha256': digest(root / 'driver.py'),
                      'marker': json.loads(marker.read_bytes()) if marker.exists() else None,
                      'released': (root / 'release').exists()}))


def execute() -> int:
    root = pathlib.Path(__file__).parent
    configuration = json.loads((root / 'configuration.json').read_bytes())
    original = pathlib.Path(configuration['original'])
    if digest(original) != configuration['original_sha256']:
        raise RuntimeError('original release executable changed')
    arguments = [sys.executable, '-B', str(original), *sys.argv[1:]]
    if '--step' not in sys.argv or sys.argv[sys.argv.index('--step') + 1] != 'credentials':
        os.execv(sys.executable, arguments)
    encoded = sys.stdin.buffer.read(1024 * 1024 + 1)
    if len(encoded) > 1024 * 1024:
        raise RuntimeError('execution payload exceeds its limit')
    context = json.loads(encoded)
    request = context['request']
    parameters = request.get('parameters', {})
    target = request['target']
    matches = request['kind'] == 'update' and target.get('resource') == 'agent' \
        and target.get('tenant_id') == configuration['tenant'] and target.get('alias') == configuration['alias'] \
        and parameters.get('runtime_key') == configuration['runtime_key'] \
        and parameters.get('placement', {}).get('container_name') == configuration['container_name']
    result = subprocess.run(arguments, input=encoded, capture_output=True, check=False)
    if matches and result.returncode == 0:
        receipt = json.loads(result.stdout)
        fingerprint = receipt['evidence']['certificate_fingerprint']
        if not isinstance(fingerprint, str) or HASH.fullmatch(fingerprint) is None:
            raise RuntimeError('real issuer fingerprint absent')
        private_json(root / 'credentials.json', {'operation_id': context['operation_id'], 'certificate_fingerprint': fingerprint})
        deadline = time.monotonic() + 100
        while not (root / 'release').exists():
            if time.monotonic() >= deadline:
                raise RuntimeError('bounded Lab credentials barrier expired')
            time.sleep(0.05)
        if configuration['mode'] == 'failure':
            print(BOUNDARY, file=sys.stderr)
            return 2
    sys.stdout.buffer.write(result.stdout)
    sys.stderr.buffer.write(result.stderr)
    return result.returncode


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--b3p2-control':
        control()
    else:
        raise SystemExit(execute())
