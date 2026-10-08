from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import unittest
import uuid
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures
import test_fleet_executor_container as containers


class NativeTemplateProfileTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    tearDown = fixtures.PhysicalExecutorTest.tearDown
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    run_step = fixtures.PhysicalExecutorTest.run_step
    configure_signer = fixtures.PhysicalExecutorTest.configure_signer
    configure_hooks = fixtures.PhysicalExecutorTest.configure_hooks

    def dynamic_profile(self):
        self.configure_hooks()
        self.policy['profiles'] = {}
        self.profile_root = self.root / 'provider-profiles'
        self.policy['profile_templates'] = [{'provider': 'codex', 'runtime_user': self.user,
            'path_root': str(self.profile_root), 'command': str(self.executable),
            'command_sha256': hashlib.sha256(self.executable.read_bytes()).hexdigest()}]
        self.agent['primary_account_id'] = 'new-account'
        self.context['request']['parameters']['primary_account_id'] = 'new-account'
        self.context['trusted_accounts'] = [{'id': 'new-account', 'provider': 'codex',
            'external_account_id': 'expected@fixture.invalid', 'payer_tenant_id': self.agent['tenant_id'],
            'shared_with_pool': False, 'enabled': True}]
        self.profile = self.profile_root / self.agent['runtime_key'] / hashlib.sha256(b'new-account').hexdigest()
        self.save_policy()

    def binding(self):
        return subprocess.run([sys.executable, str(fixtures.CLI), '--policy', str(self.policy_file), '--binding'],
            input=json.dumps(self.context), capture_output=True, text=True, timeout=15)

    def test_new_account_uses_empty_isolated_profile_without_policy_entry_or_auth_copy(self):
        self.dynamic_profile()
        self.configure_signer()
        self.assertNotEqual(self.binding().returncode, 0)
        self.assertFalse(self.profile_root.exists())
        for step in ('artifacts', 'credentials', 'runtime', 'authenticate'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(list(self.profile.iterdir()), [])
        self.assertEqual(self.profile.stat().st_uid, os.getuid())
        self.assertEqual(self.profile.stat().st_mode & 0o777, 0o700)
        result = self.binding()
        self.assertEqual(result.returncode, 0, result.stderr)
        binding = json.loads(result.stdout)['profile_binding']
        self.assertEqual(binding['path'], str(self.profile))
        self.assertEqual(binding['identity'], 'expected@fixture.invalid')
        self.assertEqual(binding['command'], str(self.executable))
        self.assertNotIn('_trusted_accounts', json.loads(result.stdout)['agent'])
        (self.profile / 'provider-session.fixture').write_text('PERSISTENT_PRIVATE_FIXTURE')
        self.assertEqual(self.run_step('stop').returncode, 0)
        self.assertEqual(self.run_step('runtime').returncode, 0)
        self.assertEqual((self.profile / 'provider-session.fixture').read_text(), 'PERSISTENT_PRIVATE_FIXTURE')

    def test_scope_disabled_duplicate_and_foreign_owner_fail_closed(self):
        self.dynamic_profile()
        row = self.context['trusted_accounts'][0]
        row['payer_tenant_id'] = 'OtherTenant'
        self.assertNotEqual(self.binding().returncode, 0)
        row['shared_with_pool'] = True
        row['enabled'] = False
        self.assertNotEqual(self.binding().returncode, 0)
        row['enabled'] = True
        self.context['trusted_accounts'].append(dict(row))
        self.assertNotEqual(self.binding().returncode, 0)
        self.assertFalse(self.profile_root.exists())

    def test_model_effort_and_pinned_command_are_observed_with_same_operation_replay(self):
        self.dynamic_profile()
        self.configure_signer()
        self.agent.update(model_id='gpt-6.1-sol', reasoning_effort='high')
        self.context['request']['parameters'].update(model_id='gpt-6.1-sol', reasoning_effort='high')
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, result.stderr)
        metadata_path = self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json'
        metadata = json.loads(metadata_path.read_bytes())
        environment = pathlib.Path('/proc/' + str(metadata['pid']) + '/environ').read_bytes()
        self.assertIn(b'CAUCE_MODEL_ID=gpt-6.1-sol\0', environment)
        self.assertIn(b'CAUCE_REASONING_EFFORT=high\0', environment)
        self.assertIn(b'CAUCE_HARNESS_COMMAND=' + str(self.executable).encode() + b'\0', environment)
        self.assertEqual(self.run_step('runtime').returncode, 0)
        self.assertEqual(json.loads(metadata_path.read_bytes())['pid'], metadata['pid'])

    def test_current_account_scope_applies_to_explicit_static_profile_too(self):
        self.configure_hooks()
        self.context['trusted_accounts'] = []
        self.assertNotEqual(self.binding().returncode, 0)
        self.context['trusted_accounts'] = [{'id': 'fixture-account', 'provider': 'codex',
            'external_account_id': 'fixture-identity', 'payer_tenant_id': 'OtherTenant', 'shared_with_pool': False, 'enabled': True}]
        self.assertNotEqual(self.binding().returncode, 0)
        self.context['trusted_accounts'][0]['shared_with_pool'] = True
        self.assertEqual(self.binding().returncode, 0)

    def test_capabilities_are_standard_public_and_do_not_write_profiles(self):
        self.dynamic_profile()
        self.configure_signer()
        self.policy['hooks']['revoke'] = self.policy['hooks']['verify']
        self.save_policy()
        result = subprocess.run([sys.executable, str(fixtures.CLI), '--policy', str(self.policy_file), '--capabilities'],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        capability = json.loads(result.stdout)
        self.assertTrue(capability['available'])
        self.assertEqual(capability['placements'][0]['runtimes'][0]['provider'], 'codex')
        self.assertNotIn('command', result.stdout)
        self.assertNotIn(str(self.profile_root), result.stdout)
        self.assertFalse(self.profile_root.exists())
        project = pathlib.Path(__file__).resolve().parents[2]
        schema = project / 'packages/protocol/src/fleet-operation.ts'
        script = 'import {FleetCapabilitySchema} from ' + json.dumps(schema.as_uri()) + ';' \
            'let s="";for await(const c of process.stdin)s+=c;FleetCapabilitySchema.parse(JSON.parse(s));'
        checked = subprocess.run(['/usr/bin/node', '--import', 'tsx', '--input-type=module', '-e', script],
            input=result.stdout, capture_output=True, text=True, cwd=project, timeout=10)
        self.assertEqual(checked.returncode, 0, checked.stderr)

    def test_incomplete_capability_is_standard_unavailable_without_public_placements(self):
        self.dynamic_profile()
        result = subprocess.run([sys.executable, str(fixtures.CLI), '--policy', str(self.policy_file), '--capabilities'],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'available': False, 'actions': [], 'placements': [], 'reason': 'executor_unconfigured'})


