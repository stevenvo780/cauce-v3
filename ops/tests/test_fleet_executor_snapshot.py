import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_export_fleet_snapshot as fixtures


class ProviderMetadataSnapshotTest(unittest.TestCase):
    def snapshot(self, source):
        try:
            return fixtures.MODULE.snapshot_document(source)
        except fixtures.MODULE.SnapshotError:
            self.fail('durable provider metadata is not accepted by the exporter')

    def test_durable_account_and_model_are_preserved_without_profile_paths(self):
        agent = {**fixtures.agent('kant'), 'primary_account_id': 'codex-personal', 'model_id': 'openai/gpt-6.1-sol'}
        snapshot = self.snapshot(fixtures.source(agents=[agent]))
        self.assertEqual(snapshot['fleet']['kant']['primaryAccountId'], 'codex-personal')
        self.assertEqual(snapshot['fleet']['kant']['modelId'], 'openai/gpt-6.1-sol')
        self.assertNotIn('profilePath', snapshot['fleet']['kant'])

    def test_null_provider_metadata_keeps_legacy_bytes(self):
        source = fixtures.source()
        before = fixtures.MODULE.canonical_bytes(fixtures.MODULE.snapshot_document(source))
        source['agents'][0].update(primary_account_id=None, model_id=None, reasoning_effort=None)
        after = fixtures.MODULE.canonical_bytes(self.snapshot(source))
        self.assertEqual(before, after)

    def test_reasoning_effort_is_preserved_and_invalid_value_is_rejected(self):
        agent = {**fixtures.agent('kant'), 'reasoning_effort': 'high'}
        snapshot = self.snapshot(fixtures.source(agents=[agent]))
        self.assertEqual(snapshot['fleet']['kant']['reasoningEffort'], 'high')
        agent['reasoning_effort'] = 'unapproved-effort'
        with self.assertRaises(fixtures.MODULE.SnapshotError):
            fixtures.MODULE.snapshot_document(fixtures.source(agents=[agent]))

    def test_shared_humans_are_preserved_sorted_and_malformed_entries_rejected(self):
        first, second = 'Miguel:' + '1' * 8 + '-1111-1111-1111-' + '1' * 12, 'Ana:' + 'a' * 8 + '-aaaa-aaaa-aaaa-' + 'a' * 12
        agent = {**fixtures.agent('kant'), 'shared_human_ids': [first, second]}
        snapshot = self.snapshot(fixtures.source(agents=[agent]))
        self.assertEqual(snapshot['fleet']['kant']['sharedHumanIds'], [second, first])
        for invalid in (['Miguel:not-a-uuid'], [first, first], [], 'Miguel'):
            agent['shared_human_ids'] = invalid
            with self.assertRaises(fixtures.MODULE.SnapshotError):
                fixtures.MODULE.snapshot_document(fixtures.source(agents=[agent]))


class SharedHumanEnvironmentTest(unittest.TestCase):
    ENTRY = 'Steven:' + 'b' * 8 + '-bbbb-bbbb-bbbb-' + 'b' * 12

    def environment(self, harness, row_extra):
        import json
        from unittest import mock
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        import fleet_executor_runtime as runtime
        row = {'tenant': 'Miguel', 'user': 'node', 'runtimeStateDirectory': '/home/node/.cauce/gaia', 'enabled': True,
               'room': 'grp.miguel', **row_extra}
        policy = {'roots': {'state': '/nonexistent'}, 'transport': {'gateway_url': 'https://gateway.example'}}
        agent = {'tenant_id': 'Miguel', 'alias': 'gaia', 'runtime_key': 'gaia', 'runtime_user': 'node',
                 'state_directory': '/home/node/.cauce/gaia', 'harness_id': harness}
        with mock.patch('fleet_runtime_materialization.load_desired_fleet', return_value={'generation': 'g'}), \
                mock.patch('fleet_executor_pki.checked_file', return_value=json.dumps({'fleet': {'gaia': row}}).encode()):
            return runtime.sdk_environment(policy, agent, False, 'op')

    def test_openclaw_gets_the_shared_human_list_and_other_harnesses_are_refused(self):
        self.assertEqual(self.environment('openclaw', {'sharedHumanIds': [self.ENTRY]})['CAUCE_SHARED_HUMAN_IDS'], self.ENTRY)
        self.assertNotIn('CAUCE_SHARED_HUMAN_IDS', self.environment('openclaw', {}))
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        from fleet_executor_policy import SafeFailure
        with self.assertRaises(SafeFailure):
            self.environment('codex', {'sharedHumanIds': [self.ENTRY]})

    def test_a_stale_shared_human_list_is_drift_even_when_none_is_expected(self):
        from unittest import mock
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        import fleet_executor_runtime as runtime
        expected = {'CAUCE_ROOM': 'grp.miguel'}
        with mock.patch.object(runtime, 'sdk_environment', return_value=expected):
            runtime.sdk_environment_proof({}, {}, dict(expected), False, 'op')
            with self.assertRaises(runtime.NamespaceMismatch):
                runtime.sdk_environment_proof({}, {}, {**expected, 'CAUCE_SHARED_HUMAN_IDS': self.ENTRY}, False, 'op')


if __name__ == '__main__':
    unittest.main()
