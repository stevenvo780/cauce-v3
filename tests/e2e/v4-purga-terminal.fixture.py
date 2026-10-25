from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import pwd
import subprocess
import sys
import uuid

ROOT = pathlib.Path(sys.argv[1])
sys.path.insert(0, str(ROOT / 'ops/cli'))
from fleet_executor_policy import SafeFailure  # noqa: E402
from fleet_executor_terminal import purge_terminal  # noqa: E402

HOME = pathlib.Path(pwd.getpwuid(os.geteuid()).pw_dir)
WORK = HOME / 'zz-canary-terminal-purge'
WORK.mkdir(mode=0o700, exist_ok=True)


def command(*args):
    result = subprocess.run(args, capture_output=True, text=True, check=True)
    return result.stdout.strip()


def systemctl(*args):
    return command('systemctl', '--user', *args)


def write(filename, content, mode=0o600):
    filename.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    filename.write_text(content)
    filename.chmod(mode)


def authority(policy, action, **fields):
    location = WORK / 'authority-policy.json'
    write(location, json.dumps(policy))
    packet = {'action': action, 'agent': {'tenant_id': 'Steven', 'alias': fields.pop('alias')},
              'scope': fields.pop('scope'), **fields}
    result = subprocess.run([sys.executable, '-I', '-B', str(ROOT / 'ops/cli/fleet-authority-issuer.py'),
        '--policy', str(location), '--policy-sha256', hashlib.sha256(location.read_bytes()).hexdigest()],
        input=json.dumps(packet), text=True, capture_output=True, check=True)
    return json.loads(result.stdout)


def prepare(alias, mode):
    config = HOME / '.config/cauce-v3'
    pki = config / 'pty-pki' / alias
    pki.mkdir(mode=0o700, parents=True)
    command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
            '-subj', '/CN=zz-canary-terminal', '-keyout', str(pki / 'client.key'), '-out', str(pki / 'client.crt'))
    certificate = pki / 'client.crt'
    fingerprint = command('openssl', 'x509', '-in', str(certificate), '-noout', '-fingerprint', '-sha256').split('=')[1].replace(':', '').lower()
    (pki / 'client.key').chmod(0o600)
    (pki / 'client.crt').chmod(0o600)
    write(pki / 'ca.crt', certificate.read_text())
    write(pki / 'alias-key.hex', '0' * 64, 0o400)
    env = config / ('pty-host' if mode == 'native' else 'pty') / (alias + '.env')
    write(env, f'RELAY_HOST=127.0.0.1\nRELAY_PORT=8445\nPKI_DIR={pki}\nALIAS_KEY_FILE={pki}/alias-key.hex\n')
    metadata = config / 'pty' / (alias + '.migration.json')
    write(metadata, json.dumps({'schema_version': 1, 'tenant': 'Steven', 'alias': alias, 'runtime_key': alias,
                                'migration_id': str(uuid.uuid4()), 'client_cert_sha256': fingerprint}))
    prefix = 'cauce-v3-pty-host@' if mode == 'native' else 'cauce-v3-pty@'
    units = [prefix + alias + '.service', 'cauce-v3-profile-expectation@' + alias + '.service']
    for unit in units:
        template = HOME / '.config/systemd/user' / (unit.split('@')[0] + '@.service')
        write(template, '[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=default.target\n')
        write(template.parent / (unit + '.d') / '20-cauce-release.conf', '[Service]\nEnvironment=ZZ_CANARY=1\n')
    systemctl('daemon-reload')
    for unit in units:
        systemctl('enable', '--now', unit)
    return {'tenant_id': 'Steven', 'alias': alias, 'runtime_key': alias, 'runtime_mode': mode,
            'systemd_user': pwd.getpwuid(os.geteuid()).pw_name}, pki, env, metadata, units, fingerprint


state = WORK / 'authority-state'
state.mkdir(mode=0o700)
registries = {}
for name in ('base_mtls', 'base_token', 'fleet_mtls', 'fleet_token', 'pty'):
    filename = 'pty_agent_identities.json' if name == 'pty' else 'mtls_identities.json' if name.endswith('mtls') else 'token_hashes.json'
    location = WORK / name / filename
    write(location, json.dumps({'version': 1, 'agents' if name == 'pty' else 'identities': []}))
    registries[name] = str(location)
ca, key = WORK / 'ca.crt', WORK / 'ca.key'
command('openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=zz-canary-authority',
        '-keyout', str(key), '-out', str(ca), '-addext', 'basicConstraints=critical,CA:TRUE')
key.chmod(0o600)
policy = {'version': 1, 'state_root': str(state), 'registries': registries,
          'signer': {'certificate': str(ca), 'key': str(key), 'certificate_sha256': hashlib.sha256(ca.read_bytes()).hexdigest(),
                     'key_sha256': hashlib.sha256(key.read_bytes()).hexdigest()}}
