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
import fleet_executor_lifecycle as lifecycle
import fleet_executor_rebind as rebind
import fleet_executor_view
from cauce_container_base import bundle_digest
from fleet_executor_policy import SafeFailure, approve_agent

OPS = pathlib.Path(__file__).resolve().parents[1]
OLD, NEW, FOREIGN = 'a' * 64, 'b' * 64, 'c' * 64
IMAGE = 'sha256:' + 'd' * 64


class FakeDocker:
    def __init__(self):
        self.containers, self.volumes, self.calls, self.live, self.stuck, self.counter = {}, {}, [], set(), set(), 0
        self.adapters = {}

    def register_adapter(self, agent, observed, bundle_digest):
        identity = container.identity_for(agent, observed)
        metadata = {'alias': agent['runtime_key'], 'wireAlias': agent['alias'], 'tenantId': agent['tenant_id'],
            'stateDirectory': agent['state_directory'], 'controlDirectory': str(identity['control']),
            'containerId': identity['container_id'], 'containerGeneration': identity['generation'],
            'runtimeUid': 65534, 'runtimeGid': 65534, 'phase': 'running', 'bundleDigest': bundle_digest}
        environment = {'CAUCE_BOOTSTRAP': '0', 'CAUCE_ROOM': agent['primary_room_id'], 'CAUCE_ALIAS': agent['alias'],
            'CAUCE_RUNTIME_KEY': agent['runtime_key'], 'CAUCE_TENANT_ID': agent['tenant_id'],
            'CAUCE_STATE_DIR': agent['state_directory'], 'CAUCE_CONTROL_DIR': str(identity['control']),
            'CAUCE_CONTAINER_ID': identity['container_id'], 'CAUCE_CONTAINER_GENERATION': identity['generation']}
        self.adapters[observed['Id']] = {'metadata': metadata, 'environment': environment}

    def by_id(self, identity):
        return next(name for name, row in self.containers.items() if row['Id'] == identity)

    def add(self, name, labels, mounts, *, running):
        self.counter += 1
        self.containers[name] = {'Id': f'{self.counter:064x}', 'Name': '/' + name, 'Image': IMAGE,
            'Config': {'Labels': labels, 'Entrypoint': ['/bin/sleep'], 'Cmd': ['infinity'], 'User': '0'}, 'Mounts': mounts,
            'HostConfig': {'ReadonlyRootfs': True, 'Privileged': False, 'PidMode': '', 'NetworkMode': 'none',
                'CapAdd': container.BASE_CAPABILITIES, 'CapDrop': ['ALL'], 'SecurityOpt': ['no-new-privileges'],
                'Tmpfs': {'/run': 'rw,nosuid,noexec,size=16m'}, 'Memory': 0, 'MemorySwap': 0, 'NanoCpus': 0, 'PidsLimit': 128},
            'NetworkSettings': {'Networks': {'none': {}}},
            'State': {'Running': running, 'Paused': False, 'Pid': 4000 + self.counter if running else 0, 'StartedAt': f't{self.counter}'}}
        return self.containers[name]

    def __call__(self, *arguments):
        self.calls.append(arguments)
        command = arguments[0]
        if command == 'ps':
            filters = [arguments[index + 1][len('label='):].split('=', 1) for index, value in enumerate(arguments)
                       if value == '--filter' and arguments[index + 1].startswith('label=')]
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
            if arguments[1] == 'rm':
                del self.volumes[arguments[2]]
                return b''
            self.volumes[arguments[-1]] = dict(value.split('=', 1) for value in arguments[3:-1:2])
            return b''
        if command == 'rm':
            del self.containers[self.by_id(arguments[-1])]
            return b''
        if command == 'start':
            self.containers[self.by_id(arguments[1])]['State'].update(Running=True, Pid=9000 + self.counter, StartedAt='restarted')
            return b''
        if command == 'stop':
            self.containers[self.by_id(arguments[1])]['State'].update(Running=False, Pid=0)
            return b''
        if command == 'rename':
            old_name = self.by_id(arguments[1])
            row = self.containers.pop(old_name)
            row['Name'] = '/' + arguments[2]
            self.containers[arguments[2]] = row
            return b''
        if command == 'create':
            return self.create(arguments)
        current_helper = lifecycle.BOOTSTRAP in arguments
        if '-c' in arguments and not current_helper and '/cauce/lifecycle/cauce-container-runtime.py' not in arguments:
            return b'clear\n'
        name = self.by_id(arguments[arguments.index('--user') + 2] if '--env' not in arguments else arguments[arguments.index('--env') + 2])
        if self.containers[name]['State']['Paused']:
            raise SafeFailure('container is paused')
        if '/usr/bin/getent' in arguments:
            return b'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin\n'
        action = arguments[arguments.index(lifecycle.BOOTSTRAP) + 2] if current_helper else \
            arguments[arguments.index('/cauce/lifecycle/cauce-container-runtime.py') + 1]
        source = str(lifecycle.SOURCE_ROOT) if current_helper else \
            next(row['Source'] for row in self.containers[name]['Mounts'] if row['Destination'] == '/cauce/lifecycle')
        if action.startswith('{'):
            observation = self.adapters[self.containers[name]['Id']]
            if any(observation['metadata'].get(key) != value for key, value in json.loads(action).items()):
                raise SafeFailure('previous adapter lifecycle identity differs')
            self.calls[-1] = ('helper', 'observe', source)
            return json.dumps(observation).encode()
        self.calls[-1] = ('helper', action, source)
        adapter = self.adapters.get(self.containers[name]['Id'])
        if action == 'check' and adapter is not None \
                and adapter['metadata']['bundleDigest'] != arguments[arguments.index('--bundle-digest') + 1]:
            raise SafeFailure('runtime effect or observation failed (exit 78): active bundle digest differs from lifecycle metadata')
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
        for value in options.get('--volume', []):
            parts = value.split(':')
            if len(parts) < 3:
                continue
            mounts.append({'Type': 'bind', 'Source': parts[0], 'Destination': parts[1],
                           'RW': 'rw' in parts[-1].split(',')})
        labels = dict(value.split('=', 1) for value in options['--label'])
        row = self.add(options['--name'][0], labels, mounts, running=False)
        if '--pids-limit' in options:
            row['HostConfig']['PidsLimit'] = int(options['--pids-limit'][0])
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
            (self.base / release / 'ops/cli/fleet_executor_image.py').write_text('guard\n')
            (self.base / release / 'adapter/worker.py').write_text('import time\ntime.sleep(60)\n')
        self.old, self.new = self.base / OLD, self.base / NEW
        self.user = pwd.getpwuid(os.geteuid()).pw_name
        for patch in (mock.patch.object(container, 'RELEASE_ROOT', self.new),):
            patch.start()
            self.addCleanup(patch.stop)
        self.name = 'cauce-fleet-rebind-' + uuid.uuid4().hex[:8]
        self.policy = {'host_id': 'fixture-host', 'executor_user': self.user, 'native': [], 'profiles': {}, 'hooks': {},
            'roots': {'state': str(pathlib.Path(self.temporary.name))},
            'containers': {self.name: {'image': IMAGE, 'runtime_user': 'nobody', 'systemd_user': self.user,
                'home_directory': '/nonexistent', 'state_root': '/tmp/cauce-state', 'python': '/usr/local/bin/python3.12'}},
            'bundles': {'codex': {'directory': str(self.new / 'adapter'), 'digest': bundle_digest(str(self.new / 'adapter')),
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

    def test_git_revision_releases_remain_supported_alongside_artifact_digests(self):
        previous = self.base / ('a' * 40)
        for tree in rebind.TREES:
            (previous / tree).mkdir(parents=True)
        self.assertEqual(rebind.bound_release(self.observed(previous), self.new), previous)
        for name in ('a' * 39, 'a' * 41, 'a' * 63, 'a' * 65, 'g' * 64):
            with self.subTest(name=name):
                self.assertIsNone(rebind.bound_release(self.observed(self.base / name), self.new))

    def test_release_trust_accepts_only_root_or_the_executor_without_write_access_for_others(self):
        with mock.patch.object(rebind.os, 'geteuid', return_value=1234):
            for owner in (0, 1234, 5678):
                for mode in (0o755, 0o775, 0o777):
                    with self.subTest(owner=owner, mode=mode):
                        self.assertEqual(rebind.trusted(mock.Mock(st_uid=owner, st_mode=mode)),
                                         owner in {0, 1234} and mode == 0o755)

    def test_previous_release_rejects_unsafe_permissions_and_symlink_entries(self):
        helper = self.old / 'ops/container-runtime/cauce-container-runtime.py'
        helper.chmod(0o666)
        with self.assertRaisesRegex(SafeFailure, 'trusted'):
            rebind.bound_release(self.observed(self.old), self.new)
        helper.unlink()
        helper.symlink_to(self.new / 'ops/container-runtime/cauce-container-runtime.py')
        with self.assertRaisesRegex(SafeFailure, 'trusted'):
            rebind.bound_release(self.observed(self.old), self.new)

class RebindEffectTests(ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.docker = FakeDocker()
        self.agent['primary_room_id'] = 'fixture'
        for module in (container, rebind):
            patch = mock.patch.object(module, 'docker', self.docker)
            patch.start()
            self.addCleanup(patch.stop)
        commands = mock.patch.object(container, 'checked_command', lambda command, **_kwargs: self.docker(*command[1:]))
        commands.start()
        self.addCleanup(commands.stop)
        labels = container.expected_labels(self.policy, self.agent)
        self.docker.volumes[self.name + '-state'] = dict(labels)

    def old_container(self, *, running=True, live=False, digest=None):
        row = self.docker.add(self.name, container.expected_labels(self.policy, self.agent), self.mounts(self.old), running=running)
        self.docker.register_adapter(self.agent, row, digest or self.policy['bundles']['codex']['digest'])
        if live:
            self.docker.live.add(self.name)
        return row

    def test_stop_uses_the_current_helper_without_rebinding_the_previous_release(self):
        before = self.old_container(live=True)
        mounts = json.loads(json.dumps(before['Mounts']))
        with mock.patch.object(container, 'observe_container', side_effect=AssertionError('stop must not refresh')), \
                mock.patch.object(container, 'approved_bundle', side_effect=AssertionError('stop must not approve a new adapter')), \
                mock.patch.object(container, 'adapter_restart_state', side_effect=AssertionError('stop must not check the new bundle')), \
                mock.patch.object(container, 'process_proof', side_effect=AssertionError('stop must not prove the new SDK')):
            result = container.stop_container(self.policy, self.agent)
        self.assertEqual(result, {'stopped_verified': True})
        after = self.docker.containers[self.name]
        self.assertEqual(after['Id'], before['Id'])
        self.assertTrue(after['State']['Running'])
        self.assertEqual(after['Config']['Labels'], before['Config']['Labels'])
        self.assertEqual(after['Mounts'], mounts)
        self.assertNotIn(self.name, self.docker.live)
        helpers = [call for call in self.docker.calls if call[0] == 'helper']
        self.assertEqual(helpers, [('helper', 'stopped', str(lifecycle.SOURCE_ROOT)),
                                   ('helper', 'observe', str(lifecycle.SOURCE_ROOT)),
                                   ('helper', 'stop', str(lifecycle.SOURCE_ROOT)),
                                   ('helper', 'stopped', str(lifecycle.SOURCE_ROOT))])
        self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename', 'rm'} for call in self.docker.calls))
        self.assertFalse(any(call[:2] == ('volume', 'create') or call[:2] == ('volume', 'rm') for call in self.docker.calls))

    def test_stop_accepts_an_adapter_launched_with_the_previous_release_bundle(self):
        (self.old / 'adapter/release').write_text('previous\n')
        previous = bundle_digest(str(self.old / 'adapter'))
        self.assertNotEqual(previous, self.policy['bundles']['codex']['digest'])
        before = self.old_container(live=True, digest=previous)
        identity = container.identity_for(self.agent, before)
        bundle = self.policy['bundles']['codex']
        with self.assertRaisesRegex(SafeFailure, 'active bundle digest differs from lifecycle metadata'):
            container.helper(self.agent, identity, 'check', *container.lifecycle_arguments(self.agent, identity),
                             '--bundle', bundle['directory'], '--bundle-digest', bundle['digest'])
        self.docker.calls.clear()
        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
        self.assertNotIn(self.name, self.docker.live)
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
        self.assertEqual([call[1] for call in self.docker.calls if call[0] == 'helper'], ['stopped', 'observe', 'stop', 'stopped'])
        self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename', 'rm'} for call in self.docker.calls))

    def test_failed_old_helper_stop_preserves_the_original_container(self):
        before = self.old_container(live=True)
        self.docker.stuck.add(self.name)
        with mock.patch.object(container, 'adapter_restart_state', return_value={'adapter_running': True}), \
                self.assertRaises(SafeFailure):
            container.stop_container(self.policy, self.agent)
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])

    def test_foreign_owned_volume_is_detected_before_the_adapter_is_stopped(self):
        before = self.old_container(live=True)
        self.docker.volumes[self.name + '-state']['cauce.fleet.owner'] = 'someone-else'
        with self.assertRaisesRegex(SafeFailure, 'another owner'):
            container.stop_container(self.policy, self.agent)
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
        self.assertFalse([call for call in self.docker.calls if call[0] in {'helper', 'rm', 'create'}])

    def test_stop_rejects_untrusted_or_mixed_previous_releases_before_effects(self):
        helper = self.old / 'ops/container-runtime/cauce-container-runtime.py'
        for drift in ('writable', 'symlink', 'mixed', 'missing'):
            with self.subTest(drift=drift):
                self.docker.containers.clear()
                self.docker.calls.clear()
                before = self.old_container(live=True)
                if drift == 'writable':
                    helper.chmod(0o666)
                elif drift == 'symlink':
                    helper.unlink()
                    helper.symlink_to(self.new / 'ops/container-runtime/cauce-container-runtime.py')
                elif drift == 'missing':
                    shutil.rmtree(self.old / 'ops/cli')
                else:
                    next(row for row in before['Mounts'] if row['Destination'] == '/cauce/executor')['Source'] = str(self.new / 'ops/cli')
                try:
                    with self.assertRaises(SafeFailure):
                        container.stop_container(self.policy, self.agent)
                    self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                    self.assertIn(self.name, self.docker.live)
                    self.assertFalse([call for call in self.docker.calls if call[0] in {'helper', 'stop', 'start', 'rename', 'rm', 'create'}])
                finally:
                    if helper.is_symlink():
                        helper.unlink()
                        helper.write_text('helper\n')
                    helper.chmod(0o644)

    def test_stopped_previous_release_is_validated_without_executing_a_helper(self):
        before = self.old_container(running=False)
        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
        self.assertFalse([call for call in self.docker.calls if call[0] in {'helper', 'stop', 'start', 'rename', 'rm', 'create'}])

    def test_a_running_container_without_an_adapter_does_not_require_a_room_pin(self):
        self.old_container()
        self.agent.pop('primary_room_id')
        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
        self.assertEqual([call[1] for call in self.docker.calls if call[0] == 'helper'], ['stopped', 'stop', 'stopped'])

    def test_rollback_pass_returns_containers_to_the_previous_release(self):
        self.old_container(running=True)
        rebind.rebind_all(self.policy, self.new)
        old_policy = json.loads(json.dumps(self.policy).replace(NEW, OLD))
        receipt = rebind.rebind_all(old_policy, self.old, include_running=True)
        self.assertEqual(receipt['rebound'], [{'container': self.name, 'release': NEW}])
        sources = {row['Destination']: row['Source'] for row in self.docker.containers[self.name]['Mounts']}
        self.assertEqual(sources['/cauce/executor'], str(self.old / 'ops/cli'))
        self.assertEqual(sources[str(self.old / 'adapter')], str(self.old / 'adapter'))

    def test_setup_defers_running_legacy_release_without_login_reservations(self):
        before = self.old_container()
        (self.old / 'ops/cli/fleet_executor_image.py').unlink()
        receipt = rebind.rebind_all(self.policy, self.new, include_running=True)
        self.assertEqual(receipt['deferred'], [{'container': self.name, 'release': OLD,
                                              'reason': 'login_guard_unavailable'}])
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
        self.assertFalse([call for call in self.docker.calls if call[0] in {'helper', 'stop', 'rename', 'rm', 'create'}])


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

    def test_real_stop_keeps_name_labels_state_volume_run_state_and_previous_release(self):
        container.create_container(self.policy, self.agent, container.runtime_mounts(self.policy, self.agent, self.old, self.new))
        subprocess.run(['docker', 'start', self.name], capture_output=True, check=True)
        subprocess.run(['docker', 'exec', self.name, '/bin/sh', '-c', 'echo kept > /tmp/cauce-state/sentinel'], capture_output=True, check=True)
        before = self.inspect()
        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
        after = self.inspect()
        self.assertEqual(after['Id'], before['Id'])
        self.assertTrue(after['State']['Running'])
        self.assertEqual(after['Config']['Labels'], before['Config']['Labels'])
        self.assertEqual({row['Destination']: row['Source'] for row in after['Mounts'] if row['Type'] == 'bind'},
                         container.runtime_mounts(self.policy, self.agent, self.old, self.new))
        kept = subprocess.run(['docker', 'exec', self.name, '/bin/cat', '/tmp/cauce-state/sentinel'], capture_output=True, text=True, check=True)
        self.assertEqual(kept.stdout, 'kept\n')

if __name__ == '__main__':
    unittest.main()
