from __future__ import annotations

import copy
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import test_fleet_executor as fixtures
from cauce_container_base import bundle_digest
from fleet_executor_container import (
    EXECUTOR_SOURCE,
    HELPER,
    expected_labels,
    identity_for,
    purge_container,
    stop_container,
)
from fleet_executor_policy import SafeFailure, approve_agent, load_policy
from fleet_executor_templates import validate_accounts


class SharedContainerExecutorTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    run_step = fixtures.PhysicalExecutorTest.run_step
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    configure_signer = fixtures.PhysicalExecutorTest.configure_signer

    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['docker', 'image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'], capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError('real shared-container fixture requires the approved local Python image')
        cls.image = result.stdout.strip()

    def tearDown(self):
        if getattr(self, 'container', None):
            subprocess.run(['docker', 'exec', self.container, '/usr/local/bin/python3.12', '-c',
                'import pathlib,shutil;p=pathlib.Path("/tmp/shared-state");'
                '\nfor key in ("physical-one","physical-two"):shutil.rmtree(p/key,ignore_errors=True)'], capture_output=True, check=False)
            subprocess.run(['docker', 'rm', '-f', self.container], capture_output=True, check=False)
        self.temporary.cleanup()

    def configure_shared(self):
        self.container = 'cauce-shared-fixture-' + uuid.uuid4().hex[:12]
        self.bundle.chmod(0o755)
        self.worker.chmod(0o644)
        self.policy['bundles']['codex'].update(executable='/usr/local/bin/python3.12', executable_sha256=None,
            digest=bundle_digest(str(self.bundle)))
        state = self.root / 'shared-state'
        state.mkdir(mode=0o755)
        mounts = [f'type=bind,source={state},destination=/tmp/shared-state',
            f'type=bind,source={HELPER.parent},destination=/cauce/lifecycle,readonly',
            f'type=bind,source={EXECUTOR_SOURCE},destination=/cauce/executor,readonly',
            f'type=bind,source={self.bundle},destination={self.bundle},readonly']
        arguments = [item for mount in mounts for item in ('--mount', mount)]
        subprocess.run(['docker', 'run', '-d', '--name', self.container, '--network', 'none', '--read-only',
            '--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'CHOWN', '--cap-add', 'SYS_PTRACE',
            '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'FOWNER', '--tmpfs', '/run:rw,nosuid,noexec,size=16m',
            '--security-opt', 'no-new-privileges', *arguments, '--entrypoint', '/bin/sleep', self.image, 'infinity'],
            capture_output=True, check=True)
        observed = self.inspect()
        self.policy['shared_containers'] = {self.container: {'container_id': observed['Id'], 'image': self.image,
            'runtime_user': 'nobody', 'runtime_uid': 65534, 'runtime_gid': 65534, 'systemd_user': self.user,
            'home_directory': '/nonexistent', 'state_root': '/tmp/shared-state', 'control_root': '/run/cauce-shared',
            'python': '/usr/local/bin/python3.12', 'mounts': [{key: row[key] for key in ('Destination', 'Source', 'Type', 'RW')} for row in observed['Mounts']],
            'aliases': {key: {'tenant_id': 'Equipo_42', 'alias': alias, 'harness_id': 'codex', 'account_id': 'fixture-account'}
                for key, alias in [('physical-one', 'shared_alias'), ('physical-two', 'second_alias')]}}}
        self.policy['profiles']['fixture-account'] = {'provider': 'codex', 'path': '/run/shared-provider',
            'identity': 'fixture-identity', 'runtime_user': 'nobody', 'container_name': self.container}
        self.agent.update(runtime_mode='container', container_name=self.container, runtime_user='nobody',
            home_directory='/nonexistent', state_directory='/tmp/shared-state/physical-one', primary_account_id='fixture-account')
        self.second = {**self.agent, 'runtime_key': 'physical-two', 'alias': 'second_alias', 'state_directory': '/tmp/shared-state/physical-two'}
        self.context['request'].update(kind='start', parameters={})
        self.context.update(previous_agents=[self.agent], fenced_targets=[{'resource': 'agent', 'tenant_id': 'Equipo_42', 'alias': 'shared_alias'}])
        self.context['snapshot']['agents'].append(self.second)
        self.context['snapshot']['memberships'].append({**self.member, 'alias': 'second_alias'})
        self.configure_signer()

    def inspect(self):
        return json.loads(subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True).stdout)[0]

    def metadata(self, key):
        return json.loads(subprocess.run(['docker', 'exec', self.container, 'cat', '/run/cauce-shared/' + key + '/cauce-v3-adapter.json'],
            capture_output=True, text=True, check=True).stdout)

    def start_both(self):
        self.configure_shared()
        for agent in (self.agent, self.second):
            context = copy.deepcopy(self.context)
            context['operation_id'] = str(uuid.uuid4())
            context['request']['target']['alias'] = agent['alias']
            context['previous_agents'] = [agent]
            context['fenced_targets'] = [{'resource': 'agent', 'tenant_id': agent['tenant_id'], 'alias': agent['alias']}]
            for step in ('artifacts', 'credentials', 'runtime'):
                result = self.run_step(step, context, timeout=40)
                self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        return self.metadata('physical-one'), self.metadata('physical-two')

    def test_stop_and_purge_one_alias_preserve_the_other_process_files_and_shared_container(self):
        first, second = self.start_both()
        before = self.inspect()
        for directory in ('/tmp/shared-state/physical-one', '/tmp/shared-state/physical-two', '/run/shared-provider'):
            subprocess.run(['docker', 'exec', self.container, '/usr/local/bin/python3.12', '-c',
                'import pathlib,sys;p=pathlib.Path(sys.argv[1]);p.mkdir(parents=True,exist_ok=True);(p/"sentinel").write_text("keep")', directory],
                capture_output=True, check=True)
        self.assertEqual(stop_container(self.policy, self.agent), {'stopped_verified': True})
        self.assertEqual(self.metadata('physical-two')['pid'], second['pid'])
        purge_container(self.policy, self.agent)
        after = self.inspect()
        self.assertEqual((after['Id'], after['State']['StartedAt']), (before['Id'], before['State']['StartedAt']))
        self.assertTrue(after['State']['Running'])
        self.assertEqual(self.metadata('physical-two'), second)
        for filename in (f'/proc/{second["pid"]}', '/tmp/shared-state/physical-two/sentinel', '/run/shared-provider/sentinel'):
            subprocess.run(['docker', 'exec', self.container, 'test', '-e', filename], capture_output=True, check=True)
        for filename in (f'/proc/{first["pid"]}', '/tmp/shared-state/physical-one'):
            self.assertNotEqual(subprocess.run(['docker', 'exec', self.container, 'test', '-e', filename], capture_output=True).returncode, 0)

    def test_unknown_alias_changed_container_and_root_overlap_are_rejected_before_effect(self):
        self.configure_shared()
        approved = approve_agent(load_policy(self.policy_file), self.agent)
        self.assertEqual(approved['_placement']['ownership'], 'shared')
        for field, value in [('runtime_key', 'unapproved'), ('alias', 'unapproved'), ('state_directory', '/tmp/shared-state/physical-two'),
            ('runtime_user', 'daemon'), ('home_directory', '/tmp')]:
            with self.assertRaises(SafeFailure):
                approve_agent(self.policy, {**self.agent, field: value})
        stale = copy.deepcopy(self.policy)
        stale['shared_containers'][self.container]['container_id'] = 'f' * 64
        with self.assertRaises(SafeFailure):
            stop_container(stale, self.agent)
        self.assertTrue(self.inspect()['State']['Running'])
        overlapping = copy.deepcopy(self.policy)
        overlapping['profiles']['fixture-account']['path'] = self.agent['state_directory']
        with self.assertRaises(SafeFailure):
            approve_agent(overlapping, self.agent)

    def test_another_alias_profile_cannot_overlap_the_first_alias_state(self):
        self.configure_shared()
        self.policy['shared_containers'][self.container]['aliases']['physical-two']['account_id'] = 'second-account'
        self.policy['profiles']['second-account'] = {**self.policy['profiles']['fixture-account'],
            'path': self.agent['state_directory'] + '/provider-profile'}
        with self.assertRaises(SafeFailure):
            approve_agent(self.policy, self.agent)

    def test_shared_hook_checks_real_alias_process_and_rejects_changed_identity(self):
        _, second = self.start_both()
        spec = importlib.util.spec_from_file_location('shared_hook', EXECUTOR_SOURCE / 'fleet-provider-hook.py')
        hook = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(hook)
        agent = approve_agent(self.policy, self.agent)
        observed = self.inspect()
        runtime = identity_for(agent, observed)
        packet = {'agent': agent, 'runtime_binding': {'container_id': runtime['container_id'], 'generation': runtime['generation'],
            'image_digest': self.image, 'python': agent['_placement']['python'], 'mounts': agent['_placement']['mounts'],
            'control_directory': str(runtime['control']), 'bundle_directory': str(self.bundle),
            'bundle_digest': self.policy['bundles']['codex']['digest'], 'runtime_uid': 65534, 'runtime_gid': 65534}}
        hook.shared_container_identity(packet, observed)
        for field, value, target in [('alias', 'second_alias', 'agent'), ('runtime_uid', 1, 'runtime_binding'),
            ('control_directory', '/run/cauce-shared/physical-two', 'runtime_binding')]:
            changed = copy.deepcopy(packet)
            changed[target][field] = value
            with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                hook.shared_container_identity(changed, observed)
        self.assertEqual(self.metadata('physical-two'), second)
        subprocess.run(['docker', 'exec', self.container, 'test', '-e', f'/proc/{second["pid"]}'], capture_output=True, check=True)

    def test_state_symlink_to_other_alias_is_not_purged(self):
        _, second = self.start_both()
        stop_container(self.policy, self.agent)
        subprocess.run(['docker', 'exec', self.container, '/usr/local/bin/python3.12', '-c',
            'import pathlib,shutil; a=pathlib.Path("/tmp/shared-state/physical-one");shutil.rmtree(a);'
            'a.symlink_to("/tmp/shared-state/physical-two",target_is_directory=True);'
            '(pathlib.Path("/tmp/shared-state/physical-two")/"sentinel").write_text("keep")'], capture_output=True, check=True)
        with self.assertRaises(SafeFailure):
            purge_container(self.policy, self.agent)
        self.assertEqual(self.metadata('physical-two'), second)
        subprocess.run(['docker', 'exec', self.container, 'test', '-e', '/tmp/shared-state/physical-two/sentinel'],
            capture_output=True, check=True)

    def test_retirement_metadata_accepts_canonical_providers_without_enabling_execution_templates(self):
        row = {'id': 'legacy-account', 'provider': 'grok', 'external_account_id': 'legacy-identity', 'payer_tenant_id': 'Equipo_42',
            'shared_with_pool': False, 'enabled': True}
        validate_accounts([row])
        with self.assertRaises(SafeFailure):
            validate_accounts([{**row, 'provider': '../../shell'}])
        self.assertEqual(expected_labels(self.policy, self.agent)['cauce.fleet.runtime_key'], 'physical-one')


if __name__ == '__main__':
    unittest.main()
