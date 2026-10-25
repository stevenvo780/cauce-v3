from __future__ import annotations

import copy
import json
import pathlib
import sys
import tempfile
import unittest
import uuid
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_container as container  # noqa: E402
import fleet_executor_container_tui as tui_container  # noqa: E402
import fleet_executor_steps as steps  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402


class CanonicalTuiStepTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-tui-steps-')
        self.addCleanup(temporary.cleanup)
        root = pathlib.Path(temporary.name)
        state = root / 'state'
        state.mkdir(mode=0o700)
        self.policy = {'roots': {'state': str(state)}}
        self.previous = {'tenant_id': 'OwnedTenant', 'alias': 'owned', 'runtime_key': 'owned-runtime',
            'harness_id': 'codex', 'runtime_mode': 'container', 'host_id': 'owned-host',
            'container_name': 'owned-container', 'runtime_user': 'cauce', 'home_directory': '/home/cauce',
            'state_directory': '/home/cauce/.cauce/owned-runtime', 'model_id': 'gpt-5.5',
            'reasoning_effort': 'medium', 'extensions': []}
        self.desired = copy.deepcopy(self.previous)
        self.context = {'operation_id': str(uuid.uuid4()), 'request': {'kind': 'retire',
            'target': {'resource': 'agent', 'tenant_id': 'OwnedTenant', 'alias': 'owned'},
            'parameters': {}}, 'previous_agents': [self.previous], 'desired_memberships': [],
            'fenced_targets': [{'resource': 'agent', 'tenant_id': 'OwnedTenant', 'alias': 'owned'}]}
        self.witness = {'version': 1, 'container_id': 'a' * 64, 'pane': {'pid': 456, 'starttime': 1000}}
        self.events = []
        self.stopped = self.patch(steps, 'stop', side_effect=lambda *_: self.events.append('adapter_stop'))
        self.observe = self.patch(tui_container, 'observe_canonical_tui', create=True,
            side_effect=lambda *_: (self.events.append('observe_tui'), copy.deepcopy(self.witness))[1])
        self.close = self.patch(tui_container, 'stop_canonical_tui', create=True, side_effect=self.apply_close)
        self.patch(steps, 'scoped_agents', side_effect=lambda *_: [self.previous])
        self.patch(steps, 'approve_agent', side_effect=lambda _policy, row: row)
        self.patch(container, 'inspect_container', return_value=None)

    def patch(self, target, name, **options):
        patcher = mock.patch.object(target, name, **options)
        result = patcher.start()
        self.addCleanup(patcher.stop)
        return result

    def executor(self, kind=None):
        if kind is not None:
            self.context['request']['kind'] = kind
        executor = steps.Executor(self.policy, self.context)
        executor.agent = mock.Mock(side_effect=lambda: self.desired)
        return executor

    def apply_close(self, _policy, row, witness):
        document = json.loads(self.current.journal_path.read_bytes())
        entry = document['canonical_tui_stops'][row['runtime_key']]
        self.assertEqual(entry['witness'], witness)
        self.events.append('close_tui')
        return {'canonical_tui_stopped': True}

    def test_retire_and_purge_persist_witness_before_close_and_reuse_it_on_replay(self):
        for kind in ('retire', 'purge'):
            with self.subTest(kind=kind):
                self.context['operation_id'] = str(uuid.uuid4())
                self.current = self.executor(kind)
                self.assertEqual(self.current.stop(), {'stopped_verified': True})
                self.assertEqual(self.events[-3:], ['adapter_stop', 'observe_tui', 'close_tui'])
                self.assertTrue(self.current.journal['canonical_tui_stops']['owned-runtime']['complete'])
                original = copy.deepcopy(self.witness)
                self.witness['pane']['pid'] += 1
                observed = self.observe.call_count
                self.current = self.executor()
                self.current.stop()
                self.assertEqual(self.observe.call_count, observed)
                self.assertEqual(self.close.call_args.args[2], original)

    def test_stop_and_other_non_retirement_operations_preserve_the_tui(self):
        for kind in ('stop', 'start', 'restore', 'create'):
            with self.subTest(kind=kind):
                self.context['operation_id'] = str(uuid.uuid4())
                self.current = self.executor(kind)
                self.current.stop()
        self.observe.assert_not_called()
        self.close.assert_not_called()

    def test_common_placement_stop_does_not_close_a_tui_during_other_phases(self):
        self.current = self.executor()
        self.current.stop_placement(self.previous)
        self.stopped.assert_called_once_with(self.policy, self.previous)
        self.observe.assert_not_called()
        self.close.assert_not_called()

    def test_update_only_closes_for_an_authorized_execution_selection_change(self):
        for field, value in (('model_id', 'gpt-5.4'), ('reasoning_effort', 'high'), ('harness_id', 'claude')):
            with self.subTest(field=field):
                self.context['operation_id'] = str(uuid.uuid4())
                self.desired = {**self.previous, field: value}
                self.current = self.executor('update')
                self.current.stop()
                closed = self.close.call_args.args[1]
                self.assertEqual({key: closed[key] for key in self.previous}, self.previous)
        calls = self.close.call_count
        self.desired = {**self.previous, 'display_name': 'Changed label'}
        self.context['operation_id'] = str(uuid.uuid4())
        self.current = self.executor('update')
        self.current.stop()
        self.assertEqual(self.close.call_count, calls)

    def test_previous_tui_uses_the_current_operation_account_authority(self):
        account = {'id': 'owned-account', 'provider': 'codex', 'external_account_id': 'owned-fixture',
            'payer_tenant_id': 'OwnedTenant', 'shared_with_pool': False, 'enabled': True}
        self.context['trusted_accounts'] = [account]
        self.previous['_trusted_accounts'] = [{'id': 'stale-account'}]
        self.desired['reasoning_effort'] = 'high'
        self.current = self.executor('update')
        self.current.close_previous_tui(self.previous, capture=True)
        for call in (self.observe.call_args, self.close.call_args):
            self.assertEqual(call.args[1]['_trusted_accounts'], [account])
            self.assertTrue(call.args[1]['_trusted_accounts_present'])
        self.assertEqual(self.previous['_trusted_accounts'], [{'id': 'stale-account'}])

    def test_migration_and_native_stop_do_not_reset_their_canonical_tui(self):
        self.current = self.executor('update')
        self.desired['reasoning_effort'] = 'high'
        with mock.patch.object(steps, 'placement_role', return_value='source'):
            self.current.stop()
        self.previous['runtime_mode'] = 'native'
        self.context['operation_id'] = str(uuid.uuid4())
        self.current = self.executor('retire')
        self.current.stop()
        self.observe.assert_not_called()
        self.close.assert_not_called()

    def test_close_failure_preserves_pending_witness_for_the_next_attempt(self):
        self.current = self.executor()
        self.close.side_effect = SafeFailure('canonical pane changed')
        with self.assertRaisesRegex(SafeFailure, 'canonical pane changed'):
            self.current.stop()
        entry = self.current.journal['canonical_tui_stops']['owned-runtime']
        self.assertFalse(entry['complete'])
        original = copy.deepcopy(entry['witness'])
        self.witness['pane']['pid'] += 1
        self.close.side_effect = self.apply_close
        self.current = self.executor()
        self.current.stop()
        self.observe.assert_called_once()
        self.assertEqual(self.close.call_args.args[2], original)

    def test_false_close_receipt_never_marks_the_stop_complete(self):
        self.current = self.executor()
        self.close.side_effect = None
        self.close.return_value = {'canonical_tui_stopped': False}
        with self.assertRaisesRegex(SafeFailure, 'closure was not observed'):
            self.current.stop()
        self.assertNotIn('stopped', self.current.journal)
        self.assertFalse(self.current.journal['canonical_tui_stops']['owned-runtime']['complete'])

    def test_previous_phase_replays_cannot_stop_the_destination_adapter(self):
        for field in ('runtime', 'runtime_launch_attempted'):
            for action in ('stop', 'revoke'):
                with self.subTest(field=field, action=action):
                    self.context['operation_id'] = str(uuid.uuid4())
                    self.current = self.executor('update')
                    self.current.journal[field] = True
                    self.current.save()
                    with self.assertRaisesRegex(SafeFailure, 'after destination startup'):
                        getattr(self.current, action)()
        self.stopped.assert_not_called()
        self.observe.assert_not_called()
        self.close.assert_not_called()

    def test_runtime_replay_revalidates_destination_without_stopping_or_recapturing(self):
        self.current = self.executor('update')
        self.current.generation = mock.Mock()
        self.current.record_extension_receipt = mock.Mock(return_value={})
        self.desired['reasoning_effort'] = 'high'
        self.current.journal['runtime_launch_attempted'] = True
        self.current.save()
        with mock.patch.object(steps, 'start', return_value={'runtime_digest': 'b' * 64}) as started:
            self.assertEqual(self.current.runtime(), {'runtime_digest': 'b' * 64})
        started.assert_called_once_with(self.policy, self.desired, operation_id=self.context['operation_id'])
        self.stopped.assert_not_called()
        self.observe.assert_not_called()
        self.close.assert_not_called()

    def test_runtime_marks_launch_after_previous_tui_close_and_before_destination_start(self):
        self.current = self.executor('update')
        self.current.generation = mock.Mock()
        self.current.record_extension_receipt = mock.Mock(return_value={})
        self.desired['reasoning_effort'] = 'high'
        def launch(*_args, **_keywords):
            stored = json.loads(self.current.journal_path.read_bytes())
            self.assertTrue(stored['runtime_launch_attempted'])
            self.assertTrue(stored['canonical_tui_stops']['owned-runtime']['complete'])
            self.events.append('destination_start')
            return {'runtime_digest': 'c' * 64}
        with mock.patch.object(steps, 'start', side_effect=launch):
            self.current.runtime()
        self.assertEqual(self.events, ['adapter_stop', 'observe_tui', 'close_tui', 'destination_start'])

    def test_lost_start_result_never_repeats_the_previous_generation_stop(self):
        self.current = self.executor('update')
        self.current.generation = mock.Mock()
        self.current.record_extension_receipt = mock.Mock(return_value={})
        self.desired['reasoning_effort'] = 'high'
        with mock.patch.object(steps, 'start', side_effect=SafeFailure('start result unavailable')):
            with self.assertRaisesRegex(SafeFailure, 'start result unavailable'):
                self.current.runtime()
        self.current = self.executor()
        self.current.generation = mock.Mock()
        self.current.record_extension_receipt = mock.Mock(return_value={})
        with mock.patch.object(steps, 'start', return_value={'runtime_digest': 'e' * 64}):
            self.current.runtime()
        self.stopped.assert_called_once()
        self.observe.assert_called_once()
        self.close.assert_called_once()

    def test_revoke_does_not_capture_a_new_tui_witness(self):
        self.current = self.executor()
        self.current.journal['stopped'] = True
        references = {'credentials': {}}
        with mock.patch.object(steps, 'credential_references', return_value=references), \
                mock.patch.object(steps, 'remove_registry_principals'), \
                mock.patch.object(steps, 'invoke_revoke', return_value={'revocation_verified': True}), \
                mock.patch.object(steps, 'remove_credentials'), mock.patch.object(steps, 'remove_runtime_credentials'):
            self.current.revoke()
        self.observe.assert_not_called()
        self.close.assert_not_called()

    def test_revoke_replay_verifies_the_original_witness_without_recapturing(self):
        self.current = self.executor()
        self.current.stop()
        original = copy.deepcopy(self.close.call_args.args[2])
        self.witness['pane']['pid'] += 1
        references = {'credentials': {}}
        with mock.patch.object(steps, 'credential_references', return_value=references), \
                mock.patch.object(steps, 'remove_registry_principals'), \
                mock.patch.object(steps, 'invoke_revoke', return_value={'revocation_verified': True}), \
                mock.patch.object(steps, 'remove_credentials'), mock.patch.object(steps, 'remove_runtime_credentials'):
            self.current.revoke()
        self.observe.assert_called_once()
        self.assertEqual(self.close.call_args.args[2], original)

    def test_scope_conflict_never_applies_the_recorded_close(self):
        self.current = self.executor()
        self.current.stop()
        self.current.journal['canonical_tui_stops']['owned-runtime']['scope_sha256'] = 'd' * 64
        self.current.save()
        calls = self.close.call_count
        with self.assertRaisesRegex(SafeFailure, 'previous operation placement'):
            self.current.stop()
        self.assertEqual(self.close.call_count, calls)


if __name__ == '__main__':
    unittest.main()
