from __future__ import annotations

import copy
import hashlib
import http.server
import importlib.util
import json
import multiprocessing
import os
import pathlib
import socketserver
import ssl
import subprocess
import sys
import threading

ROOT = pathlib.Path(sys.argv[2])
MODE = sys.argv[1]
INPUT = json.load(sys.stdin)
sys.path.insert(0, str(ROOT / 'ops/cli'))
sys.path.insert(0, str(ROOT / 'ops/tests'))
sys.path.insert(0, str(ROOT / 'ops/container-runtime'))
runtime_spec = importlib.util.spec_from_file_location('authority_live_fixture', ROOT / 'tests/e2e/v4-autoridad-pty-runtime.py')
runtime_module = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime_module)


def live_runtime():
    return runtime_module.LiveAuthorityFixture(ROOT, INPUT, command, write, digest)


def command(argv, *, data=None, user=None):
    if user is not None:
        argv = ['runuser', '-u', user, '--', 'env', 'XDG_RUNTIME_DIR=/run/user/1500',
                'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1500/bus', *argv]
    result = subprocess.run(argv, input=data, capture_output=True, text=True, timeout=180)
    if result.returncode:
        journal = ''
        if any(str(part).endswith('/fleet-authority-install.py') or str(part).startswith('zz-canary-h7d-') for part in argv):
            journal = subprocess.run(['journalctl', '--no-pager', '-u', 'zz-canary-h7d-authority.service',
                '-u', 'zz-canary-h7d-controller.service', '-n', '30', '-o', 'cat'],
                capture_output=True, text=True, check=False).stdout[-5000:]
        raise RuntimeError(f'{argv[0]} exit={result.returncode}: {result.stderr[-1500:]} {result.stdout[-1500:]} {journal}')
    return result.stdout


def write(filename, body, mode=0o600, owner=0, group=0):
    filename.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    filename.write_text(body)
    filename.chmod(mode)
    os.chown(filename, owner, group)


def digest(filename):
    return hashlib.sha256(filename.read_bytes()).hexdigest()


def native_setup():
    from cauce_container_base import bundle_digest
    from test_fleet_executor import PhysicalExecutorTest
    case = PhysicalExecutorTest()
    case.setUp()
    case.worker.write_text('import time\ntime.sleep(600)\n')
    case.policy['bundles']['codex']['digest'] = bundle_digest(str(case.bundle))
    case.configure_signer()
    for field in ('policy', 'context', 'agent'):
        value = json.loads(json.dumps(getattr(case, field)).replace('Equipo_42', INPUT['tenant'])
                           .replace('shared_alias', INPUT['alias']).replace('fixture-host', INPUT['host'])
                           .replace('physical-one', 'physical-a').replace('room: one', 'office'))
        setattr(case, field, value)
    case.save_policy()
    for step in ('artifacts', 'credentials', 'runtime'):
        result = case.run_step(step, timeout=60)
        assert result.returncode == 0, step + ': ' + result.stderr
    pid = json.loads((case.roots['runtime'] / '.control/physical-a/cauce-v3-adapter.json').read_text())['pid']
    assert pathlib.Path('/proc', str(pid)).exists()
    config = pathlib.Path.home() / '.config/cauce-v3'
    pki = config / 'pty-pki' / INPUT['alias']
    pki.mkdir(mode=0o700, parents=True)
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=zz-canary-h7d',
             '-keyout', str(pki / 'client.key'), '-out', str(pki / 'client.crt')])
    for name in ('client.key', 'client.crt'):
        (pki / name).chmod(0o600)
    fingerprint = hashlib.sha256(ssl.PEM_cert_to_DER_cert((pki / 'client.crt').read_text())).hexdigest()
    write(pki / 'ca.crt', (pki / 'client.crt').read_text(), owner=os.geteuid(), group=os.getegid())
    write(pki / 'alias-key.hex', '0' * 64, 0o400, os.geteuid(), os.getegid())
    env = config / 'pty-host' / (INPUT['alias'] + '.env')
    write(env, f'RELAY_HOST=127.0.0.1\nRELAY_PORT=8445\nPKI_DIR={pki}\nALIAS_KEY_FILE={pki}/alias-key.hex\n', owner=os.geteuid(), group=os.getegid())
    metadata = config / 'pty' / (INPUT['alias'] + '.migration.json')
    write(metadata, json.dumps({'schema_version': 1, 'tenant': INPUT['tenant'], 'alias': INPUT['alias'],
        'runtime_key': 'physical-a', 'client_cert_sha256': fingerprint}), owner=os.geteuid(), group=os.getegid())
    unit = pathlib.Path.home() / '.config/systemd/user' / ('cauce-v3-pty-host@' + INPUT['alias'] + '.service')
    write(unit, '[Service]\nExecStart=/bin/sleep infinity\n[Install]\nWantedBy=default.target\n', owner=os.geteuid(), group=os.getegid())
    command(['systemctl', '--user', 'daemon-reload'])
    command(['systemctl', '--user', 'enable', '--now', unit.name])
    record = {'root': str(case.root), 'roots': {key: str(value) for key, value in case.roots.items()},
              'policy_file': str(case.policy_file), 'context': case.context, 'agent': case.agent,
              'pid': pid, 'pki': str(pki), 'env': str(env), 'metadata': str(metadata), 'unit': unit.name,
              'fingerprint': fingerprint}
    record_path = case.root / 'h7d-case.json'
    write(record_path, json.dumps(record), owner=os.geteuid(), group=os.getegid())
    case.temporary._finalizer.detach()
    print(json.dumps({'record': str(record_path), **record}))


