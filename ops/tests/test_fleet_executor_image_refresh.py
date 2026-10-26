from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import sys
import unittest
import uuid
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_container as container
import fleet_executor_hooks as hooks
import fleet_executor_image as image_refresh
import fleet_executor_rebind as rebind
import fleet_executor_runtime as runtime
import provider_login_container as login
from fleet_executor_policy import SafeFailure, extension_resources
from test_fleet_executor_rebind import IMAGE, FakeDocker, ReleaseFixture

PREVIOUS_IMAGE = 'sha256:' + 'e' * 64


def entrypoint(filename):
    source = pathlib.Path(__file__).resolve().parents[1] / 'cli' / filename
    spec = importlib.util.spec_from_file_location('fixture_' + source.stem.replace('-', '_'), source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RefreshDocker(FakeDocker):
    def __init__(self):
        super().__init__()
        self.unavailable = self.fail_create = self.fail_start = self.invalid_candidate = self.login_open = False

    def add(self, name, labels, mounts, *, running):
        row = super().add(name, labels, mounts, running=running)
        row['Id'] = hashlib.sha256(str(self.counter).encode()).hexdigest()
        return row

    def by_id(self, identity):
        return identity if identity in self.containers else super().by_id(identity)

    def __call__(self, *arguments):
        command = arguments[0]
        if command == 'image':
            self.calls.append(arguments)
            if self.unavailable:
                raise SafeFailure('approved image digest is unavailable')
            return json.dumps([{'Id': arguments[2]}]).encode()
        if command == 'stop':
            self.calls.append(arguments)
            self.containers[self.by_id(arguments[-1])]['State'].update(Running=False, Pid=0)
            return b''
        if command == 'rename':
            self.calls.append(arguments)
            old, new = self.by_id(arguments[1]), arguments[2]
            self.containers[new] = self.containers.pop(old)
            self.containers[new]['Name'] = '/' + new
            if old in self.live:
                self.live.remove(old)
                self.live.add(new)
            return b''
        if command == 'create' and self.fail_create:
            self.calls.append(arguments)
            raise SafeFailure('simulated image container creation failed')
        if command == 'start' and self.fail_start and self.containers[self.by_id(arguments[-1])]['Image'] == IMAGE:
            self.calls.append(arguments)
            raise SafeFailure('simulated image container start failed')
        if command == 'exec' and any('/run/cauce-provider-login' in value for value in arguments):
            self.calls.append(arguments)
            return b'busy\n' if self.login_open else b'clear\n'
        return super().__call__(*arguments)

    def create(self, arguments):
        result = super().create(arguments)
        row = self.containers[arguments[arguments.index('--name') + 1]]
        row['Image'] = arguments[-2]
        if '--memory' in arguments or '--cpus' in arguments:
            resources = {'type': 'resources'}
            for key in ('memory', 'cpus', 'pids'):
                flag = '--pids-limit' if key == 'pids' else '--' + key
                if flag in arguments:
                    value = arguments[arguments.index(flag) + 1]
                    resources[key] = int(value) if key == 'pids' else float(value) if key == 'cpus' else value
            memory, cpus, pids = extension_resources(resources)
            row['HostConfig'].update(Memory=memory, MemorySwap=memory * 2, NanoCpus=cpus, PidsLimit=pids)
        for mount in row['Mounts']:
            if mount['Type'] == 'bind' and mount['RW']:
                mount.update(Mode='rw,z', Propagation='rprivate')
        if self.invalid_candidate:
            row['HostConfig']['Privileged'] = True
        return result


class ImageRefreshTests(ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.docker = RefreshDocker()
        self.agent['primary_room_id'] = 'fixture'
        self.policy['roots'] = {'state': str(self.base.parent / 'executor-state')}
        pathlib.Path(self.policy['roots']['state']).mkdir(mode=0o700)
        for module in (container, rebind):
            patch = mock.patch.object(module, 'docker', self.docker)
            patch.start()
            self.addCleanup(patch.stop)
        commands = mock.patch.object(container, 'checked_command', lambda command, **_kwargs: self.docker(*command[1:]))
        commands.start()
        self.addCleanup(commands.stop)
        private_state = login.private_state
        state = mock.patch.object(login, 'private_state', lambda value, **_kwargs:
                                  private_state(str(self.base.parent / ('login-state' if value.startswith('/tmp/cauce-provider-runtime-')
                                                                       else 'login-controller')), create=True))
        state.start()
        self.addCleanup(state.stop)
        labels = container.expected_labels(self.policy, self.agent)
        self.docker.volumes[self.name + '-state'] = dict(labels)

    def old_container(self, *, running=True, root=None):
        row = self.docker.add(self.name, container.expected_labels(self.policy, self.agent),
                              self.mounts(root or self.old), running=running)
        row['Image'] = PREVIOUS_IMAGE
        self.docker.register_adapter(self.agent, row, self.policy['bundles']['codex']['digest'])
        return row

    def receipt(self):
        return pathlib.Path(self.policy['roots']['state']) / 'image-refresh' / (self.agent['runtime_key'] + '.json')

    def mutating_calls(self):
        return [call for call in self.docker.calls if call[0] in {'create', 'stop', 'start', 'rename', 'rm', 'helper'}
                or call[:2] in {('volume', 'create'), ('volume', 'rm')}]

    def assert_original(self, before, *, running=True):
        self.assertEqual(set(self.docker.containers), {self.name})
        after = self.docker.containers[self.name]
        self.assertEqual(after['Id'], before['Id'])
        self.assertEqual(after['Image'], PREVIOUS_IMAGE)
        self.assertEqual(after['Mounts'], before['Mounts'])
        self.assertEqual(after['State']['Running'], running)
        self.assertFalse(any(call[:2] == ('volume', 'rm') for call in self.docker.calls))

    def test_image_and_release_change_preserve_identity_volumes_and_running_state(self):
        before = copy.deepcopy(self.old_container())
        after = container.observe_container(self.policy, self.agent)
        self.assertNotEqual(after['Id'], before['Id'])
        self.assertEqual(after['Image'], IMAGE)
        self.assertTrue(after['State']['Running'])
        self.assertEqual(after['Config']['Labels'], before['Config']['Labels'])
        self.assertEqual(set(self.docker.containers), {self.name})
        self.assertEqual({row['Destination']: row['Source'] for row in after['Mounts'] if row['Type'] == 'bind'},
                         container.runtime_mounts(self.policy, self.agent))
        self.assertEqual(next(row['Name'] for row in after['Mounts'] if row['Type'] == 'volume'), self.name + '-state')
        receipt = json.loads(self.receipt().read_text())
        self.assertEqual(receipt['status'], 'succeeded')
        self.assertEqual(receipt['previous_id'], before['Id'])
        self.assertEqual(receipt['previous_image'], PREVIOUS_IMAGE)
        self.assertEqual(receipt['image'], IMAGE)
        for key in ('tenant_id', 'runtime_key', 'container_name'):
            self.assertEqual(receipt[key], self.agent[key])
        self.assertEqual(receipt['host_id'], self.policy['host_id'])
        self.assertFalse(any(call[:2] in {('volume', 'create'), ('volume', 'rm')} for call in self.docker.calls))

    def test_current_image_and_release_are_idempotent(self):
        self.old_container()
        first = container.observe_container(self.policy, self.agent)
        self.docker.calls.clear()
        second = container.observe_container(self.policy, self.agent)
        self.assertEqual(first['Id'], second['Id'])
        self.assertEqual(self.mutating_calls(), [])

    def test_running_legacy_release_rejects_implicit_refresh_without_mutation(self):
        before = self.old_container()
        (self.old / 'ops/cli/fleet_executor_image.py').unlink()
        with self.assertRaisesRegex(SafeFailure, 'explicit agent operation'):
            container.observe_container(self.policy, self.agent)
        with image_refresh.image_operation(str(uuid.uuid4())), \
                self.assertRaisesRegex(SafeFailure, 'explicit agent operation'):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_explicit_agent_operation_allows_refreshing_a_running_legacy_release(self):
        before = self.old_container()
        (self.old / 'ops/cli/fleet_executor_image.py').unlink()
        with image_refresh.image_operation(str(uuid.uuid4()), legacy_target=True):
            after = container.observe_container(self.policy, self.agent)
        self.assertEqual(after['Image'], IMAGE)
        self.assertNotEqual(after['Id'], before['Id'])
        self.assertTrue(after['State']['Running'])
        self.assertEqual(set(self.docker.containers), {self.name})
        self.assertFalse(image_refresh.LEGACY_REFRESH.get())
        self.assertFalse(any(call[:2] == ('volume', 'rm') for call in self.docker.calls))

    def test_stopped_container_is_refreshed_without_starting_it(self):
        before = self.old_container(running=False, root=self.new)
        after = container.observe_container(self.policy, self.agent)
        self.assertNotEqual(after['Id'], before['Id'])
        self.assertEqual(after['Image'], IMAGE)
        self.assertFalse(after['State']['Running'])
        self.assertFalse(any(call[0] in {'start', 'helper'} for call in self.docker.calls))

    def test_stop_preserves_the_previous_image_and_start_uses_the_new_image(self):
        for effect in ('stop', 'start'):
            with self.subTest(effect=effect):
                self.docker.containers.clear()
                self.docker.calls.clear()
                if self.receipt().exists():
                    self.receipt().unlink()
                before = self.old_container()
                if effect == 'stop':
                    with mock.patch.object(container, 'observe_container', side_effect=AssertionError('stop must not refresh')), \
                            mock.patch.object(container, 'approved_bundle', side_effect=AssertionError('stop must not approve the new bundle')), \
                            mock.patch.object(container, 'process_proof', side_effect=AssertionError('stop must not check the new SDK')):
                        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
                    self.assert_original(before)
                    self.assertFalse(self.receipt().exists())
                    self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename', 'rm', 'image'} for call in self.docker.calls))
                else:
                    with mock.patch.object(container, 'approved_bundle', return_value={}), \
                            mock.patch.object(container, 'process_proof', return_value={'running': True}):
                        self.assertEqual(container.start_container(self.policy, self.agent), {'running': True})
                    self.assertEqual(self.docker.containers[self.name]['Image'], IMAGE)
                    self.assertNotEqual(self.docker.containers[self.name]['Id'], before['Id'])

    def test_binding_read_rejects_an_old_image_without_recreation(self):
        before = self.old_container()
        with mock.patch.object(login, 'reserve_runtime') as reserve, self.assertRaises(SafeFailure):
            hooks.container_binding(self.policy, self.agent)
        reserve.assert_not_called()
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_explicit_login_preparation_refreshes_before_binding_and_reserves_the_new_container(self):
        executor = entrypoint('fleet-executor.py')
        before = self.old_container()
        volumes = copy.deepcopy(self.docker.volumes)
        self.docker.live.add(self.name)
        self.assertEqual(container.stop_container(self.policy, self.agent, login=True), {'stopped_verified': True})
        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
        self.assertNotIn(self.name, self.docker.live)
        self.assertFalse(any(call[0] in {'create', 'stop', 'rename', 'rm', 'start'} for call in self.docker.calls))
        context = {'operation_id': str(uuid.uuid4())}
        profile = {'path': '/tmp/cauce-state/provider-session'}

        def binding_for(policy, agent):
            self.assertEqual(self.docker.containers[self.name]['Image'], IMAGE)
            hooks.container_binding(policy, agent)
            return 'fixture-account', profile

        with mock.patch.object(executor, 'target_agent', return_value=self.agent), \
                mock.patch.object(executor, 'binding_for', side_effect=binding_for), \
                mock.patch.object(login, 'observe', return_value=True):
            receipt = executor.approved_binding(self.policy, context, prepare_login=True)
        identity = receipt['runtime_binding']
        self.assertNotEqual(identity['container_id'], before['Id'])
        self.assertEqual(identity['image_digest'], IMAGE)
        self.assertEqual(receipt['profile_binding'], profile)
        after = self.docker.containers[self.name]
        container.validate_container(self.policy, self.agent, after)
        self.assertEqual(self.docker.volumes, volumes)
        self.assertEqual({row['Destination']: row['Source'] for row in after['Mounts'] if row['Type'] == 'bind'},
                         container.runtime_mounts(self.policy, self.agent))
        with self.assertRaises(login.LoginFailure):
            login.assert_unreserved(identity['container_id'])
        self.assertIsNone(login.assert_unreserved(before['Id']))

    def test_stop_rejects_real_drift_before_stopping_or_replacing_the_old_container(self):
        drifts = {
            'owner': lambda row: row['Config']['Labels'].update({'cauce.fleet.owner': 'foreign'}),
            'host': lambda row: row['Config']['Labels'].update({'cauce.fleet.host': 'foreign'}),
            'tenant': lambda row: row['Config']['Labels'].update({'cauce.fleet.tenant': 'ForeignTeam'}),
            'capabilities': lambda row: row['HostConfig']['CapAdd'].append('SYS_ADMIN'),
            'network': lambda row: row['NetworkSettings']['Networks'].update({'foreign': {}}),
            'limits': lambda row: row['HostConfig'].update(Memory=64),
            'writable_helper': lambda row: row['Mounts'][1].update(RW=True),
            'foreign_mount': lambda row: row['Mounts'][2].update(Source='/foreign/ops/cli'),
            'mixed_releases': lambda row: row['Mounts'][2].update(Source=str(self.new / 'ops/cli')),
            'extra_mount': lambda row: row['Mounts'].append({'Type': 'bind', 'Source': '/foreign', 'Destination': '/foreign', 'RW': False}),
            'tagged_image': lambda row: row.update(Image='fixture:latest'),
            'missing_image': lambda row: row.pop('Image'),
        }
        for login_stop in (False, True):
            for name, drift in drifts.items():
                with self.subTest(drift=name, login=login_stop):
                    self.docker.containers.clear()
                    self.docker.calls.clear()
                    before = self.old_container()
                    before['HostConfig']['CapAdd'] = list(container.BASE_CAPABILITIES)
                    drift(before)
                    with self.assertRaises(SafeFailure):
                        container.stop_container(self.policy, self.agent, login=login_stop)
                    self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                    self.assertEqual(self.mutating_calls(), [])

    def test_paused_previous_container_is_preserved_without_claiming_a_verified_stop(self):
        for login_stop in (False, True):
            with self.subTest(login=login_stop):
                self.docker.containers.clear()
                self.docker.calls.clear()
                before = copy.deepcopy(self.old_container())
                self.docker.containers[self.name]['State']['Paused'] = True
                self.docker.live.add(self.name)
                with self.assertRaisesRegex(SafeFailure, 'paused'):
                    container.stop_container(self.policy, self.agent, login=login_stop)
                self.assert_original(before)
                self.assertTrue(self.docker.containers[self.name]['State']['Paused'])
                self.assertIn(self.name, self.docker.live)
                self.assertEqual(self.mutating_calls(), [])
                self.assertFalse(self.receipt().exists())

    def test_stop_accepts_the_existing_extension_shape_after_its_approval_is_revoked(self):
        source = self.base.parent / 'extension-mount'
        source.mkdir()
        self.agent['extensions'] = [{'type': 'mount', 'source': str(source), 'target': '/fixture-data', 'mode': 'rw'}]
        self.policy['extensions_allowed'] = {'types': ['mount'], 'mount_roots': [str(source)], 'networks': []}
        previous = image_refresh.previous_agent(self.agent, PREVIOUS_IMAGE)
        before = container.create_container(self.policy, previous, container.runtime_mounts(self.policy, self.agent, self.old, self.new))
        self.docker('start', before['Id'])
        self.docker.register_adapter(self.agent, self.docker.containers[self.name], self.policy['bundles']['codex']['digest'])
        self.docker.live.add(self.name)
        self.policy['extensions_allowed'] = {'types': [], 'mount_roots': [], 'networks': []}
        self.docker.calls.clear()
        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
        self.assert_original(before)
        self.assertNotIn(self.name, self.docker.live)
        self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename', 'rm'} for call in self.docker.calls))

    def test_purge_removes_the_validated_previous_image_without_refreshing_it(self):
        before = copy.deepcopy(self.old_container())
        self.docker.live.add(self.name)
        with mock.patch.object(container, 'observe_container', side_effect=AssertionError('purge must not refresh')), \
                mock.patch.object(container, 'approved_bundle', side_effect=AssertionError('purge must not approve a new bundle')):
            result = container.purge_container(self.policy, self.agent)
        self.assertEqual(result, {'removed': [{'type': 'container', 'name': self.name},
                                             {'type': 'volume', 'name': self.name + '-state'}]})
        self.assertEqual(self.docker.containers, {})
        self.assertEqual(self.docker.volumes, {})
        self.assertIn(('rm', '-f', before['Id']), self.docker.calls)
        self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename'} for call in self.docker.calls))

    def test_shared_stop_keeps_the_original_identity_and_mount_pins(self):
        before = self.docker.add(self.name, {}, [
            {'Type': 'bind', 'Source': '/fixture-state', 'Destination': '/tmp/cauce-state', 'RW': True},
            {'Type': 'bind', 'Source': str(container.HELPER.parent), 'Destination': '/cauce/lifecycle', 'RW': False},
            {'Type': 'bind', 'Source': str(container.EXECUTOR_SOURCE), 'Destination': '/cauce/executor', 'RW': False},
            {'Type': 'bind', 'Source': str(self.new / 'adapter'), 'Destination': str(self.new / 'adapter'), 'RW': False},
        ], running=False)
        self.policy['containers'].clear()
        self.policy['shared_containers'] = {self.name: {'container_id': before['Id'], 'image': IMAGE,
            'runtime_user': 'nobody', 'runtime_uid': 65534, 'runtime_gid': 65534, 'systemd_user': self.user,
            'home_directory': '/nonexistent', 'state_root': '/tmp/cauce-state', 'control_root': '/run/cauce-shared',
            'python': '/usr/local/bin/python3.12', 'mounts': copy.deepcopy(before['Mounts']),
            'aliases': {self.agent['runtime_key']: {key: self.agent[key] for key in ('tenant_id', 'alias', 'harness_id')}}}}
        original = copy.deepcopy(before)
        drifts = {
            'valid_stopped': lambda _row: None,
            'image': lambda row: row.update(Image=PREVIOUS_IMAGE),
            'container_id': lambda row: row.update(Id='f' * 64),
            'writable_helper': lambda row: row['Mounts'][1].update(RW=True),
            'mount_source': lambda row: row['Mounts'][2].update(Source=str(self.old / 'ops/cli')),
            'privileged': lambda row: row['HostConfig'].update(Privileged=True),
        }
        for name, drift in drifts.items():
            with self.subTest(drift=name):
                self.docker.containers[self.name] = copy.deepcopy(original)
                drift(self.docker.containers[self.name])
                self.docker.calls.clear()
                if name == 'valid_stopped':
                    self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
                else:
                    with self.assertRaises(SafeFailure):
                        container.stop_container(self.policy, self.agent)
                self.assertEqual(self.mutating_calls(), [])
        self.docker.containers.clear()
        self.docker.calls.clear()
        with self.assertRaisesRegex(SafeFailure, 'not observed'):
            container.stop_container(self.policy, self.agent)
        self.assertEqual(self.mutating_calls(), [])

    def test_binding_read_while_runtime_guard_is_active_does_not_prepare_or_reserve(self):
        executor = entrypoint('fleet-executor.py')
        before = self.old_container(root=self.new)
        before['Image'] = IMAGE
        with login.runtime_guard(before['Id']), \
                mock.patch.object(executor, 'target_agent', return_value=self.agent), \
                mock.patch.object(executor, 'binding_for', return_value=('fixture-account', {})), \
                mock.patch.object(container, 'observe_container', wraps=container.observe_container) as observe, \
                mock.patch.object(login, 'reserve_runtime') as reserve:
            receipt = executor.approved_binding(self.policy, {'operation_id': str(uuid.uuid4())})
        self.assertEqual(receipt['runtime_binding']['container_id'], before['Id'])
        observe.assert_not_called()
        reserve.assert_not_called()
        self.assertEqual(self.mutating_calls(), [])

    def test_profile_volume_is_preserved(self):
        self.policy['containers'][self.name]['profile_root'] = '/tmp/provider-profiles'
        self.agent['_placement']['profile_root'] = '/tmp/provider-profiles'
        labels = {**container.expected_labels(self.policy, self.agent), 'cauce.fleet.volume': 'provider-profiles'}
        self.docker.volumes[self.name + '-provider-profiles'] = labels
        before = self.old_container()
        before['Mounts'].append({'Type': 'volume', 'Name': self.name + '-provider-profiles', 'RW': True,
                                 'Source': '/var/lib/docker/volumes/profile', 'Destination': '/tmp/provider-profiles'})
        volumes = copy.deepcopy(self.docker.volumes)
        after = container.observe_container(self.policy, self.agent)
        self.assertEqual(self.docker.volumes, volumes)
        self.assertEqual({row['Name'] for row in after['Mounts'] if row['Type'] == 'volume'}, set(volumes))

    def test_provider_session_outside_persistent_roots_rejects_refresh(self):
        self.agent['primary_account_id'] = 'fixture-account'
        self.policy['profiles']['fixture-account'] = {'path': '/tmp/ephemeral-session'}
        before = self.old_container()
        with self.assertRaisesRegex(SafeFailure, 'outside persistent'):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_provider_session_inside_state_volume_allows_refresh(self):
        self.agent['primary_account_id'] = 'fixture-account'
        self.policy['profiles']['fixture-account'] = {'path': '/tmp/cauce-state/provider-session'}
        self.old_container()
        self.assertEqual(container.observe_container(self.policy, self.agent)['Image'], IMAGE)

    def test_mount_and_resource_extensions_remain_approved_after_refresh(self):
        source = self.base.parent / 'extension-mount'
        source.mkdir()
        self.agent['extensions'] = [{'type': 'mount', 'source': str(source), 'target': '/fixture-data', 'mode': 'rw'},
                                    {'type': 'resources', 'memory': '256m', 'cpus': 0.5, 'pids': 256}]
        self.policy['extensions_allowed'] = {'types': ['mount', 'resources'], 'mount_roots': [str(source)], 'networks': []}
        previous = image_refresh.previous_agent(self.agent, PREVIOUS_IMAGE)
        before = container.create_container(self.policy, previous, container.runtime_mounts(self.policy, self.agent, self.old, self.new))
        self.docker('start', before['Id'])
        after = container.observe_container(self.policy, self.agent)
        self.assertEqual(after['Config']['Labels'][container.EXTENSIONS_LABEL], container.extensions_label(self.agent))
        self.assertEqual(after['HostConfig'], before['HostConfig'])
        mount = next(row for row in after['Mounts'] if row['Destination'] == '/fixture-data')
        self.assertEqual((mount['Source'], mount['Mode'], mount['Propagation']), (str(source), 'rw,z', 'rprivate'))

    def grok_container(self, extensions=(), pids=None):
        self.policy['bundles']['grok'] = self.policy['bundles']['codex']
        self.policy['extensions_allowed'] = {'types': ['resources'], 'mount_roots': [], 'networks': []}
        self.agent.update(harness_id='grok', extensions=list(extensions))
        before = container.create_container(self.policy, self.agent)
        self.docker('start', before['Id'])
        before = self.docker.containers[self.name]
        self.docker.register_adapter(self.agent, before, self.policy['bundles']['grok']['digest'])
        if pids is not None:
            before['HostConfig']['PidsLimit'] = pids
        self.docker.calls.clear()
        return copy.deepcopy(before)

    def test_grok_defaults_to_more_processes_even_when_resources_set_only_memory_or_cpu(self):
        self.assertEqual(self.grok_container()['HostConfig']['PidsLimit'], 512)
        for row in ({'type': 'resources', 'memory': '256m'}, {'type': 'resources', 'cpus': 0.5}):
            with self.subTest(resources=row):
                self.docker.containers.clear()
                self.assertEqual(extension_resources(row, 512)[2], 512)
                self.assertEqual(self.grok_container([row])['HostConfig']['PidsLimit'], 512)
        self.docker.containers.clear()
        self.assertEqual(self.grok_container([{'type': 'resources', 'pids': 256}])['HostConfig']['PidsLimit'], 256)
        self.assertEqual(extension_resources({'type': 'resources', 'memory': '256m'})[2], 128)

    def test_grok_container_left_at_the_base_pids_limit_stays_usable_and_is_replaced_in_place(self):
        for extensions in ([], [{'type': 'resources', 'memory': '256m'}]):
            with self.subTest(extensions=extensions):
                self.docker.containers.clear()
                before = self.grok_container(extensions, pids=128)
                container.validate_container(self.policy, self.agent, self.docker.containers[self.name])
                self.docker.live.add(self.name)
                self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
                self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                self.assertFalse(any(call[0] in {'create', 'rename', 'rm'} for call in self.docker.calls))
                after = container.observe_container(self.policy, self.agent)
                self.assertNotEqual(after['Id'], before['Id'])
                self.assertEqual((after['HostConfig']['PidsLimit'], after['HostConfig']['Memory']),
                                 (512, before['HostConfig']['Memory']))
                self.assertEqual((after['Image'], after['Config']['Labels'], after['State']['Running']),
                                 (before['Image'], before['Config']['Labels'], True))
                self.assertEqual(after['Mounts'], before['Mounts'])
                self.assertEqual(set(self.docker.containers), {self.name})
                self.assertEqual(json.loads(self.receipt().read_text())['status'], 'succeeded')
                self.docker.calls.clear()
                self.assertEqual(container.observe_container(self.policy, self.agent)['Id'], after['Id'])
                self.assertEqual(self.mutating_calls(), [])

    def test_only_the_base_limit_of_an_implicit_harness_default_is_replaceable_drift(self):
        cases = {
            'grok_other_limit': ('grok', [], 256),
            'grok_unlimited': ('grok', [], None),
            'grok_explicit_pids': ('grok', [{'type': 'resources', 'pids': 256}], 128),
            'codex_above_base': ('codex', [], 512),
        }
        for name, (harness, extensions, limit) in cases.items():
            with self.subTest(drift=name):
                self.docker.containers.clear()
                before = self.grok_container(extensions)
                self.agent['harness_id'] = harness
                if harness == 'codex':
                    self.docker.containers.clear()
                    before = copy.deepcopy(container.create_container(self.policy, self.agent))
                self.docker.containers[self.name]['HostConfig']['PidsLimit'] = limit
                self.docker.calls.clear()
                with self.assertRaisesRegex(SafeFailure, 'resource limits differ'):
                    container.validate_container(self.policy, self.agent, self.docker.containers[self.name])
                with self.assertRaisesRegex(SafeFailure, 'resource limits differ'):
                    container.ensure_container(self.policy, self.agent)
                self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                self.assertEqual(self.mutating_calls(), [])

    def test_receipt_and_event_are_attached_to_the_operation(self):
        operation = str(uuid.uuid4())
        self.old_container()
        events = io.StringIO()
        with contextlib.redirect_stderr(events), image_refresh.image_operation(operation):
            container.observe_container(self.policy, self.agent)
        rows = [json.loads(row) for row in events.getvalue().splitlines()]
        self.assertEqual([row['status'] for row in rows], ['prepared', 'succeeded'])
        self.assertTrue(all(row['event'] == 'container_image_refresh' and row['operation_id'] == operation for row in rows))
        receipt = pathlib.Path(self.policy['roots']['state']) / 'operations' / operation / ('image-refresh-' + self.agent['runtime_key'] + '.json')
        self.assertEqual(json.loads(receipt.read_text()), json.loads(self.receipt().read_text()))
        self.assertEqual([json.loads(row) for row in receipt.with_suffix('.events.jsonl').read_text().splitlines()], rows)
        self.assertEqual([json.loads(row) for row in self.receipt().with_suffix('.events.jsonl').read_text().splitlines()], rows)

    def test_real_ownership_isolation_resources_extensions_and_mount_drift_are_rejected(self):
        drifts = {
            'owner': lambda row: row['Config']['Labels'].update({'cauce.fleet.owner': 'foreign'}),
            'host': lambda row: row['Config']['Labels'].update({'cauce.fleet.host': 'foreign'}),
            'tenant': lambda row: row['Config']['Labels'].update({'cauce.fleet.tenant': 'ForeignTeam'}),
            'isolation': lambda row: row['HostConfig'].update(Privileged=True),
            'limits': lambda row: row['HostConfig'].update(Memory=64),
            'extensions': lambda row: row['Config']['Labels'].update({container.EXTENSIONS_LABEL: '[]'}),
            'mount': lambda row: row['Mounts'][1].update(RW=True),
            'volume': lambda _row: self.docker.volumes[self.name + '-state'].update({'cauce.fleet.owner': 'foreign'}),
        }
        for name, drift in drifts.items():
            with self.subTest(drift=name):
                self.docker.containers.clear()
                self.docker.calls.clear()
                self.docker.volumes[self.name + '-state'] = container.expected_labels(self.policy, self.agent)
                before = self.old_container()
                drift(before)
                with self.assertRaises(SafeFailure):
                    container.observe_container(self.policy, self.agent)
                self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                self.assertEqual(self.mutating_calls(), [])

    def test_open_remote_login_rejects_refresh_before_stopping_the_adapter(self):
        before = self.old_container()
        self.docker.login_open = True
        with self.assertRaisesRegex(SafeFailure, 'login'):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_reserved_ui_login_rejects_refresh_before_the_remote_session_starts(self):
        before = self.old_container()
        operation = str(uuid.uuid4())
        with mock.patch.object(login, 'observe', return_value=True):
            login.reserve_runtime({'container_id': before['Id']}, operation)
        with self.assertRaisesRegex(SafeFailure, 'login'):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])
        login.release_reservation(operation)
        self.assertEqual(container.observe_container(self.policy, self.agent)['Image'], IMAGE)

    def test_runtime_guard_excludes_a_concurrent_refresh(self):
        before = self.old_container()
        with login.runtime_guard(before['Id']), self.assertRaisesRegex(SafeFailure, 'login'):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_stop_preserves_reserved_container_across_image_and_release_changes(self):
        for login_stop in (False, True):
            for image in (PREVIOUS_IMAGE, IMAGE):
                with self.subTest(image=image, login=login_stop):
                    self.docker.containers.clear()
                    self.docker.calls.clear()
                    before = self.old_container()
                    before['Image'] = image
                    operation = str(uuid.uuid4())
                    with mock.patch.object(login, 'observe', return_value=True):
                        login.reserve_runtime({'container_id': before['Id']}, operation)
                    self.docker.live.add(self.name)
                    self.assertEqual(container.stop_container(self.policy, self.agent, login=login_stop), {'stopped_verified': True})
                    self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                    self.assertEqual(self.docker.containers[self.name]['Image'], image)
                    self.assertNotIn(self.name, self.docker.live)
                    self.assertFalse(any(call[0] in {'create', 'stop', 'rename', 'rm', 'start'} for call in self.docker.calls))
                    with self.assertRaises(login.LoginFailure):
                        login.assert_unreserved(before['Id'])
                    login.release_reservation(operation)

    def test_cleanup_releases_a_login_reservation_when_the_helper_never_started(self):
        before = self.old_container()
        operation = str(uuid.uuid4())
        with mock.patch.object(login, 'observe', return_value=True):
            login.reserve_runtime({'container_id': before['Id']}, operation)
        with self.assertRaises(login.LoginFailure):
            login.assert_unreserved(before['Id'])
        self.assertEqual(login.cleanup_container(operation, str(self.base.parent / 'login-controller')),
                         {'stopped_verified': True})
        self.assertIsNone(login.assert_unreserved(before['Id']))
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_login_cli_cleanup_releases_reservation_after_bridge_metadata_was_removed(self):
        helper = entrypoint('provider-login.py')
        before = self.old_container()
        operation = str(uuid.uuid4())
        with mock.patch.object(login, 'observe', return_value=True):
            login.reserve_runtime({'container_id': before['Id']}, operation)
        state = self.base.parent / 'login-controller'
        state.mkdir(mode=0o700)
        root = helper.private_state(str(state))
        try:
            login.write_metadata(root, operation, {'schemaVersion': 1, 'operation_id': operation, 'backend': 'container'})
            login.remove_metadata(root, operation)
            self.assertIsNone(helper.read_metadata(root, operation))
        finally:
            os.close(root)
        output = io.StringIO()
        with mock.patch.object(sys, 'argv', ['provider-login.py', '--cleanup', operation, str(state)]), \
                contextlib.redirect_stdout(output):
            self.assertEqual(helper.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {'stopped_verified': True})
        self.assertIsNone(login.assert_unreserved(before['Id']))
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_absent_reservation_cleanup_does_not_create_state_or_remove_metadata(self):
        operation = str(uuid.uuid4())
        with mock.patch.object(login, 'private_state', side_effect=FileNotFoundError) as private_state, \
                mock.patch.object(login, 'remove_metadata') as remove:
            self.assertIsNone(login.release_reservation(operation))
        private_state.assert_called_once_with('/tmp/cauce-provider-runtime-' + str(os.geteuid()))
        remove.assert_not_called()

    def test_login_cli_cleanup_succeeds_without_creating_an_absent_reservation_directory(self):
        helper = entrypoint('provider-login.py')
        operation = str(uuid.uuid4())
        state = self.base.parent / 'login-controller'
        state.mkdir(mode=0o700)
        reservation = self.base.parent / 'absent-runtime-reservations'
        output = io.StringIO()
        with mock.patch.object(login, 'private_state', side_effect=lambda _value, **kwargs:
                               helper.private_state(str(reservation), **kwargs)) as reservation_open, \
                mock.patch.object(sys, 'argv', ['provider-login.py', '--cleanup', operation, str(state)]), \
                contextlib.redirect_stdout(output):
            self.assertEqual(helper.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), {'stopped_verified': True})
        reservation_open.assert_called_once_with('/tmp/cauce-provider-runtime-' + str(os.geteuid()))
        self.assertFalse(reservation.exists())
        self.assertEqual(self.mutating_calls(), [])

    def test_unavailable_image_does_not_mutate_the_existing_container(self):
        before = self.old_container()
        self.docker.unavailable = True
        with self.assertRaisesRegex(SafeFailure, 'unavailable'):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertEqual(self.mutating_calls(), [])

    def test_create_start_and_validation_failures_restore_the_previous_container(self):
        for failure in ('fail_create', 'fail_start', 'invalid_candidate'):
            with self.subTest(failure=failure):
                self.docker.containers.clear()
                self.docker.calls.clear()
                if self.receipt().exists():
                    self.receipt().unlink()
                before = copy.deepcopy(self.old_container())
                setattr(self.docker, failure, True)
                with self.assertRaises(SafeFailure):
                    container.observe_container(self.policy, self.agent)
                setattr(self.docker, failure, False)
                self.assert_original(before)
                self.assertEqual(json.loads(self.receipt().read_text())['status'], 'rolled_back')

    def test_failed_adapter_stop_keeps_the_previous_container(self):
        before = copy.deepcopy(self.old_container())
        self.docker.live.add(self.name)
        self.docker.stuck.add(self.name)
        with mock.patch.object(container, 'adapter_restart_state', return_value={'adapter_running': True}), \
                self.assertRaises(SafeFailure):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertFalse(any(call[0] in {'stop', 'rename', 'create', 'rm'} for call in self.docker.calls))

    def test_an_adapter_started_without_shared_tui_can_stop_after_the_policy_enables_it(self):
        self.agent['primary_room_id'] = 'fixture'
        self.policy['transport'] = {'gateway_url': 'https://gateway.example.test'}
        self.policy['bundles']['codex']['shared_tui'] = False
        before = self.old_container()
        previous = image_refresh.previous_agent(self.agent, PREVIOUS_IMAGE)
        identity = container.identity_for(previous, before)
        operation = str(uuid.uuid4())
        row = {'tenant': self.agent['tenant_id'], 'alias': self.agent['alias'], 'user': self.agent['runtime_user'],
               'runtimeStateDirectory': self.agent['state_directory'], 'enabled': True, 'room': 'fixture'}
        snapshot = {'schemaVersion': 1, 'fleet': {self.agent['runtime_key']: row}}
        with mock.patch.object(runtime, 'materialized_sdk_snapshot', return_value=({'generation': 'f' * 64}, snapshot)):
            environment = {**runtime.sdk_environment(self.policy, self.agent, False, operation),
                'CAUCE_BOOTSTRAP': '0', 'CAUCE_FLEET_OPERATION_ID': operation,
                'CAUCE_ALIAS': self.agent['alias'], 'CAUCE_RUNTIME_KEY': self.agent['runtime_key'],
                'CAUCE_TENANT_ID': self.agent['tenant_id'], 'CAUCE_TENANT': self.agent['tenant_id'],
                'CAUCE_STATE_DIR': self.agent['state_directory'], 'CAUCE_CONTROL_DIR': str(identity['control']),
                'CAUCE_CONTAINER_ID': identity['container_id'], 'CAUCE_CONTAINER_GENERATION': identity['generation']}
            original_environment = dict(environment)
            metadata = {'alias': self.agent['runtime_key'], 'wireAlias': self.agent['alias'], 'tenantId': self.agent['tenant_id'],
                'stateDirectory': self.agent['state_directory'], 'controlDirectory': str(identity['control']),
                'containerId': identity['container_id'], 'containerGeneration': identity['generation'],
                'runtimeUid': 65534, 'runtimeGid': 65534, 'phase': 'running', 'pid': 42,
                'bundleDigest': self.policy['bundles']['codex']['digest']}

            def read_runtime(*arguments):
                if '/bin/cat' in arguments:
                    if arguments[-1] == '/proc/42/environ':
                        return b'\0'.join((key + '=' + value).encode() for key, value in environment.items())
                    self.assertEqual(arguments[-1], str(identity['control'] / 'cauce-v3-adapter.json'))
                    return json.dumps(metadata).encode()
                return self.docker(*arguments)

            def observe_runtime(command, **options):
                if options.get('input_data') is not None and command[-1].startswith('{'):
                    expected = json.loads(command[-1])
                    self.assertTrue(all(metadata.get(key) == value for key, value in expected.items()))
                    return json.dumps({'metadata': metadata, 'environment': environment}).encode()
                return read_runtime(*command[1:])

            with mock.patch.object(container, 'docker', side_effect=read_runtime), \
                    mock.patch.object(container, 'checked_command', side_effect=observe_runtime):
                self.docker.live.add(self.name)
                self.assertIn('runtime_digest', container.process_proof(self.policy, previous, identity,
                    self.policy['bundles']['codex'], bootstrap=False, operation_id=operation))
                self.policy['bundles']['codex']['shared_tui'] = True
                self.assertNotIn('CAUCE_SHARED_SESSION', environment)
                with self.assertRaisesRegex(runtime.NamespaceMismatch, 'SDK identity or transport'):
                    container.process_proof(self.policy, previous, identity,
                        self.policy['bundles']['codex'], bootstrap=False, operation_id=operation)
                for key, value in (('CAUCE_ROOM', 'foreign-room'), ('CAUCE_TENANT_ID', 'ForeignCompany'),
                                   ('CAUCE_RUNTIME_KEY', 'foreign-runtime'), ('CAUCE_ALIAS', 'foreign-alias'),
                                   ('CAUCE_STATE_DIR', '/foreign-state'), ('CAUCE_CONTROL_DIR', '/foreign-control'),
                                   ('CAUCE_CONTAINER_ID', 'f' * 64), ('CAUCE_CONTAINER_GENERATION', 'f' * 64),
                                   ('CAUCE_BOOTSTRAP', '2'),
                                   ('CAUCE_FLEET_OPERATION_ID', 'foreign-operation')):
                    with self.subTest(key=key):
                        environment[key] = value
                        self.docker.calls.clear()
                        with self.assertRaises(SafeFailure):
                            container.adapter_restart_state(self.policy, self.agent, before)
                        with self.assertRaises(SafeFailure):
                            container.stop_container(self.policy, self.agent)
                        self.assertIn(self.name, self.docker.live)
                        self.assertFalse(any(call[:2] == ('helper', 'stop') for call in self.docker.calls))
                        environment.clear()
                        environment.update(original_environment)
                restart = container.adapter_restart_state(self.policy, self.agent, before)
                self.assertTrue(restart['adapter_running'])
                self.assertFalse(restart['adapter_bootstrap'])
                self.assertFalse(container.adapter_restart_state(self.policy, self.agent, before,
                    check_sdk_policy=True)['adapter_sdk_current'])
                self.assertEqual(restart['adapter_operation_id'], operation)
                self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
                self.assertNotIn(self.name, self.docker.live)
                with self.assertRaises(runtime.NamespaceMismatch):
                    runtime.namespace_proof({**original_environment, 'CAUCE_BOOTSTRAP': '1'}, False, operation)
                with self.assertRaisesRegex(runtime.NamespaceMismatch, 'SDK identity or transport'):
                    runtime.sdk_environment_proof(self.policy, self.agent, original_environment, False, operation)
        self.assert_original(before)
        self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename', 'rm'} for call in self.docker.calls))

    def test_restore_without_a_materialized_sdk_identity_only_stops_the_original_adapter(self):
        for running in (False, True):
            with self.subTest(running=running):
                self.docker.containers.clear()
                self.docker.calls.clear()
                before = copy.deepcopy(self.old_container(running=running))
                if running:
                    self.docker.live.add(self.name)
                with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=True), \
                        mock.patch.object(container, 'approved_bundle', wraps=container.approved_bundle) as approved, \
                        mock.patch.object(image_refresh, 'refresh_image', side_effect=AssertionError('absent SDK must not refresh')), \
                        mock.patch.object(container, 'adapter_restart_state', side_effect=AssertionError('absent SDK must not restart')), \
                        mock.patch.object(container, 'start_existing_adapter', side_effect=AssertionError('absent SDK must not start')):
                    result = container.restore_existing_adapter(self.policy, self.agent, bootstrap=False)
                self.assertEqual(result, {'stopped_verified': True})
                approved.assert_called_once()
                self.assert_original(before, running=running)
                self.assertNotIn(self.name, self.docker.live)
                self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename', 'rm'} for call in self.docker.calls))
                self.assertFalse(self.receipt().exists())

    def test_sdk_absence_does_not_bypass_bundle_volume_or_observed_runtime_guards(self):
        bundle_file = self.new / 'adapter/worker.py'
        bundle_bytes = bundle_file.read_bytes()
        for drift in ('bundle', 'owner', 'volume', 'mount'):
            with self.subTest(drift=drift):
                self.docker.containers.clear()
                self.docker.calls.clear()
                self.docker.volumes[self.name + '-state'] = container.expected_labels(self.policy, self.agent)
                before = self.old_container()
                if drift == 'bundle':
                    bundle_file.write_bytes(bundle_bytes + b'changed\n')
                elif drift == 'owner':
                    before['Config']['Labels']['cauce.fleet.owner'] = 'foreign'
                elif drift == 'volume':
                    self.docker.volumes[self.name + '-state']['cauce.fleet.owner'] = 'foreign'
                else:
                    before['Mounts'][1]['RW'] = True
                try:
                    with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=True), \
                            self.assertRaises(SafeFailure):
                        container.restore_existing_adapter(self.policy, self.agent, bootstrap=False)
                    self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                    self.assertEqual(self.mutating_calls(), [])
                finally:
                    bundle_file.write_bytes(bundle_bytes)

    def test_normal_sdk_presence_and_bootstrap_restoration_keep_the_approved_refresh_path(self):
        for bootstrap in (False, True):
            with self.subTest(bootstrap=bootstrap):
                self.docker.containers.clear()
                self.docker.calls.clear()
                self.old_container()
                with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=bootstrap) as absent, \
                        mock.patch.object(image_refresh, 'refresh_image', side_effect=SafeFailure('approved refresh still required')) as refresh, \
                        self.assertRaisesRegex(SafeFailure, 'approved refresh still required'):
                    container.restore_existing_adapter(self.policy, self.agent, bootstrap=bootstrap)
                refresh.assert_called_once()
                if bootstrap:
                    absent.assert_not_called()
                else:
                    absent.assert_called_once()
                self.assertEqual(self.mutating_calls(), [])

    def test_refresh_without_a_materialized_normal_sdk_identity_preserves_the_original(self):
        for operation in (None, str(uuid.uuid4())):
            with self.subTest(operation=operation):
                self.docker.containers.clear()
                self.docker.calls.clear()
                before = copy.deepcopy(self.old_container())
                self.docker.live.add(self.name)
                with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=True), \
                        mock.patch.object(container, 'start_existing_adapter', side_effect=AssertionError('absent SDK must not start')):
                    after = image_refresh.refresh_image(self.policy, self.agent, before,
                        restore_adapter={'bootstrap': False, 'operation_id': operation})
                self.assertEqual(after['_adapter_restored'], {'stopped_verified': True})
                self.assertEqual(after['Id'], before['Id'])
                self.assert_original(before)
                self.assertNotIn(self.name, self.docker.live)
                self.assertFalse(any(call[0] in {'create', 'stop', 'start', 'rename', 'rm'} for call in self.docker.calls))
                self.assertFalse(self.receipt().exists())

    def test_refresh_without_sdk_identity_keeps_volume_and_login_guards(self):
        for drift in ('volume', 'login'):
            with self.subTest(drift=drift):
                self.docker.containers.clear()
                self.docker.calls.clear()
                self.docker.volumes[self.name + '-state'] = container.expected_labels(self.policy, self.agent)
                self.docker.login_open = drift == 'login'
                before = copy.deepcopy(self.old_container())
                if drift == 'volume':
                    self.docker.volumes[self.name + '-state']['cauce.fleet.owner'] = 'foreign'
                with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=True), \
                        self.assertRaises(SafeFailure):
                    image_refresh.refresh_image(self.policy, self.agent, before,
                        restore_adapter={'bootstrap': False, 'operation_id': None})
                self.assert_original(before)
                self.assertEqual(self.mutating_calls(), [])

    def test_failure_details_redact_credentials_before_persisting_or_reporting(self):
        details = image_refresh.failure_details(SafeFailure('denied password=fixture-pass Bearer fixture-bearer '
            '{"token":"fixture-token"} https://fixture:fixture-url@example.test/path'))
        self.assertTrue(details.startswith('SafeFailure: denied'))
        for secret in ('fixture-pass', 'fixture-bearer', 'fixture-token', 'fixture-url'):
            self.assertNotIn(secret, details)
        timeout = image_refresh.failure_details(subprocess.TimeoutExpired(['env', 'secret=fixture-timeout'], 40))
        self.assertEqual(timeout, 'TimeoutExpired: runtime command exceeded 40s')

    def prepare_interruption(self, *, candidate=False, status='prepared'):
        before = copy.deepcopy(self.old_container())
        self.docker('stop', before['Id'])
        self.docker('rename', before['Id'], self.name + '-image-rollback')
        if candidate:
            container.create_container(self.policy, self.agent)
        receipt = {key: self.agent[key] for key in ('tenant_id', 'runtime_key', 'container_name')}
        receipt.update(host_id=self.policy['host_id'], previous_id=before['Id'], previous_image=PREVIOUS_IMAGE,
                       image=IMAGE, was_running=True, status=status)
        self.receipt().parent.mkdir(mode=0o700, exist_ok=True)
        self.receipt().write_text(json.dumps(receipt))
        self.receipt().chmod(0o600)
        return before

    def test_recovery_replays_prepared_receipt_with_or_without_a_candidate(self):
        for candidate in (False, True):
            for preserve in (False, True):
                with self.subTest(candidate=candidate, preserve=preserve):
                    self.docker.containers.clear()
                    before = self.prepare_interruption(candidate=candidate)
                    self.docker.calls.clear()
                    image_refresh.recover_image(self.policy, self.agent, preserve_only=preserve)
                    if preserve:
                        self.assertEqual(set(self.docker.containers), {self.name})
                        self.assertEqual(self.docker.containers[self.name]['Id'], before['Id'])
                        self.assertFalse(self.docker.containers[self.name]['State']['Running'])
                        self.assertFalse(any(call[0] in {'start', 'helper'} for call in self.docker.calls))
                    else:
                        self.assert_original(before)
                    self.assertEqual(json.loads(self.receipt().read_text())['status'], 'preserved' if preserve else 'rolled_back')
                    self.docker.calls.clear()
                    image_refresh.recover_image(self.policy, self.agent, preserve_only=preserve)
                    self.assertEqual(self.mutating_calls(), [])

    def test_missing_normal_sdk_recovery_keeps_prepared_or_preserved_original_stopped(self):
        for status in ('prepared', 'preserved'):
            for candidate in (False, True):
                with self.subTest(status=status, candidate=candidate):
                    self.docker.containers.clear()
                    before = self.prepare_interruption(candidate=candidate, status=status)
                    receipt = json.loads(self.receipt().read_text())
                    receipt.update(restore_adapter={'bootstrap': False, 'operation_id': str(uuid.uuid4())},
                                   adapter_running=True, adapter_bootstrap=False)
                    self.receipt().write_text(json.dumps(receipt))
                    self.docker.calls.clear()
                    with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=True), \
                            mock.patch.object(container, 'start_existing_adapter', side_effect=AssertionError('absent SDK must not start')):
                        image_refresh.recover_image(self.policy, self.agent)
                    self.assert_original(before, running=False)
                    self.assertEqual(json.loads(self.receipt().read_text())['status'], 'preserved')
                    self.assertFalse(any(call[0] in {'create', 'start', 'helper'} for call in self.docker.calls))
                    self.docker.calls.clear()
                    with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=True):
                        image_refresh.recover_image(self.policy, self.agent)
                    self.assertEqual(self.mutating_calls(), [])

    def test_missing_sdk_recovery_rejects_foreign_volume_before_removing_or_renaming_any_container(self):
        for status in ('prepared', 'preserved'):
            for candidate in (False, True):
                with self.subTest(status=status, candidate=candidate):
                    self.docker.containers.clear()
                    self.docker.volumes[self.name + '-state'] = container.expected_labels(self.policy, self.agent)
                    self.prepare_interruption(candidate=candidate, status=status)
                    receipt = json.loads(self.receipt().read_text())
                    receipt['restore_adapter'] = {'bootstrap': False, 'operation_id': None}
                    self.receipt().write_text(json.dumps(receipt))
                    self.docker.volumes[self.name + '-state']['cauce.fleet.owner'] = 'foreign'
                    before = copy.deepcopy(self.docker.containers)
                    self.docker.calls.clear()
                    with mock.patch.object(runtime, 'materialized_sdk_identity_absent', return_value=True), \
                            self.assertRaisesRegex(SafeFailure, 'another owner'):
                        image_refresh.recover_image(self.policy, self.agent)
                    self.assertEqual(self.docker.containers, before)
                    self.assertEqual(self.mutating_calls(), [])
                    self.assertEqual(json.loads(self.receipt().read_text()), receipt)

    def test_recovery_refuses_a_foreign_candidate(self):
        for preserve in (False, True):
            with self.subTest(preserve=preserve):
                self.docker.containers.clear()
                self.prepare_interruption(candidate=True)
                candidate = self.docker.containers[self.name]
                candidate['Config']['Labels']['cauce.fleet.owner'] = 'foreign'
                self.docker.calls.clear()
                with self.assertRaises(SafeFailure):
                    image_refresh.recover_image(self.policy, self.agent, preserve_only=preserve)
                self.assertEqual(self.docker.containers[self.name]['Id'], candidate['Id'])
                self.assertEqual(self.mutating_calls(), [])

    def test_completed_receipt_only_removes_the_validated_previous_backup(self):
        self.prepare_interruption(candidate=True, status='succeeded')
        candidate = self.docker.containers[self.name]
        image_refresh.recover_image(self.policy, self.agent)
        self.assertEqual(set(self.docker.containers), {self.name})
        self.assertEqual(self.docker.containers[self.name]['Id'], candidate['Id'])
        self.assertFalse(any(call[:2] == ('volume', 'rm') for call in self.docker.calls))

    def test_completed_receipt_with_drifted_candidate_preserves_backup(self):
        self.prepare_interruption(candidate=True, status='succeeded')
        self.docker.containers[self.name]['HostConfig']['Privileged'] = True
        self.docker.calls.clear()
        with self.assertRaises(SafeFailure):
            image_refresh.recover_image(self.policy, self.agent)
        self.assertEqual(set(self.docker.containers), {self.name, self.name + '-image-rollback'})
        self.assertEqual(self.mutating_calls(), [])


if __name__ == '__main__':
    unittest.main()
