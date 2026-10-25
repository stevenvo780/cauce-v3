from __future__ import annotations

import importlib
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys

PROJECT = pathlib.Path(__file__).resolve().parents[2]
ROOT = pathlib.Path(os.environ.get('CAUCE_IMAGE_RELEASE', str(PROJECT)))
sys.path[:0] = [str(ROOT / 'ops/cli'), str(ROOT / 'ops/container-runtime')]

container = importlib.import_module('fleet_executor_container')
refresh = importlib.import_module('fleet_executor_image')
bundle_digest = importlib.import_module('cauce_container_base').bundle_digest
approve_agent = importlib.import_module('fleet_executor_policy').approve_agent


def prepare_credentials(directory: pathlib.Path, policy: dict, raw: dict) -> None:
    from fleet_runtime_materialization import _publish_generation, _receipt
    ca, ca_key = directory / 'ca.crt', directory / 'ca.key'
    pair = directory / 'pki/normal/image'
    pair.mkdir(parents=True, mode=0o700)
    token = directory / 'tokens/normal/image.token'
    token.parent.mkdir(parents=True, mode=0o700)
    token.write_text('fixture-image-refresh-credential')
    token.chmod(0o600)
    private, cert, csr = pair / 'agent-image.key', pair / 'agent-image.crt', directory / 'client.csr'
    extensions = directory / 'client.ext'
    extensions.write_text('basicConstraints=CA:FALSE\nextendedKeyUsage=clientAuth\nsubjectAltName=URI:urn:cauce:runtime:image\n')
    commands = [
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(ca_key), '-out', str(ca), '-days', '3', '-subj', '/CN=Fixture', '-addext', 'basicConstraints=critical,CA:TRUE'],
        ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', str(private), '-out', str(csr), '-subj', '/CN=agent-image'],
        ['x509', '-req', '-in', str(csr), '-CA', str(ca), '-CAkey', str(ca_key), '-CAcreateserial', '-out', str(cert), '-days', '2', '-extfile', str(extensions)],
    ]
    for arguments in commands:
        subprocess.run(['openssl', *arguments], capture_output=True, check=True)
    private.chmod(0o600)
    ca_key.chmod(0o600)
    policy['roots'].update(pki=str(directory / 'pki'), tokens=str(directory / 'tokens'))
    policy['signer'] = {'certificate': str(ca)}
    policy['transport'] = {'network': 'none', 'gateway_url': 'https://gateway.example.test',
                           'bootstrap_url': 'https://gateway.example.test', 'ca_certificate': str(ca)}
    fleet = {'image': {'tenant': raw['tenant_id'], 'alias': raw['alias'], 'user': raw['runtime_user'],
                      'runtimeStateDirectory': raw['state_directory'], 'enabled': True, 'room': 'fixture'}}
    files = {name: b'{}' for name in ('container-aliases.json', 'generated/fleet.json', 'schemas/alias-manifest.schema.json')}
    files['flota.json'] = json.dumps({'schemaVersion': 1, 'fleet': fleet}).encode()
    receipt = _receipt(files)
    state = pathlib.Path(policy['roots']['state'])
    _publish_generation(state, receipt, files)
    (state / 'desired-fleet.json').write_text(json.dumps(receipt))


