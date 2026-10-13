from __future__ import annotations

# cauce:requiere docker
import ast
import hashlib
import json
import os
import pathlib
import re
import signal
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures
from cauce_container_base import bundle_digest

SWEEP = fixtures.OPS / 'cli/fleet_orphan_sweep.py'


def inventory_inspect_command(stderr):
    failure = re.search(r"^subprocess\.CalledProcessError: Command '(\[.+\])' returned non-zero exit status 1\.$", stderr, re.MULTILINE)
    if not failure:
        return None
    try:
        command = ast.literal_eval(failure.group(1))
    except (ValueError, SyntaxError):
        return None
    if not isinstance(command, list) or len(command) < 4 or command[:3] not in (
            ['/usr/bin/docker', 'container', 'inspect'], ['/usr/bin/docker', 'volume', 'inspect']):
        return None
    if not all(isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,255}', value) for value in command[3:]):
        return None
    return command


def sweep_failure(stderr):
    command = inventory_inspect_command(stderr)
    if command:
        return f'CalledProcessError: docker {command[1]} inspect exit=1 inventory_count={len(command) - 3}'
    failure = stderr.strip().splitlines()[-1] if stderr.strip() else 'no stderr'
    if failure.startswith('subprocess.CalledProcessError: Command '):
        return 'CalledProcessError: Docker command failed'
    return failure[-512:]


def disappeared_inventory(stderr):
    command = inventory_inspect_command(stderr)
    if command is None:
        return False
    probe = subprocess.run([*command[:3], '--format', '{{.Name}}', *command[3:]],
                           capture_output=True, text=True, timeout=5)
    errors = probe.stderr.strip().splitlines()
    missing = [re.fullmatch(r'Error(?: response from daemon)?: No such (?:object|container|volume): (.+)',
                           line, re.IGNORECASE) or (re.fullmatch(r'Error response from daemon: get (.+): no such volume',
                           line, re.IGNORECASE) if command[1] == 'volume' else None) for line in errors]
    return probe.returncode == 1 and bool(errors) and all(
        match is not None and match.group(1) in command[3:] for match in missing)


def sweep_report(rows_file, runtime_prefix, host_id):
    for attempt in range(1, 4):
        result = subprocess.run([sys.executable, str(SWEEP), '--rows', str(rows_file),
            '--runtime-key-prefix', runtime_prefix, '--host-id', host_id],
            capture_output=True, text=True, timeout=15)
        try:
            report = json.loads(result.stdout)
        except json.JSONDecodeError as error:
            if result.returncode == 1 and not result.stdout.strip() and attempt < 3 and disappeared_inventory(result.stderr):
                print(f'FLEET_ORPHAN_INVENTORY_RETRY attempt={attempt} cause=listed_resource_disappeared', file=sys.stderr, flush=True)
                time.sleep(0.05)
                continue
            raise RuntimeError(f'scoped fleet sweep infrastructure failed exit={result.returncode} '
                               f'stdout_bytes={len(result.stdout)} cause={sweep_failure(result.stderr)}') from error
        if result.returncode not in (0, 1) or not isinstance(report, dict) or type(report.get('clean')) is not bool \
                or any(not isinstance(report.get(field), list) for field in ('orphan_resources', 'orphan_rows')) \
                or result.returncode != int(not report['clean']):
            raise RuntimeError(f'scoped fleet sweep protocol failed exit={result.returncode} cause={sweep_failure(result.stderr)}')
        return report, result.returncode, attempt
    raise RuntimeError('scoped fleet sweep exhausted its inventory attempts')


