#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import socket
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
import fleet_controller_upgrade_lib as lib

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts/fleet-authority-install.py'
OLD, NEW = 'a' * 40, 'b' * 40
SECRET = 'postgres://cauce_fleet:never-printed@postgres:5432/cauce'


class FakeHost:
    def __init__(self, fixture):
        self.fixture, self.active, self.events, self.endpoint = fixture, False, [], None
        self.gateway_reply = {'status': 403, 'body': {'error': 'forbidden'}}

    def __call__(self, command, check=True, **options):
        output = ''
        if command[:2] == ['systemctl', 'show']:
            main = self.fixture.current / 'app/services/gateway/dist/fleet/main.js'
            output = {'ExecStart': f'{{ path={self.fixture.node} ; argv[]={self.fixture.node} {main} ; ignore_errors=no }}',
                      'BindReadOnlyPaths': f'-{self.fixture.hosts}:/etc/hosts:rbind /srv:/srv', 'Environment': 'TZ=UTC'}[command[4]]
        elif command[:2] == ['systemctl', 'is-active']:
            output = 'active' if self.active else 'inactive'
        elif command[0] == 'systemctl':
            self.events.append(command[1])
            if command[1] in ('restart', 'start'):
                self.listen()
            if command[1] == 'stop':
                self.close()
        elif command[0] == 'systemd-tmpfiles':
            self.events.append('tmpfiles')
            self.fixture.socket_directory.mkdir(exist_ok=True)
            self.fixture.socket_directory.chmod(0o750)
        elif command[-1] == '--ready':
            output = '{"ready":true}'
        elif command[:3] == [sys.executable, '-I', '-c']:
            output = json.dumps(self.gateway_reply if 'user' in options else {'status': 403, 'body': {'error': 'AUTHORITY_REVOKED'}})
        else:
            raise AssertionError(command)
        return subprocess.CompletedProcess(command, 0, output, '')

    def listen(self):
        self.close()
        location = self.fixture.socket_directory / 'authority.sock'
        location.unlink(missing_ok=True)
        self.endpoint = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.endpoint.bind(str(location))
        location.chmod(0o660)
        self.active = True

    def close(self):
        if self.endpoint is not None:
            self.endpoint.close()
            self.endpoint = None
        self.active = False


class InstallFixture(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('fleet_authority_install', SCRIPT)
        self.kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.kit)
        self.temporary = tempfile.TemporaryDirectory(prefix='authority-install-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        real_fstat = os.fstat

        def root_stat(descriptor):
            values = list(real_fstat(descriptor))
            values[4] = 0
            return os.stat_result(values)

        for target, replacement in ((lib.os, {'fstat': mock.Mock(side_effect=root_stat), 'fchown': mock.Mock()}),
                                    (self.kit, {'AUTHORITY_UID': os.geteuid(), 'wait_until': lambda predicate, *_: predicate()})):
            for name, value in replacement.items():
                patcher = mock.patch.object(target, name, value)
                patcher.start()
                self.addCleanup(patcher.stop)
        patcher = mock.patch('time.sleep')
        patcher.start()
        self.addCleanup(patcher.stop)
        self.output = io.StringIO()
        patcher = mock.patch.object(self.kit, 'say', side_effect=lambda message: self.output.write(message + '\n'))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.fleet, self.tools = self.root / 'fleet', self.root / 'tools'
        self.controller, self.socket_directory = self.fleet / 'controller', self.root / 'run/cauce-fleet-signed-authority'
        for directory in (self.controller, self.root / 'systemd', self.root / 'tmpfiles.d', self.root / 'run', self.root / 'bin'):
            directory.mkdir(parents=True, exist_ok=True)
        self.controller.chmod(0o700)
        self.node = self.file(self.root / 'bin/node', b'#!/bin/sh\n', 0o755)
        self.hosts = self.file(self.controller / 'hosts', b'172.18.0.2 postgres\n', 0o644)
        self.database = self.file(self.controller / 'database-url', SECRET.encode(), 0o400)
        self.issuer_state = self.root / 'issuer-state'
        self.issuer_state.mkdir(mode=0o700)
        self.policy = self.file(self.controller / 'authority.v1.json',
                                json.dumps({'version': 1, 'state_root': str(self.issuer_state)}).encode() + b'\n')
        self.release(OLD)
        self.host = FakeHost(self)
        patcher = mock.patch.object(self.kit, 'run', self.host)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.host.close)

    def file(self, path, body=b'content\n', mode=0o600):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(body)
        path.chmod(mode)
        return path

    def release(self, name, issuer=b'print("issuer")\n'):
        root = self.current = self.tools / name
        self.file(root / 'app/services/gateway/dist/fleet/authority/signed-main.js', b'export {};\n', 0o644)
        executable = self.file(root / 'ops/cli/fleet-authority-issuer.py', issuer, 0o755)
        self.command = {'python': sys.executable, 'executable': str(executable), 'sha256': hashlib.sha256(issuer).hexdigest(),
                        'policy_file': str(self.policy), 'policy_sha256': hashlib.sha256(self.policy.read_bytes()).hexdigest()}
        self.file(self.controller / 'controller.env', f'CAUCE_FLEET_PROJECT_ROOT={root}\n'
                  f'CAUCE_FLEET_DATABASE_URL_FILE={self.database}\nNODE_ENV=production\n'.encode())
        self.file(self.controller / 'controller.v1.json', lib.dumps({'version': 1, 'authority_command': self.command}))
        return root

    def arguments(self, *extra):
        return self.kit.parse_arguments(['--fleet-config', str(self.fleet), '--tools-base', str(self.tools),
            '--unit', str(self.root / 'systemd/cauce-fleet-signed-authority.service'),
            '--tmpfiles', str(self.root / 'tmpfiles.d/cauce-fleet-signed-authority.conf'),
            '--socket-directory', str(self.socket_directory),
            '--gateway-uid', str(os.geteuid()), '--gateway-gid', str(os.getegid()), *extra])

    def tree(self):
        return {str(item): item.read_bytes() if item.is_file() else None for item in sorted(self.root.rglob('*'))
                if not item.is_socket()}


