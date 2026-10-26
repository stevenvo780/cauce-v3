from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest
import uuid
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_steps as steps  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402


class StopCompensationTest(unittest.TestCase):
    """Cancelling a failed stop of a baseline (legacy traslado) agent stops it and never touches its credentials."""

    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='cauce-stop-compensation-')
        self.addCleanup(temporary.cleanup)
        state = pathlib.Path(temporary.name) / 'state'
        state.mkdir(mode=0o700)
        # No legacy_credentials row: credential_references() would raise «baseline retirement requires an exact
        # legacy credential inventory» for this agent.
        self.policy = {'host_id': 'host-a', 'roots': {'state': str(state)}}
        self.agent = {'tenant_id': 'Equipo_42', 'alias': 'baseline_a', 'runtime_key': 'baseline-a', 'host_id': 'host-a',
            'runtime_mode': 'container', 'container_name': 'cauce-baseline-a', 'fleet_baseline': True}
        self.context = {'operation_id': str(uuid.uuid4()), 'request': {'kind': 'stop',
            'target': {'resource': 'agent', 'tenant_id': 'Equipo_42', 'alias': 'baseline_a'}, 'parameters': {}},
            'previous_agents': [self.agent], 'desired_memberships': [],
            'fenced_targets': [{'resource': 'agent', 'tenant_id': 'Equipo_42', 'alias': 'baseline_a'}]}
        for name, options in (('scoped_agents', {'return_value': [self.agent]}), ('stop', {}),
                              ('credential_references', {'side_effect': AssertionError('stop compensation read credentials')}),
                              ('remove_credentials', {'side_effect': AssertionError('stop compensation removed credentials')}),
                              ('remove_registry_principals', {'side_effect': AssertionError('stop compensation revoked')})):
            patcher = mock.patch.object(steps, name, **options)
            setattr(self, name, patcher.start())
            self.addCleanup(patcher.stop)
        patcher = mock.patch('fleet_executor_container.discard_operation')
        self.discard = patcher.start()
        self.addCleanup(patcher.stop)

    def test_cancelled_stop_is_stopped_without_credential_effects_and_replays(self):
        executor = steps.Executor(self.policy, self.context)
        executor.journal.update(attempted=['stop'])
        for _ in range(2):
            self.assertEqual(executor.perform('compensate'), {'evidence': {'stopped_verified': True, 'revocation_verified': True}})
        self.assertEqual(self.stop.call_count, 2)
        self.assertEqual(self.discard.call_count, 2)
        self.assertTrue(executor.journal['stopped'])
        self.credential_references.assert_not_called()

    def test_stop_journal_with_credential_effects_fails_honestly(self):
        executor = steps.Executor(self.policy, self.context)
        executor.journal.update(attempted=['stop'], normal_credentials='a' * 64)
        with self.assertRaisesRegex(SafeFailure, 'a stop never makes'):
            executor.perform('compensate')
        self.credential_references.assert_not_called()


if __name__ == '__main__':
    unittest.main()