def sweep_owned_fleet(rows_file, rows, name_prefix, host_id, runtime_prefix=None):
    runtime_prefix = runtime_prefix or name_prefix
    pathlib.Path(rows_file).write_text(json.dumps(rows))
    report, sweep_exit, attempts = sweep_report(rows_file, runtime_prefix, host_id)
    scoped = [row for row in rows if row['runtime_key'].startswith(runtime_prefix) and row.get('host_id') == host_id]
    names = {row['container_name'] for row in scoped if row.get('runtime_mode') == 'container'}
    expected_volumes = {name + suffix for name in names for suffix in ('-state', '-provider-profiles')}
    named = []
    for kind, arguments, approved in (
            ('container', ['ps', '-a', '--format', '{{.Names}}', '--filter', 'name=^/' + re.escape(name_prefix)], names),
            ('volume', ['volume', 'ls', '--format', '{{.Name}}', '--filter', 'name=^' + re.escape(name_prefix)], expected_volumes)):
        found = subprocess.run(['/usr/bin/docker', *arguments], capture_output=True, text=True, check=True, timeout=5)
        named.extend({'kind': kind, 'name': name} for name in found.stdout.split()
                     if name.startswith(name_prefix) and name not in approved)
    report['orphan_named_resources'] = named
    report['sweep_exit'] = sweep_exit
    report['inventory_attempts'] = attempts
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
                subprocess.run(['docker', 'rm', '-f', self.container], capture_output=True, timeout=40)
                subprocess.run(['docker', 'volume', 'rm', self.container + '-state', self.container + '-provider-profiles'],
                               capture_output=True, timeout=40)
                report = sweep_owned_fleet(self.root / 'orphan-rows.json', [], self.container,
                                          self.policy['host_id'], self.agent['runtime_key'])
                self.assertTrue(report['clean'], report)
        finally:
            self.temporary.cleanup()

    def configure_container(self, prefix='cauce-fleet-fixture-'):
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

    def assert_inventory_race_retried(self, kind, owned):
        global SWEEP
        source = SWEEP
        checkpoint = self.root / (kind + '-inventory-checkpoint.json')
        runner = self.root / (kind + '-inventory-checkpoint.py')
        runner.write_text('import json,linecache,os,pathlib,runpy,signal,sys\n'
            f'source=pathlib.Path({str(source)!r});checkpoint=pathlib.Path({str(checkpoint)!r});owned={owned!r};kind={kind!r}\n'
            'def trace(frame,event,argument):\n'
            " if event=='line' and frame.f_code.co_name=='docker_json' and frame.f_locals.get('kind')==kind and not checkpoint.exists() and linecache.getline(str(source),frame.f_lineno).lstrip().startswith('return json.loads(subprocess.run'):\n"
            "  assert any(owned.startswith(value) if kind=='container' else owned==value for value in frame.f_locals['names'])\n"
            "  checkpoint.write_text(json.dumps({'pid':os.getpid(),'listed_owned':True}));os.kill(os.getpid(),signal.SIGSTOP)\n"
            ' return trace\n'
            "sys.argv=[str(source),*sys.argv[1:]];sys.settrace(trace);runpy.run_path(str(source),run_name='__main__')\n")
        paused = None
        SWEEP = runner
        try:
            with ThreadPoolExecutor(max_workers=1) as executor:
                future = executor.submit(sweep_owned_fleet, self.root / 'orphan-rows.json', [], self.container, self.container)
                try:
                    deadline = time.monotonic() + 10
                    while not checkpoint.exists():
                        if future.done():
                            future.result()
                            self.fail('sweep completed before its real inventory checkpoint')
                        self.assertLess(time.monotonic(), deadline, 'real inventory checkpoint timed out')
                        time.sleep(0.01)
                    paused = json.loads(checkpoint.read_text())['pid']
                    subprocess.run(['/usr/bin/docker', kind, 'rm', owned], capture_output=True, check=True)
                    os.kill(paused, signal.SIGCONT)
                    report = future.result(timeout=25)
                    self.assertTrue(report['clean'], report)
                    self.assertEqual(report['inventory_attempts'], 2)
                    print(f'FLEET_ORPHAN_INVENTORY_RACE kind={kind} clean=true attempts=2', flush=True)
                finally:
                    if paused is not None:
                        try:
                            os.kill(paused, signal.SIGCONT)
                        except ProcessLookupError:
                            pass
        finally:
            SWEEP = source

    def test_sweep_retries_only_a_measured_list_inspect_race_and_never_an_orphan_report(self):
        self.container = 'zz-canary-sweep-race-' + uuid.uuid4().hex[:12]
        self.policy['host_id'] = self.container
        self.agent['runtime_key'] = self.container
        container_id = subprocess.run(['/usr/bin/docker', 'create', '--name', self.container, self.image, 'true'],
                                      capture_output=True, text=True, check=True).stdout.strip()
        self.assert_inventory_race_retried('container', container_id)
        volume = self.container + '-race'
        subprocess.run(['/usr/bin/docker', 'volume', 'create', volume], capture_output=True, check=True)
        try:
            self.assert_inventory_race_retried('volume', volume)
        finally:
            subprocess.run(['/usr/bin/docker', 'volume', 'rm', volume], capture_output=True)
        volume = self.container + '-orphan'
        try:
            subprocess.run(['/usr/bin/docker', 'volume', 'create', '--label', 'cauce.fleet.runtime_key=' + self.container,
                            '--label', 'cauce.fleet.host=' + self.container, volume], capture_output=True, check=True)
            report = sweep_owned_fleet(self.root / 'orphan-rows.json', [], self.container, self.container)
            self.assertFalse(report['clean'])
            self.assertEqual(report['sweep_exit'], 1)
            self.assertEqual(report['inventory_attempts'], 1)
            self.assertEqual([item['name'] for item in report['orphan_resources']], [volume])
        finally:
            subprocess.run(['/usr/bin/docker', 'volume', 'rm', volume], capture_output=True, check=True)

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
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [self.agent], self.container,
                                  self.policy['host_id'], self.agent['runtime_key'])
        self.assertTrue(report['clean'], report)

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

    def test_compensation_removes_created_container_but_never_another_operations_resources(self):
        module, policy = self.operation_fixture()
        module.create_container(policy, self.agent, operation_id='op-one')
        module.discard_operation(policy, self.agent, 'op-two')
        self.assertEqual(len(self.containers()), 1)
        self.assertEqual(set(self.volumes()), {self.container + '-state', self.container + '-provider-profiles'})
        module.discard_operation(policy, self.agent, 'op-one')
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [], self.container,
                                  policy['host_id'], self.agent['runtime_key'])
        self.assertTrue(report['clean'], report)
        self.assertEqual((self.containers(), self.volumes()), ([], []))

    def test_real_purge_removes_container_and_provider_volumes_before_the_sweep(self):
        module, policy = self.operation_fixture()
        module.create_container(policy, self.agent, operation_id='op-purge')
        report = sweep_owned_fleet(self.root / 'orphan-rows.json', [self.agent], self.container,
                                  policy['host_id'], self.agent['runtime_key'])
        self.assertTrue(report['clean'], report)
        removed = module.purge_container(policy, self.agent)
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

    def test_reports_nothing_when_the_container_and_volumes_are_already_gone(self):
        result, calls = self.purge([None, None], b'')
        self.assertEqual(result, {'removed': []})
        self.assertFalse(any(call[:1] == ('rm',) or call[:2] == ('volume', 'rm') for call in calls))

    def test_shared_container_is_not_listed_as_removed(self):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        import fleet_executor_container as container
        agent = {'container_name': 'ws-humanizar', '_placement': {'ownership': 'shared'}}
        with patch.object(container, 'approve_agent', return_value=agent), \
                patch.object(container, 'stop_container'), \
                patch.object(container, 'inspect_container', return_value={'Id': 'shared'}), \
                patch('fleet_executor_legacy.purge_shared') as purge_shared:
            self.assertEqual(container.purge_container({}, agent), {'removed': []})
        purge_shared.assert_called_once()

    def test_prior_purge_without_removed_omits_the_evidence_key(self):
        sys.path.insert(0, str(fixtures.OPS / 'cli'))
        import fleet_executor_steps as steps
        temporary = tempfile.TemporaryDirectory(prefix='cauce-purge-evidence-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        state = pathlib.Path(temporary.name)
        state.chmod(0o700)
        context = {'operation_id': uuid.uuid4().hex, 'request': {'kind': 'purge', 'target': {'resource': 'agent'}},
                   'fenced_targets': [], 'previous_agents': [], 'desired_memberships': []}
        executor = steps.Executor({'roots': {'state': str(state)}, 'host_id': 'fixture-host'}, context)
        executor.journal.update(stopped=True, revocation_complete=True, purged=True)
        executor.journal.pop('removed', None)
        executor.save()
        observed = {'removed': [{'type': 'container', 'name': 'ws-w'}]}
        agents = patch.object(steps, 'scoped_agents', return_value=[{'runtime_key': 'w'}])
        references = patch.object(steps, 'credential_references', return_value={'credentials': {}})
        with agents, references, patch.object(steps, 'purge_runtime', return_value=observed):
            prior = executor.purge()
            self.assertNotIn('removed', prior)
            fresh_state = state / 'fresh'
            fresh_state.mkdir(mode=0o700)
            fresh = steps.Executor({'roots': {'state': str(fresh_state)}, 'host_id': 'fixture-host'},
                                    {**context, 'operation_id': uuid.uuid4().hex})
            fresh.journal.update(stopped=True, revocation_complete=True)
            fresh.save()
            self.assertEqual(fresh.purge()['removed'], observed['removed'])
            self.assertEqual(fresh.purge()['removed'], observed['removed'])
        with agents, references, patch.object(steps, 'purge_runtime', return_value={}):
            empty_state = state / 'empty'
            empty_state.mkdir(mode=0o700)
            empty = steps.Executor({'roots': {'state': str(empty_state)}, 'host_id': 'fixture-host'},
                                    {**context, 'operation_id': uuid.uuid4().hex})
            empty.journal.update(stopped=True, revocation_complete=True)
            empty.save()
            self.assertEqual(empty.purge()['removed'], [])
        self.assertNotIn('removed', executor.journal)
        self.assertIs(executor.journal.get('purged'), True)


if __name__ == '__main__':
    unittest.main()