def native_purge():
    from test_fleet_executor import PhysicalExecutorTest
    record = json.loads(pathlib.Path(INPUT['record']).read_text())
    case = PhysicalExecutorTest()
    case.root = pathlib.Path(record['root'])
    case.roots = {key: pathlib.Path(value) for key, value in record['roots'].items()}
    case.user = 'cauce'
    case.policy_file = pathlib.Path(record['policy_file'])
    case.policy = json.loads(case.policy_file.read_text())
    case.agent, case.context = record['agent'], record['context']
    case.policy.pop('signer')
    case.policy['authority'] = {'socket_path': INPUT['socket'], 'owner_uid': os.geteuid(),
        'host_id': INPUT['scope']['host_id'], 'ca_certificate': INPUT['ca']}
    case.context.update(operation_id=INPUT['scope']['operation_id'], fleet_scope=INPUT['scope'],
                        previous_agents=[copy.deepcopy(case.agent)], fenced_targets=[case.context['request']['target']])
    case.context['request'].update(kind='purge', parameters={'confirm_alias': case.agent['alias']})
    driver = case.root / 'h7d-revoke.py'
    driver.write_text('import json,sys\n' + f'sys.path.insert(0,{str(ROOT / "ops/cli")!r})\n'
        'from fleet_executor_authority import verify_absence\np=json.load(sys.stdin)\n'
        'verify_absence(p["cauce_credentials"]["central"],p["agent"],p["operation_id"])\n'
        'r={k:p[k] for k in ("nonce","account_id","identity")}\n'
        'r.update({k:p["agent"][k] for k in ("tenant_id","alias","runtime_key")})\n'
        'r["revocation_verified"]=True\nprint(json.dumps(r))\n')
    case.policy['hooks']['revoke'] = {'executable': str(pathlib.Path(sys.executable).resolve()),
        'sha256': digest(pathlib.Path(sys.executable).resolve()), 'argv': [str(driver)],
        'files': {str(driver): digest(driver)}, 'user': 'cauce'}
    case.save_policy()
    assert pathlib.Path('/proc', str(record['pid'])).exists()
    for step in ('stop', 'revoke', 'purge'):
        result = case.run_step(step, timeout=60)
        assert result.returncode == 0, step + ': ' + result.stderr
    assert not pathlib.Path('/proc', str(record['pid'])).exists()
    assert not any(pathlib.Path(record[key]).exists() for key in ('pki', 'env', 'metadata'))
    assert command(['systemctl', '--user', 'show', record['unit'], '--property=ActiveState', '--value']).strip() == 'inactive'
    print(json.dumps({'cli_purge': True, 'runtime_removed': True, 'pty_removed': True}))


