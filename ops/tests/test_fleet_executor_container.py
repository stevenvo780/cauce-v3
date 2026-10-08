from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import sys
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures
from cauce_container_base import bundle_digest


class DisposableContainerExecutorTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    run_step = fixtures.PhysicalExecutorTest.run_step
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    configure_signer = fixtures.PhysicalExecutorTest.configure_signer
    configure_hooks = fixtures.PhysicalExecutorTest.configure_hooks

    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['docker', 'image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'], capture_output=True, text=True)
        if result.returncode:
            raise unittest.SkipTest('disposable local Python image is unavailable')
        cls.image = result.stdout.strip()

    def tearDown(self):
        if getattr(self, 'container', None):
            subprocess.run(['docker', 'rm', '-f', self.container], capture_output=True)
            subprocess.run(['docker', 'volume', 'rm', self.container + '-state'], capture_output=True)
        self.temporary.cleanup()

    def configure_container(self):
        self.container = 'cauce-fleet-fixture-' + uuid.uuid4().hex[:12]
        self.bundle.chmod(0o755)
        self.worker.chmod(0o644)
        self.policy['bundles']['codex'].update(executable='/usr/local/bin/python3.12', executable_sha256=None,
                                             digest=bundle_digest(str(self.bundle)))
        self.policy['containers'][self.container] = {'image': self.image, 'runtime_user': 'nobody',
            'systemd_user': self.user, 'home_directory': '/nonexistent', 'state_root': '/tmp/cauce-state',
            'python': '/usr/local/bin/python3.12'}
        placement = self.context['request']['parameters']['placement']
        placement.update(mode='container', container_name=self.container, runtime_user='nobody',
                         home_directory='/nonexistent', state_directory='/tmp/cauce-state/physical-one')
        self.agent.update(runtime_mode='container', container_name=self.container, runtime_user='nobody',
                          home_directory='/nonexistent', state_directory='/tmp/cauce-state/physical-one')
        self.save_policy()

    def test_new_owned_container_process_and_stop_are_verified_with_real_docker(self):
        self.configure_container()
        self.configure_signer()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step, timeout=40)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        inspect = subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True)
        observed = json.loads(inspect.stdout)[0]
        self.assertEqual(observed['Image'], self.image)
        self.assertEqual(observed['Config']['Labels']['cauce.fleet.runtime_key'], 'physical-one')
        self.assertTrue(observed['State']['Running'])
        identity = subprocess.run(['docker', 'exec', self.container, 'cat', '/run/cauce-fleet/physical-one/cauce-v3-adapter.json'],
            capture_output=True, text=True, check=True)
        metadata = json.loads(identity.stdout)
        self.assertEqual(metadata['runtimeUid'], 65534)
        self.assertEqual(metadata['wireAlias'], 'shared_alias')
        stopped = self.run_step('stop', timeout=40)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertTrue(json.loads(stopped.stdout)['evidence']['stopped_verified'])
        gone = subprocess.run(['docker', 'exec', self.container, 'test', '-e', '/proc/' + str(metadata['pid'])], capture_output=True)
        self.assertNotEqual(gone.returncode, 0)

    def test_exact_container_uid_can_read_only_its_cauce_credential_view(self):
        self.configure_container()
        self.configure_signer()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step, timeout=40)
            self.assertEqual(result.returncode, 0, result.stderr)
        credential = '/run/cauce-credentials/physical-one/bootstrap/agent.key'
        result = subprocess.run(['docker', 'exec', '--user', '65534:65534', self.container,
            '/usr/local/bin/python3.12', '-c', 'import pathlib,hashlib;print(hashlib.sha256(pathlib.Path("' + credential + '").read_bytes()).hexdigest())'],
            capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        original = self.roots['pki'] / 'bootstrap/physical-one/agent-physical-one.key'
        self.assertEqual(result.stdout.strip(), hashlib.sha256(original.read_bytes()).hexdigest())
        denied = subprocess.run(['docker', 'exec', '--user', '1:1', self.container, '/bin/cat', credential], capture_output=True)
        self.assertNotEqual(denied.returncode, 0)

    def test_container_profile_binding_is_measured_inside_container_without_host_profile_lookup(self):
        self.configure_container()
        self.configure_signer()
        self.configure_hooks()
        self.policy['profiles']['fixture-account'].update(path=self.agent['state_directory'],
            runtime_user='nobody', container_name=self.container)
        self.save_policy()
        self.assertFalse(pathlib.Path(self.agent['state_directory']).exists())
        for step in ('artifacts', 'credentials', 'runtime', 'authenticate'):
            result = self.run_step(step, timeout=40)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        self.assertTrue(json.loads(result.stdout)['evidence']['provider_verified'])

    def test_existing_foreign_container_is_not_claimed_or_stopped(self):
        self.configure_container()
        subprocess.run(['docker', 'create', '--name', self.container, '--network', 'none', '--entrypoint', '/bin/sleep',
                        self.image, 'infinity'], capture_output=True, check=True)
        subprocess.run(['docker', 'start', self.container], capture_output=True, check=True)
        original = json.loads(subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True).stdout)[0]['Id']
        self.assertEqual(self.run_step('artifacts').returncode, 0)
        rejected = self.run_step('runtime', timeout=40)
        self.assertNotEqual(rejected.returncode, 0)
        still = json.loads(subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True).stdout)[0]
        self.assertEqual(still['Id'], original)
        self.assertTrue(still['State']['Running'])


if __name__ == '__main__':
    unittest.main()