class ArgumentTests(InstallFixture):
    def test_defaults_are_the_production_paths_matching_the_fleet_overlay(self):
        args = self.kit.parse_arguments([])
        self.assertEqual(args.config_directory, pathlib.Path('/etc/cauce-v3/fleet-v35/signed-authority'))
        self.assertEqual(args.socket_directory / self.kit.SOCKET_NAME, pathlib.Path('/run/cauce-fleet-signed-authority/authority.sock'))
        self.assertEqual((args.gateway_uid, args.gateway_gid), (1000, 1000))
        overlay = (pathlib.Path(__file__).resolve().parents[2] / 'deploy/compose.fleet.yaml').read_text()
        for line in ('CAUCE_FLEET_AUTHORITY_SOCKET: /run/cauce-fleet-signed-authority/authority.sock',
                     'CAUCE_FLEET_AUTHORITY_OWNER_UID: "0"', 'CAUCE_FLEET_AUTHORITY_PEER_UID: "1000"',
                     'CAUCE_FLEET_AUTHORITY_GROUP_GID: "1000"', 'source: /run/cauce-fleet-signed-authority'):
            self.assertIn(line, overlay)

    def test_unsafe_values_and_non_root_are_rejected_before_any_effect(self):
        for extra in (['--unit', 'relative.service'], ['--gateway-uid', '0'], ['--controller-service', 'x; rm -rf /'],
                      ['--socket-directory', '/run/../tmp']):
            with self.assertRaises(SystemExit), mock.patch('sys.stderr'):
                self.arguments(*extra)
        with mock.patch.object(lib.os, 'geteuid', return_value=1000), mock.patch.object(self.kit, 'install') as install:
            with self.assertRaisesRegex(lib.Abort, 'root'):
                self.kit.main([])
        install.assert_not_called()


