import hashlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest import mock

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
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        import fleet_executor_runtime as runtime
        row = {'tenant': 'Miguel', 'user': 'node', 'runtimeStateDirectory': '/home/node/.cauce/gaia', 'enabled': True,
               'room': 'grp.miguel', **row_extra}
        policy = {'roots': {'state': '/nonexistent'}, 'transport': {'gateway_url': 'https://gateway.example'},
                  'bundles': {harness: {'shared_tui': False}}}
        agent = {'tenant_id': 'Miguel', 'alias': 'gaia', 'runtime_key': 'gaia', 'runtime_user': 'node',
                 'state_directory': '/home/node/.cauce/gaia', 'harness_id': harness}
        snapshot = json.dumps({'schemaVersion': 1, 'fleet': {'gaia': row}}).encode()
        receipt = {'generation': 'g', 'snapshotSha256': hashlib.sha256(snapshot).hexdigest()}
        with mock.patch('fleet_runtime_materialization.load_desired_fleet', return_value=receipt), \
                mock.patch('fleet_executor_pki.checked_file', return_value=snapshot):
            return runtime.sdk_environment(policy, agent, False, 'op')

    def materialized(self, snapshot):
        import fleet_runtime_materialization as materialization
        temporary = tempfile.TemporaryDirectory(prefix='cauce-sdk-snapshot-', dir='/var/tmp')
        self.addCleanup(temporary.cleanup)
        state = pathlib.Path(temporary.name) / 'state'
        receipt = materialization.materialize(fixtures.source(agents=[], memberships=[]), {}, state)
        generation = state / 'generations' / receipt['generation']
        files = {name: (generation / name).read_bytes() for name in receipt['files']}
        document = {'schemaVersion': 1, **snapshot} if isinstance(snapshot, dict) else snapshot
        files['flota.json'] = fixtures.MODULE.canonical_bytes(document)
        with mock.patch.object(materialization, 'render_artifacts', return_value=files):
            receipt = materialization.materialize({}, {}, state)
        return {'roots': {'state': str(state)}}, receipt

    def test_verified_sdk_snapshot_accepts_an_absent_key_with_an_optional_bootstrap_section(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        import fleet_executor_runtime as runtime
        for snapshot in ({'fleet': {}}, {'fleet': {}, 'bootstrap': {}}, {'fleet': {'other-runtime': {}}}):
            with self.subTest(snapshot=snapshot):
                policy, _ = self.materialized(snapshot)
                self.assertTrue(runtime.materialized_sdk_identity_absent(policy, {'runtime_key': 'physical-one'}))

    def test_a_present_sdk_key_is_never_absence_even_when_its_row_or_namespace_is_invalid(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        import fleet_executor_runtime as runtime
        agent = {'runtime_key': 'physical-one', 'tenant_id': 'Equipo_42', 'alias': 'shared_alias',
                 'runtime_user': 'nobody', 'state_directory': '/tmp/cauce-state/physical-one'}
        for section in ('fleet', 'bootstrap'):
            for row in (None, [], {}, {'tenant': 'AnotherCompany', 'alias': 'another-agent'}):
                with self.subTest(section=section, row=row):
                    policy, _ = self.materialized({'fleet': {}, section: {agent['runtime_key']: row}})
                    self.assertFalse(runtime.materialized_sdk_identity_absent(policy, agent))
                    with self.assertRaises(runtime.SafeFailure):
                        runtime.sdk_environment(policy, agent, False, None)

    def test_malformed_verified_sections_never_authorize_absence(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        import fleet_executor_runtime as runtime
        for snapshot in ({}, [], {'fleet': None}, {'fleet': []},
                         {'fleet': {}, 'bootstrap': None}, {'fleet': {}, 'bootstrap': []},
                         {'schemaVersion': None, 'fleet': {}}, {'schemaVersion': True, 'fleet': {}},
                         {'schemaVersion': 2, 'fleet': {}}):
            with self.subTest(snapshot=snapshot):
                policy, _ = self.materialized(snapshot)
                with self.assertRaises(runtime.SafeFailure):
                    runtime.materialized_sdk_identity_absent(policy, {'runtime_key': 'physical-one'})

    def test_the_checked_sdk_bytes_must_match_the_verified_generation_digest(self):
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
        import fleet_executor_runtime as runtime
        policy, receipt = self.materialized({'fleet': {}})
        with mock.patch('fleet_executor_pki.checked_file', return_value=b'{"fleet":{"physical-one":null}}'), \
                self.assertRaises(runtime.SafeFailure):
            runtime.materialized_sdk_identity_absent(policy, {'runtime_key': 'physical-one'})
        state = pathlib.Path(policy['roots']['state'])
        (state / 'generations' / receipt['generation'] / 'flota.json').write_text('{"fleet":{}}\n')
        with self.assertRaises((runtime.SafeFailure, ValueError)):
            runtime.materialized_sdk_identity_absent(policy, {'runtime_key': 'physical-one'})

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
