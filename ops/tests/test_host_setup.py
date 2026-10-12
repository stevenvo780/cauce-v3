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
        return subprocess.CompletedProcess(command, 0, out, b'')

    def start_server(self):
        test = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                test.requests.append(self.path)
                self.send_response(200)
                self.send_header('Content-Length', str(len(test.archive)))
                self.end_headers()
                self.wfile.write(test.archive)

            def do_POST(self):
                json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                package = {'version': 1, 'company_id': 'company-a', 'host_id': 'local-a', 'issued_at': time.time_ns() // 1000000,
                    'artifacts': [{'name': 'release', 'kind': 'release', 'sha256': hashlib.sha256(test.archive).hexdigest(),
                        'size': len(test.archive), 'url': test.url + '/artifacts/release'}],
                    'policy': {'hooks': {}, 'bundles': {}}, **test.package_overrides}
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
        unit = (self.home / '.config/systemd/user' / host_setup.UNIT_NAME).read_text()
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
        self.assertNotIn(['systemctl', '--user', 'restart', host_setup.UNIT_NAME], self.commands)
        self.assertNotIn(['systemctl', '--user', 'daemon-reload'], self.commands)

    def test_dry_run_changes_nothing(self):
        receipt = host_setup.setup(self.identity, self.install_base(), True)
        self.assertTrue(receipt['dry_run'])
        self.assertIn('download and extract release', receipt['actions'])
        self.assertFalse(self.install_base().exists())
        self.assertFalse((self.home / '.config').exists())
        self.assertFalse((self.identity / 'setup-signer.json').exists())
        self.assertEqual(self.requests, [])

    def test_bad_signature_digest_and_foreign_host_are_rejected_before_install(self):
        self.tamper_signature = True
        with self.assertRaisesRegex(HostFailure, 'signature is invalid'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.tamper_signature = False
        self.package_overrides = {'host_id': 'other-host'}
        with self.assertRaisesRegex(HostFailure, 'another computer'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.package_overrides = {'artifacts': [{'name': 'release', 'kind': 'release', 'sha256': 'a' * 64,
            'size': len(self.archive), 'url': self.url + '/artifacts/release'}]}
        with self.assertRaisesRegex(HostFailure, 'digest differs'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse((self.home / '.config').exists())

    def test_policy_cannot_override_local_identity_and_signer_is_pinned(self):
        self.package_overrides = {'policy': {'executor_user': 'root'}}
        with self.assertRaisesRegex(HostFailure, 'cannot override'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.package_overrides = {}
        host_setup.setup(self.identity, self.install_base(), False)
        other = self.home / 'other-signer'
        self.signer, self.signer_dir = ensure_key(other), other
        with self.assertRaisesRegex(HostFailure, 'pinned'):
            host_setup.setup(self.identity, self.install_base(), False)

    def test_executor_rejecting_policy_blocks_service_start(self):
        self.capabilities = {'available': False, 'placements': [], 'reason': 'executor_unconfigured'}
        with self.assertRaisesRegex(HostFailure, 'rejects it'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse(self.active)

    def test_unsafe_release_entries_are_rejected(self):
        self.archive = release_tar({'../escape': b'x'})
        with self.assertRaisesRegex(HostFailure, 'unsafe entry'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.archive = release_tar()
        broken = io.BytesIO()
        with tarfile.open(fileobj=broken, mode='w') as archive:
            info = tarfile.TarInfo('ops/readme')
            info.size = 0
            archive.addfile(info, io.BytesIO(b''))
        self.archive = broken.getvalue()
        with self.assertRaisesRegex(HostFailure, 'does not contain'):
            host_setup.setup(self.identity, self.install_base(), False)

    def bundle_package(self, digest=None):
        runtime = pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'
        sys.path.insert(0, str(runtime))
        from cauce_container_base import bundle_digest
        sys.path.pop(0)
        with tempfile.TemporaryDirectory() as scratch:
            (pathlib.Path(scratch) / 'index.js').write_text('1\n')
            (pathlib.Path(scratch) / 'index.js').chmod(0o644)
            real = bundle_digest(scratch)
        self.archive = release_tar({'ops/container-runtime/cauce_container_base.py': (runtime / 'cauce_container_base.py').read_bytes(),
            'bundle/index.js': b'1\n'})
        self.package_overrides = {'artifacts': [{'name': 'release', 'kind': 'release', 'sha256': hashlib.sha256(self.archive).hexdigest(),
            'size': len(self.archive), 'url': self.url + '/artifacts/release'}],
            'policy': {'bundles': {'codex': {'directory': '@release@/bundle', 'digest': digest or real, 'executable': '/x',
                'executable_sha256': 'a' * 64, 'argv': []}}}}

    def test_bundle_digest_is_verified_against_the_extracted_release(self):
        self.bundle_package('f' * 64)
        with self.assertRaisesRegex(HostFailure, 'bundle digest differs'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse(self.active)
        self.bundle_package()
        self.assertTrue(host_setup.setup(self.identity, self.install_base(), False)['service_active'])

    def test_status_reports_executor_ready_only_after_setup(self):
        before = host_setup.status(self.identity, self.install_base())
        self.assertFalse(before['executor_ready'])
        self.assertEqual(before['reason'], 'setup_required')
        host_setup.setup(self.identity, self.install_base(), False)
        after = host_setup.status(self.identity, self.install_base())
        self.assertTrue(after['executor_ready'])
        self.active = False
        self.assertFalse(host_setup.status(self.identity, self.install_base())['executor_ready'])


if __name__ == '__main__':
    unittest.main()
