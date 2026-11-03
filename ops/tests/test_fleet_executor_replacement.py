from __future__ import annotations

import contextlib
import copy
import hashlib
import json
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'container-runtime'))
import fleet_executor_container as container
import fleet_executor_image as image
import fleet_executor_replacement as replacement
from fleet_executor_policy import SafeFailure


class ReplacementRetirementTest(unittest.TestCase):
    def setUp(self):
        self.policy = {'host_id': 'host', 'executor_user': 'executor'}
        self.agent = {'tenant_id': 'Tenant', 'alias': 'agent', 'runtime_key': 'physical', 'host_id': 'host',
                      'container_name': 'old-agent', 'runtime_mode': 'container', '_placement': {}}
        self.observed = {'Id': 'a' * 64, 'Created': 'created', 'Name': '/old-agent', 'Image': 'sha256:' + 'b' * 64,
                         'Config': {'Labels': {'owner': 'executor'}}, 'HostConfig': {}, 'Mounts': [],
                         'State': {'Running': True, 'Pid': 42, 'StartedAt': 'started'}}
        self.volumes = [{'name': 'old-agent-state', 'created_at': 'created', 'identity_sha256': 'c' * 64}]
        self.calls = []
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(mock.patch.object(replacement, 'approve_agent', side_effect=lambda policy, agent: agent))
        self.stack.enter_context(mock.patch.object(container, 'inspect_container', side_effect=lambda name: self.observed))
        self.stack.enter_context(mock.patch.object(container, 'validate_container'))
        self.stack.enter_context(mock.patch.object(replacement, 'volume_pins', side_effect=lambda *args: copy.deepcopy(self.volumes)))
        self.stack.enter_context(mock.patch.object(container, 'docker', side_effect=self.docker))
        self.stack.enter_context(mock.patch.object(image, 'image_guard', side_effect=lambda identity: contextlib.nullcontext()))
        self.login_check = self.stack.enter_context(mock.patch.object(image, 'assert_no_login'))

    def docker(self, *arguments):
        self.calls.append(arguments)
        if arguments[0] == 'ps':
            return b'' if self.observed is None else self.observed['Id'].encode()
        if arguments[0] == 'stop':
            self.observed['State'].update(Running=False, Pid=0)
        elif arguments[0] == 'rm':
            self.assertFalse(self.observed['State']['Running'])
            self.observed = None
        else:
            self.fail('unexpected Docker mutation: ' + json.dumps(arguments))
        return b''

    def authorized(self, *, patched=True):
        receipt = replacement.capture_previous(self.policy, self.agent)
        receipt['replacement'] = {'agent': {'container_name': 'new-agent'}, 'pin': {'container_id': 'd' * 64, 'started_at': 'new-started'},
                                  'normal_verified': True, 'operation_id': '00000000-0000-4000-8000-000000000001',
                                  'runtime_digest': 'f' * 64}
        receipt['confirmed_operation'] = {'operation_id': receipt['replacement']['operation_id'], 'status': 'succeeded',
            'runtime_digest': receipt['replacement']['runtime_digest'], 'container_id': 'd' * 64, 'started_at': 'new-started'}
        if patched:
            self.stack.enter_context(mock.patch.object(replacement, 'authorize_replacement', side_effect=lambda policy, agent, receipt, proof: copy.deepcopy(receipt)))
        return receipt

    def test_preflight_is_read_only_and_preserves_persistent_volumes(self):
        receipt = container.retire_replaced_container(self.policy, self.agent)
        self.assertEqual(receipt['retention'], replacement.RETENTION)
        self.assertEqual(receipt['volumes'], self.volumes)
        self.assertEqual(self.calls, [])

    def test_shared_container_is_never_retired(self):
        self.agent['_placement']['ownership'] = 'shared'
        with self.assertRaisesRegex(SafeFailure, 'dedicated'):
            replacement.capture_previous(self.policy, self.agent)
        self.assertEqual(self.calls, [])

    def test_missing_normal_roundtrip_cannot_remove_original(self):
        receipt = replacement.capture_previous(self.policy, self.agent)
        with self.assertRaisesRegex(SafeFailure, 'normal runtime verification'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])

    def test_replaced_name_with_foreign_id_is_not_touched(self):
        receipt = self.authorized()
        self.observed['Id'] = 'e' * 64
        with self.assertRaisesRegex(SafeFailure, 'identity changed'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])

    def test_changed_labels_mounts_or_generation_are_not_touched(self):
        for field, value in [('Config', {'Labels': {'owner': 'other'}}), ('Mounts', [{'Source': '/foreign'}]),
                             ('State', {'Running': True, 'Pid': 42, 'StartedAt': 'restarted'})]:
            with self.subTest(field=field):
                original = copy.deepcopy(self.observed)
                receipt = self.authorized()
                self.observed[field] = value
                with self.assertRaisesRegex(SafeFailure, 'identity changed'):
                    container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
                self.assertEqual(self.calls, [])
                self.observed = original

    def test_changed_volume_identity_is_not_touched(self):
        receipt = self.authorized()
        self.volumes[0]['created_at'] = 'replaced'
        with self.assertRaisesRegex(SafeFailure, 'volume identity changed'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])

    def test_unconfirmed_or_wrong_operation_cannot_remove_original(self):
        receipt = self.authorized()
        for commit in (None, {**receipt['confirmed_operation'], 'status': 'cancelling'},
                       {**receipt['confirmed_operation'], 'container_id': 'e' * 64}):
            with self.subTest(commit=commit):
                receipt['confirmed_operation'] = commit
                with self.assertRaisesRegex(SafeFailure, 'confirmed operation'):
                    container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
                self.assertEqual(self.calls, [])

    def test_pending_login_keeps_original_and_volumes(self):
        receipt = self.authorized()
        self.login_check.side_effect = SafeFailure('provider login session is open or unverified')
        with self.assertRaisesRegex(SafeFailure, 'login session'):
            container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])
        self.assertTrue(self.observed['State']['Running'])

    def test_stop_remove_uses_pinned_id_without_deleting_volumes_and_retries(self):
        receipt = self.authorized()
        completed = container.retire_replaced_container(self.policy, self.agent, receipt, apply=True)
        mutations = [call for call in self.calls if call[0] != 'ps']
        self.assertEqual(mutations, [('stop', '--time', '15', 'a' * 64), ('rm', 'a' * 64)])
        self.assertEqual(completed['volumes'], self.volumes)
        self.assertIs(completed['complete'], True)
        self.assertEqual(container.retire_replaced_container(self.policy, self.agent, completed, apply=True), completed)

    def committed_executor(self, *, patched=True):
        receipt = self.authorized(patched=patched)
        body = {'version': 1, 'decision': 'configuration_committed',
                'operation_id': receipt['replacement']['operation_id'], 'company_id': 'company', 'host_id': 'host',
                'snapshot_sha256': '1' * 64, 'original_container_id': 'a' * 64, 'replacement_container_id': 'd' * 64,
                'replacement_started_at': 'new-started', 'runtime_digest': 'f' * 64,
                'request_sha256': '2' * 64, 'target_slice_sha256': '3' * 64, 'applied_revision': 4}
        encoded = json.dumps(body, separators=(',', ':'))
        commit = {**body, 'commit_canonical': encoded, 'commit_sha256': hashlib.sha256(encoded.encode()).hexdigest()}
        desired = {**self.agent, 'container_name': 'new-agent'}
        return SimpleNamespace(policy=self.policy, agent=lambda: desired, save=mock.Mock(),
            context={'operation_id': body['operation_id'], 'request': {'kind': 'update'},
                     'previous_agents': [self.agent], 'snapshot': {'replacement_commit': commit}},
            journal={'replacement_retirement': receipt, 'replacement_compensation': {'snapshot_sha256': body['snapshot_sha256']},
                     'admission_normal_proof': {**{key: True for key in replacement.REQUIRED_PROOF},
                         'operation_id': body['operation_id'], 'runtime_digest': 'f' * 64}})

    def test_committed_configuration_retires_pinned_original_before_terminal_success(self):
        executor = self.committed_executor()
        evidence = replacement.retire_committed(executor)
        self.assertIsNone(self.observed)
        saved = executor.journal['replacement_retirement_commit']
        self.assertEqual(saved['receipt']['confirmed_operation']['status'], 'configuration_committed')
        self.assertEqual(saved['phase'], 'complete')
        self.assertEqual(saved['receipt']['volumes'], self.volumes)
        self.assertEqual(evidence['replacement_retired']['commit_sha256'], saved['commit_sha256'])
        self.assertEqual([call for call in self.calls if call[0] != 'ps'],
                         [('stop', '--time', '15', 'a' * 64), ('rm', 'a' * 64)])

    def test_missing_or_changed_commit_never_touches_original(self):
        for change in ('missing', 'body', 'literal', 'previous_commit'):
            with self.subTest(change=change):
                executor = self.committed_executor()
                commit = executor.context['snapshot']['replacement_commit']
                if change == 'missing':
                    executor.context['snapshot'].clear()
                elif change == 'body':
                    commit['original_container_id'] = 'e' * 64
                elif change == 'literal':
                    commit['commit_canonical'] += ' '
                else:
                    executor.journal['replacement_retirement_commit'] = {'commit_sha256': 'e' * 64}
                with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
                    replacement.retire_committed(executor)
                self.assertEqual(self.calls, [])
                self.assertTrue(self.observed['State']['Running'])

    def test_login_hold_keeps_committed_operation_pending_with_original_and_volumes(self):
        executor = self.committed_executor()
        self.login_check.side_effect = SafeFailure('provider login session is open or unverified')
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
            replacement.retire_committed(executor)
        self.assertEqual(executor.journal['replacement_retirement_commit']['phase'], 'retiring')
        self.assertTrue(self.observed['State']['Running'])
        self.assertEqual(self.calls, [])

    def test_crash_after_removal_replays_without_repeating_stop_or_remove(self):
        executor = self.committed_executor()
        persisted = []

        def save():
            if persisted:
                raise OSError
            persisted.append(copy.deepcopy(executor.journal))

        executor.save.side_effect = save
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
            replacement.retire_committed(executor)
        self.assertIsNone(self.observed)
        self.assertEqual(persisted[0]['replacement_retirement_commit']['phase'], 'retiring')
        executor.journal = persisted[0]
        executor.save = mock.Mock()
        evidence = replacement.retire_committed(executor)
        self.assertIs(evidence['replacement_retired']['volumes_retained'], True)
        self.assertEqual([call for call in self.calls if call[0] != 'ps'],
                         [('stop', '--time', '15', 'a' * 64), ('rm', 'a' * 64)])

    def test_pending_commit_cannot_be_used_without_its_bound_envelope(self):
        executor = self.committed_executor()
        receipt = executor.journal['replacement_retirement']
        receipt['confirmed_operation']['status'] = 'configuration_committed'
        with self.assertRaisesRegex(SafeFailure, 'confirmed operation'):
            replacement.retire_replaced(self.policy, self.agent, receipt, apply=True)
        self.assertEqual(self.calls, [])

    def relaunchable(self, adapter: dict):
        """The committed replacement checked by the real authorization: only Docker and the adapter process are faked."""
        operation = '00000000-0000-4000-8000-000000000001'
        self.replacement_observed = {**copy.deepcopy(self.observed), 'Id': 'd' * 64, 'Name': '/new-agent',
                                     'State': {'Running': True, 'Pid': 77, 'StartedAt': 'new-started'}}
        self.adapter, self.live, self.launches, self.stops, self.dies_after, self.clock = adapter, 'f' * 64, [], [], None, [0.0]
        if adapter.get('adapter_running') is not True:
            self.live = None

        def proof(policy, agent, identity, bundle, *, bootstrap=None, operation_id=None):
            self.assertEqual((bootstrap, operation_id, bundle), (False, operation, {'digest': 'bundle'}))
            if self.dies_after is not None:
                self.dies_after -= 1
                if self.dies_after < 0:
                    self.adapter, self.live = {'adapter_running': False}, None
            if self.live is None:
                raise SafeFailure('container adapter identity was not observed')
            return {'runtime_digest': self.live}

        def launch(policy, agent, observed, bundle, *, bootstrap, operation_id=None):
            self.assertFalse(self.adapter.get('adapter_running'))
            self.launches.append({'container': observed['Id'], 'bootstrap': bootstrap, 'operation_id': operation_id})
            self.adapter = {'adapter_running': True, 'adapter_bootstrap': bootstrap, 'adapter_operation_id': operation_id}
            self.live = format(len(self.launches), 'x') * 64
            return {'runtime_digest': self.live}

        def stop(agent, observed):
            self.stops.append(observed['Id'])
            self.adapter, self.live = {'adapter_running': False}, None
            return {'stopped_verified': True}

        def sleep(seconds):
            self.clock[0] += seconds

        import fleet_executor_runtime as runtime
        self.stack.enter_context(mock.patch.object(replacement, 'approve_agent', side_effect=lambda policy, agent: {'_placement': {}, **agent}))
        self.stack.enter_context(mock.patch.object(container, 'inspect_container',
            side_effect=lambda name: self.replacement_observed if name == 'new-agent' else self.observed))
        self.stack.enter_context(mock.patch.object(container, 'adapter_restart_state', side_effect=lambda policy, agent, observed: dict(self.adapter)))
        self.stack.enter_context(mock.patch.object(container, 'identity_for', side_effect=lambda agent, observed: {'container_id': observed['Id']}))
        self.stack.enter_context(mock.patch.object(container, 'process_proof', side_effect=proof))
        self.stack.enter_context(mock.patch.object(container, 'start_existing_adapter', side_effect=launch))
        self.stack.enter_context(mock.patch.object(container, 'stop_running_adapter', side_effect=stop))
        self.stack.enter_context(mock.patch.object(runtime, 'approved_bundle', side_effect=lambda policy, agent: {'digest': 'bundle'}))
        self.stack.enter_context(mock.patch.object(replacement, 'time', SimpleNamespace(monotonic=lambda: self.clock[0], sleep=sleep)))
        executor = self.committed_executor(patched=False)
        executor.journal['replacement_retirement']['replacement'].update(
            agent={**{key: value for key, value in self.agent.items() if not key.startswith('_')}, 'container_name': 'new-agent'},
            pin=replacement.container_pin(self.replacement_observed))
        return executor

    def test_admitted_adapter_retires_the_original_without_a_relaunch(self):
        executor = self.relaunchable({'adapter_running': True, 'adapter_bootstrap': False,
                                      'adapter_operation_id': '00000000-0000-4000-8000-000000000001'})
        evidence = replacement.retire_committed(executor)
        self.assertEqual((self.launches, self.stops), ([], []))
        self.assertNotIn('replacement_relaunch', executor.journal)
        self.assertNotIn('relaunched', executor.journal['replacement_retirement_commit']['receipt'])
        self.assertEqual(evidence['replacement_retired']['runtime_digest'], 'f' * 64)
        self.assertIsNone(self.observed)

    def test_replacement_adapter_gone_after_the_commit_is_relaunched_for_its_operation(self):
        operation = '00000000-0000-4000-8000-000000000001'
        for adapter in ({'adapter_running': False},
                        # Relaunched by hand without the operation, as the stuck operation 3b7d01a9 was found.
                        {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': None},
                        {'adapter_running': True, 'adapter_bootstrap': True, 'adapter_operation_id': operation},
                        {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': '00000000-0000-4000-8000-000000000002'}):
            with self.subTest(adapter=adapter):
                original = copy.deepcopy(self.observed)
                executor = self.relaunchable(adapter)
                evidence = replacement.retire_committed(executor)
                self.assertEqual(self.launches, [{'container': 'd' * 64, 'bootstrap': False, 'operation_id': operation}])
                self.assertEqual(self.stops, ['d' * 64] if adapter['adapter_running'] else [])
                relaunched = {'commit_sha256': executor.context['snapshot']['replacement_commit']['commit_sha256'],
                              'pin': replacement.container_pin(self.replacement_observed), 'runtime_digest': '1' * 64, 'admitted': True}
                self.assertEqual(executor.journal['replacement_relaunch'], relaunched)
                self.assertEqual(executor.journal['replacement_retirement_commit']['receipt']['relaunched'], relaunched)
                # The gateway still receives the committed identity; only the live process pin moved.
                self.assertEqual(evidence['replacement_retired']['runtime_digest'], 'f' * 64)
                self.assertGreaterEqual(self.clock[0], replacement.RELAUNCH_ADMISSION_S)
                self.assertIsNone(self.observed)
                self.observed = original

    def test_unknown_normal_adapter_of_the_operation_is_relaunched(self):
        executor = self.relaunchable({'adapter_running': True, 'adapter_bootstrap': False,
                                      'adapter_operation_id': '00000000-0000-4000-8000-000000000001'})
        self.live = '7' * 64
        replacement.retire_committed(executor)
        self.assertEqual((len(self.launches), self.stops), (1, ['d' * 64]))
        self.assertIsNone(self.observed)

    def test_unproven_live_adapter_holds_the_retirement_without_being_stopped(self):
        executor = self.relaunchable({'adapter_running': True, 'adapter_bootstrap': False,
                                      'adapter_operation_id': '00000000-0000-4000-8000-000000000001'})
        self.live = None
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified: container adapter identity'):
            replacement.retire_committed(executor)
        self.assertEqual((self.launches, self.stops, self.calls), ([], [], []))
        self.assertTrue(self.observed['State']['Running'])

    def test_relaunch_that_exits_before_its_admission_keeps_the_original_and_relaunches_again(self):
        executor = self.relaunchable({'adapter_running': False})
        self.dies_after = 3
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified: relaunched replacement adapter exited before its admission'):
            replacement.retire_committed(executor)
        self.assertEqual(self.calls, [])
        self.assertTrue(self.observed['State']['Running'])
        self.assertEqual(executor.journal['replacement_relaunch']['admitted'], False)
        self.dies_after = None
        replacement.retire_committed(executor)
        self.assertEqual([launch['operation_id'] for launch in self.launches], ['00000000-0000-4000-8000-000000000001'] * 2)
        self.assertEqual(executor.journal['replacement_relaunch']['runtime_digest'], '2' * 64)
        self.assertIsNone(self.observed)

    def test_retry_keeps_the_relaunched_adapter_and_finishes_its_admission_window(self):
        executor = self.relaunchable({'adapter_running': False})
        commit = executor.context['snapshot']['replacement_commit']
        pin = executor.journal['replacement_retirement']['replacement']['pin']
        # A host command killed inside the window left the relaunch unconfirmed; its process is still the live one.
        self.adapter = {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': '00000000-0000-4000-8000-000000000001'}
        self.live = '9' * 64
        executor.journal['replacement_relaunch'] = {'commit_sha256': commit['commit_sha256'], 'pin': pin, 'runtime_digest': '9' * 64, 'admitted': False}
        replacement.retire_committed(executor)
        self.assertEqual((self.launches, self.stops), ([], []))
        self.assertGreaterEqual(self.clock[0], replacement.RELAUNCH_ADMISSION_S)
        self.assertEqual(executor.journal['replacement_retirement_commit']['receipt']['relaunched']['runtime_digest'], '9' * 64)
        self.assertIsNone(self.observed)

    def test_relaunch_of_another_commit_or_container_is_never_accepted(self):
        executor = self.relaunchable({'adapter_running': False})
        pin = executor.journal['replacement_retirement']['replacement']['pin']
        executor.journal['replacement_relaunch'] = {'commit_sha256': 'e' * 64, 'pin': pin, 'runtime_digest': '9' * 64, 'admitted': True}
        self.adapter = {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': '00000000-0000-4000-8000-000000000001'}
        self.live = '9' * 64
        replacement.retire_committed(executor)
        self.assertEqual((len(self.launches), self.stops), (1, ['d' * 64]))
        receipt = copy.deepcopy(executor.journal['replacement_retirement_commit']['receipt'])
        receipt.pop('removed')
        receipt.pop('complete')
        for change in ('commit', 'pin', 'admitted', 'uncommitted'):
            with self.subTest(change=change):
                changed = copy.deepcopy(receipt)
                if change == 'commit':
                    changed['relaunched']['commit_sha256'] = 'e' * 64
                elif change == 'pin':
                    changed['relaunched']['pin'] = {**pin, 'started_at': 'restarted'}
                elif change == 'admitted':
                    changed['relaunched']['admitted'] = False
                else:
                    changed.pop('configuration_commit')
                with self.assertRaisesRegex(SafeFailure, 'outside its configuration commitment'):
                    replacement.retire_replaced(self.policy, self.agent, changed, apply=True)
        self.live = '7' * 64
        with self.assertRaisesRegex(SafeFailure, 'differs from its normal verification'):
            replacement.retire_replaced(self.policy, self.agent, receipt, apply=True)

    def test_restarted_replacement_container_is_not_relaunched(self):
        executor = self.relaunchable({'adapter_running': False})
        self.replacement_observed['State']['StartedAt'] = 'restarted'
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified: replacement has no live normal adapter'):
            replacement.retire_committed(executor)
        self.assertEqual((self.launches, self.calls), ([], []))
        self.assertNotIn('replacement_relaunch', executor.journal)
        self.assertTrue(self.observed['State']['Running'])


if __name__ == '__main__':
    unittest.main()
