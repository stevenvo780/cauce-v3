from __future__ import annotations

import base64
import contextlib
import hashlib
import importlib
import io
import json
import os
import pathlib
import pwd
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops/cli'))
import fleet_provider_identity as identity  # noqa: E402


class IsolatedProviderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='grok-muse-driver-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.cli = self.root / 'provider-cli'
        self.cli.write_text('#!/usr/bin/python3\nimport json,os,sys\nprint(json.dumps({"argv":sys.argv[1:],"env":dict(os.environ)}))\n')
        self.cli.chmod(0o700)
        self.bridge = ROOT / 'ops/container-runtime/muse-cauce'
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.user = pwd.getpwuid(os.getuid()).pw_name
        self.agent = {'runtime_user': self.user, 'home_directory': str(self.root), 'state_directory': str(self.state),
            'runtime_mode': 'native', 'harness_id': 'grok', 'runtime_key': 'isolated', 'model_id': None,
            'primary_account_id': 'account'}
        self.binding = {'provider': 'grok', 'runtime_user': self.user, 'identity': 'subject',
            'path': str(self.root / 'profile'), 'command': str(self.cli),
            'command_sha256': hashlib.sha256(self.cli.read_bytes()).hexdigest()}
        self.packet = {'agent': self.agent, 'profile_binding': self.binding, 'identity': 'subject', 'nonce': 'a' * 64}

    def driver(self, provider):
        self.agent['harness_id'] = provider
        self.binding['provider'] = provider
        if provider == 'muse':
            self.binding['muse'] = {'bridge': str(self.bridge), 'bridge_sha256': hashlib.sha256(self.bridge.read_bytes()).hexdigest()}
        else:
            self.binding.pop('muse', None)
        return importlib.import_module('fleet_provider_' + provider)

    def test_grok_profile_environment_is_exact_without_home_reassignment(self):
        driver = self.driver('grok')
        self.assertEqual(driver.environment(self.binding, self.agent), {'GROK_HOME': self.binding['path']})
        self.assertEqual(driver.login_command(self.binding), [str(self.cli), 'login', '--device-auth'])

    def test_grok_container_environment_is_pure_when_the_computer_has_no_agent_state(self):
        driver = self.driver('grok')
        state = self.root / 'absent-computer-parent' / 'state'
        self.assertFalse(state.parent.exists())
        values = driver.environment(self.binding, {**self.agent, 'runtime_mode': 'container', 'state_directory': str(state)})
        temporary = state / 'space' / 'tmp'
        self.assertEqual(values['TMPDIR'], str(temporary))
        self.assertFalse(state.parent.exists())
        self.assertEqual(values['CAUCE_GROK_WORKSPACE'], str(state / 'space' / 'projects'))
        self.assertNotEqual(values['TMPDIR'], values['GROK_HOME'] + '/tmp')
        self.assertFalse((pathlib.Path(values['GROK_HOME']) / 'tmp').exists())

    def test_muse_profile_environment_separates_auth_and_sessions(self):
        driver = self.driver('muse')
        values = driver.environment(self.binding, self.agent)
        self.assertEqual(values['XDG_CONFIG_HOME'], self.binding['path'] + '/config')
        self.assertEqual(values['XDG_DATA_HOME'], self.binding['path'] + '/data')
        self.assertEqual(values['MUSE_NO_AUTO_UPDATE'], '1')
        self.assertEqual(values['CAUCE_MUSE_CLI_COMMAND'], str(self.cli))
        self.assertEqual(values['CAUCE_MUSE_CLI_SHA256'], self.binding['command_sha256'])
        self.assertEqual(driver.login_command(self.binding), [str(self.cli), 'login'])
        self.assertNotIn('HOME', values)
        self.assertEqual(values['TMPDIR'], self.binding['path'] + '/tmp')
        self.assertNotIn('CAUCE_MUSE_WORKSPACE', values)

    def test_muse_container_environment_is_pure_when_the_computer_has_no_agent_state(self):
        driver = self.driver('muse')
        state = self.root / 'absent-computer-parent' / 'state'
        self.assertFalse(state.parent.exists())
        values = driver.environment(self.binding, {**self.agent, 'runtime_mode': 'container', 'state_directory': str(state)})
        temporary = state / 'space' / 'tmp'
        self.assertEqual(values['TMPDIR'], str(temporary))
        self.assertFalse(state.parent.exists())
        self.assertEqual(values['CAUCE_MUSE_WORKSPACE'], str(state / 'space' / 'projects'))

    def test_container_authentication_prepares_private_temp_before_the_nonce_turn(self):
        for provider in ('grok', 'muse'):
            with self.subTest(provider=provider):
                driver = self.driver(provider)
                state = self.root / ('agent-' + provider)
                state.mkdir(mode=0o700)
                packet = {**self.packet, 'agent': {**self.agent, 'runtime_mode': 'container', 'state_directory': str(state)}}

                def roundtrip(*_, state=state):
                    temporary = state / 'space' / 'tmp'
                    self.assertTrue(temporary.is_dir())
                    self.assertFalse(temporary.is_symlink())
                    self.assertEqual(temporary.stat().st_mode & 0o777, 0o700)
                    return True

                with mock.patch.object(driver, 'nonce_roundtrip', side_effect=roundtrip) as nonce, \
                        mock.patch.object(driver, 'verified_identities', return_value={'subject'}):
                    self.assertEqual(driver.authenticated_identity(packet), 'subject')
                nonce.assert_called_once()

    def test_driver_rejects_foreign_harness_owner_and_profile_paths(self):
        for provider in ('grok', 'muse'):
            driver = self.driver(provider)
            for field, value in [('runtime_user', 'other'), ('provider', 'codex'), ('path', '/profile/../other')]:
                binding = {**self.binding, field: value}
                with self.subTest(provider=provider, field=field), self.assertRaises(ValueError):
                    driver.environment(binding, self.agent)

    @staticmethod
    def b64(raw):
        return base64.urlsafe_b64encode(raw).decode().rstrip('=')

    def rsa_key(self, name):
        pem = self.root / f'{name}.pem'
        if not pem.exists():
            subprocess.run(['openssl', 'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048',
                            '-out', str(pem)], check=True, capture_output=True, timeout=30)
            pem.chmod(0o600)
        return pem

    def jwk(self, name):
        pem = self.rsa_key(name)
        modulus = subprocess.run(['openssl', 'rsa', '-in', str(pem), '-modulus', '-noout'],
                                 check=True, capture_output=True, text=True, timeout=10).stdout.strip().removeprefix('Modulus=')
        n = int(modulus, 16).to_bytes((len(modulus) + 1) // 2, 'big').lstrip(b'\0')
        return {'kty': 'RSA', 'kid': 'fixture', 'n': self.b64(n), 'e': self.b64((65537).to_bytes(3, 'big'))}

    def signed_id_token(self, name, claims):
        header = self.b64(json.dumps({'alg': 'RS256', 'kid': 'fixture'}).encode())
        payload = self.b64(json.dumps(claims).encode())
        signing = f'{header}.{payload}'.encode()
        signature = subprocess.run(['openssl', 'dgst', '-sha256', '-sign', str(self.rsa_key(name))],
                                   input=signing, check=True, capture_output=True, timeout=10).stdout
        return f'{header}.{payload}.{self.b64(signature)}'

    FAKE_CLI = '''#!/usr/bin/python3
import json, pathlib, re, sys, time
mode = '__MODE__'
if mode == 'hang':
    time.sleep(30)
if mode == 'fail':
    sys.exit(3)
args = sys.argv[1:]
prompt = pathlib.Path(args[args.index('--prompt-file') + 1]).read_text()
token = re.search(r'CAUCE_BOOTSTRAP_[0-9a-f]+', prompt).group(0)
text = 'CAUCE_BOOTSTRAP_' + 'a' * 64 if mode == 'replay' else token if mode == 'ok' else 'wrong'
if '__PROVIDER__' == 'grok':
    print(json.dumps({'text': text, 'stopReason': 'end_turn'}))
else:
    print(json.dumps({'payload': {'kind': 'run_output_delta', 'text': text}}))
    print(json.dumps({'payload': {'kind': 'run_terminal', 'terminal': 'completed', 'text': text}}))
'''

    def install_fake_cli(self, provider, mode, identity_value='subject', *, signer='signing'):
        driver = self.driver(provider)
        fake = self.root / f'fake-{provider}-{mode}-{signer}'
        fake.write_text(self.FAKE_CLI.replace('__MODE__', mode).replace('__PROVIDER__', provider))
        fake.chmod(0o700)
        self.binding['command'] = str(fake)
        self.binding['command_sha256'] = hashlib.sha256(fake.read_bytes()).hexdigest()
        profile = pathlib.Path(self.binding['path'])
        if provider == 'grok':
            profile.mkdir(mode=0o700, exist_ok=True)
            auth = profile / 'auth.json'
            auth.write_text(json.dumps({'https://auth.fixture.invalid': {
                'key': 'fixture-token', 'email': 'local-forged@fixture.invalid'}}))
            patcher = mock.patch.object(driver, 'fetch_userinfo',
                                        return_value={'email': identity_value, 'email_verified': True, 'sub': 'subject-1'})
        else:
            directory = profile / 'config' / 'muse'
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            auth = directory / 'auth.json'
            token = self.signed_id_token(signer, {'iss': 'https://auth.meta.com',
                'aud': '1031625952748946', 'iat': int(time.time()),
                'sub': identity_value, 'exp': int(time.time()) + 3600})
            auth.write_text(json.dumps({'token': token}))
            patcher = mock.patch.object(driver, 'fetch_jwks', return_value={'keys': [self.jwk('signing')]})
        auth.chmod(0o600)
        patcher.start()
        self.addCleanup(patcher.stop)
        packet = {**self.packet, 'fleet_module': f'fleet_provider_{provider}'}
        return packet

    def test_fake_cli_authenticates_grok_and_muse_with_identity_and_nonce(self):
        for provider in ('grok', 'muse'):
            with self.subTest(provider=provider):
                packet = self.install_fake_cli(provider, 'ok')
                streams = io.StringIO()
                with contextlib.redirect_stdout(streams), contextlib.redirect_stderr(streams):
                    self.assertTrue(identity.authenticated_provider(packet))
                self.assertEqual(streams.getvalue(), '')
                self.assertEqual(list(self.state.glob('.cauce-auth-prompt-*')), [])

    def test_fake_cli_wrong_identity_wrong_nonce_exit_and_timeout_all_fail_closed(self):
        for provider in ('grok', 'muse'):
            with self.subTest(provider=provider, case='identity'):
                self.assertFalse(identity.authenticated_provider(self.install_fake_cli(provider, 'ok', 'foreign')))
                self.assertEqual(identity.last_probe_failure(), 'identity_mismatch')
            with self.subTest(provider=provider, case='nonce'):
                self.assertFalse(identity.authenticated_provider(self.install_fake_cli(provider, 'wrong')))
                self.assertEqual(identity.last_probe_failure(), 'probe_nonce_mismatch')
            with self.subTest(provider=provider, case='exit'):
                self.assertFalse(identity.authenticated_provider(self.install_fake_cli(provider, 'fail')))
                self.assertEqual(identity.last_probe_failure(), 'probe_exit_3')
            with self.subTest(provider=provider, case='timeout'):
                started = time.monotonic()
                with mock.patch.object(identity, 'ROUNDTRIP_TIMEOUT', 1):
                    self.assertFalse(identity.authenticated_provider(self.install_fake_cli(provider, 'hang')))
                self.assertLess(time.monotonic() - started, 8)
                self.assertEqual(identity.last_probe_failure(), 'probe_timeout after 1s')
            with self.subTest(provider=provider, case='scope'):
                packet = self.install_fake_cli(provider, 'ok')
                packet = {**packet, 'profile_binding': {**packet['profile_binding'], 'runtime_user': 'other'}}
                self.assertFalse(identity.authenticated_provider(packet))
                self.assertEqual(identity.last_probe_failure(), 'config_scope')
                self.assertEqual(list(self.state.glob('.cauce-auth-prompt-*')), [])

    def test_muse_without_id_token_uses_the_email_of_its_meta_token(self):
        packet = self.install_fake_cli('muse', 'ok', 'owner@fixture.invalid')
        auth = pathlib.Path(self.binding['path']) / 'config' / 'muse' / 'auth.json'
        auth.write_text(json.dumps({'providers': {'meta': {'access_token': 'fixture-token', 'api_base_url': 'api.fixture.invalid',
            'user_email': 'owner@fixture.invalid'}}}))
        self.assertTrue(identity.authenticated_provider({**packet, 'identity': 'owner@fixture.invalid'}))
        self.assertTrue(identity.authenticated_provider({**packet, 'identity': 'unverified:muse'}))
        self.assertFalse(identity.authenticated_provider({**packet, 'identity': 'foreign@fixture.invalid'}))
        auth.write_text(json.dumps({'providers': {'meta': {'user_email': 'owner@fixture.invalid'}}}))
        self.assertFalse(identity.authenticated_provider({**packet, 'identity': 'owner@fixture.invalid'}))

class MuseBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='muse-bridge-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.binary = self.root / 'muse-bin'
        self.binary.write_text('#!/usr/bin/python3\nimport json,os,pathlib,sys\na=sys.argv[1:]\np=pathlib.Path(a[a.index("--prompt-file")+1])\nprint(json.dumps({"args":a,"prompt":p.read_text(),"api_key":"META_API_KEY" in os.environ}))\n')
        self.binary.chmod(0o700)
        self.env = {'PATH': '/usr/bin:/bin', 'HOME': str(self.root), 'TMPDIR': str(self.root),
            'XDG_CONFIG_HOME': str(self.root / 'config'), 'XDG_DATA_HOME': str(self.root / 'data'),
            'CAUCE_MUSE_CLI_COMMAND': str(self.binary), 'CAUCE_MUSE_CLI_SHA256': hashlib.sha256(self.binary.read_bytes()).hexdigest()}
        self.bridge = ROOT / 'ops/container-runtime/muse-cauce'

    def run_bridge(self, args=('exec', '--json')):
        return subprocess.run(['bash', str(self.bridge), *args], input='exact prompt', text=True,
            env=self.env, cwd=self.root, capture_output=True, timeout=5)

    def test_v4_bridge_uses_pinned_binary_no_legacy_link_and_deletes_prompt(self):
        result = self.run_bridge()
        self.assertEqual(result.returncode, 0, result.stderr)
        observed = json.loads(result.stdout)
        self.assertEqual(observed['prompt'], 'exact prompt')
        self.assertFalse(observed['api_key'])
        self.assertEqual(observed['args'].count('--reasoning-effort'), 1)
        self.assertFalse((self.root / '.config').exists())
        self.assertEqual(list(self.root.glob('muse-prompt.*')), [])

if __name__ == '__main__':
    unittest.main()
