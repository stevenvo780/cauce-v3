from __future__ import annotations

# cauce:requiere docker
import copy
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
import uuid

sys.path[:0] = [str(pathlib.Path(__file__).resolve().parent), str(pathlib.Path(__file__).resolve().parents[1] / 'cli')]
import fleet_executor_container as runtime  # noqa: E402
import test_fleet_executor_container as fixtures  # noqa: E402
from fleet_executor_policy import approve_agent, load_policy  # noqa: E402

OWNER = 'h9c-hades-refresco-imagen-1025'


class RefreshedContainerStartupTests(unittest.TestCase):
    setUp = fixtures.DisposableContainerExecutorTest.setUp
    tearDown = fixtures.DisposableContainerExecutorTest.tearDown
    configure_container = fixtures.DisposableContainerExecutorTest.configure_container
    configure_signer = fixtures.DisposableContainerExecutorTest.configure_signer
    save_policy = fixtures.DisposableContainerExecutorTest.save_policy
    run_step = fixtures.DisposableContainerExecutorTest.run_step

    @classmethod
    def setUpClass(cls):
        fixtures.DisposableContainerExecutorTest.setUpClass.__func__(cls)
        cls.images = []
        cls.addClassCleanup(cls.remove_images)
        for generation, command in (
                ('old', 'cp /usr/local/bin/python3.12 /usr/local/bin/fixture-adapter'),
                ('new', 'ln -s /usr/local/bin/python3.12 /usr/local/bin/fixture-adapter')):
            tag = f'zz-canary-h9c-{uuid.uuid4().hex[:12]}:{generation}'
            cls.images.append(tag)
            with tempfile.TemporaryDirectory(prefix='zz-canary-h9c-build-') as directory:
                pathlib.Path(directory, 'Dockerfile').write_text(
                    f'FROM python:3.12-slim\nLABEL cauce.e2e.owner={OWNER}\nRUN {command}\n')
                built = subprocess.run(['docker', 'build', '--pull=false', '-q', '-t', tag, directory],
                    capture_output=True, text=True, timeout=120)
                if built.returncode:
                    raise AssertionError(built.stderr)
        cls.previous_image, cls.image = [subprocess.run(
            ['docker', 'image', 'inspect', tag, '--format', '{{.Id}}'],
            capture_output=True, text=True, check=True, timeout=20).stdout.strip() for tag in cls.images]

    @classmethod
    def remove_images(cls):
        for image in cls.images:
            subprocess.run(['docker', 'image', 'rm', image], capture_output=True, timeout=30)

    def prepare_update(self, *, legacy_lease=False):
        self.configure_container(prefix='zz-canary-h9c-')
        self.configure_signer()
        placement = self.policy['containers'][self.container]
        placement['image'] = self.previous_image
        self.policy['bundles']['codex']['executable'] = '/usr/local/bin/fixture-adapter'
        self.save_policy()
        policy = load_policy(self.policy_file)
        approved = approve_agent(policy, self.agent)
        volumes, _ = runtime.owned_volumes(policy, approved)
        for name, labels in volumes.items():
            runtime.docker('volume', 'create', '--label', f'cauce.e2e.owner={OWNER}',
                *[item for key, value in labels.items() for item in ('--label', f'{key}={value}')], name)
        original = runtime.create_container(policy, approved)
        if legacy_lease:
            runtime.docker('start', original['Id'])
            observed = runtime.inspect_container(self.container)
            runtime.helper(approved, runtime.identity_for(approved, observed), 'prepare-state',
                '--mount', approved['_placement']['state_root'], '--state', approved['state_directory'],
                '--uid', '65534', '--gid', '65534')
            runtime.docker('exec', '--user', '65534:65534', original['Id'], '/usr/local/bin/python3.12', '-I', '-B', '-c',
                'import os,sys;fd=os.open(sys.argv[1],os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o600);'
                'os.write(fd,b"unknown legacy record");os.close(fd)',
                self.agent['state_directory'] + '/.consumer-shared_alias.lock')
            runtime.docker('stop', original['Id'])
        self.context['request']['kind'] = 'update'
        self.context['previous_agents'] = [copy.deepcopy(self.agent)]
        self.context['fenced_targets'] = [self.context['request']['target'].copy()]
        placement['image'] = self.image
        self.save_policy()
        for step in ('artifacts', 'credentials'):
            result = self.run_step(step, timeout=60)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        return original

    def assert_no_startup_logs(self):
        result = runtime.docker('exec', '--user', '0', self.container, '/usr/local/bin/python3.12', '-I', '-B', '-c',
            'import os,sys;print(len([name for name in os.listdir(sys.argv[1]) if name.startswith(".startup-")]))',
            '/run/cauce-fleet/physical-one')
        self.assertEqual(result.strip(), b'0')

    def test_stopped_update_refreshes_image_and_observes_adapter_after_executable_becomes_a_symlink(self):
        original = self.prepare_update()
        result = self.run_step('runtime', timeout=75)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('runtime_digest', json.loads(result.stdout)['evidence'])
        refreshed = runtime.inspect_container(self.container)
        self.assertNotEqual(refreshed['Id'], original['Id'])
        self.assertEqual(refreshed['Image'], self.image)
        self.assertTrue(refreshed['State']['Running'])
        self.assertEqual(refreshed['RestartCount'], 0)
        self.assertEqual([row['Name'] for row in refreshed['Mounts'] if row['Type'] == 'volume'],
                         [row['Name'] for row in original['Mounts'] if row['Type'] == 'volume'])
        metadata = json.loads(runtime.docker('exec', '--user', '0', self.container, '/bin/cat',
            '/run/cauce-fleet/physical-one/cauce-v3-adapter.json'))
        self.assertEqual((metadata['phase'], metadata['alias'], metadata['wireAlias'], metadata['tenantId']),
                         ('running', 'physical-one', 'shared_alias', self.agent['tenant_id']))
        self.assertEqual(metadata['containerId'], refreshed['Id'])
        self.assertEqual(metadata['executable']['path'], '/usr/local/bin/python3.12')
        self.assertEqual(metadata['executable']['procPath'], '/usr/local/bin/python3.12')
        runtime.docker('exec', '--user', '65534:65534', self.container, 'test', '-r',
            '/run/cauce-credentials/physical-one/bootstrap/agent.key')
        self.assertIn('"was_running": false', result.stderr)
        self.assertIn('"status": "succeeded"', result.stderr)
        self.assert_no_startup_logs()
        stop_context = copy.deepcopy(self.context)
        stop_context['operation_id'] = str(uuid.uuid4())
        stop_context['request']['kind'] = 'stop'
        stop_context['request']['parameters'] = {}
        stopped = self.run_step('stop', context=stop_context, timeout=60)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertTrue(json.loads(stopped.stdout)['evidence']['stopped_verified'])

    def test_failed_start_reports_controller_stderr_and_preserves_unknown_consumer_lease(self):
        self.prepare_update(legacy_lease=True)
        result = self.run_step('runtime', timeout=75)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('controller stderr:', result.stderr)
        self.assertIn('consumer lease legacy record is unknown', result.stderr)
        self.assertNotIn('PRIVATE KEY', result.stderr)
        self.assertNotIn('BEGIN ', result.stderr)
        raw = runtime.docker('exec', '--user', '65534:65534', self.container, '/bin/cat',
            self.agent['state_directory'] + '/.consumer-shared_alias.lock')
        self.assertEqual(raw, b'unknown legacy record')
        self.assert_no_startup_logs()


if __name__ == '__main__':
    unittest.main()
