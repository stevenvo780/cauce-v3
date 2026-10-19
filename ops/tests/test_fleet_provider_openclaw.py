from __future__ import annotations

import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli'
sys.path.insert(0, str(CLI))
import fleet_executor_templates as templates  # noqa: E402
import fleet_provider_identity as identity  # noqa: E402
import fleet_provider_openclaw as driver  # noqa: E402

SCRIPT = '''import fs from 'node:fs';
const argv=process.argv.slice(2);
const root=process.env.OPENCLAW_HOME;
if(!fs.statSync(process.env.TMPDIR).isDirectory()||!fs.statSync(process.env.NODE_COMPILE_CACHE).isDirectory()) process.exit(2);
const mode=fs.existsSync(root+'/mode')?fs.readFileSync(root+'/mode','utf8'):'';
if(argv.includes('--version')) { console.log(mode==='version'?'2026.1.1':'OpenClaw 2026.7.1-2 (0790d9f)'); }
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
 if(mode==='cooldown-expired') meta.profiles[0].cooldownUntil='2000-01-01T00:00:00Z';
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
        self.source.write_bytes((CLI.parent / 'tests/fixtures/openclaw-auth-list-2026.7.1-2.txt').read_bytes())
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

    def test_wrong_process_observations_are_never_identity_or_effect(self):
        for mode in ('identity', 'account', 'provider', 'agent', 'expiry', 'cooldown', 'ambiguous', 'type', 'shape', 'profile-shape', 'nonce', 'version'):
            with self.subTest(mode=mode):
                (self.profile / 'mode').write_text(mode)
                self.assertFalse(identity.authenticated_provider(self.packet))

    def test_an_expired_cooldown_no_longer_blocks_the_identity(self):
        (self.profile / 'mode').write_text('cooldown-expired')
        self.assertTrue(identity.authenticated_provider(self.packet))

    def test_capability_probe_prepares_its_isolated_temporary_directories(self):
        self.assertTrue(driver.measured_definition(self.binding))

    def test_preparation_creates_private_temporary_and_compile_directories_for_node(self):
        env = driver.environment(self.binding, self.agent)
        self.assertEqual(env['TMPDIR'], str(self.profile / 'tmp'))
        self.assertEqual(env['NODE_COMPILE_CACHE'], str(self.profile / 'tmp' / 'node-compile-cache'))
        for key in ('TMPDIR', 'NODE_COMPILE_CACHE'):
            details = pathlib.Path(env[key]).stat()
            self.assertEqual(details.st_uid, os.geteuid())
            self.assertEqual(details.st_mode & 0o777, 0o700)
        result = subprocess.run([self.node, '--input-type=module', '-e',
            "import fs from 'node:fs';import os from 'node:os';"
            "const path=fs.mkdtempSync(os.tmpdir()+'/openclaw-');"
            "fs.writeFileSync(path+'/probe','synthetic');console.log(os.tmpdir());"],
            env={**env, 'PATH': '/usr/bin:/bin'}, capture_output=True, text=True, check=True, timeout=5)
        self.assertEqual(result.stdout.strip(), env['TMPDIR'])
        self.assertTrue(any(pathlib.Path(env['NODE_COMPILE_CACHE']).iterdir()))

    def test_temporary_directories_reject_symlinks_or_public_permissions(self):
        for directory in (self.profile / 'tmp' / 'node-compile-cache', self.profile / 'tmp'):
            with self.subTest(directory=directory):
                directory.chmod(0o755)
                with self.assertRaises(ValueError):
                    driver.prepare(self.binding, self.agent)
                directory.chmod(0o700)
                if directory.name == 'tmp':
                    (directory / 'node-compile-cache').rmdir()
                directory.rmdir()
                directory.symlink_to(self.state, target_is_directory=True)
                with self.assertRaises((OSError, ValueError)):
                    driver.prepare(self.binding, self.agent)
                directory.unlink()
                driver.prepare(self.binding, self.agent)
        self.assertEqual(list(self.state.iterdir()), [self.state / 'workspace'])

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

    def test_container_preparation_sends_bounded_public_packet_to_exact_runtime_user_over_stdin(self):
        import fleet_executor_container
        import fleet_executor_policy
        import fleet_executor_profiles
        agent = {**self.agent, 'runtime_mode': 'container', 'container_name': 'isolated', '_placement': {'python': '/usr/bin/python3'}}
        binding = {**self.binding, 'container_name': 'isolated'}
        receipt = {'extensions_sha256': hashlib.sha256(b'[]').hexdigest()}
        with mock.patch.object(fleet_executor_policy, 'approve_agent', return_value=agent), \
                mock.patch.object(templates, 'resolve_profile', return_value=binding), \
                mock.patch.object(fleet_executor_container, 'inspect_container', return_value={}), \
                mock.patch.object(fleet_executor_container, 'validate_container'), \
                mock.patch.object(fleet_executor_container, 'identity_for', return_value={'container_id': 'a' * 64}), \
                mock.patch.object(fleet_executor_container, 'user_identity', return_value=('1000', '1000')), \
                mock.patch.object(fleet_executor_container, 'checked_command',
                    side_effect=[b'', json.dumps(receipt).encode()]) as execute:
            self.assertEqual(fleet_executor_profiles.prepare_profile({'profiles': {'account-one': binding}}, agent), receipt)
        self.assertEqual(execute.call_count, 2)
        for call, script, action in zip(execute.call_args_list,
                ('fleet_provider_openclaw.py', 'fleet_provider_identity.py'), ('--prepare', '--prepare-extensions'), strict=True):
            argv = call.args[0]
            self.assertEqual(argv[:8], [fleet_executor_container.DOCKER, 'exec', '-i', '-w', '/',
                '--user', agent['runtime_user'], 'a' * 64])
            self.assertEqual(argv[8:12], [agent['_placement']['python'], '-I', '-B', '-c'])
            self.assertEqual(argv[-3:], ['/', f'{fleet_executor_container.EXECUTOR_DESTINATION}/{script}', action])
            raw = call.kwargs['input_data']
            self.assertIsInstance(raw, bytes)
            self.assertLessEqual(len(raw), 262144)
            packet = json.loads(raw)
            self.assertEqual(packet['agent']['runtime_user'], agent['runtime_user'])
            self.assertNotIn('_placement', packet['agent'])
            self.assertFalse(any(key.startswith('_') for key in packet['agent']))
        profile_packet, extension_packet = [json.loads(call.kwargs['input_data']) for call in execute.call_args_list]
        self.assertEqual(set(profile_packet), {'profile_binding', 'agent'})
        self.assertEqual(profile_packet['profile_binding'], binding)
        self.assertEqual(extension_packet, {'profile': binding['path'], 'state': agent['state_directory'],
            'agent': profile_packet['agent']})
        self.assertEqual(execute.call_args_list[1].kwargs['timeout'], fleet_executor_profiles.PREPARE_EXTENSION_TIMEOUT)

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

if __name__ == '__main__':
    unittest.main()
