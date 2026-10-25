from __future__ import annotations

import base64
import hashlib
import http.server
import io
import json
import os
import pathlib
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import host_setup
from host_channel_client import HostFailure, ensure_key, save_private, stable_json


def release_tar(extra: dict[str, bytes] | None = None) -> bytes:
    files = {'ops/cli/fleet-executor.py': b'#!/usr/bin/env python3\n', 'services/gateway/dist/fleet/main.js': b'//\n', **(extra or {})}
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for name, body in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(body)
            archive.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


class HostSetupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = pathlib.Path(self.temporary.name)
        os.chmod(self.home, 0o700)
        patcher = mock.patch.dict(os.environ, {'HOME': str(self.home)})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.identity = self.home / 'state/company-a/local-a'
        key = ensure_key(self.identity)
        self.signer_dir = self.home / 'signer'
        self.signer = ensure_key(self.signer_dir)
        self.archive = release_tar()
        self.commands: list[list[str]] = []
        self.capabilities = {'available': True, 'placements': [{'runtimes': [{'mode': 'container'}]}]}
        self.package_overrides: dict = {}
        self.tamper_signature = False
        self.requests: list[str] = []
        self.image = b''
        self.image_id = 'sha256:' + 'e' * 64
        self.docker_images: dict[str, str] = {}
        self.loaded_as = self.image_id
        self.cut_after: int | None = None
        host_setup.DOCKER = '/bin/sh'
        self.addCleanup(setattr, host_setup, 'DOCKER', '/usr/bin/docker')
        delays = mock.patch.object(host_setup, 'DOWNLOAD_RETRY_SECONDS', (0, 0))
        delays.start()
        self.addCleanup(delays.stop)
        node = mock.patch('shutil.which', side_effect=lambda name: '/usr/bin/' + name)
        node.start()
        self.addCleanup(node.stop)
        host_setup.runner = self.run_command
        self.addCleanup(setattr, host_setup, 'runner', host_setup.default_runner)
        self.linger = False
        self.active = False
        self.start_server()
        save_private(self.identity / 'identity.json', {'gateway': self.url, 'enrollment_id': 'e', 'company_id': 'company-a',
            'host_id': 'local-a', 'state': 'enrolled', 'executor_ready': False, 'key_fingerprint': hashlib.sha256(key).hexdigest()})
        host_setup.anchor_signer(self.identity, hashlib.sha256(self.signer).hexdigest())

    def run_command(self, command, timeout=60):
        self.commands.append(command)
        out = b''
        if command[0] == 'loginctl' and command[1] == 'show-user':
            out = b'yes\n' if self.linger else b'no\n'
        if command[0] == 'loginctl' and command[1] == 'enable-linger':
            self.linger = True
        if command[:2] == ['systemctl', '--user'] and command[2] == 'enable':
            self.active = True
        if command[:2] == ['systemctl', '--user'] and command[2] == 'is-active':
            out = b'active\n' if self.active else b'inactive\n'
        if command[-1] == '--capabilities':
            out = json.dumps(self.capabilities).encode()
        if command[0] == host_setup.DOCKER and command[1:3] == ['image', 'inspect']:
            found = self.docker_images.get(command[-1])
            if found is None:
                return subprocess.CompletedProcess(command, 1, b'', b'Error response from daemon: No such image: ' + command[-1].encode())
            out = (json.dumps({'Id': found, 'Descriptor': {'annotations': {'config.digest': self.image_id}}}).encode()
                if command[4] == '{{json .}}' else found.encode()) + b'\n'
        if command[0] == host_setup.DOCKER and command[1] == 'load':
            self.assertEqual(hashlib.sha256(pathlib.Path(command[-1]).read_bytes()).hexdigest(), hashlib.sha256(self.image).hexdigest())
            self.docker_images.update({self.loaded_as: self.loaded_as, 'fixture-agent:latest': self.loaded_as})
        if command[0] == host_setup.DOCKER and command[1:3] == ['image', 'tag']:
            self.docker_images[command[-1]] = self.docker_images[command[-2]]
        return subprocess.CompletedProcess(command, 0, out, b'')

    def test_capabilities_imports_release_modules_without_bytecode_with_shared_umask(self):
        release = self.home / 'release'
        cli = release / 'ops/cli'
        cli.mkdir(parents=True)
        (cli / 'release_dependency.py').write_text('VALUE=1\n')
        (cli / 'fleet-executor.py').write_text('import os,sys,json\nos.umask(0o002)\nimport release_dependency\n'
            'assert sys.dont_write_bytecode and release_dependency.VALUE==1\n'
            'print(json.dumps({"available":True,"placements":[]}))\n')
        with mock.patch.object(host_setup, 'runner', host_setup.default_runner), \
                mock.patch.dict(os.environ, {'PYTHONDONTWRITEBYTECODE': ''}):
            self.assertTrue(host_setup.capabilities_report(release, self.home / 'policy.json')['available'])
        self.assertFalse((cli / '__pycache__').exists())

    def test_signed_backup_approval_is_preserved_and_cannot_approve_lifecycle(self):
        from fleet_executor_legacy import shared_placement, validate_shared_containers
        from fleet_executor_policy import SafeFailure, approve_agent, load_policy
        approval = {'backup_only': True, 'runtime_user': 'node', 'systemd_user': 'node', 'home_directory': '/home/node'}
        self.package_overrides = {'policy': {'hooks': {}, 'bundles': {}, 'shared_containers': {'ws-legacy': approval}}}
        host_setup.setup(self.identity, self.install_base(), False)
        policy = load_policy(self.install_base() / 'company-a/local-a/executor-policy.json')
        self.assertEqual(policy['shared_containers'], {'ws-legacy': approval})
        with self.assertRaisesRegex(SafeFailure, 'backup-only container rejects fleet placement'):
            shared_placement(policy, {'container_name': 'ws-legacy'})
        with self.assertRaises(SafeFailure):
            approve_agent(policy, {'runtime_key': 'legacy', 'host_id': 'local-a', 'harness_id': 'codex'})
        for field, value in [('backup_only', False), ('home_directory', '/'), ('home_directory', '/home/node/'),
                             ('runtime_user', 'node;id'), ('command', '/bin/sh')]:
            with self.subTest(field=field, value=value), self.assertRaises(SafeFailure):
                validate_shared_containers({**policy, 'shared_containers': {'ws-legacy': {**approval, field: value}}})

    def test_backup_only_setup_starts_without_runtime_templates_and_rejects_fleet_effects(self):
        approval = {'backup_only': True, 'runtime_user': 'node', 'systemd_user': 'node', 'home_directory': '/home/node'}
        self.package_overrides = {'policy': {'execution_scope': 'backups', 'hooks': {}, 'bundles': {},
                                           'shared_containers': {'ws-legacy': approval}}}
        self.capabilities = {'available': False, 'actions': [], 'placements': [], 'reason': 'executor_unconfigured',
                             'execution_scope': 'backups', 'space_backup': True}
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertTrue(receipt['service_active'])
        self.assertTrue(receipt['space_backup'])
        self.assertEqual(receipt['templates'], 0)
        status = host_setup.status(self.identity, self.install_base())
        self.assertFalse(status['executor_ready'])
        self.assertTrue(status['space_backup_ready'])
        self.assertIsNone(status['reason'])
        policy_file = self.install_base() / 'company-a/local-a/executor-policy.json'
        policy = json.loads(policy_file.read_bytes())
        self.assertEqual(policy['native'], [])
        command = [sys.executable, str(pathlib.Path(host_setup.__file__).with_name('fleet-executor.py')), '--policy', str(policy_file)]
        available = subprocess.run([*command, '--capabilities'], capture_output=True, check=False)
        self.assertEqual(available.returncode, 0, available.stderr)
        self.assertEqual(json.loads(available.stdout), self.capabilities)
        for action in ('--binding', '--quota', '--recovery-preflight'):
            rejected = subprocess.run([*command, action], input=b'{}', capture_output=True, check=False)
            self.assertEqual(rejected.returncode, 2, rejected.stderr)
            self.assertIn(b'backup-only executor rejects fleet effects', rejected.stderr)
        policy['bundles'] = {'codex': {}}
        policy_file.write_text(json.dumps(policy))
        rejected = subprocess.run([*command, '--capabilities'], capture_output=True, check=False)
        self.assertEqual(rejected.returncode, 2)
        self.assertIn(b'backup-only executor policy grants another execution scope', rejected.stderr)

    def artifacts(self) -> list[dict]:
        items = [{'name': 'release', 'kind': 'release', 'sha256': hashlib.sha256(self.archive).hexdigest(), 'size': len(self.archive)}]
        if self.image:
            items.append({'name': 'agent-image', 'kind': 'image', 'sha256': hashlib.sha256(self.image).hexdigest(), 'size': len(self.image),
                'image_id': self.image_id})
        return items

    def start_server(self):
        test = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                packet = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path.endswith('/setup/artifact'):
                    wanted = packet['payload']
                    test.requests.append(f'{wanted["name"]}@{wanted["offset"]}')
                    body = {'release': test.archive, 'agent-image': test.image}[wanted['name']][wanted['offset']:]
                    self.send_response(206 if wanted['offset'] else 200)
                    self.send_header('Content-Length', str(len(body)))
                    if wanted['offset']:
                        total = wanted['offset'] + len(body)
                        self.send_header('Content-Range', f'bytes {wanted["offset"]}-{total - 1}/{total}')
                    self.end_headers()
                    if test.cut_after is not None and len(body) > test.cut_after:
                        self.wfile.write(body[:test.cut_after])
                        test.cut_after = None
                        self.close_connection = True
                        self.connection.shutdown(2)
                        return
                    self.wfile.write(body)
                    return
                package = {'version': 1, 'company_id': 'company-a', 'host_id': 'local-a', 'issued_at': time.time_ns() // 1000000,
                    'artifacts': test.artifacts(), 'policy': {'hooks': {}, 'bundles': {}}, **test.package_overrides}
                proof = self.sign(package)
                body = stable_json({'package': package, 'signature': proof, 'signer_public_key': base64.b64encode(test.signer).decode()})
                self.send_response(200)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def sign(self, package):
                from host_channel_client import sign
                value = sign(test.signer_dir, stable_json(package))
                return base64.b64encode(b'\0' * 64).decode() if test.tamper_signature else value

        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.url = f'http://127.0.0.1:{self.server.server_port}'
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    unit_name = 'cauce-v3-host-executor-company-a-local-a.service'

    def install_base(self):
        return self.home / 'share'

    def test_setup_installs_release_policy_unit_and_starts_service(self):
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertTrue(receipt['service_active'])
        self.assertEqual(receipt['templates'], 1)
        policy_file = self.install_base() / 'company-a/local-a/executor-policy.json'
        self.assertEqual(oct(policy_file.stat().st_mode & 0o777), '0o600')
        policy = json.loads(policy_file.read_text())
        self.assertEqual((policy['host_id'], policy['schemaVersion']), ('local-a', 1))
        unit = (self.home / '.config/systemd/user' / self.unit_name).read_text()
        self.assertIn('CAUCE_FLEET_HOST=local-a', unit)
        self.assertNotRegex(unit, r'@[A-Z_]+@')
        self.assertIn(['loginctl', 'enable-linger', policy['executor_user']], self.commands)
        self.assertTrue((self.identity / 'setup-signer.json').is_file())

    def test_second_run_is_idempotent_and_does_not_redownload_or_restart(self):
        host_setup.setup(self.identity, self.install_base(), False)
        downloads, self.commands = len(self.requests), []
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertEqual(len(self.requests), downloads)
        self.assertFalse(receipt['policy_changed'])
        self.assertNotIn(['systemctl', '--user', 'restart', self.unit_name], self.commands)
        self.assertNotIn(['systemctl', '--user', 'daemon-reload'], self.commands)

    def test_bad_signature_digest_and_foreign_host_are_rejected_before_install(self):
        self.tamper_signature = True
        with self.assertRaisesRegex(HostFailure, 'signature is invalid'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.tamper_signature = False
        self.package_overrides = {'host_id': 'other-host'}
        with self.assertRaisesRegex(HostFailure, 'another computer'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.package_overrides = {'artifacts': [{'name': 'release', 'kind': 'release', 'sha256': 'a' * 64, 'size': len(self.archive)}]}
        with self.assertRaisesRegex(HostFailure, 'no coincide con el SHA-256 firmado'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse((self.home / '.config').exists())


    def test_second_company_for_the_same_system_user_is_rejected_and_first_unit_survives(self):
        host_setup.setup(self.identity, self.install_base(), False)
        unit = self.home / '.config/systemd/user' / self.unit_name
        before = unit.read_text()
        other = self.home / 'state/company-b/local-b'
        key = ensure_key(other)
        save_private(other / 'identity.json', {'gateway': self.url, 'enrollment_id': 'e2', 'company_id': 'company-b',
            'host_id': 'local-b', 'state': 'enrolled', 'executor_ready': False, 'key_fingerprint': hashlib.sha256(key).hexdigest()})
        host_setup.anchor_signer(other, hashlib.sha256(self.signer).hexdigest())
        for dry_run in (False, True):
            with self.assertRaisesRegex(HostFailure, 'one system user per company'):
                host_setup.setup(other, self.install_base(), dry_run)
        self.assertEqual(unit.read_text(), before)
        self.assertTrue(host_setup.status(self.identity, self.install_base())['executor_ready'])
        self.assertFalse(host_setup.status(other, self.install_base())['executor_ready'])

    def login_package(self, *, helper: bool = True, login: bool = True):
        cli = pathlib.Path(__file__).resolve().parents[1]
        files = {name: (cli / name.removeprefix('ops/')).read_bytes() for name in host_setup.LOGIN_HELPER_FILES} if helper else {}
        self.archive = release_tar(files)
        template = {'provider': 'codex', 'runtime_user': 'node', 'path_root': '/home/node/.cauce-profiles', 'command': '/usr/local/bin/codex',
            'command_sha256': 'c' * 64, 'runtime_mode': 'container', 'container_prefix': 'zz-'}
        if login:
            template['login'] = {'method': 'device', 'command': ['/usr/local/bin/codex', 'login', '--device-auth'], 'sha256': 'c' * 64}
        self.package_overrides = {'policy': {'hooks': {}, 'bundles': {}, 'profile_templates': [template]}}

    def test_login_recipe_and_agent_image_arrive_in_one_setup(self):
        self.login_package()
        config = stable_json({'architecture': 'amd64', 'os': 'linux', 'rootfs': {'type': 'layers', 'diff_ids': []}, 'config': {}})
        self.image_id = 'sha256:' + hashlib.sha256(config).hexdigest()
        self.loaded_as = 'sha256:' + 'f' * 64
        config_file = self.image_id.removeprefix('sha256:') + '.json'
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for name, body in {config_file: config, 'manifest.json': stable_json([
                    {'Config': config_file, 'RepoTags': ['fixture-agent:latest'], 'Layers': []}])}.items():
                info = tarfile.TarInfo(name)
                info.size = len(body)
                archive.addfile(info, io.BytesIO(body))
        self.image = buffer.getvalue()
        self.package_overrides['policy']['container_templates'] = [{'harness_id': 'codex', 'image': self.image_id}]
        actions = host_setup.setup(self.identity, self.install_base(), True)['actions']
        self.assertEqual(actions[:4], ['download and extract release', 'download and load agent image ' + self.image_id,
            'write executor policy', 'write provider auth policy'])
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertEqual((receipt['image_loaded'], receipt['provider_auth']), (True, True))
        self.assertEqual((receipt['image_id'], receipt['local_image_id']), (self.image_id, self.loaded_as))
        policy = json.loads((self.install_base() / 'company-a/local-a/executor-policy.json').read_text())
        self.assertEqual(policy['container_templates'][0]['image'], self.loaded_as)
        self.assertEqual(self.requests, ['release@0', 'agent-image@0'])
        self.assertIn('CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE=', (self.home / '.config/systemd/user' / self.unit_name).read_text())

    def test_second_host_of_the_same_company_gets_its_own_unit(self):
        host_setup.setup(self.identity, self.install_base(), False)
        other = self.home / 'state/company-a/local-b'
        key = ensure_key(other)
        save_private(other / 'identity.json', {'gateway': self.url, 'enrollment_id': 'e2', 'company_id': 'company-a',
            'host_id': 'local-b', 'state': 'enrolled', 'executor_ready': False, 'key_fingerprint': hashlib.sha256(key).hexdigest()})
        host_setup.anchor_signer(other, hashlib.sha256(self.signer).hexdigest())
        self.package_overrides = {'host_id': 'local-b'}
        host_setup.setup(other, self.install_base(), False)
        units = sorted(item.name for item in (self.home / '.config/systemd/user').glob('cauce-v3-host-executor-*.service'))
        self.assertEqual(units, [self.unit_name, 'cauce-v3-host-executor-company-a-local-b.service'])


if __name__ == '__main__':
    unittest.main()