def run_case(directory: pathlib.Path, name: str, old_image: str, new_image: str, scenario: str) -> dict:
    if scenario == 'two-releases':
        releases = directory / 'releases'
        for revision in ('a' * 64, 'b' * 64):
            root = releases / revision
            for tree in ('ops/cli', 'ops/container-runtime', 'ops/scripts', 'ops/schemas'):
                shutil.copytree(PROJECT / tree, root / tree)
            adapter = root / 'adapter'
            adapter.mkdir()
            (adapter / 'adapter.py').write_text('import time\nwhile True: time.sleep(0.05)\n')
        old, new = (releases / revision for revision in ('a' * 64, 'b' * 64))
        result = None
        for root, phase in ((old, 'setup-old'), (new, 'restore-new')):
            completed = subprocess.run([sys.executable, '-B', str(pathlib.Path(__file__).resolve()), str(directory), name, old_image, new_image, phase],
                                       env={**os.environ, 'CAUCE_IMAGE_RELEASE': str(root)}, capture_output=True, check=True, text=True)
            sys.stderr.write(completed.stderr)
            result = json.loads(completed.stdout)
        return {'scenario': scenario, **result}
    if scenario == 'restore-new':
        stored = json.loads((directory / 'setup.json').read_text())
        policy, raw = stored['policy'], stored['raw']
        old_root = pathlib.Path(policy['bundles']['codex']['directory']).parent
        policy['bundles']['codex'].update(directory=str(ROOT / 'adapter'), digest=bundle_digest(str(ROOT / 'adapter')),
                                        argv=[str(ROOT / 'adapter/adapter.py')])
        agent = approve_agent(policy, raw)
        observed = container.inspect_container(name)
        container.stop_running_adapter(agent, observed)
        proof = container.restore_existing_adapter(policy, raw)
        after = container.inspect_container(name)
        source = next(row['Source'] for row in after['Mounts'] if row['Destination'] == '/cauce/lifecycle')
        return {'runtime_verified': bool(proof.get('runtime_digest')), 'original_id': after['Id'] == stored['id'],
                'current_release_mounted': source == str(ROOT / 'ops/container-runtime'),
                'previous_release_available': old_root.is_dir(),
                'state_volume_preserved': any(row.get('Name') == name + '-state' and row.get('Destination') == '/tmp/cauce-state'
                                              for row in after['Mounts'])}
    bundle = ROOT / 'adapter' if scenario == 'setup-old' else directory / 'bundle'
    if not bundle.exists():
        bundle.mkdir()
        (bundle / 'adapter.py').write_text('import time\nwhile True: time.sleep(0.05)\n')
    os.chmod(directory, 0o755)
    os.chmod(bundle, 0o755)
    state = directory / 'executor-state'
    state.mkdir(mode=0o700)
    placement = {'image': old_image, 'runtime_user': 'nobody', 'home_directory': '/nonexistent',
                 'state_root': '/tmp/cauce-state', 'python': '/usr/local/bin/python3',
                 'systemd_user': pwd.getpwuid(os.geteuid()).pw_name}
    policy = {'host_id': 'fixture-host', 'executor_user': placement['systemd_user'], 'native': [], 'profiles': {},
              'containers': {name: placement}, 'roots': {'state': str(state)},
              'bundles': {'codex': {'directory': str(bundle), 'digest': bundle_digest(str(bundle)),
                  'executable': '/usr/local/bin/python3.12', 'executable_sha256': None,
                  'argv': [str(bundle / 'adapter.py')]}}}
    raw = {'tenant_id': 'Fixture', 'alias': 'image', 'runtime_key': 'image', 'harness_id': 'codex',
           'host_id': policy['host_id'], 'runtime_mode': 'container', 'container_name': name,
           'runtime_user': placement['runtime_user'], 'home_directory': placement['home_directory'],
           'state_directory': placement['state_root'] + '/image', 'systemd_user': placement['systemd_user']}
    prepare_credentials(directory, policy, raw)
    agent = approve_agent(policy, raw)
    labels = {**container.expected_labels(policy, agent), 'cauce.e2e.owner': 'f4-flota-server2-1025'}
    container.docker('volume', 'create', *[value for key, item in labels.items() for value in ('--label', key + '=' + item)], name + '-state')
    before = container.start_container(policy, raw, bootstrap=False)
    observed = container.inspect_container(name)
    if scenario == 'setup-old':
        (directory / 'setup.json').write_text(json.dumps({'policy': policy, 'raw': raw, 'id': observed['Id']}))
        return {'setup': True}
    old_started = observed['State']['StartedAt']
    if scenario == 'idle-container-rollback':
        container.stop_running_adapter(agent, observed)
    placement['image'] = new_image
    desired = approve_agent(policy, raw)
    failure = None
    if scenario == 'live-container-rollback':
        receipt = {'host_id': policy['host_id'], 'tenant_id': raw['tenant_id'], 'runtime_key': raw['runtime_key'],
                   'container_name': name, 'previous_id': observed['Id'], 'previous_image': old_image,
                   'image': new_image, 'was_running': True, 'adapter_running': True, 'adapter_bootstrap': False,
                   'status': 'prepared'}
        if hasattr(container, 'adapter_restart_state'):
            receipt.update(container.adapter_restart_state(policy, agent, observed))
        refresh.remember(policy, desired, receipt)
        container.stop_running_adapter(agent, observed)
        refresh.restore_previous(policy, desired, receipt)
    else:
        try:
            refreshed = refresh.refresh_image(policy, desired, observed)
        except BaseException as error:
            failure = {'type': type(error).__name__, 'message': str(error),
                       'cause_type': type(error.__cause__).__name__ if error.__cause__ else None,
                       'cause_message': str(error.__cause__) if error.__cause__ else None}
        else:
            if scenario == 'success':
                return {'scenario': scenario, 'status': 'succeeded', 'new_image': refreshed['Image'] == new_image,
                        'replaced': refreshed['Id'] != observed['Id'], 'before_running': bool(before)}
            raise RuntimeError('broken image unexpectedly started')
    current = container.inspect_container(name)
    proof = None
    try:
        proof = container.process_proof(policy, agent, container.identity_for(agent, current), policy['bundles']['codex'])
    except Exception:
        pass
    receipt = json.loads(refresh.receipt_path(policy, desired).read_text())
    return {'scenario': scenario, 'failure': failure, 'original_id': current['Id'] == observed['Id'],
            'original_image': current['Image'] == old_image, 'running': current['State']['Running'],
            'container_never_stopped': current['State']['StartedAt'] == old_started,
            'adapter_running': bool(proof),
            'receipt': receipt['status'], 'failure_cause': receipt.get('failure_cause')}


if __name__ == '__main__':
    directory, name, old_image, new_image, scenario = sys.argv[1:]
    try:
        print(json.dumps(run_case(pathlib.Path(directory), name, old_image, new_image, scenario), sort_keys=True))
    finally:
        if scenario != 'setup-old':
            for target in (name, name + '-image-rollback'):
                subprocess.run(['/usr/bin/docker', 'rm', '-f', target], capture_output=True, check=False)
            subprocess.run(['/usr/bin/docker', 'volume', 'rm', name + '-state'], capture_output=True, check=False)
