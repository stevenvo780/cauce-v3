from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
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
        self.policy['roots'] = {'state': str(self.base.parent / 'executor-state')}
        pathlib.Path(self.policy['roots']['state']).mkdir(mode=0o700)
        for module in (container, rebind):
            patch = mock.patch.object(module, 'docker', self.docker)
            patch.start()
            self.addCleanup(patch.stop)
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

    def test_stop_and_start_use_the_new_image(self):
        for effect in ('stop', 'start'):
            with self.subTest(effect=effect):
                self.docker.containers.clear()
                if self.receipt().exists():
                    self.receipt().unlink()
                before = self.old_container()
                with mock.patch.object(container, 'approved_bundle', return_value={}), \
                        mock.patch.object(container, 'process_proof', return_value={'running': True}):
                    if effect == 'stop':
                        self.assertEqual(container.stop_container(self.policy, self.agent), {'stopped_verified': True})
                    else:
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
        with self.assertRaises(login.LoginFailure):
            login.assert_unreserved(identity['container_id'])
        self.assertIsNone(login.assert_unreserved(before['Id']))

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

    def test_login_stop_preserves_reserved_container_across_image_and_release_changes(self):
        for image in (PREVIOUS_IMAGE, IMAGE):
            with self.subTest(image=image):
                self.docker.containers.clear()
                self.docker.calls.clear()
                before = self.old_container()
                before['Image'] = image
                operation = str(uuid.uuid4())
                with mock.patch.object(login, 'observe', return_value=True):
                    login.reserve_runtime({'container_id': before['Id']}, operation)
                self.docker.live.add(self.name)
                self.assertEqual(container.stop_container(self.policy, self.agent, login=True), {'stopped_verified': True})
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
        with self.assertRaises(SafeFailure):
            container.observe_container(self.policy, self.agent)
        self.assert_original(before)
        self.assertFalse(any(call[0] in {'stop', 'rename', 'create', 'rm'} for call in self.docker.calls))

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
            with self.subTest(candidate=candidate):
                self.docker.containers.clear()
                before = self.prepare_interruption(candidate=candidate)
                image_refresh.recover_image(self.policy, self.agent)
                self.assert_original(before)
                self.assertEqual(json.loads(self.receipt().read_text())['status'], 'rolled_back')
                self.docker.calls.clear()
                image_refresh.recover_image(self.policy, self.agent)
                self.assertEqual(self.mutating_calls(), [])

    def test_recovery_refuses_a_foreign_candidate(self):
        self.prepare_interruption(candidate=True)
        candidate = self.docker.containers[self.name]
        candidate['Config']['Labels']['cauce.fleet.owner'] = 'foreign'
        self.docker.calls.clear()
        with self.assertRaises(SafeFailure):
            image_refresh.recover_image(self.policy, self.agent)
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
