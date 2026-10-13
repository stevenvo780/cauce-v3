from __future__ import annotations

import copy
import hashlib
import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli'
sys.path.insert(0, str(CLI))
import fleet_executor_runtime as runtime  # noqa: E402
import fleet_executor_templates as templates  # noqa: E402
import fleet_provider_identity as identity  # noqa: E402
import fleet_provider_openclaw as driver  # noqa: E402

SCRIPT = '''import fs from 'node:fs';
const argv=process.argv.slice(2);
const root=process.env.OPENCLAW_HOME;
const mode=fs.existsSync(root+'/mode')?fs.readFileSync(root+'/mode','utf8'):'';
if(argv.includes('--version')) { console.log(mode==='version'?'2026.1.1':'OpenClaw 2026.6.6 (8c802aa)'); }
else if(argv.includes('list')) {
 let meta={agentId:'runtime-one',provider:'openai',profiles:[{id:'cauce:account-one',provider:'openai',type:'oauth',email:'observed@fixture.invalid',expiresAt:'2099-01-01T00:00:00Z'}]};
 if(mode.startsWith('anthropic')) { meta.provider='anthropic'; meta.profiles[0].provider='anthropic'; }
 if(mode.startsWith('anthropic-token')) { meta.profiles[0].type='token'; delete meta.profiles[0].expiresAt; }
 if(mode==='anthropic-token-expired') meta.profiles[0].expiresAt='2000-01-01T00:00:00Z';
 if(mode==='anthropic-token-identity') delete meta.profiles[0].email;
 if(mode==='identity') meta.profiles[0].email='foreign@fixture.invalid';
 if(mode==='account') meta.profiles[0].id='cauce:foreign';
 if(mode==='provider') meta.profiles[0].provider='anthropic';
 if(mode==='agent') meta.agentId='foreign';
 if(mode==='expiry') meta.profiles[0].expiresAt='2000-01-01T00:00:00Z';
 if(mode==='cooldown') meta.profiles[0].cooldownUntil='2099-01-01T00:00:00Z';
 if(mode==='ambiguous') meta.profiles.push({...meta.profiles[0],id:'other'});
 if(mode==='type') meta.profiles[0].type='api_key';
 if(mode==='shape') meta=[];
 if(mode==='profile-shape') meta.profiles=[false];
 fs.writeFileSync(root+'/observed-env',JSON.stringify(process.env));
 console.log(JSON.stringify(meta));
} else {
 fs.writeFileSync(root+'/observed-args',JSON.stringify(argv));
 let text=argv[argv.indexOf('--message')+1].split('únicamente ')[1].split('.')[0];
 if(mode==='nonce') text='wrong';
 console.log(JSON.stringify({payloads:[{text}]}));
}
'''


class OpenClawProviderTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-openclaw-proof-')
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.profile = self.root / 'profile'
        self.profile.mkdir(mode=0o700)
        self.state = self.root / 'state'
        self.state.mkdir(mode=0o700)
        self.command = self.root / 'cli.mjs'
        self.command.write_text(SCRIPT)
        self.command.chmod(0o600)
        self.source = self.root / 'auth-list.js'
        self.source.write_bytes((CLI.parent / 'tests/fixtures/openclaw-auth-list-2026.6.6.txt').read_bytes())
        self.source.chmod(0o600)
        self.bridge = self.root / 'bridge.mjs'
        self.bridge.write_text('export const bridge=true;')
        self.bridge.chmod(0o600)
        self.node = str(pathlib.Path(shutil.which('node')).resolve())
        pins = {'provider_id': 'openai', 'method_id': 'device-code', 'version': driver.VERSION,
                'auth_list_source': str(self.source), 'auth_list_sha256': driver.AUTH_LIST_SHA256,
                'node_command': self.node, 'node_command_sha256': self.hash(self.node),
                'bridge': str(self.bridge), 'bridge_sha256': self.hash(self.bridge)}
        self.binding = {'provider': 'codex', 'path': str(self.profile), 'identity': 'observed@fixture.invalid',
                        'runtime_user': 'fixture', 'command': str(self.command), 'command_sha256': self.hash(self.command), 'openclaw': pins}
        self.agent = {'harness_id': 'openclaw', 'runtime_mode': 'native', 'runtime_user': 'fixture', 'runtime_key': 'runtime-one',
                      'home_directory': str(self.root), 'state_directory': str(self.state), 'primary_account_id': 'account-one',
                      'model_id': 'openai/gpt-5.5', 'reasoning_effort': 'high'}
        self.packet = {'agent': self.agent, 'profile_binding': self.binding, 'account_id': 'account-one',
                       'identity': 'observed@fixture.invalid', 'nonce': 'a' * 64}
        driver.prepare(self.binding, self.agent)

    @staticmethod
    def hash(path):
        return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest()

    def test_fixture_cli_process_observes_identity_and_nonce_with_exact_local_model(self):
        self.assertTrue(identity.authenticated_provider(self.packet))
        argv = json.loads((self.profile / 'observed-args').read_bytes())
        for key, expected in [('--agent', 'runtime-one'), ('--model', 'openai/gpt-5.5'), ('--thinking', 'high')]:
            self.assertEqual(argv[argv.index(key) + 1], expected)
        self.assertIn('--local', argv)
        env = json.loads((self.profile / 'observed-env').read_bytes())
        for key, expected in driver.environment(self.binding, self.agent).items():
            self.assertEqual(env[key], expected)
        self.assertEqual(env['HOME'], str(self.root))
        self.assertEqual(env['OPENCLAW_AUTH_STORE_READONLY'], '1')
        self.assertNotEqual(env['CODEX_HOME'], env['HOME'])

    def test_fixture_cli_uses_a_fresh_runtime_scoped_session_for_each_nonce(self):
        sessions = []
        for nonce in ('a' * 64, 'b' * 64):
            self.packet['nonce'] = nonce
            self.assertTrue(identity.authenticated_provider(self.packet))
            argv = json.loads((self.profile / 'observed-args').read_bytes())
            sessions.append(argv[argv.index('--session-key') + 1])
            self.assertIn('CAUCE_BOOTSTRAP_' + nonce, argv[argv.index('--message') + 1])
        self.assertNotEqual(*sessions)
        for session in sessions:
            self.assertTrue(session.startswith('agent:runtime-one:cauce-auth-'))

    def test_wrong_process_observations_are_never_identity_or_effect(self):
        for mode in ('identity', 'account', 'provider', 'agent', 'expiry', 'cooldown', 'ambiguous', 'type', 'shape', 'profile-shape', 'nonce', 'version'):
            with self.subTest(mode=mode):
                (self.profile / 'mode').write_text(mode)
                self.assertFalse(identity.authenticated_provider(self.packet))

    def test_input_identity_is_not_proof_and_account_cannot_change(self):
        self.packet['identity'] = self.binding['identity'] = 'foreign@fixture.invalid'
        self.assertFalse(identity.authenticated_provider(self.packet))
        self.packet['identity'] = self.binding['identity'] = 'observed@fixture.invalid'
        self.packet['account_id'] = 'foreign'
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_model_effort_and_nonce_are_exact_and_never_fall_back_to_cli_defaults(self):
        for field, value in [('model_id', None), ('model_id', 'anthropic/claude'), ('reasoning_effort', 'unmeasured')]:
            original = self.agent[field]
            self.agent[field] = value
            self.assertFalse(identity.authenticated_provider(self.packet))
            self.agent[field] = original
        self.packet['nonce'] = 'external text'
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_cli_source_node_and_bridge_pins_are_independent(self):
        for path in (self.command, self.source, self.bridge):
            with self.subTest(path=path):
                body = path.read_bytes()
                path.write_bytes(body + b'\nchanged')
                self.assertFalse(identity.authenticated_provider(self.packet))
                path.write_bytes(body)
        self.binding['openclaw']['node_command_sha256'] = '0' * 64
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_config_is_idempotent_and_rejects_foreign_changes_without_overwrite(self):
        config = self.profile / 'openclaw.json'
        before = config.read_bytes()
        self.agent['model_id'] = 'openai/gpt-5.4'
        driver.prepare(self.binding, self.agent)
        self.assertEqual(config.read_bytes(), before)
        self.assertEqual(config.stat().st_mode & 0o777, 0o600)
        changed = json.loads(before)
        changed['agents']['list'][0]['id'] = 'foreign'
        config.write_text(json.dumps(changed))
        with self.assertRaises(ValueError):
            driver.prepare(self.binding, self.agent)
        self.assertEqual(json.loads(config.read_bytes()), changed)
        self.assertFalse((self.profile / 'auth.json').exists())
        self.assertEqual(list((self.profile / '.external-cli-disabled').iterdir()), [])

    def test_symlink_and_malformed_configs_fail_closed(self):
        config = self.profile / 'openclaw.json'
        for changed in ([], {'agents': False}, {'agents': {'list': [False]}, 'auth': {}}):
            config.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):
                driver.read_config(self.binding, self.agent)
        config.unlink()
        config.symlink_to(self.command)
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_existing_static_profile_prepares_configuration_in_the_exact_user_without_chown_or_auth_copy(self):
        import fleet_executor_policy
        import fleet_executor_profiles
        self.agent['runtime_user'] = self.binding['runtime_user'] = pwd.getpwuid(os.geteuid()).pw_name
        config = self.profile / 'openclaw.json'
        config.unlink()
        policy = {'profiles': {'account-one': self.binding}}
        with mock.patch.object(fleet_executor_policy, 'approve_agent', return_value=self.agent), \
                mock.patch.object(templates, 'resolve_profile', return_value=self.binding):
            fleet_executor_profiles.prepare_profile(policy, self.agent)
        self.assertTrue(config.is_file())
        self.assertEqual(config.stat().st_uid, os.geteuid())
        self.assertFalse(any(self.profile.rglob('auth.json')))

    def test_container_preparation_sends_bounded_public_packet_to_exact_runtime_user_over_stdin(self):
        import fleet_executor_container
        import fleet_executor_policy
        import fleet_executor_profiles
        agent = {**self.agent, 'runtime_mode': 'container', 'container_name': 'isolated', '_placement': {'python': '/usr/bin/python3'}}
        binding = {**self.binding, 'container_name': 'isolated'}
        with mock.patch.object(fleet_executor_policy, 'approve_agent', return_value=agent), \
                mock.patch.object(templates, 'resolve_profile', return_value=binding), \
                mock.patch.object(fleet_executor_container, 'inspect_container', return_value={}), \
                mock.patch.object(fleet_executor_container, 'validate_container'), \
                mock.patch.object(fleet_executor_container, 'identity_for', return_value={'container_id': 'a' * 64}), \
                mock.patch.object(fleet_executor_container, 'user_identity', return_value=('1000', '1000')), \
                mock.patch.object(fleet_executor_container, 'checked_command') as execute:
            fleet_executor_profiles.prepare_profile({'profiles': {'account-one': binding}}, agent)
        argv = execute.call_args.args[0]
        self.assertEqual(argv[argv.index('--user') + 1], agent['runtime_user'])
        self.assertIn('-i', argv)
        packet = json.loads(execute.call_args.kwargs['input_data'])
        self.assertEqual(packet['profile_binding'], binding)
        self.assertNotIn('_placement', packet['agent'])

    def test_runtime_uses_node_bridge_dist_and_cli_pins_instead_of_auth_cli_as_harness(self):
        with mock.patch.object(templates, 'resolve_profile', return_value=self.binding):
            env = runtime.provider_environment({}, self.agent)
        self.assertEqual(env['CAUCE_HARNESS_COMMAND'], self.node)
        self.assertEqual(env['CAUCE_HARNESS_BRIDGE'], str(self.bridge))
        self.assertEqual(env['CAUCE_OPENCLAW_DIST_DIR'], str(self.source.parent))
        pins = json.loads(env['CAUCE_HARNESS_COMMAND_FILES'])
        self.assertEqual(pins[str(self.command)], self.hash(self.command))
        self.assertEqual(pins[str(self.source)], driver.AUTH_LIST_SHA256)

    def test_native_and_openclaw_templates_with_same_provider_resolve_separately(self):
        native = {'provider': 'codex', 'runtime_user': 'fixture', 'path_root': str(self.root / 'profiles-native'),
                  'command': str(self.command), 'command_sha256': self.hash(self.command)}
        claw = {**native, 'path_root': str(self.root / 'profiles-claw'), 'openclaw': self.binding['openclaw']}
        policy = {'bundles': {}, 'profiles': {}, 'profile_templates': [native, claw]}
        templates.validate_templates(policy)
        agent = {**self.agent, 'tenant_id': 'tenant', '_placement': {'state_root': str(self.state)},
                 '_trusted_accounts_present': True, '_trusted_accounts': [{'id': 'account-one', 'provider': 'codex',
                  'external_account_id': 'observed@fixture.invalid', 'enabled': True, 'payer_tenant_id': 'tenant', 'shared_with_pool': False}]}
        binding = templates.resolve_profile(policy, agent)
        self.assertTrue(binding['path'].startswith(claw['path_root'] + '/runtime-one/'))
        self.assertIn('openclaw', binding)
        agent['harness_id'] = 'codex'
        binding = templates.resolve_profile(policy, agent)
        self.assertTrue(binding['path'].startswith(native['path_root'] + '/runtime-one/'))
        self.assertNotIn('openclaw', binding)
        agent['harness_id'] = 'openclaw'
        agent['_trusted_accounts'][0]['provider'] = 'claude'
        with self.assertRaises(ValueError):
            templates.resolve_profile(policy, agent)

    def test_model_is_required_before_activation_and_unrelated_or_retired_agents_do_not_block_stop(self):
        import fleet_executor_policy
        target = {'resource': 'agent', 'tenant_id': 'Tenant', 'alias': 'runtime-one'}
        document = {'operation_id': '00000000-0000-4000-8000-000000000001', 'fenced_targets': [target], 'previous_agents': [],
                    'desired_memberships': [], 'snapshot': {'agents': [{'tenant_id': 'Tenant', 'alias': 'runtime-one',
                      'harness_id': 'openclaw', 'model_id': None}]}, 'request': {'kind': 'start', 'target': target,
                      'parameters': {}, 'expected_revision': 0, 'idempotency_key': 'scoped-model'}}
        for action in ('start', 'restore'):
            document['request']['kind'] = action
            with self.assertRaisesRegex(ValueError, 'explicit measured provider model'):
                fleet_executor_policy.validate_payload(document)
        for action in ('stop', 'retire', 'purge'):
            document['request']['kind'] = action
            self.assertIs(fleet_executor_policy.validate_payload(document), document)
        document['request']['kind'] = 'start'
        document['snapshot']['agents'][0]['alias'] = 'unrelated'
        self.assertIs(fleet_executor_policy.validate_payload(document), document)
        document['request']['kind'] = 'create'
        document['request']['parameters'] = {'runtime_key': 'runtime-one', 'harness_id': 'openclaw', 'primary_room_id': 'room',
                                             'memberships': [], 'placement': {}}
        with self.assertRaisesRegex(ValueError, 'explicit measured provider model'):
            fleet_executor_policy.validate_payload(document)

    def test_capability_requires_ready_fixture_authority_and_measured_provider_pins(self):
        template = {**self.binding, 'path_root': str(self.root / 'profiles')}
        template.pop('path')
        template.pop('identity')
        release = self.root / 'release'
        shutil.copytree(CLI.parents[1] / 'packages/adapter-sdk/descriptors',
                        release / 'packages/adapter-sdk/dist/descriptors')
        policy = {'host_id': 'isolated', 'native': [{'runtime_user': 'fixture', 'systemd_user': 'fixture',
                  'home_directory': str(self.root), 'state_root': str(self.state)}], 'containers': {},
                  'bundles': {'codex': {'directory': str(release)}, 'openclaw': {'directory': str(release)}},
                  'profiles': {}, 'profile_templates': [template],
                  'transport': {}, 'hooks': {key: {} for key in ('authenticate', 'profile', 'verify', 'revoke')}}
        self.assertFalse(templates.capabilities(policy)['available'])
        certificate, key = self.root / 'capability-ca.crt', self.root / 'capability-ca.key'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
            '-subj', '/CN=isolated-capability-fixture', '-addext', 'basicConstraints=critical,CA:TRUE',
            '-keyout', str(key), '-out', str(certificate)], capture_output=True, check=True, timeout=10)
        key.chmod(0o600)
        certificate.chmod(0o600)
        policy['signer'] = {'certificate': str(certificate), 'key': str(key)}
        observed = templates.capabilities(policy)
        runtimes = observed['placements'][0]['runtimes']
        self.assertEqual([(row['harness_id'], row['provider']) for row in runtimes], [('openclaw', 'codex')])
        template['provider'] = 'claude'
        template['openclaw'] = {**template['openclaw'], 'provider_id': 'anthropic'}
        observed = templates.capabilities(policy)
        self.assertFalse(observed['available'])
        template['openclaw'] = {**template['openclaw'], 'method_id': 'setup-token'}
        runtimes = templates.capabilities(policy)['placements'][0]['runtimes']
        self.assertEqual([(row['harness_id'], row['provider']) for row in runtimes], [('openclaw', 'claude')])
        template['provider'] = 'codex'
        template['openclaw'] = {**template['openclaw'], 'provider_id': 'openai', 'method_id': 'device-code'}
        policy['signer']['key'] = str(self.root / 'missing-capability-key')
        self.assertFalse(templates.capabilities(policy)['available'])
        policy['signer']['key'] = str(key)
        template['openclaw']['node_command_sha256'] = '0' * 64
        self.assertFalse(templates.capabilities(policy)['available'])

    def test_unmeasured_or_cross_provider_definition_is_rejected(self):
        for field, changed in [('version', '2026.1.1'), ('provider_id', 'anthropic'), ('method_id', 'cli'), ('auth_list_sha256', '0' * 64)]:
            value = copy.deepcopy(self.binding['openclaw'])
            value[field] = changed
            with self.assertRaises(ValueError):
                driver.validate_definition(value, 'codex')
        with self.assertRaises(ValueError):
            driver.validate_definition(self.binding['openclaw'], 'claude')
        anthropic = {**copy.deepcopy(self.binding['openclaw']), 'provider_id': 'anthropic', 'method_id': 'setup-token'}
        driver.validate_definition(anthropic, 'claude')
        with self.assertRaisesRegex(ValueError, 'no measured independent account flow'):
            driver.validate_definition(anthropic, 'codex')
        for method in ('oauth', 'device-code', 'cli', 'api-key'):
            with self.subTest(method=method), self.assertRaisesRegex(ValueError, 'no measured independent account flow'):
                driver.validate_definition({**anthropic, 'method_id': method}, 'claude')

    def anthropic(self, mode='anthropic-token'):
        self.binding['provider'] = 'claude'
        self.binding['openclaw'] = {**self.binding['openclaw'], 'provider_id': 'anthropic', 'method_id': 'setup-token'}
        self.agent['model_id'] = 'anthropic/claude-opus-5'
        (self.profile / 'openclaw.json').unlink()
        driver.prepare(self.binding, self.agent)
        (self.profile / 'mode').write_text(mode)

    def test_anthropic_setup_token_authenticates_with_the_controlled_cli(self):
        self.anthropic()
        config = json.loads((self.profile / 'openclaw.json').read_bytes())
        self.assertEqual(config['auth']['order'], {'anthropic': ['cauce:account-one']})
        self.assertTrue(identity.authenticated_provider(self.packet))
        argv = json.loads((self.profile / 'observed-args').read_bytes())
        self.assertEqual(argv[argv.index('--model') + 1], 'anthropic/claude-opus-5')
        env = json.loads((self.profile / 'observed-env').read_bytes())
        self.assertEqual(env['CLAUDE_CONFIG_DIR'], str(self.profile / '.external-cli-disabled'))
        self.assertEqual(env['OPENCLAW_AUTH_STORE_READONLY'], '1')

    def test_anthropic_requires_its_profile_type_identity_expiry_and_model(self):
        for mode in ('anthropic', 'anthropic-token-expired', 'anthropic-token-identity', 'identity', 'nonce'):
            with self.subTest(mode=mode):
                self.anthropic(mode)
                self.assertFalse(identity.authenticated_provider(self.packet))
        self.anthropic()
        self.agent['model_id'] = 'openai/gpt-5.5'
        self.assertFalse(identity.authenticated_provider(self.packet))
        with self.assertRaisesRegex(ValueError, 'model provider differs'):
            driver.validate_binding(self.binding, self.agent)

    def test_binding_provider_without_flow_is_refused_with_reason(self):
        self.binding['provider'] = 'grok'
        with self.assertRaisesRegex(ValueError, "no account flow for binding provider 'grok'"):
            driver.validate_definition(self.binding['openclaw'], 'grok')
        self.assertFalse(identity.authenticated_provider(self.packet))

    def test_flow_without_measurement_never_inspects_cli_or_mutates_the_profile(self):
        binding = {**self.binding, 'provider': 'claude',
                   'openclaw': {**self.binding['openclaw'], 'provider_id': 'anthropic', 'method_id': 'setup-token'}}
        agent = {**self.agent, 'model_id': 'anthropic/claude-opus-5'}
        packet = {**self.packet, 'agent': agent, 'profile_binding': binding}
        before = (self.profile / 'openclaw.json').read_bytes()
        with mock.patch.dict(driver.PROVIDER_FLOWS, {'anthropic': None}), \
                mock.patch.object(identity, 'command_output', side_effect=AssertionError('unmeasured CLI forbidden')), \
                mock.patch.object(driver, 'owned_directory', side_effect=AssertionError('unmeasured profile forbidden')):
            for operation in (driver.validate_binding, driver.environment, driver.prepare):
                with self.subTest(operation=operation.__name__), self.assertRaisesRegex(ValueError, 'flow has not been measured'):
                    operation(binding, agent)
            with self.assertRaisesRegex(ValueError, 'flow has not been measured'):
                driver.pinned_packet(packet)
            self.assertFalse(driver.measured_definition(binding))
            self.assertFalse(identity.authenticated_provider(packet))
        self.assertEqual((self.profile / 'openclaw.json').read_bytes(), before)
        self.assertFalse((self.profile / 'observed-env').exists())
        self.assertFalse((self.profile / 'observed-args').exists())

if __name__ == '__main__':
    unittest.main()
