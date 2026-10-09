from __future__ import annotations

import json
import os
import pathlib
import pwd
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_container as container
import fleet_executor_rebind as rebind
import fleet_executor_view
from fleet_executor_policy import SafeFailure, approve_agent

OPS = pathlib.Path(__file__).resolve().parents[1]
OLD, NEW, FOREIGN = 'a' * 40, 'b' * 40, 'c' * 40
IMAGE = 'sha256:' + 'd' * 64


class FakeDocker:
    def __init__(self):
        self.containers, self.volumes, self.calls, self.live, self.stuck, self.counter = {}, {}, [], set(), set(), 0

    def by_id(self, identity):
        return next(name for name, row in self.containers.items() if row['Id'] == identity)

    def add(self, name, labels, mounts, *, running):
        self.counter += 1
        self.containers[name] = {'Id': f'{self.counter:064x}', 'Name': '/' + name, 'Image': IMAGE,
            'Config': {'Labels': labels}, 'Mounts': mounts,
            'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'PidMode': '', 'NetworkMode': 'none'},
            'State': {'Running': running, 'Pid': 4000 + self.counter if running else 0, 'StartedAt': f't{self.counter}'}}
        return self.containers[name]

    def __call__(self, *arguments):
        self.calls.append(arguments)
        command = arguments[0]
        if command == 'ps':
            filters = [arguments[index + 1][len('label='):].split('=', 1) for index, value in enumerate(arguments) if value == '--filter']
            return '\n'.join(name for name, row in self.containers.items()
                             if all(row['Config']['Labels'].get(key) == value for key, value in filters)).encode()
        if command == 'inspect':
            return json.dumps([self.containers[arguments[1]]]).encode()
        if command == 'image':
            return json.dumps([{'Id': IMAGE}]).encode()
        if command == 'volume':
            if arguments[1] == 'ls':
                return '\n'.join(self.volumes).encode()
            if arguments[1] == 'inspect':
                return json.dumps([{'Labels': self.volumes[arguments[2]]}]).encode()
            self.volumes[arguments[-1]] = dict(value.split('=', 1) for value in arguments[3:-1:2])
            return b''
        if command == 'rm':
            del self.containers[self.by_id(arguments[-1])]
            return b''
        if command == 'start':
            self.containers[self.by_id(arguments[1])]['State'].update(Running=True, Pid=9000 + self.counter, StartedAt='restarted')
            return b''
        if command == 'create':
            return self.create(arguments)
        name = self.by_id(arguments[arguments.index('--user') + 2] if '--env' not in arguments else arguments[arguments.index('--env') + 2])
        if '/usr/bin/getent' in arguments:
            return b'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n'
        action = arguments[arguments.index('/cauce/lifecycle/cauce-container-runtime.py') + 1]
        source = next(row['Source'] for row in self.containers[name]['Mounts'] if row['Destination'] == '/cauce/lifecycle')
        self.calls[-1] = ('helper', action, source)
        if action == 'stopped' and name in self.live:
            raise SafeFailure('runtime effect or observation failed')
        if action == 'stop' and name not in self.stuck:
            self.live.discard(name)
        return b''

    def create(self, arguments):
        options = {}
        for index in range(1, len(arguments) - 3):
            if arguments[index].startswith('--') and index + 1 < len(arguments):
                options.setdefault(arguments[index], []).append(arguments[index + 1])
        mounts = []
        for value in options['--mount']:
            fields = dict(item.split('=', 1) for item in value.split(',') if '=' in item)
            row = {'Type': fields['type'], 'Source': fields['source'], 'Destination': fields['destination'], 'RW': not value.endswith(',readonly')}
            if fields['type'] == 'volume':
                row['Name'] = fields['source']
            mounts.append(row)
        labels = dict(value.split('=', 1) for value in options['--label'])
        self.add(options['--name'][0], labels, mounts, running=False)
        return b''


class ReleaseFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cauce-rebind-', dir='/var/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.base = pathlib.Path(self.temporary.name) / 'releases'
        for release in (OLD, NEW):
            for tree in ('ops/cli', 'ops/container-runtime', 'adapter'):
                (self.base / release / tree).mkdir(parents=True)
            (self.base / release / 'ops/container-runtime/cauce-container-runtime.py').write_text('helper\n')
            (self.base / release / 'adapter/worker.py').write_text('import time\ntime.sleep(60)\n')
        self.old, self.new = self.base / OLD, self.base / NEW
        self.user = pwd.getpwuid(os.geteuid()).pw_name
        for patch in (mock.patch.object(rebind, 'OWNER', os.geteuid()), mock.patch.object(container, 'RELEASE_ROOT', self.new)):
            patch.start()
            self.addCleanup(patch.stop)
        self.name = 'cauce-fleet-rebind-' + uuid.uuid4().hex[:8]
        self.policy = {'host_id': 'fixture-host', 'executor_user': self.user, 'native': [], 'profiles': {}, 'hooks': {},
            'containers': {self.name: {'image': IMAGE, 'runtime_user': 'nobody', 'systemd_user': self.user,
                'home_directory': '/nonexistent', 'state_root': '/tmp/cauce-state', 'python': '/usr/local/bin/python3.12'}},
            'bundles': {'codex': {'directory': str(self.new / 'adapter'), 'digest': 'sha256:' + '0' * 64,
                'executable': '/usr/local/bin/python3.12', 'executable_sha256': None, 'argv': []}}}
        self.agent = approve_agent(self.policy, {'tenant_id': 'Equipo_42', 'alias': 'shared_alias', 'runtime_key': 'physical-one',
            'harness_id': 'codex', 'host_id': 'fixture-host', 'runtime_mode': 'container', 'container_name': self.name,
            'runtime_user': 'nobody', 'home_directory': '/nonexistent', 'state_directory': '/tmp/cauce-state/physical-one',
            'systemd_user': self.user})

    def mounts(self, root):
        state = {'Type': 'volume', 'Name': self.name + '-state', 'Source': '/var/lib/docker/volumes/x', 'Destination': '/tmp/cauce-state', 'RW': True}
        return [state, *({'Type': 'bind', 'Source': source, 'Destination': destination, 'RW': False}
                         for destination, source in container.runtime_mounts(self.policy, self.agent, root, self.new).items())]


class BoundReleaseTests(ReleaseFixture):
    def observed(self, root):
        return {'Mounts': self.mounts(root)}

    def test_sibling_installed_release_is_detected_and_current_or_foreign_mounts_are_ignored(self):
        self.assertEqual(rebind.bound_release(self.observed(self.old), self.new), self.old)
        self.assertIsNone(rebind.bound_release(self.observed(self.new), self.new))
        self.assertIsNone(rebind.bound_release(self.observed(pathlib.Path('/opt/elsewhere') / OLD), self.new))
        self.assertIsNone(rebind.bound_release(self.observed(self.base / 'not-a-release'), self.new))
        self.assertIsNone(rebind.bound_release(self.observed(self.old), self.base / 'checkout'))

    def test_missing_symlinked_writable_or_foreign_owned_release_tree_is_refused(self):
        with self.assertRaisesRegex(SafeFailure, 'unavailable'):
            rebind.bound_release(self.observed(self.base / FOREIGN), self.new)
        (self.base / FOREIGN).symlink_to(self.old)
        with self.assertRaisesRegex(SafeFailure, 'symlink'):
            rebind.bound_release(self.observed(self.base / FOREIGN), self.new)
        helper = self.old / 'ops/container-runtime/cauce-container-runtime.py'
        helper.chmod(0o664)
        with self.assertRaisesRegex(SafeFailure, 'trusted'):
            rebind.bound_release(self.observed(self.old), self.new)
        helper.chmod(0o644)
        (self.old / 'ops/cli/linked.py').symlink_to(helper)
        with self.assertRaisesRegex(SafeFailure, 'trusted'):
            rebind.bound_release(self.observed(self.old), self.new)
        (self.old / 'ops/cli/linked.py').unlink()
        with mock.patch.object(rebind, 'OWNER', 0) if os.geteuid() else mock.patch.object(rebind, 'OWNER', 1):
            with self.assertRaisesRegex(SafeFailure, 'ownership'):
                rebind.bound_release(self.observed(self.old), self.new)


