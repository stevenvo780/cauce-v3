#!/usr/bin/env python3
from __future__ import annotations

import fcntl
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
import types
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
        self.container_reply = self.gateway_reply
        self.commands = []
        self.enabled = False

    def __call__(self, command, check=True, **options):
        self.commands.append(command)
        output = ''
        if command[:2] == ['systemctl', 'show']:
            main = self.fixture.current / 'app/services/gateway/dist/fleet/main.js'
            output = {'ExecStart': f'{{ path={self.fixture.node} ; argv[]={self.fixture.node} {main} ; ignore_errors=no }}',
                      'BindReadOnlyPaths': f'-{self.fixture.hosts}:/etc/hosts:rbind /srv:/srv', 'Environment': 'TZ=UTC'}[command[4]]
        elif command[:2] == ['systemctl', 'is-active']:
            output = 'active' if self.active else 'inactive'
        elif command[:2] == ['systemctl', 'is-enabled']:
            return subprocess.CompletedProcess(command, 0 if self.enabled else 1,
                                               'enabled' if self.enabled else 'disabled', '')
        elif command[0] == 'systemctl':
            self.events.append(command[1])
            if command[1] in ('enable', 'disable'):
                self.enabled = command[1] == 'enable'
            if command[1] in ('restart', 'start'):
                self.listen()
            if command[1] == 'stop':
                self.close()
        elif command[0] == 'systemd-tmpfiles':
            self.events.append('tmpfiles')
            self.fixture.socket_directory.mkdir(exist_ok=True)
            self.fixture.socket_directory.chmod(0o750)
            os.chown(self.fixture.socket_directory, -1, self.fixture.gateway_gid)
        elif command[-1] == '--ready':
            output = '{"ready":true}'
        elif command[:3] == [sys.executable, '-I', '-c']:
            output = json.dumps(self.gateway_reply if 'user' in options else {'status': 403, 'body': {'error': 'AUTHORITY_REVOKED'}})
        elif command[:2] == ['docker', 'exec']:
            output = json.dumps(self.container_reply)
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
        os.chown(location, -1, self.fixture.gateway_gid)
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
        self.authority_uid = self.root.stat().st_uid
        self.gateway_uid, self.gateway_gid = self.authority_uid or 1000, self.root.stat().st_gid or 1000
        real_fstat = os.fstat

        def root_stat(descriptor):
            values = list(real_fstat(descriptor))
            values[4] = 0
            return os.stat_result(values)

        for target, replacement in ((lib.os, {'fstat': mock.Mock(side_effect=root_stat), 'fchown': mock.Mock()}),
                                    (self.kit, {'AUTHORITY_UID': self.authority_uid, 'wait_until': lambda predicate, *_: predicate()})):
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
        self.registries = {f'{scope}_{kind}': str(self.root / 'registries' / scope / filename)
                           for scope in ('base', 'fleet')
                           for kind, filename in (('mtls', 'mtls_identities.json'), ('token', 'token_hashes.json'))}
        self.policy = self.file(self.controller / 'authority.v1.json',
                                lib.dumps({'version': 1, 'state_root': str(self.issuer_state), 'registries': self.registries}))
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
            '--gateway-uid', str(self.gateway_uid), '--gateway-gid', str(self.gateway_gid), *extra])

    def tree(self):
        return {str(item): item.read_bytes() if item.is_file() else None for item in sorted(self.root.rglob('*'))
                if not item.is_socket()}