class PreflightTests(InstallFixture):
    def test_preflight_derives_the_enclave_from_the_controller_and_writes_nothing(self):
        before = self.tree()
        self.assertEqual(self.kit.install(self.arguments()), 'preflight OK; nothing was written')
        self.assertEqual(self.tree(), before)
        self.assertEqual(self.host.events, [])
        state = self.kit.controller_state(self.arguments())
        files = self.kit.desired_files(self.arguments(), state)
        unit = files[self.root / 'systemd/cauce-fleet-signed-authority.service'][0].decode()
        environment = files[self.fleet / 'signed-authority/authority.env'][0].decode()
        self.assertIn(f'ExecStart={self.node} {self.tools / OLD}/app/services/gateway/dist/fleet/authority/signed-main.js\n', unit)
        self.assertIn(f'BindReadOnlyPaths={self.hosts}:/etc/hosts\n', unit)
        self.assertIn(f'EnvironmentFile={self.fleet}/signed-authority/authority.env\n', unit)
        self.assertNotIn('@', unit)
        self.assertIn('ProtectSystem=strict\n', unit)
        self.assertIn(f'ReadWritePaths={self.issuer_state} {self.socket_directory}\n', unit)
        self.assertIn('PartOf=cauce-fleet-v35-controller.service\n', unit)
        self.assertIn('CapabilityBoundingSet=\n', unit)
        self.assertEqual(dict(line.split('=', 1) for line in environment.splitlines()), {
            'CAUCE_FLEET_AUTHORITY_SOCKET': str(self.socket_directory / 'authority.sock'),
            'CAUCE_FLEET_AUTHORITY_OWNER_UID': str(os.geteuid()), 'CAUCE_FLEET_AUTHORITY_PEER_UID': str(os.geteuid()),
            'CAUCE_FLEET_AUTHORITY_GROUP_GID': str(os.getegid()),
            'CAUCE_FLEET_AUTHORITY_COMMAND_FILE': str(self.fleet / 'signed-authority/command.v1.json'),
            'CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE': str(self.database), 'NODE_ENV': 'production'})
        self.assertEqual(json.loads(files[self.fleet / 'signed-authority/command.v1.json'][0]), self.command)
        self.assertEqual(files[self.root / 'tmpfiles.d/cauce-fleet-signed-authority.conf'][0].decode().splitlines()[-1],
                         f'd {self.socket_directory} 0750 root {os.getegid()} -')
        self.assertNotIn('never-printed', self.output.getvalue())

    def test_preflight_refuses_an_old_release_pin_drift_a_public_database_file_and_a_missing_command(self):
        entry = self.tools / OLD / self.kit.ENTRY
        entry.unlink()
        with self.assertRaisesRegex(lib.Abort, 'upgrade the controller first'):
            self.kit.install(self.arguments())
        self.release(OLD)
        pathlib.Path(self.command['executable']).write_bytes(b'tampered\n')
        with self.assertRaisesRegex(lib.Abort, 'executable differs'):
            self.kit.install(self.arguments())
        self.release(OLD)
        self.database.chmod(0o440)
        with self.assertRaisesRegex(lib.Abort, 'private regular file'):
            self.kit.install(self.arguments())
        self.database.chmod(0o400)
        self.file(self.controller / 'controller.v1.json', lib.dumps({'version': 1}))
        with self.assertRaisesRegex(lib.Abort, 'authority_command'):
            self.kit.install(self.arguments())
        self.assertFalse((self.fleet / 'signed-authority').exists())

    def test_a_controller_that_is_not_node_on_its_own_release_is_refused(self):
        wrapper = '{ path=/usr/bin/env ; argv[]=/usr/bin/env node main.js ; ignore_errors=no }'
        with mock.patch.object(self.kit, 'systemctl_show', side_effect=lambda _service, prop: wrapper if prop == 'ExecStart' else ''):
            with self.assertRaisesRegex(lib.Abort, 'must run exactly one node'):
                self.kit.install(self.arguments())


