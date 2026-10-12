from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import importlib
import io
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops/cli'))
import fleet_executor_hooks as hooks  # noqa: E402
import fleet_executor_policy as policy_validation  # noqa: E402
import fleet_executor_profiles as profiles  # noqa: E402
import fleet_executor_runtime as runtime  # noqa: E402
import fleet_executor_templates as templates  # noqa: E402
import fleet_provider_identity as identity  # noqa: E402
import harness_operations as operations  # noqa: E402


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

    def test_driver_rejects_foreign_harness_owner_and_profile_paths(self):
        for provider in ('grok', 'muse'):
            driver = self.driver(provider)
            for field, value in [('runtime_user', 'other'), ('provider', 'codex'), ('path', '/profile/../other')]:
                binding = {**self.binding, field: value}
                with self.subTest(provider=provider, field=field), self.assertRaises(ValueError):
                    driver.environment(binding, self.agent)

    def test_templates_accept_exact_device_login_and_reject_other_recipes(self):
        for provider in ('grok', 'muse'):
            driver = self.driver(provider)
            row = {key: value for key, value in self.binding.items() if key not in {'path', 'identity'}}
            row.update(path_root=str(self.root / 'profiles'), login={'method': 'device',
                'command': driver.login_command(self.binding), 'sha256': self.binding['command_sha256']})
            policy = {'bundles': {provider: {}}, 'profile_templates': [row]}
            templates.validate_templates(policy)
            for env in ({'META_API_KEY': 'forbidden-fixture'}, {'GROK_AUTH': 'forbidden-fixture'}, {'BASH_ENV': '/override'}):
                candidate = copy.deepcopy(row)
                candidate['login']['env'] = env
                with self.subTest(provider=provider, env=env), self.assertRaises(ValueError):
                    templates.validate_templates({**policy, 'profile_templates': [candidate]})
            candidate = copy.deepcopy(row)
            candidate['login']['command'].append('--oauth')
            with self.assertRaises(ValueError):
                templates.validate_templates({**policy, 'profile_templates': [candidate]})

    def test_login_environment_is_neutral_for_every_provider_and_openclaw(self):
        rows = []
        for provider, method, args in [('codex', 'device', ['login', '--device-auth']),
                ('claude', 'terminal', ['auth', 'login']), ('grok', 'device', ['login', '--device-auth']),
                ('muse', 'device', ['login'])]:
            rows.append({'provider': provider, 'command': '/provider/cli', 'command_sha256': 'a' * 64,
                'login': {'method': method, 'command': ['/provider/cli', *args], 'sha256': 'a' * 64}})
        rows.append({'provider': 'codex', 'command': '/provider/cli', 'command_sha256': 'a' * 64,
            'openclaw': {'node_command': '/provider/node', 'node_command_sha256': 'b' * 64},
            'login': {'method': 'device', 'command': ['/provider/node', '/provider/cli', 'models', 'auth', 'login'],
                'sha256': 'b' * 64, 'files': {'/provider/cli': 'a' * 64}}})
        for row in rows:
            candidate = copy.deepcopy(row)
            candidate['login']['env'] = {'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TERM': 'xterm', 'NO_COLOR': '1'}
            templates.validate_login(candidate)
            for key in ('CODEX_HOME', 'ANTHROPIC_API_KEY', 'META_API_KEY', 'GROK_AUTH', 'BASH_ENV'):
                candidate['login']['env'] = {key: 'forbidden-fixture'}
                with self.subTest(provider=row['provider'], openclaw='openclaw' in row, key=key), self.assertRaises(ValueError):
                    templates.validate_login(candidate)

    def test_runtime_and_inspection_use_the_same_clean_profile(self):
        for provider in ('grok', 'muse'):
            driver = self.driver(provider)
            policy = {'profiles': {'account': self.binding}}
            with mock.patch.dict(os.environ, {'META_API_KEY': 'forbidden-fixture', 'GROK_AUTH': 'forbidden-fixture'}):
                observed = json.loads(identity.command_output([str(self.cli)], self.packet))
            expected = driver.environment(self.binding, self.agent)
            values = runtime.provider_environment(policy, self.agent)
            for key, value in expected.items():
                self.assertEqual(values[key], value)
                self.assertEqual(observed['env'][key], value)
            self.assertEqual(observed['env']['HOME'], self.agent['home_directory'])
            self.assertEqual(observed['env']['PATH'], '/usr/bin:/bin')
            self.assertNotIn('META_API_KEY', observed['env'])
            self.assertNotIn('GROK_AUTH', observed['env'])
            command = self.bridge if provider == 'muse' else self.cli
            self.assertEqual(values['CAUCE_HARNESS_COMMAND'], str(command))
            pins = json.loads(values['CAUCE_HARNESS_COMMAND_FILES'])
            self.assertEqual(pins[str(self.cli)], self.binding['command_sha256'])

    def test_changed_binary_and_bridge_are_rejected_before_runtime(self):
        self.driver('muse')
        policy = {'profiles': {'account': self.binding}}
        self.binding['muse']['bridge_sha256'] = 'b' * 64
        with self.assertRaises(ValueError):
            runtime.provider_environment(policy, self.agent)
        self.driver('grok')
        self.cli.write_text('changed')
        with self.assertRaises(ValueError):
            runtime.provider_environment(policy, self.agent)

    def test_muse_profile_creates_owned_private_xdg_dirs_without_credentials(self):
        root = self.root / 'profiles'
        profile = root / 'isolated' / ('a' * 64)
        profiles.prepare_empty_profile(str(root), str(profile), os.getuid(), os.getgid(), provider='muse')
        for directory in (profile, profile / 'config', profile / 'data'):
            self.assertEqual(directory.stat().st_uid, os.getuid())
            self.assertEqual(directory.stat().st_mode & 0o777, 0o700)
        self.assertEqual(list((profile / 'config').iterdir()), [])
        self.assertEqual(list((profile / 'data').iterdir()), [])
        (profile / 'config').rmdir()
        (profile / 'config').symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            profiles.prepare_empty_profile(str(root), str(profile), os.getuid(), os.getgid(), provider='muse')

    def test_muse_binding_remains_resolvable_and_authentication_is_supported(self):
        driver = self.driver('muse')
        pathlib.Path(self.binding['path']).mkdir(mode=0o700)
        policy = {'profiles': {'account': self.binding}}
        with mock.patch.object(hooks, 'approve_agent', return_value=self.agent):
            account, binding = hooks.binding_for(policy, self.agent)
        self.assertEqual(account, 'account')
        self.assertEqual(binding['muse'], self.binding['muse'])
        self.assertTrue(driver.authentication_supported())
        self.assertFalse(identity.authenticated_provider(self.packet))
        for foreign in ({**self.binding, 'provider': 'grok'}, {**self.binding, 'muse': {'bridge': '/bridge'}}):
            with mock.patch.object(hooks, 'approve_agent', return_value=self.agent), self.assertRaises(ValueError):
                hooks.binding_for({'profiles': {'account': foreign}}, self.agent)

    def test_declarative_payload_uses_measured_muse_and_grok_efforts(self):
        document = {'operation_id': str(uuid.uuid4()), 'request': {'kind': 'create',
            'target': {'resource': 'agent', 'tenant_id': 'Team', 'alias': 'isolated'}, 'expected_revision': 0,
            'idempotency_key': 'isolated-request', 'parameters': {'harness_id': 'muse', 'runtime_key': 'isolated',
                'primary_room_id': 'room', 'memberships': [{'room_id': 'room', 'role': 'observer'}], 'placement': {}}},
            'fenced_targets': [], 'previous_agents': [], 'desired_memberships': []}
        parameters = document['request']['parameters']
        for effort in ('none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'):
            parameters['reasoning_effort'] = effort
            with self.subTest(effort=effort):
                self.assertIs(policy_validation.validate_payload(document), document)
        for provider, effort in [('grok', 'high'), ('muse', 'unapproved'), ('codex', 'none'), ('claude', 'ultra')]:
            parameters.update(harness_id=provider, reasoning_effort=effort)
            with self.subTest(provider=provider, effort=effort), self.assertRaises(ValueError):
                policy_validation.validate_payload(document)
        parameters.update(harness_id='grok', reasoning_effort=None)
        self.assertIs(policy_validation.validate_payload(document), document)
        for kind in ('start', 'restore'):
            request = {**document['request'], 'kind': kind, 'parameters': {}}
            for provider, effort in [('grok', 'high'), ('muse', 'unapproved')]:
                observed = {**document, 'request': request, 'snapshot': {'agents': [
                    {**request['target'], 'harness_id': provider, 'reasoning_effort': effort}]}}
                with self.subTest(kind=kind, provider=provider), self.assertRaises(ValueError):
                    policy_validation.validate_payload(observed)

    def test_conflicting_cli_or_bridge_pins_fail_closed(self):
        self.driver('muse')
        for filename in (str(self.cli), str(self.bridge)):
            self.binding['command_files'] = {filename: 'b' * 64}
            with self.subTest(filename=filename), self.assertRaises(ValueError):
                runtime.provider_environment({'profiles': {'account': self.binding}}, self.agent)
            with self.assertRaises(ValueError):
                identity.provider_command(self.packet)

    def test_runtime_rejects_profile_purge_overlap_invalid_selection_and_pin_shapes(self):
        for provider in ('grok', 'muse'):
            driver = self.driver(provider)
            for destination in (self.agent['state_directory'], self.agent['state_directory'] + '/profile'):
                with self.subTest(provider=provider, destination=destination), self.assertRaises(ValueError):
                    driver.environment({**self.binding, 'path': destination}, self.agent)
            for model in ('--override', 'model\nchanged'):
                with self.assertRaises(ValueError):
                    driver.environment(self.binding, {**self.agent, 'model_id': model})
            with self.assertRaises(ValueError):
                driver.environment(self.binding, {**self.agent, 'reasoning_effort': []})
            for pins in (None, []):
                binding = {**self.binding, 'command_files': pins}
                with self.assertRaises(ValueError):
                    runtime.provider_environment({'profiles': {'account': binding}}, self.agent)
                with self.assertRaises(ValueError):
                    identity.provider_command({**self.packet, 'profile_binding': binding})

    def test_model_arguments_are_real_and_grok_effort_is_unsupported(self):
        for provider in ('grok', 'muse'):
            driver = self.driver(provider)
            self.agent['model_id'] = 'approved-model'
            args = driver.execution_arguments(self.agent, '/private/prompt')
            self.assertIn('--model', args)
            self.assertEqual(args[args.index('--model') + 1], 'approved-model')
            self.agent['reasoning_effort'] = 'max'
            if provider == 'grok':
                with self.assertRaises(ValueError):
                    driver.execution_arguments(self.agent, '/private/prompt')
            else:
                args = driver.execution_arguments(self.agent, '/private/prompt')
                self.assertEqual(args[args.index('--reasoning-effort') + 1], 'max')
                self.assertNotIn('--effort', args)
            self.agent.pop('reasoning_effort')

    def test_missing_profile_identity_cannot_authenticate_or_emit_model_request(self):
        for provider in ('grok', 'muse'):
            driver = self.driver(provider)
            with mock.patch.object(identity, 'command_output', side_effect=AssertionError('no model or token request')):
                self.assertFalse(identity.authenticated_provider(self.packet))
            self.assertTrue(driver.authentication_supported())

    def test_providers_advertise_capabilities_only_with_a_descriptor_bundle(self):
        release = self.root / 'release'
        shutil.copytree(ROOT / 'packages/adapter-sdk/descriptors',
                        release / 'packages/adapter-sdk/dist/descriptors')
        for provider in ('grok', 'muse'):
            self.driver(provider)
            policy = {'bundles': {provider: {}}, 'profiles': {'account': self.binding}, 'native': [
                {'runtime_user': self.user, 'systemd_user': self.user, 'home_directory': str(self.root), 'state_root': str(self.root / 'state')}],
                'containers': {}, 'host_id': 'isolated', 'transport': {},
                'hooks': {name: {} for name in ('authenticate', 'profile', 'verify', 'revoke')}}
            self.assertEqual(templates.runtime_candidates(policy), [])
            policy['bundles'] = {provider: {'directory': str(release)}}
            observed = templates.runtime_candidates(policy)
            self.assertEqual([row['harness_id'] for row in observed], [provider])

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
text = token if mode == 'ok' else 'wrong'
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
                                        return_value={'email': identity_value, 'sub': 'subject-1'})
        else:
            directory = profile / 'config' / 'muse'
            directory.mkdir(mode=0o700, parents=True, exist_ok=True)
            auth = directory / 'auth.json'
            token = self.signed_id_token(signer, {'iss': 'https://auth.meta.com',
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
            with self.subTest(provider=provider, case='nonce'):
                self.assertFalse(identity.authenticated_provider(self.install_fake_cli(provider, 'wrong')))
            with self.subTest(provider=provider, case='exit'):
                self.assertFalse(identity.authenticated_provider(self.install_fake_cli(provider, 'fail')))
            with self.subTest(provider=provider, case='timeout'):
                started = time.monotonic()
                with mock.patch.object(identity, 'ROUNDTRIP_TIMEOUT', 1):
                    self.assertFalse(identity.authenticated_provider(self.install_fake_cli(provider, 'hang')))
                self.assertLess(time.monotonic() - started, 8)
                self.assertEqual(list(self.state.glob('.cauce-auth-prompt-*')), [])

    def test_forged_id_token_signature_does_not_bind_muse_identity(self):
        packet = self.install_fake_cli('muse', 'ok', signer='foreign')
        with mock.patch.object(identity, 'command_output', side_effect=AssertionError('model turn forbidden')):
            self.assertFalse(identity.authenticated_provider(packet))

    def test_local_grok_email_field_does_not_bind_identity_without_userinfo(self):
        driver = self.driver('grok')
        profile = pathlib.Path(self.binding['path'])
        profile.mkdir(mode=0o700, exist_ok=True)
        (profile / 'auth.json').write_text(json.dumps({'https://auth.fixture.invalid': {
            'key': 'fixture-token', 'email': 'subject'}}))
        with mock.patch.object(driver, 'fetch_userinfo', side_effect=OSError('provider unavailable')), \
                mock.patch.object(identity, 'command_output', side_effect=AssertionError('model turn forbidden')):
            self.assertFalse(identity.authenticated_provider(
                {**self.packet, 'fleet_module': 'fleet_provider_grok'}))

    def test_template_login_arguments_come_from_the_descriptor(self):
        self.driver('grok')
        bundle = self.root / 'descriptor-release'
        shutil.copytree(ROOT / 'packages/adapter-sdk/descriptors',
                        bundle / 'packages/adapter-sdk/dist/descriptors')
        descriptor = bundle / 'packages/adapter-sdk/dist/descriptors/grok.json'
        value = json.loads(descriptor.read_text())
        value['provider']['authenticate_argv'] = ['/usr/local/bin/grok', 'login', '--device-auth', '--tenant', 'fixture']
        descriptor.write_text(json.dumps(value))
        row = {key: val for key, val in self.binding.items() if key not in {'path', 'identity'}}
        row.update(path_root=str(self.root / 'profiles'), login={'method': 'device',
            'command': [str(self.cli), 'login', '--device-auth', '--tenant', 'fixture'],
            'sha256': self.binding['command_sha256']})
        templates.validate_templates({'bundles': {'grok': {'directory': str(bundle)}}, 'profile_templates': [row]})
        with self.assertRaises(ValueError):
            templates.validate_templates({'bundles': {'grok': {}}, 'profile_templates': [row]})

    def test_lifecycle_recipes_have_muse_login_and_no_unpinned_grok_update(self):
        bundle = self.root / 'release'
        shutil.copytree(ROOT / 'packages/adapter-sdk/descriptors',
                        bundle / 'packages/adapter-sdk/dist/descriptors')
        self.assertEqual(operations.provider_command('muse', 'authenticate', str(bundle)), ['/usr/local/bin/muse', 'login'])
        with self.assertRaises(operations.HarnessOperationFailure):
            operations.provider_command('grok', 'update', str(bundle))


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

    def test_v4_bridge_rejects_pin_change_secret_override_and_duplicate_effort(self):
        for key, value in [('CAUCE_MUSE_CLI_SHA256', '0' * 64), ('META_API_KEY', 'forbidden-fixture'),
                ('MUSE_CONFIG_DIR', '/legacy')]:
            with self.subTest(key=key):
                env = self.env.copy()
                self.env[key] = value
                self.assertNotEqual(self.run_bridge().returncode, 0)
                self.env = env
        result = self.run_bridge(('exec', '--json', '--reasoning-effort', 'high'))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['args'].count('--reasoning-effort'), 1)

    def test_v4_bridge_refuses_an_echo_provider_and_multiple_prompt_or_effort_flags(self):
        for args in [('exec', '--provider', 'echo'), ('exec', '--prompt-file', '/override'),
                ('exec', '--reasoning-effort', 'high', '--reasoning-effort=max')]:
            with self.subTest(args=args):
                self.assertNotEqual(self.run_bridge(args).returncode, 0)

    def test_bridge_without_exact_pins_refuses_legacy_launcher_and_relink(self):
        launcher = self.root / '.local/bin/muse'
        launcher.parent.mkdir(parents=True)
        launcher.write_bytes(self.binary.read_bytes())
        launcher.chmod(0o700)
        legacy = self.root / '.local/share/cauce-v3/config/hegel/.config/muse'
        legacy.mkdir(parents=True)
        for missing in (('CAUCE_MUSE_CLI_COMMAND', 'CAUCE_MUSE_CLI_SHA256'),
                ('CAUCE_MUSE_CLI_COMMAND',), ('CAUCE_MUSE_CLI_SHA256',)):
            saved = self.env.copy()
            for key in missing:
                self.env.pop(key)
            with self.subTest(missing=missing):
                self.assertEqual(self.run_bridge().returncode, 78)
                self.assertFalse((self.root / '.config').exists())
            self.env = saved


if __name__ == '__main__':
    unittest.main()
