from __future__ import annotations

# cauce:requiere docker
import hashlib
import importlib.util
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures
from cauce_container_base import bundle_digest
from plazos import plazo

SWEEP = fixtures.OPS / 'cli/fleet_orphan_sweep.py'


def sweep_failure(stderr):
    failure = stderr.strip().splitlines()[-1] if stderr.strip() else 'no stderr'
    if failure.startswith('subprocess.CalledProcessError: Command '):
        return 'CalledProcessError: Docker command failed'
    return failure[-512:]


def sweep_report(rows_file, runtime_prefix, host_id):
    result = subprocess.run([sys.executable, str(SWEEP), '--rows', str(rows_file),
        '--runtime-key-prefix', runtime_prefix, '--host-id', host_id],
        capture_output=True, text=True, timeout=plazo(30))
    try:
        report = json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError(f'scoped fleet sweep infrastructure failed exit={result.returncode} '
                           f'stdout_bytes={len(result.stdout)} cause={sweep_failure(result.stderr)}') from error
    if result.returncode not in (0, 1) or not isinstance(report, dict) or type(report.get('clean')) is not bool \
            or any(not isinstance(report.get(field), list) for field in ('orphan_resources', 'orphan_rows')) \
            or result.returncode != int(not report['clean']):
        raise RuntimeError(f'scoped fleet sweep protocol failed exit={result.returncode} cause={sweep_failure(result.stderr)}')
    return report, result.returncode