class ArgumentTests(InstallFixture):
    def test_defaults_are_the_production_paths_matching_the_fleet_overlay(self):
        args = self.kit.parse_arguments([])
        self.assertEqual(args.config_directory, pathlib.Path('/etc/cauce-v3/fleet-v35/signed-authority'))
        self.assertEqual(args.socket_directory / self.kit.SOCKET_NAME, pathlib.Path('/run/cauce-fleet-signed-authority/authority.sock'))
        self.assertEqual((args.gateway_uid, args.gateway_gid), (1000, 1000))
        self.assertEqual(args.gateway_container, 'cauce-v3-prod-gateway-1')
        overlay = (pathlib.Path(__file__).resolve().parents[2] / 'deploy/compose.fleet.yaml').read_text()
        for line in ('CAUCE_FLEET_AUTHORITY_SOCKET: /run/cauce-fleet-signed-authority/authority.sock',
                     'CAUCE_FLEET_AUTHORITY_OWNER_UID: "0"', 'CAUCE_FLEET_AUTHORITY_PEER_UID: "1000"',
                     'CAUCE_FLEET_AUTHORITY_GROUP_GID: "1000"', 'source: /run/cauce-fleet-signed-authority'):
            self.assertIn(line, overlay)

    def test_unsafe_values_and_non_root_are_rejected_before_any_effect(self):
        for extra in (['--unit', 'relative.service'], ['--gateway-uid', '0'], ['--gateway-gid', '0'],
                      ['--gateway-container', '-dangerous'], ['--gateway-container', 'gateway; exit'],
                      ['--controller-service', 'x; rm -rf /'],
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
        self.assertIn(f'After=network-online.target docker.service {self.arguments().controller_service}\n', unit)
        self.assertEqual(dict(line.split('=', 1) for line in environment.splitlines()), {
            'CAUCE_FLEET_AUTHORITY_SOCKET': str(self.socket_directory / 'authority.sock'),
            'CAUCE_FLEET_AUTHORITY_OWNER_UID': str(self.authority_uid), 'CAUCE_FLEET_AUTHORITY_PEER_UID': str(self.gateway_uid),
            'CAUCE_FLEET_AUTHORITY_GROUP_GID': str(self.gateway_gid),
            'CAUCE_FLEET_AUTHORITY_COMMAND_FILE': str(self.fleet / 'signed-authority/command.v1.json'),
            'CAUCE_FLEET_AUTHORITY_DATABASE_URL_FILE': str(self.database), 'NODE_ENV': 'production'})
        self.assertEqual(json.loads(files[self.fleet / 'signed-authority/command.v1.json'][0]), self.command)
        self.assertEqual(files[self.root / 'tmpfiles.d/cauce-fleet-signed-authority.conf'][0].decode().splitlines()[-1],
                         f'd {self.socket_directory} 0750 root {self.gateway_gid} -')
        self.assertNotIn('never-printed', self.output.getvalue())

    def rendered_unit(self):
        args = self.arguments()
        unit = self.kit.desired_files(args, self.kit.controller_state(args))[args.unit][0].decode()
        return dict(line.split('=', 1) for line in unit.splitlines() if '=' in line)

    def test_rendered_unit_retains_the_capabilities_for_socket_and_registry_ownership(self):
        capabilities = self.rendered_unit()['CapabilityBoundingSet'].split()
        self.assertEqual(set(capabilities), {'CAP_CHOWN', 'CAP_DAC_OVERRIDE', 'CAP_FOWNER'})

    def test_rendered_unit_allows_writes_to_every_registry_parent_without_duplicates(self):
        paths = self.rendered_unit()['ReadWritePaths'].split()
        self.assertEqual(paths, [str(self.issuer_state), str(self.root / 'registries/base'),
                                str(self.root / 'registries/fleet'), str(self.socket_directory)])

    def test_rendered_unit_does_not_stop_with_the_controller(self):
        self.assertNotIn('PartOf', self.rendered_unit())

    def test_unsafe_state_root_is_rejected_before_any_effect(self):
        state = self.kit.controller_state(self.arguments())
        policy = json.loads(self.policy.read_bytes())
        for root in ('/var/lib/cauce/unsafe path', '/var/lib/cauce/%n', '/var/lib/cauce/\nInjected=value',
                     '/var/lib/../cauce', 'relative'):
            with self.subTest(root=root):
                self.policy.write_bytes(lib.dumps({**policy, 'state_root': root}))
                with self.assertRaises(lib.Abort):
                    self.kit.desired_files(self.arguments(), state)
        self.assertEqual(self.host.events, [])

    def test_broad_state_root_and_registry_parents_are_rejected_before_any_effect(self):
        policy = json.loads(self.policy.read_bytes())
        for field in ('state_root', 'registries'):
            for directory in ('/', '/etc', '/usr', '/var', '/home', '/root', '/boot', '/proc', '/sys', '/dev', '/run', '/srv'):
                with self.subTest(field=field, directory=directory):
                    value = directory if field == 'state_root' else {'base_mtls': str(pathlib.Path(directory) / 'mtls_identities.json')}
                    self.policy.write_bytes(lib.dumps({**policy, field: value}))
                    self.release(OLD)
                    before = self.tree()
                    for extra in ((), ('--apply',)):
                        with self.assertRaisesRegex(lib.Abort, 'state_root and registry parents.*at least two levels'):
                            self.kit.install(self.arguments(*extra))
                        self.assertEqual(self.tree(), before)
                        self.assertEqual(self.host.events, [])

    def test_write_paths_two_levels_below_root_are_allowed(self):
        self.policy.write_bytes(lib.dumps({'state_root': '/var/lib', 'registries': {'base_mtls': '/etc/cauce/mtls_identities.json'}}))
        self.assertEqual(self.kit.issuer_write_paths({'command': self.command}), {'/var/lib', '/etc/cauce'})

    def test_unsafe_or_missing_registries_are_rejected_before_any_effect(self):
        state = self.kit.controller_state(self.arguments())
        policy = json.loads(self.policy.read_bytes())
        for registries in (None, {}, [], {'base_mtls': 'relative/file'},
                           {'base_mtls': '/etc/cauce/../registry/file'},
                           {'base_mtls': '/etc/cauce/unsafe path/file'},
                           {'base_mtls': '/etc/cauce/%n/file'}, {'base_mtls': 42}):
            with self.subTest(registries=registries):
                self.policy.write_bytes(lib.dumps({**policy, 'registries': registries}))
                with self.assertRaises(lib.Abort):
                    self.kit.desired_files(self.arguments(), state)
        self.assertEqual(self.host.events, [])

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
        self.assertEqual(self.host.events, ['tmpfiles', 'daemon-reload', 'restart', 'enable'])
        self.assertTrue(self.host.enabled)
        self.assertTrue(any(command[:2] == ['docker', 'exec'] for command in self.host.commands))
        self.assertIn('ready: cauce-fleet-signed-authority.service active', self.output.getvalue())
        before = self.tree()
        self.assertEqual(self.kit.install(self.arguments('--apply')), 'no changes; the running enclave was verified')
        self.assertEqual(self.host.events, ['tmpfiles', 'daemon-reload', 'restart', 'enable', 'enable'])
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
        self.assertEqual(self.host.events[4:], ['daemon-reload', 'restart', 'stop', 'daemon-reload', 'start'])
        self.assertTrue(self.host.active)
        self.assertTrue(self.host.enabled)
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
        self.assertEqual(self.host.events, ['tmpfiles', 'daemon-reload', 'restart', 'stop', 'daemon-reload'])
        self.assertFalse(self.host.enabled)
        self.assertTrue((self.root / 'tmpfiles.d/cauce-fleet-signed-authority.conf').is_file())

    def test_socket_directory_only_needs_no_controller_and_touches_no_unit(self):
        for item in self.controller.iterdir():
            item.unlink()
        self.assertEqual(self.kit.install(self.arguments('--socket-directory-only', '--apply')), 'socket directory ready')
        self.assertEqual(self.host.events, ['tmpfiles'])
        self.assertTrue(self.kit.directory_ok(self.socket_directory, self.gateway_gid))
        self.assertFalse((self.root / 'systemd/cauce-fleet-signed-authority.service').exists())
        self.assertFalse(any(command[0] == 'docker' for command in self.host.commands))

    def test_container_probe_failure_rolls_back_even_when_the_host_probe_succeeds(self):
        self.host.container_reply = {'status': None, 'body': None}
        with self.assertRaisesRegex(lib.Abort, 'gateway container'):
            self.kit.install(self.arguments('--apply'))
        self.assertFalse((self.fleet / 'signed-authority').exists())
        self.assertFalse(self.host.active)

    def test_enable_runs_only_after_successful_verification(self):
        verify = self.kit.verify

        def verified(*args):
            verify(*args)
            self.host.events.append('verify')

        with mock.patch.object(self.kit, 'verify', side_effect=verified):
            self.kit.install(self.arguments('--apply'))
        self.assertEqual(self.host.events, ['tmpfiles', 'daemon-reload', 'restart', 'verify', 'enable'])
        self.assertTrue(self.host.enabled)

    def fail_after_enable(self, command, **options):
        result = self.host(command, **options)
        if command[:2] == ['systemctl', 'enable']:
            raise lib.Abort('injected enable failure')
        return result

    def test_failed_enable_removes_new_enablement_and_created_configuration(self):
        with mock.patch.object(self.kit, 'run', side_effect=self.fail_after_enable):
            with self.assertRaisesRegex(lib.Abort, 'injected enable failure'):
                self.kit.install(self.arguments('--apply'))
        self.assertFalse(self.host.enabled)
        self.assertFalse(self.host.active)
        self.assertFalse((self.fleet / 'signed-authority').exists())
        self.assertFalse(self.arguments().unit.exists())
        self.assertIn('disable', self.host.events)

    def test_failed_enable_preserves_previous_enablement_and_running_configuration(self):
        self.kit.install(self.arguments('--apply'))
        unit = self.arguments().unit
        previous = unit.read_bytes()
        self.release(NEW)
        with mock.patch.object(self.kit, 'run', side_effect=self.fail_after_enable):
            with self.assertRaisesRegex(lib.Abort, 'injected enable failure'):
                self.kit.install(self.arguments('--apply'))
        self.assertTrue(self.host.enabled)
        self.assertTrue(self.host.active)
        self.assertEqual(unit.read_bytes(), previous)
        self.assertNotIn('disable', self.host.events)

    def test_unmanaged_enablement_states_are_rejected_before_any_effect(self):
        before = self.tree()

        def unmanaged(command, **options):
            if command[:2] == ['systemctl', 'is-enabled']:
                return subprocess.CompletedProcess(command, 0, status, '')
            return self.host(command, **options)

        for status in ('enabled-runtime', 'linked', 'linked-runtime', 'masked', 'static'):
            with self.subTest(status=status), mock.patch.object(self.kit, 'run', side_effect=unmanaged):
                with self.assertRaisesRegex(lib.Abort, 'enablement'):
                    self.kit.install(self.arguments('--apply'))
                self.assertEqual(self.tree(), before)
                self.assertEqual(self.host.events, [])

    def test_failed_disable_reports_incomplete_rollback(self):
        def failed_disable(command, **options):
            if command[:2] == ['systemctl', 'disable']:
                return subprocess.CompletedProcess(command, 1, '', 'injected disable failure')
            return self.fail_after_enable(command, **options)

        with mock.patch.object(self.kit, 'run', side_effect=failed_disable):
            with self.assertRaisesRegex(lib.Abort, 'injected enable failure'):
                self.kit.install(self.arguments('--apply'))
        self.assertIn('ROLLBACK INCOMPLETE', self.output.getvalue())
        self.assertTrue(self.host.enabled)
        self.assertTrue(self.arguments().unit.exists())
        self.assertTrue((self.fleet / 'signed-authority/authority.env').exists())
        self.assertFalse(self.host.active)


class LockTests(InstallFixture):
    def upgrade_kit(self):
        spec = importlib.util.spec_from_file_location('fleet_controller_upgrade', SCRIPT.with_name('fleet-controller-upgrade.py'))
        kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kit)
        return kit

    def upgrade_arguments(self):
        return ['--release', NEW, '--runtime-image-from', str(self.root / 'runtime.env'),
                '--ops-source', str(self.root / 'src'), '--adapter-bundle', str(self.root / 'adapter'),
                '--fleet-config', str(self.fleet), '--work-root', str(self.root / 'work')]

    def test_installer_and_upgrade_refuse_the_same_locked_configuration(self):
        descriptor = lib.directory_fd(self.fleet)
        self.addCleanup(os.close, descriptor)
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        upgrade = self.upgrade_kit()
        with mock.patch.object(self.kit, 'require_root'), mock.patch.object(self.kit, 'install') as install:
            self.assertEqual(self.kit.main(['--fleet-config', str(self.fleet)]), 2)
        install.assert_not_called()
        with mock.patch.object(upgrade, 'require_root'), mock.patch.dict(os.environ), \
                mock.patch.object(upgrade.subprocess, 'run') as command:
            with self.assertRaisesRegex(lib.Abort, 'authority install'):
                upgrade.main(self.upgrade_arguments())
        command.assert_not_called()
        self.assertFalse((self.root / 'work').exists())

    def test_upgrade_holds_the_shared_lock_while_the_namespace_child_runs_and_releases_it(self):
        upgrade = self.upgrade_kit()
        (self.root / 'work').mkdir(mode=0o700)
        observed = []

        def child(command, **_options):
            with mock.patch.object(self.kit, 'require_root'), mock.patch.object(self.kit, 'install') as install:
                observed.append(self.kit.main(['--fleet-config', str(self.fleet)]))
            install.assert_not_called()
            return subprocess.CompletedProcess(command, 0)

        with mock.patch.object(upgrade, 'require_root'), mock.patch.dict(os.environ), \
                mock.patch.object(upgrade.subprocess, 'run', side_effect=child):
            self.assertEqual(upgrade.main(self.upgrade_arguments()), 0)
        self.assertEqual(observed, [2])
        with mock.patch.object(self.kit, 'require_root'), mock.patch.object(self.kit, 'install', return_value='verified') as install:
            self.assertEqual(self.kit.main(['--fleet-config', str(self.fleet)]), 0)
        install.assert_called_once()

    def test_installer_holds_the_lock_while_installing_and_releases_it_after_failure(self):
        def fail(_args):
            descriptor = lib.directory_fd(self.fleet)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(descriptor)
            raise lib.Abort('injected failure')

        with mock.patch.object(self.kit, 'require_root'), mock.patch.object(self.kit, 'install', side_effect=fail):
            self.assertEqual(self.kit.main(['--fleet-config', str(self.fleet)]), 2)
        with mock.patch.object(self.kit, 'require_root'), mock.patch.object(self.kit, 'install', return_value='verified'):
            self.assertEqual(self.kit.main(['--fleet-config', str(self.fleet)]), 0)


