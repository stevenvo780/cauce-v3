from __future__ import annotations

import http.client
import json
import pathlib
import re
import socket


class LiveAuthorityFixture:
    def __init__(self, root, inputs, command, write, digest):
        self.root, self.inputs = root, inputs
        self.command, self.write, self.digest = command, write, digest
        self.fleet = pathlib.Path('/etc/cauce-v3/fleet-v35')
        self.controller = self.fleet / 'controller'
        self.state = pathlib.Path('/var/lib/zz-canary-h7e-authority')
        self.socket = pathlib.Path('/run/zz-canary-h7e-controller/authority.sock')
        self.unit = 'zz-canary-h7d-controller.service'
        self.enclave = 'zz-canary-h7d-authority.service'
        self.policy = self.controller / 'executor.server.v1.json'
        self.initial_backups = self.configuration_backups()

    def configuration_backups(self):
        parents = (self.fleet, pathlib.Path('/etc/systemd/system'), pathlib.Path('/etc/tmpfiles.d'),
                   pathlib.Path('/etc/cauce-v3/terminal'))
        return {str(path) for parent in parents for pattern in ('*.pre-pty-*', '*.pre-authority-*')
                for path in parent.rglob(pattern)}

    def verify_receipt(self, filename):
        receipt = json.loads(filename.read_text())
        directory = pathlib.Path(receipt['backup_directory'])
        assert directory.is_absolute() and directory.is_relative_to('/var/backups/cauce-v3/authority-pty-h7e')
        assert not directory.is_relative_to('/etc') and not directory.is_relative_to(self.inputs['socket_directory'])
        assert re.fullmatch(r'\d{8}T\d{6}Z-[a-f0-9]{8}', directory.name)
        details = directory.stat()
        assert details.st_uid == 0 and details.st_mode & 0o777 == 0o700
        assert filename.stat().st_uid == 0 and filename.stat().st_mode & 0o777 == 0o600
        backups = 0
        for item in receipt['files']:
            if item['before'] is None:
                assert item['backup'] is None
                continue
            backup = pathlib.Path(item['backup'])
            assert backup.parent == directory
            observed = backup.stat()
            assert self.digest(backup) == item['before']['sha256']
            assert (observed.st_uid, observed.st_gid, observed.st_mode & 0o777) == tuple(item['before'][key] for key in ('uid', 'gid', 'mode'))
            backups += 1
        assert self.configuration_backups() == self.initial_backups
        return {'private_root_directory': True, 'dated_directory': True, 'backups_outside_configuration': True,
                'backup_hash_and_metadata_verified': True, 'verified_backups': backups, 'configuration_backups_unchanged': True}

    def configure(self):
        from test_fleet_executor import PhysicalExecutorTest
        case = PhysicalExecutorTest()
        case.setUp()
        case.configure_signer()
        case.configure_hooks()
        case.policy['hooks']['revoke'] = dict(case.policy['hooks']['verify'])
        profile = case.policy['profiles']['fixture-account']
        profile.update(command=str(case.executable), command_sha256=self.digest(case.executable))
        case.policy['host_id'] = self.inputs['host']
        case.policy.pop('signer')
        authority = json.loads((self.controller / 'authority.v1.json').read_text())
        case.policy['authority'] = {'socket_path': str(self.socket), 'owner_uid': 0,
            'host_id': self.inputs['host'], 'ca_certificate': authority['signer']['certificate']}
        self.write(self.policy, json.dumps(case.policy, indent=2) + '\n')
        case.temporary._finalizer.detach()
        self.socket.parent.mkdir(mode=0o700, parents=True)
        document = json.loads((self.controller / 'controller.v1.json').read_text())
        execution = {'python': '/usr/bin/python3', 'executable': str(self.root / 'ops/cli/fleet-executor.py'),
                     'policyFile': str(self.policy), 'timeoutMs': 150000}
        document.update(controller_host=self.inputs['host'], hosts=[{'host_id': self.inputs['host'],
            'command': execution, 'authority_socket': str(self.socket)}])
        self.write(self.controller / 'controller.v1.json', json.dumps(document, indent=2) + '\n')
        self.write(self.controller / 'auth.server.v1.json', '{}\n')
        environment = {'CAUCE_FLEET_PROJECT_ROOT': str(self.root), 'CAUCE_FLEET_HOST': self.inputs['host'],
            'CAUCE_FLEET_WORKER_ID': 'h7e-live-controller', 'CAUCE_FLEET_DATABASE_URL_FILE': str(self.controller / 'database-url'),
            'CAUCE_FLEET_PYTHON': execution['python'], 'CAUCE_FLEET_EXECUTABLE': execution['executable'],
            'CAUCE_FLEET_POLICY_FILE': str(self.policy), 'CAUCE_FLEET_CONTROLLER_FILE': str(self.controller / 'controller.v1.json'),
            'CAUCE_FLEET_POLL_MS': '60000'}
        self.write(self.controller / 'controller.env', ''.join(f'{key}={value}\n' for key, value in environment.items()))
        self.state.mkdir(mode=0o700, parents=True, exist_ok=True)
        control = self.state / 'controller-control.py'
        descriptor = case.bundle / 'packages/adapter-sdk/dist/descriptors/codex.json'
        source = CONTROL_SOURCE
        constants = {'mode': None, 'key': authority['signer']['key'], 'descriptor': str(descriptor),
            'marker': str(self.state / 'fail-next'), 'active': str(self.state / 'active-failure'),
            'observations': str(self.state / 'observations.jsonl'), 'socket': str(self.socket),
            'executor': execution['executable'], 'policy': str(self.policy)}
        self.write(control, 'CONFIG=' + repr(constants) + '\n' + source, 0o700)
        unit = pathlib.Path('/etc/systemd/system') / self.unit
        self.write(unit, '[Service]\nType=simple\nEnvironmentFile=' + str(self.controller / 'controller.env')
            + '\nExecStartPre=/usr/bin/python3 ' + str(control) + ' pre\nExecStart=/usr/local/bin/node '
            + str(self.root / 'app/services/gateway/dist/fleet/main.js')
            + '\nExecStartPost=/usr/bin/python3 ' + str(control) + ' post\nTimeoutStopSec=15\n[Install]\nWantedBy=multi-user.target\n', 0o644)

    def start(self):
        self.command(['systemctl', 'daemon-reload'])
        self.command(['systemctl', 'start', self.unit])
        result = self.verify()
        self.write(self.fleet / 'gateway/capability.v1.json', json.dumps(result['executor'], indent=2) + '\n', 0o600, 1000, 1000)
        return result

    def ready(self):
        connection = http.client.HTTPConnection('localhost', timeout=5)
        endpoint = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        endpoint.settimeout(5)
        endpoint.connect(str(self.socket))
        connection.sock = endpoint
        try:
            connection.request('POST', '/authority-ready', '{}', {'Content-Type': 'application/json'})
            response = connection.getresponse()
            return {'status': response.status, 'body': json.loads(response.read(4096))}
        finally:
            connection.close()

    def verify(self):
        for unit in (self.unit, self.enclave):
            assert self.command(['systemctl', 'is-active', unit]).strip() == 'active'
        ready = self.ready()
        assert ready == {'status': 200, 'body': {'ready': True, 'host_id': self.inputs['host']}}
        capability = json.loads(self.command(['/usr/bin/python3', '-B', str(self.root / 'ops/cli/fleet-executor.py'),
            '--policy', str(self.policy), '--capabilities']))
        assert capability['available'] is True
        assert set(capability['actions']) == {'create', 'update', 'start', 'stop', 'retire', 'restore', 'purge'}
        assert [placement['host_id'] for placement in capability['placements']] == [self.inputs['host']]
        return {'controller': ready, 'executor': capability,
            'pids': {unit: int(self.command(['systemctl', 'show', unit, '-p', 'MainPID', '--value']).strip())
                     for unit in (self.unit, self.enclave)}}

    def failure(self, invocation, mode, receipt):
        before = self.verify()
        paths = [self.controller / name for name in ('authority.v1.json', 'controller.v1.json', 'executor.server.v1.json')]
        hashes = {str(path): self.digest(path) for path in paths}
        self.write(self.state / 'fail-next', mode)
        try:
            self.command([*invocation, '--verification-timeout', '2', '--aplicar', '--recibo', str(receipt)])
        except RuntimeError:
            pass
        else:
            raise AssertionError('a failed live verification was accepted')
        assert json.loads(receipt.read_text())['status'] == 'reverted'
        assert {str(path): self.digest(path) for path in paths} == hashes
        after = self.verify()
        assert all(before['pids'][unit] != after['pids'][unit] for unit in before['pids'])
        observations = [json.loads(line) for line in (self.state / 'observations.jsonl').read_text().splitlines()]
        failed = [row for row in observations if row['mode'] == mode]
        assert failed
        if mode == 'readiness':
            assert any(row.get('status') == 409 and row.get('error') == 'AUTHORITY_UNAVAILABLE' for row in failed)
        else:
            assert any(row.get('executor_available') is False for row in failed)
        backup = self.verify_receipt(receipt)
        return {'mode': mode, 'compensated': True, 'previous_config_restored': True,
                'both_services_restarted': True, 'live_failure_observed': True, 'backup_verification': backup}

    def default_receipt_cycle(self, invocation, output):
        before = self.verify()
        applied = self.command([*invocation, '--aplicar'])
        packets = []
        for line in applied.splitlines():
            try:
                packet = json.loads(line)
            except ValueError:
                continue
            if isinstance(packet, dict) and packet.get('status') == 'applied':
                packets.append(packet)
        assert len(packets) == 1
        receipt = pathlib.Path(packets[0]['receipt'])
        document = json.loads(receipt.read_text())
        assert receipt.parent == pathlib.Path(document['backup_directory'])
        backup = self.verify_receipt(receipt)
        after = self.verify()
        assert all(before['pids'][unit] != after['pids'][unit] for unit in before['pids'])
        self.command([*invocation, '--revertir', '--recibo', str(receipt)])
        reverted = self.verify()
        assert all(after['pids'][unit] != reverted['pids'][unit] for unit in after['pids'])
        assert json.loads(receipt.read_text())['status'] == 'reverted'
        self.verify_receipt(receipt)
        self.write(output, receipt.read_text())
        return {'applied_without_receipt_flag': True, 'receipt_in_private_backup_directory': True,
                'reverted_and_verified': True, 'backup_verification': backup}

    def preflight(self):
        work = pathlib.Path('/run/zz-canary-h7e-upgrade')
        work.mkdir(mode=0o700)
        assert self.command(['stat', '-f', '-c', '%T', str(work)]).strip() == 'tmpfs'
        runtime = self.state / 'runtime-reference'
        self.write(runtime, 'CAUCE_RUNTIME_IMAGE=' + self.inputs['runtime_image'] + '\n')
        source = self.root.parent.parent / 'upgrade-source'
        source.mkdir(mode=0o700)
        self.command(['cp', '-a', str(self.root / 'ops'), str(source / 'ops')])
        self.write(source / '.release-sha', self.inputs['new_release'] + '\n')
        result = self.command(['/usr/bin/python3', '-B', str(self.root / 'ops/scripts/fleet-controller-upgrade.py'),
            '--release', self.inputs['new_release'], '--runtime-image-from', str(runtime), '--ops-source', str(source),
            '--adapter-bundle', str(self.root / 'adapter'), '--tools-base', str(self.root.parent),
            '--fleet-config', str(self.fleet), '--unit', '/etc/systemd/system/' + self.unit,
            '--state-root', str(self.state), '--runtime-directory', str(self.socket.parent), '--work-root', str(work),
            '--host-id', self.inputs['host'], '--rehearse'])
        assert 'RESULT: preflight OK; nothing was written outside the kit' in result
        assert not (self.root.parent / self.inputs['new_release']).exists()
        assert self.configuration_backups() == self.initial_backups
        return {'full_script': True, 'preflight_green': True, 'different_release': self.root.name != self.inputs['new_release'],
                'rehearse': True, 'simulate_apply': False, 'namespace_overlay_work_filesystem': 'tmpfs', 'output': result}