evidence = {}
for mode in ('native',):
    alias = 'zz-canary-h7-' + mode
    agent, pki, env, metadata, units, fingerprint = prepare(alias, mode)
    foreign = {'tenant_id': 'Other', 'alias': alias, 'fingerprint_sha256': 'B' * 64, 'expires_at': '2099-01-01T00:00:00Z'}
    target = {'tenant_id': 'Steven', 'alias': alias, 'fingerprint_sha256': fingerprint.upper(), 'expires_at': '2099-01-01T00:00:00Z'}
    registry = pathlib.Path(registries['pty'])
    write(registry, json.dumps({'version': 1, 'agents': [target, foreign]}))
    scope = {'operation_id': str(uuid.uuid4()), 'host_id': 'zz-canary-h7-host', 'scope_sha256': 'a' * 64, 'runtime_key': alias}
    journal = {}
    executor_policy = {'executor_user': agent['systemd_user']}
    def save(current=journal, filename=WORK / (alias + '-receipt.json')):
        write(filename, json.dumps(current))
    try:
        purge_terminal(executor_policy, agent, journal, save)
    except SafeFailure as error:
        assert str(error) == 'terminal purge requires observed relay authority revocation'
    else:
        raise AssertionError('terminal removal without authority unexpectedly succeeded')
    before = [systemctl('is-active', unit) for unit in units]
    observed = authority(policy, 'inventory', alias=alias, scope=scope)
    pins = [{key: row[key] for key in ('id', 'sha256')} for row in observed['authorities']]
    absence = authority(policy, 'revoke', alias=alias, scope=scope, expected_inventory=pins)
    assert authority(policy, 'revoke', alias=alias, scope=scope, expected_inventory=pins) == absence
    journal['central_revocations'] = {alias: {'complete': True, 'absence': absence, 'terminal_fingerprints': [fingerprint]}}
    save()
    if mode == 'container':
        pki.chmod(0o500)
        try:
            purge_terminal(executor_policy, agent, journal, save)
        except PermissionError:
            pass
        else:
            raise AssertionError('filesystem obstruction did not exercise resume')
        pki.chmod(0o700)
        restored = json.loads((WORK / (alias + '-receipt.json')).read_text())
        journal.clear()
        journal.update(restored)
    removed = purge_terminal(executor_policy, agent, journal, save)
    replay = purge_terminal(executor_policy, agent, journal, save)
    assert removed == replay
    assert not any(os.path.lexists(filename) for filename in (pki, env, metadata))
    assert json.loads(registry.read_text()) == {'version': 1, 'agents': [foreign]}
    after = [systemctl('show', unit, '--property=ActiveState', '--value') for unit in units]
    assert before == ['active', 'active'] and after == ['inactive', 'inactive']
    assert not any((HOME / '.config/systemd/user/default.target.wants' / unit).exists() for unit in units)
    write(env, f'PKI_DIR={pki}\nALIAS_KEY_FILE={pki}/alias-key.hex\n')
    try:
        purge_terminal(executor_policy, agent, journal, save)
    except SafeFailure as error:
        assert str(error) == 'terminal artifacts reappeared after observed removal'
    else:
        raise AssertionError('reappeared terminal artifacts were accepted')
    env.unlink()
    evidence[mode] = {'before': before, 'after': after, 'removed': removed['removed'],
                      'relay_foreign_identity_preserved': True, 'replay_identical': True,
                      'resumed_after_permission_failure': mode == 'container', 'reappearance_rejected': True}
sys.path.insert(0, str(ROOT / 'ops/tests'))
from test_fleet_executor import PhysicalExecutorTest  # noqa: E402
from test_fleet_executor_authority import CentralAuthorityAdapterTest  # noqa: E402
from test_fleet_executor_container import DisposableContainerExecutorTest  # noqa: E402