class ContainerTemplateProfileTest(unittest.TestCase):
    setUp = containers.DisposableContainerExecutorTest.setUp
    save_policy = containers.DisposableContainerExecutorTest.save_policy
    run_step = containers.DisposableContainerExecutorTest.run_step
    configure_signer = containers.DisposableContainerExecutorTest.configure_signer
    configure_container = containers.DisposableContainerExecutorTest.configure_container

    @classmethod
    def setUpClass(cls):
        containers.DisposableContainerExecutorTest.setUpClass.__func__(cls)

    def tearDown(self):
        containers.DisposableContainerExecutorTest.tearDown(self)
        if getattr(self, 'container', None):
            subprocess.run(['docker', 'volume', 'rm', self.container + '-provider-profiles'], capture_output=True)

    def dynamic_container(self):
        self.configure_container()
        placement = self.policy['containers'].pop(self.container)
        self.key = 'rt-' + uuid.uuid4().hex[:10]
        self.container = 'cauce-fleet-fixture-' + self.key
        placement.update(harness_id='codex', prefix='cauce-fleet-fixture-', profile_root='/tmp/provider-profiles')
        self.policy['container_templates'] = [placement]
        self.context['request']['parameters'].update(runtime_key=self.key, primary_account_id='new-account')
        self.context['request']['parameters']['placement'].update(container_name=self.container,
            state_directory='/tmp/cauce-state/' + self.key)
        self.agent.update(runtime_key=self.key, primary_account_id='new-account', container_name=self.container,
            state_directory='/tmp/cauce-state/' + self.key)
        fingerprint = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--name',
            'cauce-fleet-fixture-hash-' + uuid.uuid4().hex[:10], self.image, '/usr/local/bin/python3.12', '-c',
            'import hashlib,pathlib;print(hashlib.sha256(pathlib.Path("/usr/local/bin/python3.12").read_bytes()).hexdigest())'],
            capture_output=True, text=True, check=True, timeout=10).stdout.strip()
        self.policy['profile_templates'] = [{'provider': 'codex', 'runtime_user': 'nobody',
            'path_root': '/tmp/provider-profiles', 'command': '/usr/local/bin/python3.12', 'command_sha256': fingerprint}]
        self.context['trusted_accounts'] = [{'id': 'new-account', 'provider': 'codex', 'external_account_id': 'expected@fixture.invalid',
            'payer_tenant_id': self.agent['tenant_id'], 'shared_with_pool': False, 'enabled': True}]
        self.profile = '/tmp/provider-profiles/' + self.key + '/' + hashlib.sha256(b'new-account').hexdigest()
        self.configure_signer()
        self.save_policy()

    def prepare_runtime(self):
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_new_container_and_account_prepare_exact_template_and_private_separate_profile(self):
        self.dynamic_container()
        self.prepare_runtime()
        result = subprocess.run([sys.executable, str(fixtures.CLI), '--policy', str(self.policy_file), '--binding'],
            input=json.dumps(self.context), capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['profile_binding']['path'], self.profile)
        measured = subprocess.run(['docker', 'exec', '--user', '65534:65534', self.container, '/usr/local/bin/python3.12', '-c',
            'import os,json;d=' + repr(self.profile) + ';s=os.stat(d);print(json.dumps([s.st_uid,s.st_mode&511,os.listdir(d)]))'],
            capture_output=True, text=True, check=True).stdout
        self.assertEqual(json.loads(measured), [65534, 0o700, []])
        self.assertFalse(pathlib.Path(self.profile).exists())
        metadata = json.loads(subprocess.run(['docker', 'exec', self.container, 'cat',
            '/run/cauce-fleet/' + self.key + '/cauce-v3-adapter.json'], capture_output=True, text=True, check=True).stdout)
        env = subprocess.run(['docker', 'exec', self.container, 'cat', '/proc/' + str(metadata['pid']) + '/environ'], capture_output=True, check=True).stdout
        self.assertIn(b'CAUCE_HARNESS_COMMAND=/usr/local/bin/python3.12\0', env)
        self.assertIn(b'HOME=/nonexistent\0', env)
        self.assertNotIn(b'CAUCE_CONFIG_FILE=', env)

    def test_purge_removes_runtime_but_retains_provider_volume_bytes(self):
        self.dynamic_container()
        self.prepare_runtime()
        marker = self.profile + '/provider-session.fixture'
        subprocess.run(['docker', 'exec', '--user', '65534:65534', self.container, '/usr/local/bin/python3.12', '-c',
            'import pathlib;pathlib.Path(' + repr(marker) + ').write_text("PRIVATE_SESSION_FIXTURE")'], capture_output=True, check=True)
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        from fleet_executor_container import purge_container
        from fleet_executor_policy import load_policy
        purge_container(load_policy(self.policy_file), self.agent)
        volume = self.container + '-provider-profiles'
        self.assertEqual(subprocess.run(['docker', 'volume', 'inspect', volume], capture_output=True).returncode, 0)
        result = subprocess.run(['docker', 'run', '--rm', '--network', 'none', '--user', '65534:65534', '--name',
            'cauce-fleet-fixture-read-' + uuid.uuid4().hex[:10], '--mount', 'type=volume,source=' + volume + ',destination=/profiles',
            self.image, '/usr/local/bin/python3.12', '-c', 'import hashlib,pathlib;print(hashlib.sha256(pathlib.Path(' +
            repr('/profiles/' + self.key + '/' + hashlib.sha256(b'new-account').hexdigest() + '/provider-session.fixture') + ').read_bytes()).hexdigest())'],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), hashlib.sha256(b'PRIVATE_SESSION_FIXTURE').hexdigest())

    def test_name_outside_template_is_not_created(self):
        self.dynamic_container()
        self.agent['container_name'] = 'unapproved-container'
        self.context['request']['parameters']['placement']['container_name'] = 'unapproved-container'
        self.assertNotEqual(self.run_step('artifacts').returncode, 0)

    def test_clean_docker_launcher_does_not_inherit_container_configuration_overrides(self):
        self.dynamic_container()
        for step in ('artifacts', 'credentials'):
            self.assertEqual(self.run_step(step).returncode, 0)
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        import fleet_executor_container
        from fleet_executor_policy import load_policy, target_agent
        real_docker = fleet_executor_container.docker
        def injected_docker(*arguments):
            if arguments[0] == 'create':
                arguments = ('create', '--env', 'CAUCE_CONFIG_FILE=/private/unapproved.fixture',
                    '--env', 'CAUCE_TLS_KEY_FILE=/private/unapproved-key.fixture', *arguments[1:])
            return real_docker(*arguments)
        with mock.patch.object(fleet_executor_container, 'docker', side_effect=injected_docker):
            fleet_executor_container.start_container(load_policy(self.policy_file), target_agent(self.context),
                operation_id=self.context['operation_id'])
        observed = json.loads(subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True).stdout)[0]
        self.assertIn('CAUCE_CONFIG_FILE=/private/unapproved.fixture', observed['Config']['Env'])
        metadata = json.loads(subprocess.run(['docker', 'exec', self.container, 'cat',
            '/run/cauce-fleet/' + self.key + '/cauce-v3-adapter.json'], capture_output=True, text=True, check=True).stdout)
        environment = subprocess.run(['docker', 'exec', self.container, 'cat', '/proc/' + str(metadata['pid']) + '/environ'],
            capture_output=True, check=True).stdout
        self.assertNotIn(b'CAUCE_CONFIG_FILE=', environment)
        self.assertNotIn(b'CAUCE_TLS_KEY_FILE=', environment)


if __name__ == '__main__':
    unittest.main()
