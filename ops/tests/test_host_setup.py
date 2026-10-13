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
            out = found.encode() + b'\n'
        if command[0] == host_setup.DOCKER and command[1] == 'load':
            self.assertEqual(hashlib.sha256(pathlib.Path(command[-1]).read_bytes()).hexdigest(), hashlib.sha256(self.image).hexdigest())
            self.docker_images[self.image_id] = self.loaded_as
        return subprocess.CompletedProcess(command, 0, out, b'')

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

    def test_dry_run_changes_nothing(self):
        receipt = host_setup.setup(self.identity, self.install_base(), True)
        self.assertTrue(receipt['dry_run'])
        self.assertIn('download and extract release', receipt['actions'])
        self.assertFalse(self.install_base().exists())
        self.assertFalse((self.home / '.config').exists())
        self.assertEqual(json.loads((self.identity / 'setup-signer.json').read_text()), {'fingerprint': hashlib.sha256(self.signer).hexdigest()})
        self.assertEqual(self.requests, [])

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

    def test_policy_cannot_override_local_identity_and_signer_is_anchored(self):
        self.package_overrides = {'policy': {'executor_user': 'root'}}
        with self.assertRaisesRegex(HostFailure, 'cannot override'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.package_overrides = {}
        host_setup.setup(self.identity, self.install_base(), False)
        other = self.home / 'other-signer'
        self.signer, self.signer_dir = ensure_key(other), other
        with self.assertRaisesRegex(HostFailure, 'differs from the anchored one'):
            host_setup.setup(self.identity, self.install_base(), False)

    def test_unanchored_identity_never_trusts_the_first_signer(self):
        (self.identity / 'setup-signer.json').unlink()
        with self.assertRaisesRegex(HostFailure, 'no setup signer is anchored'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse((self.identity / 'setup-signer.json').exists())
        self.assertFalse(self.install_base().exists())
        with self.assertRaisesRegex(HostFailure, 'differs from the anchored one'):
            host_setup.setup(self.identity, self.install_base(), False, 'a' * 64)
        expected = hashlib.sha256(self.signer).hexdigest()
        self.assertTrue(host_setup.setup(self.identity, self.install_base(), True, expected)['dry_run'])
        self.assertFalse((self.identity / 'setup-signer.json').exists())
        self.assertTrue(host_setup.setup(self.identity, self.install_base(), False, expected)['service_active'])
        self.assertEqual(json.loads((self.identity / 'setup-signer.json').read_text()), {'fingerprint': expected})

    def test_policy_user_placeholder_becomes_the_local_executor_user(self):
        self.package_overrides = {'policy': {'hooks': {'verify': {'user': '@user@', 'argv': ['@release@/hook']}}, 'bundles': {}}}
        host_setup.setup(self.identity, self.install_base(), False)
        policy = json.loads((self.install_base() / 'company-a/local-a/executor-policy.json').read_text())
        self.assertEqual(policy['hooks']['verify']['user'], policy['executor_user'])
        self.assertTrue(policy['hooks']['verify']['argv'][0].endswith('/hook'))
        self.assertNotIn('@', json.dumps(policy['hooks']))

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
            'size': len(self.archive)}],
            'policy': {'bundles': {'codex': {'directory': '@release@/bundle', 'digest': digest or real, 'executable': '/x',
                'executable_sha256': 'a' * 64, 'argv': []}}}}

    def test_release_directories_keep_their_archived_mode_whatever_the_umask(self):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode='w') as archive:
            for name, kind in (('ops', tarfile.DIRTYPE), ('ops/cli', tarfile.DIRTYPE), ('services', tarfile.DIRTYPE)):
                info = tarfile.TarInfo(name)
                info.type, info.mode = kind, 0o755 if name != 'services' else 0o777
                archive.addfile(info)
            for name in host_setup.REQUIRED_IN_RELEASE:
                info = tarfile.TarInfo(name)
                info.size, info.mode = 2, 0o644
                archive.addfile(info, io.BytesIO(b'1\n'))
        (self.home / 'release.tar').write_bytes(buffer.getvalue())
        previous = os.umask(0o077)
        try:
            host_setup.extract_release(self.home / 'release.tar', self.home / 'extracted')
        finally:
            os.umask(previous)
        modes = {name: (self.home / 'extracted' / name).stat().st_mode & 0o777 for name in ('ops', 'ops/cli', 'services')}
        self.assertEqual(modes, {'ops': 0o755, 'ops/cli': 0o755, 'services': 0o755})

    def test_bundle_digest_is_verified_against_the_extracted_release(self):
        self.bundle_package('f' * 64)
        with self.assertRaisesRegex(HostFailure, 'bundle digest differs'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse(self.active)
        self.bundle_package()
        self.assertTrue(host_setup.setup(self.identity, self.install_base(), False)['service_active'])

    def test_release_with_internal_links_extracts_and_escaping_links_are_refused(self):
        def linked(target: str) -> bytes:
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode='w') as archive:
                for name in host_setup.REQUIRED_IN_RELEASE + ('adapter/node_modules/.pnpm/ws/index.js',):
                    info = tarfile.TarInfo(name)
                    info.size = 2
                    archive.addfile(info, io.BytesIO(b'1\n'))
                link = tarfile.TarInfo('adapter/node_modules/ws')
                link.type, link.linkname = tarfile.SYMTYPE, target
                archive.addfile(link)
            return buffer.getvalue()
        (self.home / 'inside.tar').write_bytes(linked('.pnpm/ws'))
        host_setup.extract_release(self.home / 'inside.tar', self.home / 'inside')
        self.assertEqual((self.home / 'inside/adapter/node_modules/ws/index.js').read_text(), '1\n')
        for target in ('../../../escape', '/etc'):
            (self.home / 'outside.tar').write_bytes(linked(target))
            with self.assertRaisesRegex(HostFailure, 'unsafe entry'):
                host_setup.extract_release(self.home / 'outside.tar', self.home / 'outside')

    def test_a_cut_download_resumes_from_the_signed_offset(self):
        self.archive = release_tar({'ops/padding.bin': os.urandom(200_000)})
        self.cut_after = 70_000
        self.assertTrue(host_setup.setup(self.identity, self.install_base(), False)['service_active'])
        self.assertEqual(self.requests, ['release@0', 'release@70000'])

    def test_agent_image_is_downloaded_loaded_and_checked_once(self):
        self.image = os.urandom(150_000)
        self.package_overrides = {'policy': {'hooks': {}, 'bundles': {}, 'container_templates': [{'harness_id': 'codex', 'image': self.image_id}]}}
        dry = host_setup.setup(self.identity, self.install_base(), True)
        self.assertIn('download and load agent image ' + self.image_id, dry['actions'])
        self.assertEqual(self.requests, [])
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertEqual((receipt['image_id'], receipt['image_present'], receipt['image_loaded']), (self.image_id, False, True))
        self.assertEqual(self.requests, ['release@0', 'agent-image@0'])
        loads = [command for command in self.commands if command[:2] == [host_setup.DOCKER, 'load']]
        self.assertEqual(len(loads), 1)
        self.assertFalse(pathlib.Path(loads[0][-1]).exists())
        self.requests, self.commands = [], []
        again = host_setup.setup(self.identity, self.install_base(), False)
        self.assertEqual((again['image_present'], again['image_loaded']), (True, False))
        self.assertEqual(self.requests, [])
        self.assertFalse(any(command[:2] == [host_setup.DOCKER, 'load'] for command in self.commands))

    def test_agent_image_of_another_id_or_template_never_starts_the_service(self):
        self.image = os.urandom(1000)
        self.package_overrides = {'policy': {'hooks': {}, 'bundles': {}, 'container_templates': [{'harness_id': 'codex', 'image': 'sha256:' + 'f' * 64}]}}
        with self.assertRaisesRegex(HostFailure, 'no usa la imagen de agentes'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertEqual(self.requests, [])
        self.package_overrides = {'policy': {'hooks': {}, 'bundles': {}, 'container_templates': [{'harness_id': 'codex', 'image': self.image_id}]}}
        self.loaded_as = 'sha256:' + '1' * 64
        with self.assertRaisesRegex(HostFailure, 'otro almacén'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse(self.active)
        self.image_id, self.loaded_as = 'e' * 64, 'e' * 64
        with self.assertRaisesRegex(HostFailure, 'artifact is invalid'):
            host_setup.setup(self.identity, self.install_base(), False)

    def test_status_reports_executor_ready_only_after_setup(self):
        before = host_setup.status(self.identity, self.install_base())
        self.assertFalse(before['executor_ready'])
        self.assertEqual(before['reason'], 'setup_required')
        host_setup.setup(self.identity, self.install_base(), False)
        after = host_setup.status(self.identity, self.install_base())
        self.assertTrue(after['executor_ready'])
        self.active = False
        self.assertFalse(host_setup.status(self.identity, self.install_base())['executor_ready'])

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

    def test_other_company_identity_without_executor_policy_rejects_setup(self):
        other = self.home / 'state/company-b/local-b'
        other.mkdir(parents=True)
        (other / 'identity.json').write_text('{}')
        with self.assertRaisesRegex(HostFailure, 'one system user per company'):
            host_setup.setup(self.identity, self.install_base(), True)
        self.assertFalse(self.install_base().exists())

    def login_package(self, *, helper: bool = True, login: bool = True):
        cli = pathlib.Path(__file__).resolve().parents[1]
        files = {name: (cli / name.removeprefix('ops/')).read_bytes() for name in host_setup.LOGIN_HELPER_FILES} if helper else {}
        self.archive = release_tar(files)
        template = {'provider': 'codex', 'runtime_user': 'node', 'path_root': '/home/node/.cauce-profiles', 'command': '/usr/local/bin/codex',
            'command_sha256': 'c' * 64, 'runtime_mode': 'container', 'container_prefix': 'zz-'}
        if login:
            template['login'] = {'method': 'device', 'command': ['/usr/local/bin/codex', 'login', '--device-auth'], 'sha256': 'c' * 64}
        self.package_overrides = {'policy': {'hooks': {}, 'bundles': {}, 'profile_templates': [template]}}

    def test_signed_login_recipe_installs_a_private_auth_policy_named_by_the_unit(self):
        self.login_package()
        self.assertIn('write provider auth policy', host_setup.setup(self.identity, self.install_base(), True)['actions'])
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertTrue(receipt['provider_auth'])
        root = self.install_base() / 'company-a/local-a'
        auth_file, executor = root / 'provider-auth-policy.json', json.loads((root / 'executor-policy.json').read_text())
        self.assertEqual(oct(auth_file.stat().st_mode & 0o777), '0o600')
        self.assertEqual(oct((root / 'provider-login').stat().st_mode & 0o777), '0o700')
        auth = json.loads(auth_file.read_text())
        self.assertEqual(set(auth), {'schemaVersion', 'host_id', 'state_root', 'helper', 'profiles', 'profile_templates', 'logins'})
        self.assertEqual((auth['host_id'], auth['state_root'], auth['logins']), ('local-a', str(root / 'provider-login'), {}))
        self.assertEqual((auth['profiles'], auth['profile_templates']), (executor['profiles'], executor['profile_templates']))
        release = pathlib.Path(receipt['release'])
        self.assertEqual(auth['helper']['executable'], str(release / 'ops/cli/provider-login.py'))
        self.assertEqual(auth['helper']['files'], {str(release / name): hashlib.sha256((release / name).read_bytes()).hexdigest()
            for name in host_setup.LOGIN_HELPER_FILES})
        self.assertEqual(auth['helper']['sha256'], auth['helper']['files'][auth['helper']['executable']])
        self.assertNotRegex(auth_file.read_text(), r'(?i)token|secret|password|private')
        unit = (self.home / '.config/systemd/user' / self.unit_name).read_text()
        self.assertIn(f'Environment=CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE={auth_file}\n', unit)
        self.assertLess(unit.index('CAUCE_FLEET_POLICY_FILE='), unit.index('CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE='))
        self.assertTrue(host_setup.status(self.identity, self.install_base())['provider_auth'])
        self.commands = []
        self.assertFalse(host_setup.setup(self.identity, self.install_base(), False)['policy_changed'])
        self.assertNotIn(['systemctl', '--user', 'restart', self.unit_name], self.commands)

    def test_without_a_signed_login_recipe_the_unit_serves_no_provider_login(self):
        self.login_package(login=False)
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse(receipt['provider_auth'])
        self.assertFalse((self.install_base() / 'company-a/local-a/provider-auth-policy.json').exists())
        self.assertNotIn('CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE', (self.home / '.config/systemd/user' / self.unit_name).read_text())
        self.assertFalse(host_setup.status(self.identity, self.install_base())['provider_auth'])
        self.assertNotIn('write provider auth policy', host_setup.setup(self.identity, self.install_base(), True)['actions'])

    def test_withdrawn_login_recipe_removes_the_auth_policy_and_restarts_the_service(self):
        self.login_package()
        host_setup.setup(self.identity, self.install_base(), False)
        self.login_package(login=False)
        self.commands = []
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertTrue(receipt['policy_changed'])
        self.assertFalse(receipt['provider_auth'])
        self.assertFalse((self.install_base() / 'company-a/local-a/provider-auth-policy.json').exists())
        self.assertNotIn('CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE', (self.home / '.config/systemd/user' / self.unit_name).read_text())
        self.assertIn(['systemctl', '--user', 'restart', self.unit_name], self.commands)

    def test_login_recipe_and_agent_image_arrive_in_one_setup(self):
        self.login_package()
        self.image = os.urandom(50_000)
        self.package_overrides['policy']['container_templates'] = [{'harness_id': 'codex', 'image': self.image_id}]
        actions = host_setup.setup(self.identity, self.install_base(), True)['actions']
        self.assertEqual(actions[:4], ['download and extract release', 'download and load agent image ' + self.image_id,
            'write executor policy', 'write provider auth policy'])
        receipt = host_setup.setup(self.identity, self.install_base(), False)
        self.assertEqual((receipt['image_loaded'], receipt['provider_auth']), (True, True))
        self.assertEqual(self.requests, ['release@0', 'agent-image@0'])
        self.assertIn('CAUCE_FLEET_ENROLLED_AUTH_POLICY_FILE=', (self.home / '.config/systemd/user' / self.unit_name).read_text())

    def test_login_recipe_without_the_helper_in_the_release_does_not_start_the_service(self):
        self.login_package(helper=False)
        with self.assertRaisesRegex(HostFailure, 'provider login helper'):
            host_setup.setup(self.identity, self.install_base(), False)
        self.assertFalse(self.active)
        self.assertFalse((self.home / '.config/systemd/user' / self.unit_name).exists())

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