def sweep_owned_fleet(rows_file, rows, name_prefix, host_id, runtime_prefix=None):
    runtime_prefix = runtime_prefix or name_prefix
    pathlib.Path(rows_file).write_text(json.dumps(rows))
    report, sweep_exit = sweep_report(rows_file, runtime_prefix, host_id)
    scoped = [row for row in rows if row['runtime_key'].startswith(runtime_prefix) and row.get('host_id') == host_id]
    names = {row['container_name'] for row in scoped if row.get('runtime_mode') == 'container'}
    expected_volumes = {name + suffix for name in names for suffix in ('-state', '-provider-profiles')}
    named = []
    for kind, arguments, approved in (
            ('container', ['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^/' + re.escape(name_prefix)], names),
            ('volume', ['volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=^' + re.escape(name_prefix)], expected_volumes)):
        found = subprocess.run(['/usr/bin/docker', *arguments], capture_output=True, text=True, check=True, timeout=plazo(15))
        named.extend({'kind': kind, 'name': name} for name in found.stdout.split()
                     if name.startswith(name_prefix) and name not in approved)
    report['orphan_named_resources'] = named
    report['sweep_exit'] = sweep_exit
    report['clean'] = report['clean'] and not named
    print('FLEET_ORPHAN_SWEEP ' + json.dumps({'scope': name_prefix, 'host': host_id,
        'orphan_resources': len(report['orphan_resources']), 'orphan_rows': len(report['orphan_rows']),
        'orphan_named_resources': len(named), 'clean': report['clean']}), file=sys.stderr, flush=True)
    return report


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
            if os.environ.get('CAUCE_RELEASE_VALIDATION') == '1':
                raise RuntimeError('disposable local Python image is unavailable for the release orphan gate')
            raise unittest.SkipTest('disposable local Python image is unavailable')
        cls.image = result.stdout.strip()

    def tearDown(self):
        try:
            if getattr(self, 'container', None):
                subprocess.run(['docker', 'rm', '-f', self.container], capture_output=True, timeout=plazo(40))
                subprocess.run(['docker', 'volume', 'rm', self.container + '-state', self.container + '-provider-profiles'],
                               capture_output=True, timeout=plazo(40))
                report = sweep_owned_fleet(self.root / 'orphan-rows.json', [], self.container,
                                          self.policy['host_id'], self.agent['runtime_key'])
                self.assertTrue(report['clean'], report)
        finally:
            self.temporary.cleanup()

    def configure_container(self, prefix='zz-canary-fleet-fixture-'):
        self.container = prefix + uuid.uuid4().hex[:12]
        self.policy['host_id'] = self.container
        self.context['request']['parameters']['placement']['host_id'] = self.container
        self.agent['host_id'] = self.container
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
            result = self.run_step(step, timeout=plazo(40))
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
        stopped = self.run_step('stop', timeout=plazo(40))
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertTrue(json.loads(stopped.stdout)['evidence']['stopped_verified'])
        gone = subprocess.run(['docker', 'exec', self.container, 'test', '-e', '/proc/' + str(metadata['pid'])], capture_output=True)
        self.assertNotEqual(gone.returncode, 0)
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [self.agent], self.container,
                                  self.policy['host_id'], self.agent['runtime_key'])
        self.assertTrue(report['clean'], report)

    def test_exact_container_uid_can_read_only_its_cauce_credential_view(self):
        self.configure_container()
        self.configure_signer()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step, timeout=plazo(40))
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

    def test_existing_foreign_container_is_not_claimed_or_stopped(self):
        self.configure_container()
        subprocess.run(['docker', 'create', '--name', self.container, '--network', 'none', '--entrypoint', '/bin/sleep',
                        self.image, 'infinity'], capture_output=True, check=True)
        subprocess.run(['docker', 'start', self.container], capture_output=True, check=True)
        original = json.loads(subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True).stdout)[0]['Id']
        self.assertEqual(self.run_step('artifacts').returncode, 0)
        rejected = self.run_step('runtime', timeout=plazo(40))
        self.assertNotEqual(rejected.returncode, 0)
        still = json.loads(subprocess.run(['docker', 'inspect', self.container], capture_output=True, text=True, check=True).stdout)[0]
        self.assertEqual(still['Id'], original)
        self.assertTrue(still['State']['Running'])

    def volumes(self):
        return subprocess.run(['docker', 'volume', 'ls', '-q', '--filter', 'name=' + self.container], capture_output=True, text=True).stdout.split()

    def containers(self):
        return subprocess.run(['docker', 'ps', '-aq', '--filter', 'name=' + self.container], capture_output=True, text=True).stdout.split()

    def operation_fixture(self):
        self.configure_container(prefix='zz-canary-fleet-')
        self.policy['containers'][self.container]['profile_root'] = '/tmp/provider-profiles'
        self.save_policy()
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        import fleet_executor_container as module
        from fleet_executor_policy import approve_agent, load_policy
        policy = load_policy(self.policy_file)
        self.agent = approve_agent(policy, self.agent)
        return module, policy

    def test_failed_create_is_compensated_to_zero_containers_and_volumes(self):
        module, policy = self.operation_fixture()
        operation = str(uuid.uuid4())
        with self.assertRaises(module.SafeFailure):
            module.create_container(policy, self.agent, {'/cauce/missing': '/nonexistent/zz-canary'}, operation_id=operation)
        expected = {self.container + '-state', self.container + '-provider-profiles'}
        self.assertEqual(set(self.volumes()), expected)
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [], self.container,
                                  policy['host_id'], self.agent['runtime_key'])
        self.assertFalse(report['clean'], report)
        self.assertEqual(report['sweep_exit'], 1)
        self.assertEqual({row['name'] for row in report['orphan_resources']}, expected)
        module.discard_operation(policy, self.agent, str(uuid.uuid4()))
        self.assertEqual(set(self.volumes()), expected)
        module.discard_operation(policy, self.agent, operation)
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [], self.container,
                                  policy['host_id'], self.agent['runtime_key'])
        self.assertTrue(report['clean'], report)
        self.assertEqual(report['sweep_exit'], 0)
        self.assertEqual((self.containers(), self.volumes()), ([], []))

    def test_real_purge_removes_container_and_provider_volumes_before_the_sweep(self):
        import test_fleet_executor_lifecycle as lifecycle_fixtures
        module, policy = self.operation_fixture()
        module.create_container(policy, self.agent, operation_id='op-purge')
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [self.agent], self.container,
                                  policy['host_id'], self.agent['runtime_key'])
        self.assertTrue(report['clean'], report)
        self.context['request'].update(kind='purge', parameters={'confirm_alias': self.agent['alias']})
        self.context['previous_agents'] = [self.agent]
        lifecycle_fixtures.PhysicalLifecycleTest.revoke_hook(self)
        for step in ('stop', 'revoke', 'purge'):
            result = self.run_step(step, timeout=plazo(40))
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        removed = json.loads(result.stdout)['evidence']
        self.assertEqual({(row['type'], row['name']) for row in removed['removed']}, {
            ('container', self.container), ('volume', self.container + '-state'),
            ('volume', self.container + '-provider-profiles')})
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [], self.container,
                                  policy['host_id'], self.agent['runtime_key'])
        self.assertTrue(report['clean'], report)
        self.assertEqual(report['sweep_exit'], 0)
        self.assertEqual((self.containers(), self.volumes()), ([], []))