class ApplyTests(InstallFixture):
    def test_apply_installs_private_files_starts_verifies_and_a_second_run_changes_nothing(self):
        self.assertEqual(self.kit.install(self.arguments('--apply')), 'apply OK')
        config = self.fleet / 'signed-authority'
        modes = {path: stat.S_IMODE(path.stat().st_mode) for path in (config, config / 'command.v1.json', config / 'authority.env',
                 self.root / 'systemd/cauce-fleet-signed-authority.service', self.root / 'tmpfiles.d/cauce-fleet-signed-authority.conf',
                 self.socket_directory, self.socket_directory / 'authority.sock')}
        self.assertEqual(list(modes.values()), [0o700, 0o600, 0o600, 0o644, 0o644, 0o750, 0o660])
        self.assertEqual(self.host.events, ['tmpfiles', 'enable', 'daemon-reload', 'restart'])
        self.assertIn('ready: cauce-fleet-signed-authority.service active', self.output.getvalue())
        before = self.tree()
        self.assertEqual(self.kit.install(self.arguments('--apply')), 'no changes; the running enclave was verified')
        self.assertEqual(self.host.events, ['tmpfiles', 'enable', 'daemon-reload', 'restart', 'enable'])
        self.assertEqual(self.tree(), before)

    def test_a_release_change_is_backed_up_and_a_failed_verification_restores_the_running_enclave(self):
        self.kit.install(self.arguments('--apply'))
        unit = self.root / 'systemd/cauce-fleet-signed-authority.service'
        command = self.fleet / 'signed-authority/command.v1.json'
        previous = {unit: unit.read_bytes(), command: command.read_bytes()}
        self.release(NEW, issuer=b'print("issuer R")\n')
        self.host.gateway_reply = {'status': 409, 'body': {'error': 'AUTHORITY_UNAVAILABLE'}}
        with self.assertRaisesRegex(lib.Abort, 'installation reverted: .*PostgreSQL'):
            self.kit.install(self.arguments('--apply'))
        self.assertEqual({path: path.read_bytes() for path in previous}, previous)
        self.assertEqual(self.host.events[4:], ['enable', 'daemon-reload', 'restart', 'stop', 'daemon-reload', 'start'])
        self.assertTrue(self.host.active)
        backups = sorted(item.name.split('.pre-authority-')[0] for item in self.root.rglob('*.pre-authority-*'))
        self.assertEqual(backups, ['cauce-fleet-signed-authority.service', 'command.v1.json'])
        self.host.gateway_reply = {'status': 403, 'body': {'error': 'forbidden'}}
        self.assertEqual(self.kit.install(self.arguments('--apply')), 'apply OK')
        self.assertIn(str(self.tools / NEW).encode(), unit.read_bytes())

    def test_a_first_install_that_fails_verification_leaves_no_enclave_configuration(self):
        self.host.gateway_reply = {'status': 200, 'body': {'ready': True}}
        with self.assertRaisesRegex(lib.Abort, 'unenrolled host'):
            self.kit.install(self.arguments('--apply'))
        self.assertFalse((self.fleet / 'signed-authority').exists())
        self.assertFalse((self.root / 'systemd/cauce-fleet-signed-authority.service').exists())
        self.assertEqual(self.host.events, ['tmpfiles', 'enable', 'daemon-reload', 'restart', 'stop', 'daemon-reload'])
        self.assertTrue((self.root / 'tmpfiles.d/cauce-fleet-signed-authority.conf').is_file())

    def test_socket_directory_only_needs_no_controller_and_touches_no_unit(self):
        for item in self.controller.iterdir():
            item.unlink()
        self.assertEqual(self.kit.install(self.arguments('--socket-directory-only', '--apply')), 'socket directory ready')
        self.assertEqual(self.host.events, ['tmpfiles'])
        self.assertTrue(self.kit.directory_ok(self.socket_directory, os.getegid()))
        self.assertFalse((self.root / 'systemd/cauce-fleet-signed-authority.service').exists())


class ProbeTests(unittest.TestCase):
    def test_probe_posts_an_unsigned_ready_for_the_canary_host_over_the_unix_socket(self):
        spec = importlib.util.spec_from_file_location('fleet_authority_install', SCRIPT)
        kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kit)
        with tempfile.TemporaryDirectory(prefix='authority-probe-', dir='/var/tmp') as directory:
            location = str(pathlib.Path(directory) / 'authority.sock')
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(location)
            server.listen(1)
            received = {}

            def serve():
                connection, _ = server.accept()
                with connection:
                    data = b''
                    while b'\r\n\r\n' not in data:
                        data += connection.recv(4096)
                    head, _, body = data.partition(b'\r\n\r\n')
                    length = int(re.search(rb'(?i)content-length: (\d+)', head)[1])
                    while len(body) < length:
                        body += connection.recv(4096)
                    received.update(head=head.decode(), body=json.loads(body))
                    reply = b'{"error":"forbidden"}'
                    connection.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: '
                                       + str(len(reply)).encode() + b'\r\nConnection: close\r\n\r\n' + reply)

            thread = threading.Thread(target=serve)
            thread.start()
            try:
                with redirect_stdout(io.StringIO()):
                    self.assertEqual(kit.probe(location), (403, {'error': 'forbidden'}))
            finally:
                thread.join(10)
                server.close()
        self.assertTrue(received['head'].startswith('POST /signed-authority HTTP/1.1'))
        packet = received['body']['packet']
        self.assertEqual(received['body']['host_id'], 'zz-canary-probe')
        self.assertEqual((packet['host_id'], packet['payload']), ('zz-canary-probe', {'action': 'ready'}))
        self.assertRegex(packet['nonce'], r'^[0-9a-f]{64}$')
        self.assertLess(abs(packet['issued_at'] - time.time_ns() // 1_000_000), 10_000)


if __name__ == '__main__':
    unittest.main()