def installer_arguments():
    return ['--fleet-config', '/etc/cauce-v3/fleet-v35', '--tools-base', str(ROOT.parent),
        '--controller-service', 'zz-canary-h7d-controller.service', '--unit', '/etc/systemd/system/zz-canary-h7d-authority.service',
        '--tmpfiles', '/etc/tmpfiles.d/zz-canary-h7d-authority.conf', '--socket-directory', INPUT['socket_directory'],
        '--gateway-container', INPUT['gateway_container']]


def setup():
    public = {key: INPUT[key] for key in ('tenant', 'alias', 'host')}
    native = json.loads(command(['python3', '-B', __file__, 'native-setup', str(ROOT)], data=json.dumps(public), user='cauce'))
    fleet = pathlib.Path('/etc/cauce-v3/fleet-v35')
    controller = fleet / 'controller'
    enclave = fleet / 'signed-authority'
    for path in (controller, enclave):
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
    state = pathlib.Path('/var/lib/zz-canary-h7d-authority/state')
    state.mkdir(mode=0o700, parents=True)
    registries = {}
    for name in ('base_mtls', 'base_token', 'fleet_mtls', 'fleet_token'):
        parent = state.parent / name
        parent.mkdir(mode=0o700)
        owner = 1000 if name.startswith('base_') else 0
        os.chown(parent, owner, 1000)
        filename = parent / ('mtls_identities.json' if name.endswith('mtls') else 'token_hashes.json')
        write(filename, json.dumps({'version': 1, 'identities': []}), 0o400 if owner else 0o640, owner, 1000)
        registries[name] = str(filename)
    allowlist = pathlib.Path('/etc/cauce-v3/terminal/pty_agent_identities.json')
    allowlist.parent.mkdir(mode=0o750)
    os.chown(allowlist.parent, 1000, 1000)
    target = {'tenant_id': INPUT['tenant'], 'alias': INPUT['alias'], 'fingerprint_sha256': native['fingerprint'], 'expires_at': '2099-01-01T00:00:00Z'}
    foreign = {**target, 'tenant_id': 'Other', 'fingerprint_sha256': 'B' * 64}
    write(allowlist, json.dumps({'version': 1, 'agents': [target, foreign]}), 0o440, 1000, 1000)
    write(allowlist.with_name(allowlist.name + '.lock'), '', 0o644)
    ca, key = state.parent / 'ca.crt', state.parent / 'ca.key'
    command(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=zz-canary-h7d-authority',
        '-keyout', str(key), '-out', str(ca), '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'])
    key.chmod(0o600)
    policy = {'version': 1, 'state_root': str(state), 'registries': registries, 'base_registry_owner_uid': 1000,
        'signer': {'certificate': str(ca), 'key': str(key), 'certificate_sha256': digest(ca), 'key_sha256': digest(key)}}
    policy_file = controller / 'authority.v1.json'
    def canonical(document):
        return json.dumps(document, indent=2) + '\n'
    write(policy_file, canonical(policy))
    executable = ROOT / 'ops/cli/fleet-authority-issuer.py'
    issuer = {'python': '/usr/bin/python3', 'executable': str(executable), 'sha256': digest(executable),
              'policy_file': str(policy_file), 'policy_sha256': digest(policy_file)}
    write(controller / 'controller.v1.json', canonical({'version': 1, 'authority_command': issuer}))
    write(enclave / 'command.v1.json', canonical(issuer))
    database = controller / 'database-url'
    write(database, INPUT['database_url'])
    write(controller / 'controller.env', f'CAUCE_FLEET_PROJECT_ROOT={ROOT}\nCAUCE_FLEET_DATABASE_URL_FILE={database}\n')
    unit = pathlib.Path('/etc/systemd/system/zz-canary-h7d-controller.service')
    write(unit, f'[Service]\nExecStart=/usr/local/bin/node {ROOT}/app/services/gateway/dist/fleet/main.js\n', 0o644)
    write(pathlib.Path('/etc/systemd/system/zz-canary-h7d-authority.service'),
          '[Service]\nExecStart=/bin/false\n[Install]\nWantedBy=multi-user.target\n', 0o644)
    runtime = live_runtime()
    runtime.configure()
    command(['systemctl', 'daemon-reload'])
    command(['python3', '-B', str(ROOT / 'ops/scripts/fleet-authority-install.py'), '--apply', *installer_arguments()])
    baseline = runtime.start()
    print(json.dumps({'native': native, 'registry_count': len(registries), 'unit_active': True, 'live_baseline': baseline}))