CONTROL_SOURCE = r'''
import http.client,json,pathlib,socket,subprocess,sys,time
c=CONFIG; key=pathlib.Path(c['key']);descriptor=pathlib.Path(c['descriptor']);backup=descriptor.with_suffix('.disabled')
active=pathlib.Path(c['active']);marker=pathlib.Path(c['marker'])
if sys.argv[1]=='pre':
 key.chmod(0o600)
 if backup.exists():backup.rename(descriptor)
 mode=marker.read_text() if marker.exists() else 'normal'
 if marker.exists():marker.unlink()
 active.write_text(mode)
 if mode=='readiness':key.chmod(0o644)
 if mode=='capabilities':descriptor.rename(backup)
else:
 result={'mode':active.read_text()}
 for _ in range(100):
  try:
   endpoint=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);endpoint.settimeout(1);endpoint.connect(c['socket'])
   connection=http.client.HTTPConnection('localhost',timeout=1);connection.sock=endpoint
   connection.request('POST','/authority-ready','{}',{'Content-Type':'application/json'})
   response=connection.getresponse();body=json.loads(response.read(4096));connection.close()
   result.update(status=response.status,ready=body.get('ready') is True,error=body.get('error'));break
  except (OSError,ValueError):time.sleep(.1)
 output=subprocess.run(['/usr/bin/python3','-B',c['executor'],'--policy',c['policy'],'--capabilities'],capture_output=True,text=True,timeout=15)
 try:result['executor_available']=json.loads(output.stdout).get('available') is True
 except ValueError:result['executor_available']=False
 with open(c['observations'],'a') as log:log.write(json.dumps(result)+'\n')
'''
