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


if __name__ == '__main__':
    unittest.main()