def transport(connection, socket):
    os.setgroups([])
    os.setgid(1500)
    os.setuid(1500)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self):
            packet = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            connection.send((self.path, packet))
            response = connection.recv()
            body = json.dumps(response).encode()
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = socketserver.UnixStreamServer(socket, Handler)
    os.chmod(socket, 0o600)
    connection.send('ready')
    server.serve_forever()


def exercise():
    runtime = live_runtime()
    live_before = runtime.verify()
    fleet = pathlib.Path('/etc/cauce-v3/fleet-v35')
    policy_file = fleet / 'controller/authority.v1.json'
    allowlist = pathlib.Path('/etc/cauce-v3/terminal/pty_agent_identities.json')
    def snapshot():
        files = [*fleet.rglob('*'), *allowlist.parent.iterdir(), pathlib.Path('/etc/systemd/system/zz-canary-h7d-authority.service'),
                 pathlib.Path('/etc/tmpfiles.d/zz-canary-h7d-authority.conf')]
        return {str(p): (digest(p), p.stat().st_uid, p.stat().st_gid, p.stat().st_mode, p.stat().st_ino) for p in files if p.is_file()}
    before = snapshot()
    invocation = [str(ROOT / '.delegados/v4/autoridad-pty.sh'), '--ops-root', str(ROOT / 'ops'),
        '--backup-root', '/var/backups/cauce-v3/authority-pty-h7e', '--executor-host', INPUT['host'], *installer_arguments()]
    command([*invocation, '--simular'])
    assert snapshot() == before
    receipt = pathlib.Path(INPUT['receipt'])
    command([*invocation, '--aplicar', '--recibo', str(receipt)])
    backup_verification = runtime.verify_receipt(receipt)
    live_after = runtime.verify()
    assert all(live_before['pids'][unit] != live_after['pids'][unit] for unit in live_before['pids'])
    assert len(json.loads(policy_file.read_text())['registries']) == 5
    assert stat_mode(allowlist.with_name(allowlist.name + '.lock')) == 0o600
    assert snapshot()[str(allowlist)] == before[str(allowlist)]
    assert snapshot()[str(allowlist) + '.lock'][-1] == before[str(allowlist) + '.lock'][-1]
    controller = fleet / 'controller/controller.v1.json'
    controller.chmod(0o640)
    current = snapshot()
    try:
        command([*invocation, '--revertir', '--recibo', str(receipt)])
    except RuntimeError:
        pass
    else:
        raise AssertionError('rollback accepted changed file mode')
    assert snapshot() == current
    controller.chmod(0o600)
    spec = importlib.util.spec_from_file_location('h7d_issuer', ROOT / 'ops/cli/fleet-authority-issuer.py')
    issuer = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(issuer)
    expected_scope = {**INPUT['scope'], 'runtime_key': 'physical-a'}
    agent = {key: INPUT['native']['agent'][key] for key in ('tenant_id', 'alias')}
    packet = {'action': 'inventory', 'agent': agent, 'scope': {key: expected_scope[key] for key in ('operation_id', 'host_id', 'scope_sha256', 'runtime_key')}}
    inventory = issuer.perform(json.loads(policy_file.read_text()), packet)
    assert len(inventory['authorities']) == 5
    private = pathlib.Path('/home/cauce/.h7d-authority-proxy')
    private.mkdir(mode=0o700)
    os.chown(private, 1500, 1500)
    ca = private / 'ca.crt'
    write(ca, pathlib.Path(json.loads(policy_file.read_text())['signer']['certificate']).read_text(), 0o644, 1500, 1500)
    parent, child = multiprocessing.Pipe()
    socket = str(private / 'authority.sock')
    proxy = multiprocessing.Process(target=transport, args=(child, socket))
    proxy.start()
    assert parent.recv() == 'ready'
    failures = []

    def serve():
        try:
            while True:
                path, request = parent.recv()
                if path == '/authority-ready':
                    issuer.readiness(json.loads(policy_file.read_text()))
                    response = {'ready': True, 'host_id': expected_scope['host_id']}
                else:
                    assert path == '/authority' and request['scope'] == expected_scope
                    request['scope'] = {key: expected_scope[key] for key in ('operation_id', 'host_id', 'scope_sha256', 'runtime_key')}
                    response = issuer.perform(json.loads(policy_file.read_text()), {**request, 'agent': agent})
                parent.send(response)
        except (EOFError, OSError):
            return
        except Exception as error:
            failures.append(type(error).__name__)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        purge = json.loads(command(['python3', '-B', __file__, 'native-purge', str(ROOT)], user='cauce', data=json.dumps({
            'record': INPUT['native']['record'], 'scope': INPUT['scope'], 'socket': socket, 'ca': str(ca)})))
        assert not failures
        remaining = json.loads(allowlist.read_text())['agents']
        assert len(remaining) == 1 and remaining[0]['tenant_id'] == 'Other'
        command([*invocation, '--revertir', '--simular', '--recibo', str(receipt)])
        command([*invocation, '--revertir', '--recibo', str(receipt)])
        live_reverted = runtime.verify()
        assert all(live_after['pids'][unit] != live_reverted['pids'][unit] for unit in live_after['pids'])
        assert len(json.loads(policy_file.read_text())['registries']) == 4
        assert json.loads(allowlist.read_text())['agents'] == remaining
        assert allowlist.stat().st_uid == 1000 and stat_mode(allowlist) == 0o440
        assert stat_mode(allowlist.with_name(allowlist.name + '.lock')) == 0o644
        assert command(['systemctl', 'is-active', 'zz-canary-h7d-authority.service']).strip() == 'active'
        failed_receipt = receipt.with_name('authority-pty-failed-receipt.json')
        try:
            command([*invocation, '--gateway-container', INPUT['gateway_container'] + '-missing',
                     '--aplicar', '--recibo', str(failed_receipt)])
        except RuntimeError:
            pass
        else:
            raise AssertionError('installer accepted an absent gateway')
        persistent_status = json.loads(failed_receipt.read_text())['status']
        assert persistent_status == 'failed-requires-reconciliation'
        write(failed_receipt.with_name('authority-pty-failed-before-retry.json'), failed_receipt.read_text())
        assert len(json.loads(policy_file.read_text())['registries']) == 4
        assert json.loads(allowlist.read_text())['agents'] == remaining
        assert stat_mode(allowlist.with_name(allowlist.name + '.lock')) == 0o644
        assert command(['systemctl', 'is-active', 'zz-canary-h7d-authority.service']).strip() == 'active'
        command([*invocation, '--revertir', '--recibo', str(failed_receipt)])
        assert json.loads(failed_receipt.read_text())['status'] == 'reverted'
        live_failures = [runtime.failure(invocation, mode, receipt.with_name('authority-pty-' + mode + '-failed.json'))
                         for mode in ('readiness', 'capabilities')]
        default_receipt = runtime.default_receipt_cycle(invocation, receipt.with_name('authority-pty-default-receipt.json'))
        evidence = {'simulation_unchanged': True, 'authorities_after_apply': 5, 'authorities_after_revert': 4,
            'canonical_installer_active': True, 'canonical_cli_purge': purge, 'foreign_identity_preserved': True,
            'allowlist_not_restored': True, 'rollback_cas_rejected_before_writes': True,
            'persistent_gateway_failure_rejected': True, 'persistent_gateway_failure_status': persistent_status,
            'valid_gateway_retry_verified': True, 'receipt': str(receipt),
            'live_controller_and_enclave': True, 'controller_pin_loaded_at_start': True,
            'both_services_restarted_after_apply_and_revert': True, 'live_failure_compensation': live_failures,
            'backup_verification': backup_verification, 'default_receipt_cycle': default_receipt,
            'baseline': live_before, 'applied': live_after, 'reverted': live_reverted}
        write(receipt.with_name('authority-pty-before-preflight.json'), json.dumps(evidence, indent=2) + '\n')
        evidence['full_upgrade_preflight'] = runtime.preflight()
        print(json.dumps(evidence))
    finally:
        proxy.terminate()
        proxy.join(timeout=10)
        parent.close()


def stat_mode(filename):
    return filename.stat().st_mode & 0o777


if MODE == 'setup':
    setup()
elif MODE == 'exercise':
    exercise()
elif MODE == 'native-setup':
    native_setup()
elif MODE == 'native-purge':
    native_purge()
else:
    raise RuntimeError('unsupported fixture phase')