class RebindEffectTests(ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.docker = FakeDocker()
        for module in (container, rebind):
            patch = mock.patch.object(module, 'docker', self.docker)
            patch.start()
            self.addCleanup(patch.stop)
        labels = container.expected_labels(self.policy, self.agent)
        self.docker.volumes[self.name + '-state'] = dict(labels)

    def old_container(self, *, running=True, live=False):
        row = self.docker.add(self.name, container.expected_labels(self.policy, self.agent), self.mounts(self.old), running=running)
        if live:
            self.docker.live.add(self.name)
        return row

    def test_running_live_container_is_stopped_by_its_own_helper_then_recreated_on_the_current_release(self):
        before = self.old_container(live=True)
        result = container.stop_container(self.policy, self.agent)
        self.assertEqual(result, {'stopped_verified': True})
        after = self.docker.containers[self.name]
        self.assertNotEqual(after['Id'], before['Id'])
        self.assertTrue(after['State']['Running'])
        self.assertEqual(after['Config']['Labels'], before['Config']['Labels'])
        sources = {row['Destination']: row['Source'] for row in after['Mounts']}
        self.assertEqual(sources['/cauce/lifecycle'], str(self.new / 'ops/container-runtime'))
        self.assertEqual(sources['/cauce/executor'], str(self.new / 'ops/cli'))
        self.assertEqual(sources[str(self.new / 'adapter')], str(self.new / 'adapter'))
        self.assertEqual(sources['/tmp/cauce-state'], self.name + '-state')
        helpers = [call for call in self.docker.calls if call[0] == 'helper']
        self.assertEqual(helpers[:2], [('helper', 'stop', str(self.old / 'ops/container-runtime')),
                                       ('helper', 'stopped', str(self.old / 'ops/container-runtime'))])
        self.assertTrue(all(source == str(self.new / 'ops/container-runtime') for _, _, source in helpers[2:]))
        self.assertFalse(any(call[:2] == ('volume', 'create') or call[:2] == ('volume', 'rm') for call in self.docker.calls))

    def test_stopped_container_is_recreated_stopped_without_running_any_helper(self):
        self.old_container(running=False)
        observed = container.observe_container(self.policy, self.agent)
        self.assertFalse(observed['State']['Running'])
        self.assertFalse([call for call in self.docker.calls if call[0] in {'helper', 'start'}])
        self.assertEqual(observed['Mounts'][1]['Source'], str(self.new / 'ops/container-runtime'))

    def test_start_path_migrates_before_validation(self):
        self.old_container(running=False)
        observed = container.ensure_container(self.policy, self.agent)
        self.assertTrue(observed['State']['Running'])
        container.validate_container(self.policy, self.agent, observed)

    def test_failed_old_helper_stop_preserves_the_original_container(self):
        before = self.old_container(live=True)
        self.docker.stuck.add(self.name)
        with self.assertRaises(SafeFailure):
            container.stop_container(self.policy, self.agent)
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])

    def test_changed_shape_or_image_is_never_recreated(self):
        before = self.old_container(running=False)
        before['HostConfig']['Privileged'] = True
        with self.assertRaisesRegex(SafeFailure, 'isolation'):
            container.stop_container(self.policy, self.agent)
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
        self.assertFalse(any(call[0] in {'rm', 'create'} for call in self.docker.calls))

    def test_foreign_owned_volume_is_detected_before_the_adapter_is_stopped(self):
        before = self.old_container(live=True)
        self.docker.volumes[self.name + '-state']['cauce.fleet.owner'] = 'someone-else'
        with self.assertRaisesRegex(SafeFailure, 'another owner'):
            container.stop_container(self.policy, self.agent)
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
        self.assertFalse([call for call in self.docker.calls if call[0] in {'helper', 'rm', 'create'}])

    def test_eager_plan_reports_a_foreign_owned_volume_as_refused(self):
        self.old_container(running=False)
        self.docker.volumes[self.name + '-state']['cauce.fleet.owner'] = 'someone-else'
        receipt = rebind.rebind_all(self.policy, self.new, dry_run=True)
        self.assertEqual(receipt['refused'], [{'container': self.name, 'release': OLD, 'reason': 'existing runtime volume has another owner'}])

    def test_eager_pass_refuses_containers_without_tenant_and_alias_identity(self):
        labels = {key: value for key, value in container.expected_labels(self.policy, self.agent).items() if key != 'cauce.fleet.alias'}
        self.docker.add(self.name, labels, self.mounts(self.old), running=False)
        receipt = rebind.rebind_all(self.policy, self.new)
        self.assertEqual(receipt['refused'], [{'container': self.name, 'release': OLD,
                                               'reason': 'container has no approved tenant and alias identity'}])
        self.assertFalse(any(call[0] in {'rm', 'create'} for call in self.docker.calls))

    def test_shared_placement_is_never_recreated(self):
        observed = self.old_container(running=False)
        with self.assertRaisesRegex(SafeFailure, 'shared'):
            rebind.rebind(self.policy, {**self.agent, '_placement': {**self.agent['_placement'], 'ownership': 'shared'}},
                          observed, self.old, self.new)

    def test_eager_pass_rebinds_idle_defers_live_reports_refused_and_skips_shared(self):
        self.old_container(running=True)
        labels = container.expected_labels(self.policy, self.agent)
        live = self.name + '-live'
        self.policy['containers'][live] = self.policy['containers'][self.name]
        self.docker.volumes[live + '-state'] = dict(labels)
        live_agent = {**self.agent, 'container_name': live}
        self.docker.add(live, labels, [{**row, 'Name': live + '-state'} if row['Type'] == 'volume' else row
                                       for row in self.mounts(self.old)], running=True)
        self.docker.live.add(live)
        stray = self.docker.add(self.name + '-stray', labels, self.mounts(self.old), running=False)
        self.docker.add('shared-legacy', labels, self.mounts(self.old), running=True)
        self.policy['shared_containers'] = {'shared-legacy': {}}
        planned = rebind.rebind_all(self.policy, self.new, dry_run=True)
        self.assertEqual(planned['rebound'], [])
        self.assertEqual({row['container'] for row in planned['deferred']}, {self.name, live})
        self.assertEqual(self.docker.containers[self.name]['Mounts'][1]['Source'], str(self.old / 'ops/container-runtime'))
        receipt = rebind.rebind_all(self.policy, self.new)
        self.assertEqual(receipt['rebound'], [{'container': self.name, 'release': OLD}])
        self.assertEqual(receipt['deferred'], [{'container': live, 'release': OLD}])
        self.assertEqual(receipt['refused'], [{'container': stray['Name'][1:], 'release': OLD,
                                               'reason': 'container has no approved runtime placement'}])
        self.assertEqual(receipt['shared'], ['shared-legacy'])
        again = rebind.rebind_all(self.policy, self.new, include_running=True)
        self.assertEqual(again['current'], [self.name])
        self.assertEqual(again['rebound'], [{'container': live, 'release': OLD}])
        container.validate_container(self.policy, approve_agent(self.policy, live_agent), self.docker.containers[live])

    def test_rollback_pass_returns_containers_to_the_previous_release(self):
        self.old_container(running=True)
        rebind.rebind_all(self.policy, self.new)
        old_policy = json.loads(json.dumps(self.policy).replace(NEW, OLD))
        receipt = rebind.rebind_all(old_policy, self.old, include_running=True)
        self.assertEqual(receipt['rebound'], [{'container': self.name, 'release': NEW}])
        sources = {row['Destination']: row['Source'] for row in self.docker.containers[self.name]['Mounts']}
        self.assertEqual(sources['/cauce/executor'], str(self.old / 'ops/cli'))
        self.assertEqual(sources[str(self.old / 'adapter')], str(self.old / 'adapter'))