class ProbeTests(unittest.TestCase):
    def test_gateway_probe_uses_its_container_identity_and_configured_socket(self):
        spec = importlib.util.spec_from_file_location('fleet_authority_install', SCRIPT)
        kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kit)
        with tempfile.TemporaryDirectory(prefix='gateway-authority-probe-', dir='/var/tmp') as directory:
            location = str(pathlib.Path(directory) / 'authority.sock')
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(location)
            server.listen(1)
            server.settimeout(10)
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
                    connection.sendall(b'HTTP/1.1 403 Forbidden\r\nContent-Length: '
                                       + str(len(reply)).encode() + b'\r\nConnection: close\r\n\r\n' + reply)

            args = types.SimpleNamespace(gateway_container='gateway-fixture', gateway_uid=os.getuid(), gateway_gid=os.getgid())

            def execute(command, **_options):
                self.assertEqual(command[:6], ['docker', 'exec', '--workdir', '/', 'gateway-fixture', 'node'])
                return subprocess.run(command[5:], capture_output=True, text=True, timeout=15,
                                      env={**os.environ, 'CAUCE_FLEET_AUTHORITY_SOCKET': location})

            thread = threading.Thread(target=serve)
            thread.start()
            try:
                with mock.patch.object(kit, 'run', side_effect=execute):
                    self.assertEqual(kit.gateway_probe(args, location), (403, {'error': 'forbidden'}))
                    args.gateway_uid += 1
                    self.assertEqual(kit.gateway_probe(args, location), (None, None))
                    args.gateway_uid -= 1
                    self.assertEqual(kit.gateway_probe(args, location + '.absent'), (None, None))
            finally:
                thread.join(10)
                server.close()
        self.assertTrue(received['head'].startswith('POST /signed-authority HTTP/1.1'))
        self.assertEqual(received['body']['packet']['payload'], {'action': 'ready'})
        self.assertEqual(received['body']['host_id'], 'zz-canary-probe')

    def test_a_nonzero_probe_exit_cannot_be_accepted_from_stdout(self):
        spec = importlib.util.spec_from_file_location('fleet_authority_install', SCRIPT)
        kit = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(kit)
        result = subprocess.CompletedProcess([], 2, '{"status":403,"body":{"error":"forbidden"}}', '')
        self.assertEqual(kit.probe_reply(result), (None, None))

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