def canonical_cli(mode):
    central = CentralAuthorityAdapterTest()
    central.setUp()
    case = DisposableContainerExecutorTest() if mode == 'container' else PhysicalExecutorTest()
    case.setUp()
    try:
        if mode == 'container':
            case.image = command('docker', 'image', 'inspect', sys.argv[2], '--format', '{{.Id}}')
            case.configure_container(prefix='zz-canary-h7-trasladados-1025-')
        case.configure_signer()
        alias = 'zz-canary-cli-' + mode
        def mapped(document):
            return json.loads(json.dumps(document).replace('physical-one', 'physical-a')
                              .replace('shared_alias', alias).replace('Equipo_42', 'Steven'))
        case.policy, case.agent, case.context = mapped(case.policy), mapped(case.agent), mapped(case.context)
        case.save_policy()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = case.run_step(step, timeout=60)
            assert result.returncode == 0, step + ': ' + result.stderr
        if mode == 'container':
            assert json.loads(command('docker', 'inspect', case.container))[0]['State']['Running'] is True
        else:
            process = json.loads((case.roots['runtime'] / '.control/physical-a/cauce-v3-adapter.json').read_text())['pid']
            assert pathlib.Path('/proc', str(process)).exists()
        _, pki, env, metadata, units, fingerprint = prepare(alias, mode)
        manifest = json.loads(metadata.read_text())
        manifest['runtime_key'] = case.agent['runtime_key']
        write(metadata, json.dumps(manifest))
        orphan_bundle = None
        orphan_pid = None
        if mode == 'container':
            observed_container = json.loads(command('docker', 'inspect', case.container))[0]
            uid, gid = 65534, 65534
            package_root = '/run/cauce-pty-agent-' + alias
            orphan_bundle = '/run/cauce-pty-' + alias + '/bundle.json'
            package = {filename.name: filename.read_text() for filename in (ROOT / 'ops/pty-agent/cauce_pty_agent').glob('*.py')}
            package['contexto-de-gobierno.json'] = (ROOT / 'ops/schemas/contexto-de-gobierno.json').read_text()
            install = ('import json,pathlib,os,sys;root=pathlib.Path(sys.argv[1]);root.mkdir(mode=0o755);'
                       'module=root/"cauce_pty_agent";module.mkdir(mode=0o755);'
                       '\nfor name,body in json.load(sys.stdin).items():\n p=module/name;p.write_text(body);p.chmod(0o644)\n'
                       'bundle=pathlib.Path(sys.argv[2]).parent;bundle.mkdir(mode=0o700);os.chown(bundle,65534,65534)')
            subprocess.run(['docker', 'exec', '-i', '--user', '0', case.container, '/usr/bin/python3', '-I', '-B', '-c',
                            install, package_root, orphan_bundle], input=json.dumps(package), text=True, capture_output=True, check=True)
            bundle = {'tenant_id': 'Steven', 'alias': alias, 'container_id': observed_container['Id'],
                      'generation': 'a' * 32, 'image_id': observed_container['Image'], 'runtime_user': 'nobody',
                      'runtime_uid': uid, 'runtime_gid': gid, 'home': '/nonexistent', 'harness': 'codex',
                      'agent_version': 'zz-canary-h7', 'relay_host': '127.0.0.1', 'relay_port': 8445,
                      'alias_key_hex': '0' * 64, 'shell_candidates': [['/bin/sh', '-l']],
                      'client_cert_pem': (pki / 'client.crt').read_text(), 'client_key_pem': (pki / 'client.key').read_text(),
                      'ca_pem': (pki / 'ca.crt').read_text()}
            install_bundle = 'import pathlib,sys,os;p=pathlib.Path(sys.argv[1]);p.write_bytes(sys.stdin.buffer.read());p.chmod(0o600)'
            subprocess.run(['docker', 'exec', '-i', '--user', '65534:65534', case.container, '/usr/bin/python3', '-I', '-B', '-c',
                            install_bundle, orphan_bundle], input=json.dumps(bundle), text=True, capture_output=True, check=True)
            command('docker', 'exec', '-d', '--user', '65534:65534', '-e', 'PYTHONPATH=' + package_root,
                    '-e', 'TMPDIR=' + str(pathlib.PurePosixPath(orphan_bundle).parent),
                    case.container, '/bin/sh', '-c',
                    'exec /usr/bin/python3 -m cauce_pty_agent --bundle "$1" > "$2" 2>&1',
                    'pty', orphan_bundle, orphan_bundle + '.log')
            probe = ('import pathlib,sys;expected=[b"/usr/bin/python3",b"-m",b"cauce_pty_agent",b"--bundle",sys.argv[1].encode()];'
                     'matches=[]\nfor directory in pathlib.Path("/proc").iterdir():\n'
                     ' if not directory.name.isdigit():continue\n'
                     ' try:actual=(directory/"cmdline").read_bytes().rstrip(b"\\0").split(b"\\0")\n'
                     ' except FileNotFoundError:continue\n'
                     ' if actual==expected:matches.append(directory.name)\n'
                     'assert len(matches)==1;print(matches[0])')
            try:
                orphan_pid = command('docker', 'exec', '--user', '65534:65534', case.container,
                                     '/usr/bin/python3', '-I', '-B', '-c', probe, orphan_bundle)
            except subprocess.CalledProcessError as error:
                diagnostic = command('docker', 'exec', '--user', '65534:65534', case.container,
                                     '/bin/cat', orphan_bundle + '.log')
                raise AssertionError('PTY startup failed: ' + diagnostic[-1000:] + '\nProbe: ' + error.stderr[-500:]) from None
            write(env, env.read_text() + 'CONTAINER_RUNTIME_DIR=/run\n')
        location = central.root / 'pty_agent_identities.json'
        foreign = {'tenant_id': 'Other', 'alias': alias, 'fingerprint_sha256': 'B' * 64, 'expires_at': '2099-01-01T00:00:00Z'}
        target = {**foreign, 'tenant_id': 'Steven', 'fingerprint_sha256': fingerprint.upper()}
        write(location, json.dumps({'version': 1, 'agents': [target, foreign]}))
        central.registries['pty'] = str(location)
        central.agent = case.agent
        central.policy['host_id'] = case.policy['host_id']
        operation = str(uuid.uuid4())
        central.scope.update(operation_id=operation, host_id=case.policy['host_id'])
        case.context.update(operation_id=operation, fleet_scope=central.scope,
                            previous_agents=[copy.deepcopy(case.agent)], fenced_targets=[case.context['request']['target']])
        case.context['request'].update(kind='purge', parameters={'confirm_alias': alias})
        case.policy.pop('signer')
        case.policy['authority'] = {**central.policy['authority'], 'host_id': case.policy['host_id']}
        driver = case.root / 'terminal-revocation-hook.py'
        driver.write_text('import json,sys\n'
            f'sys.path.insert(0,{str(ROOT / "ops/cli")!r})\n'
            'from fleet_executor_authority import verify_absence\n'
            'packet=json.load(sys.stdin)\n'
            'verify_absence(packet["cauce_credentials"]["central"],packet["agent"],packet["operation_id"])\n'
            'result={key:packet[key] for key in ("nonce","account_id","identity")}\n'
            'result.update({key:packet["agent"][key] for key in ("tenant_id","alias","runtime_key")})\n'
            'result["revocation_verified"]=True\nprint(json.dumps(result))\n')
        case.policy['hooks']['revoke'] = {'executable': str(case.executable),
            'sha256': hashlib.sha256(case.executable.read_bytes()).hexdigest(), 'argv': [str(driver)],
            'files': {str(driver): hashlib.sha256(driver.read_bytes()).hexdigest()}, 'user': case.user}
        case.save_policy()
        for step in ('stop', 'revoke'):
            result = case.run_step(step, timeout=60)
            assert result.returncode == 0, step + ': ' + result.stderr
        if mode == 'container':
            assert command('docker', 'exec', '--user', '65534:65534', case.container,
                           '/usr/bin/python3', '-I', '-B', '-c', probe, orphan_bundle) == orphan_pid
            pki.chmod(0o500)
            failed = case.run_step('purge', timeout=60)
            assert failed.returncode != 0
            assert orphan_bundle is not None and orphan_pid is not None
            gone = subprocess.run(['docker', 'exec', '--user', '65534:65534', case.container,
                '/usr/bin/python3', '-I', '-B', '-c',
                'import pathlib,sys;p=pathlib.Path("/proc",sys.argv[2],"cmdline");assert not pathlib.Path(sys.argv[1]).exists();'
                'assert not p.exists() or not p.read_bytes()', orphan_bundle, orphan_pid],
                capture_output=True, text=True)
            assert gone.returncode == 0, 'orphan bundle survived first purge: ' + failed.stderr
            pki.chmod(0o700)
        result = case.run_step('purge', timeout=60)
        assert result.returncode == 0, 'purge: ' + result.stderr
        receipt = json.loads(result.stdout)['evidence']
        replay = case.run_step('purge', timeout=60)
        assert replay.returncode == 0, 'replay: ' + replay.stderr
        assert json.loads(replay.stdout)['evidence'] == receipt
        assert json.loads(location.read_text()) == {'version': 1, 'agents': [foreign]}
        assert not any(os.path.lexists(filename) for filename in (pki, env, metadata))
        if mode == 'container':
            assert command('docker', 'ps', '-aq', '--filter', 'name=^/' + case.container + '$') == ''
        else:
            assert not pathlib.Path('/proc', str(process)).exists()
            assert not pathlib.Path(case.agent['state_directory']).exists()
        after = [systemctl('show', unit, '--property=ActiveState', '--value') for unit in units]
        return {'after': after, 'replay_identical': True, 'relay_foreign_identity_preserved': True,
                'canonical_cli': True, 'runtime_removal_observed': True, 'orphan_cleaned_before_container_removal': orphan_bundle is not None,
                'orphan_live_before_purge': orphan_pid is not None,
                'removed': receipt['removed']}
    finally:
        if mode == 'container':
            case.tearDown()
        else:
            PhysicalExecutorTest.tearDown(case)
        central.tearDown()


CentralAuthorityAdapterTest.setUpClass()
try:
    for mode in ('native', 'container'):
        evidence[mode] = canonical_cli(mode)
finally:
    CentralAuthorityAdapterTest.tearDownClass()
print(json.dumps(evidence, sort_keys=True))