class CredentialViewRemovalTests(unittest.TestCase):
    def test_absent_view_parent_proves_absence(self):
        with tempfile.TemporaryDirectory(prefix='cauce-view-', dir='/var/tmp') as directory:
            fleet_executor_view.remove(pathlib.Path(directory) / 'cauce-credentials' / 'physical-one')
            link = pathlib.Path(directory) / 'link'
            link.symlink_to(directory)
            with self.assertRaises(OSError):
                fleet_executor_view.remove(link / 'physical-one')


class RealDockerRebindTest(ReleaseFixture):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(['docker', 'image', 'inspect', 'python:3.12-slim', '--format', '{{.Id}}'], capture_output=True, text=True)
        if result.returncode:
            raise unittest.SkipTest('disposable local Python image is unavailable')
        cls.image = result.stdout.strip()

    def setUp(self):
        super().setUp()
        for release in (self.old, self.new):
            for tree in ('ops/cli', 'ops/container-runtime'):
                shutil.rmtree(release / tree)
                shutil.copytree(OPS / tree.removeprefix('ops/'), release / tree, ignore=shutil.ignore_patterns('__pycache__'))
        for item in [self.base, *self.base.rglob('*')]:
            item.chmod(0o755 if item.is_dir() else 0o644)
        self.policy['containers'][self.name]['image'] = self.image
        self.agent['_placement']['image'] = self.image
        self.addCleanup(self.remove)

    def remove(self):
        subprocess.run(['docker', 'rm', '-f', self.name], capture_output=True, check=False)
        subprocess.run(['docker', 'volume', 'rm', self.name + '-state'], capture_output=True, check=False)

    def inspect(self):
        return json.loads(subprocess.run(['docker', 'inspect', self.name], capture_output=True, text=True, check=True).stdout)[0]

    def test_real_container_keeps_name_labels_state_volume_and_run_state_across_rebind(self):
        container.create_container(self.policy, self.agent, container.runtime_mounts(self.policy, self.agent, self.old, self.new))
        subprocess.run(['docker', 'start', self.name], capture_output=True, check=True)
        subprocess.run(['docker', 'exec', self.name, '/bin/sh', '-c', 'echo kept > /tmp/cauce-state/sentinel'], capture_output=True, check=True)
        before = self.inspect()
        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
        after = self.inspect()
        self.assertNotEqual(after['Id'], before['Id'])
        self.assertTrue(after['State']['Running'])
        self.assertEqual(after['Config']['Labels'], before['Config']['Labels'])
        self.assertEqual({row['Destination']: row['Source'] for row in after['Mounts'] if row['Type'] == 'bind'},
                         container.runtime_mounts(self.policy, self.agent))
        kept = subprocess.run(['docker', 'exec', self.name, '/bin/cat', '/tmp/cauce-state/sentinel'], capture_output=True, text=True, check=True)
        self.assertEqual(kept.stdout, 'kept\n')

    def test_real_stopped_container_is_rebound_by_the_eager_pass_and_left_stopped(self):
        container.create_container(self.policy, self.agent, container.runtime_mounts(self.policy, self.agent, self.old, self.new))
        receipt = rebind.rebind_all(self.policy, self.new)
        self.assertEqual(receipt['rebound'], [{'container': self.name, 'release': OLD}])
        after = self.inspect()
        self.assertFalse(after['State']['Running'])
        container.validate_container(self.policy, self.agent, after)


if __name__ == '__main__':
    unittest.main()