class PurgeRemovalEvidenceTest(unittest.TestCase):
    def purge(self, inspections, volumes, ownership='dedicated'):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        import fleet_executor_container as container
        agent = {'container_name': 'ws-w', '_placement': {'ownership': ownership}}
        calls = []

        def docker(*arguments):
            calls.append(arguments)
            if arguments[:2] == ('volume', 'ls'):
                return volumes
            return b''

        with patch.object(container, 'approve_agent', return_value=agent), \
                patch.object(container, 'stop_container'), \
                patch.object(container, 'inspect_container', side_effect=inspections), \
                patch.object(container, 'validate_container'), \
                patch.object(container, 'owned_volumes', return_value=(
                    {'ws-w-state': {}, 'ws-w-provider-profiles': {}}, [])), \
                patch.object(container, 'docker', side_effect=docker):
            result = container.purge_container({}, agent)
        return result, calls

    def test_reports_only_the_container_and_volumes_that_existed(self):
        result, calls = self.purge([{'Id': 'abc'}, None], b'ws-w-state\nforeign\n')
        self.assertEqual(result, {'removed': [
            {'type': 'container', 'name': 'ws-w'}, {'type': 'volume', 'name': 'ws-w-state'}]})
        self.assertIn(('rm', '-f', 'abc'), calls)
        self.assertIn(('volume', 'rm', 'ws-w-state'), calls)
        self.assertFalse(any(call[:2] == ('volume', 'rm') and call[-1] == 'ws-w-provider-profiles' for call in calls))

class DockerFailureDiagnosticTest(unittest.TestCase):
    """A failed Docker effect names its cause in the host journal instead of a bare 'unverified'."""

    @classmethod
    def setUpClass(cls):
        if str(fixtures.OPS / 'cli') not in sys.path:
            sys.path.insert(0, str(fixtures.OPS / 'cli'))

    def test_failure_keeps_a_bounded_single_line_stderr_tail(self):
        import fleet_executor_container as container
        from fleet_executor_policy import SafeFailure
        noisy = 'x' * 900 + '\nError response from daemon: delegated Cauce credential effect was not verified\n'
        with self.assertRaises(SafeFailure) as raised:
            container.checked_command(['/bin/sh', '-c', 'printf "%s" "$1" >&2; exit 7', 'sh', noisy])
        message = str(raised.exception)
        self.assertTrue(message.startswith('runtime effect or observation failed (exit 7): '), message)
        self.assertTrue(message.endswith('delegated Cauce credential effect was not verified'), message)
        self.assertNotIn('\n', message)
        self.assertLessEqual(len(message), len('runtime effect or observation failed (exit 7): ') + container.DIAGNOSTIC_LIMIT)

class PurgeBrowserFixtureRecoveryTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        DisposableContainerExecutorTest.setUpClass()

    def test_interrupted_prepare_records_owned_resources_before_creating_them(self):
        source = fixtures.OPS.parent / 'tests/e2e/v4-purge-docker.fixture.py'
        spec = importlib.util.spec_from_file_location('purge_browser_fixture', source)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        key = 'zz-canary-recovery-' + uuid.uuid4().hex[:12]
        fail_key = key + '-fail'
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            create = module.create_container
            calls = 0

            def interrupt(*args, **kwargs):
                nonlocal calls
                calls += 1
                result = create(*args, **kwargs)
                if calls == 2:
                    raise RuntimeError('interrupted after Docker create')
                return result

            try:
                with patch.object(sys, 'argv', [str(source), 'prepare', '--root', directory,
                        '--tenant', 'zz-canary-tenant', '--alias', 'zzrecovery', '--runtime-key', key, '--fail-key', fail_key]), \
                        patch.object(module, 'create_container', side_effect=interrupt):
                    with self.assertRaisesRegex(RuntimeError, 'interrupted after Docker create'):
                        module.main()
                self.assertTrue((root / 'manifest.json').exists(), 'failed prepare must retain its cleanup manifest')
                with patch.object(sys, 'argv', [str(source), 'cleanup', '--root', directory]):
                    self.assertEqual(module.main(), 0)
                report = sweep_owned_fleet(root / 'recovery-rows.json', [], key, key)
                self.assertTrue(report['clean'], report)
            finally:
                module.remove(key)
                module.remove(fail_key)


if __name__ == '__main__':
    unittest.main()
