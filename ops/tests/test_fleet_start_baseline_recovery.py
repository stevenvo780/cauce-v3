"""Production, 26-oct: the start of hegel (a relocated, baseline identity) waited half an hour for a provider login.
Meanwhile another operation of the same host published its own applied generation, and admission refused every retry
with «applied fleet changed before admission runtime effects». Cancelling it then failed forever with «baseline
retirement requires an exact legacy credential inventory», because the generic compensation revokes every credential of
the runtime, including the legacy base records and the normal pair an earlier operation issued."""
from __future__ import annotations

import copy
import json
import pathlib
import sys
import tempfile
import types
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
sys.path.insert(0, str(OPS / 'scripts'))
import fleet_executor_start_compensation as start_compensation  # noqa: E402
import fleet_executor_steps as steps  # noqa: E402
import fleet_provider_revoke  # noqa: E402
import test_fleet_executor_authority as adapter_fixtures  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402
from fleet_runtime_apply import publish_applied  # noqa: E402
from fleet_runtime_materialization import load_applied_fleet, materialize  # noqa: E402
from test_export_fleet_snapshot import agent, membership, source  # noqa: E402


class AdmissionRebaseTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(dir='/var/tmp')
        self.addCleanup(directory.cleanup)
        self.state = pathlib.Path(directory.name)

    def row(self, alias, **changes):
        return {**agent(alias), 'runtime_key': alias, 'primary_room_id': 'grp.steven', 'lifecycle_state': 'ready', **changes}

    def fleet(self, *rows):
        return source(agents=list(rows), memberships=[membership(row['alias']) for row in rows])

    def publish(self, snapshot):
        receipt = materialize(snapshot, {}, self.state)
        current = load_applied_fleet(self.state)['generation'] if (self.state / 'applied-fleet.json').exists() else None
        publish_applied(self.state, receipt['generation'], current)
        return receipt['generation']

    def executor(self, expected):
        executor = types.SimpleNamespace(state=self.state, saves=0, journal={'expected_applied': expected})
        executor.save = lambda: setattr(executor, 'saves', executor.saves + 1)
        return executor

    def base(self, executor, receipt):
        return steps.Executor.admission_base(executor, {'runtime_key': 'hegel'}, receipt)

    def test_a_retire_published_while_the_start_waited_is_kept_and_hegel_is_admitted(self):
        fenced = self.row('hegel', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), fenced, self.row('canary')))
        later = self.publish(self.fleet(self.row('kant'), fenced, self.row('canary', enabled=False, lifecycle_state='retiring')))
        # The admission receipt is rendered from the current fleet snapshot: it already carries the retire.
        receipt = materialize(self.fleet(self.row('kant'), self.row('hegel'),
                                         self.row('canary', enabled=False, lifecycle_state='retiring')), {}, self.state)
        executor = self.executor(expected)
        self.assertEqual(self.base(executor, receipt), later)
        self.assertEqual(executor.journal['admission_rebased_applied'], [{'from': later, 'to': receipt['generation']}])
        publish_applied(self.state, receipt['generation'], later)
        applied = json.loads((self.state / 'generations' / receipt['generation'] / 'flota.json').read_bytes())
        self.assertIn('hegel', applied['fleet'])
        self.assertIn('canary', applied['retired'])
        # A replay finds its own generation applied and records nothing new.
        self.assertEqual(self.base(executor, receipt), receipt['generation'])
        self.assertEqual(len(executor.journal['admission_rebased_applied']), 1)

    def test_an_unchanged_applied_generation_needs_no_rebase(self):
        fenced = self.row('hegel', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), fenced))
        receipt = materialize(self.fleet(self.row('kant'), self.row('hegel')), {}, self.state)
        executor = self.executor(expected)
        self.assertEqual(self.base(executor, receipt), expected)
        self.assertNotIn('admission_rebased_applied', executor.journal)

    def test_an_applied_change_to_another_agent_that_the_receipt_lacks_is_refused(self):
        fenced = self.row('hegel', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), fenced))
        self.publish(self.fleet(self.row('kant', enabled=False, lifecycle_state='failed'), fenced))
        # Admitting from a snapshot where kant is enabled would silently re-enable it on this host.
        receipt = materialize(self.fleet(self.row('kant'), self.row('hegel')), {}, self.state)
        executor = self.executor(expected)
        with self.assertRaisesRegex(SafeFailure, 'applied fleet changed before admission runtime effects'):
            self.base(executor, receipt)
        self.assertNotIn('admission_rebased_applied', executor.journal)

    def test_an_extra_agent_only_on_the_host_is_refused(self):
        fenced = self.row('hegel', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), fenced))
        self.publish(self.fleet(self.row('kant'), fenced, self.row('argos')))
        receipt = materialize(self.fleet(self.row('kant'), self.row('hegel')), {}, self.state)
        with self.assertRaisesRegex(SafeFailure, 'applied fleet changed before admission runtime effects'):
            self.base(self.executor(expected), receipt)

    def test_a_missing_applied_generation_is_only_accepted_when_none_was_expected(self):
        receipt = materialize(self.fleet(self.row('kant'), self.row('hegel')), {}, self.state)
        self.assertIsNone(self.base(self.executor(None), receipt))
        with self.assertRaisesRegex(SafeFailure, 'applied fleet changed before admission runtime effects'):
            self.base(self.executor('a' * 64), receipt)


class BaselineStartCompensationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        adapter_fixtures.CentralAuthorityAdapterTest.setUpClass()

    @classmethod
    def tearDownClass(cls):
        adapter_fixtures.CentralAuthorityAdapterTest.tearDownClass()

    def setUp(self):
        self.fixture = adapter_fixtures.CentralAuthorityAdapterTest(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        fixture = self.fixture
        fixture.agent['fleet_baseline'] = True
        fixture.policy['transport'] = {'gateway_url': 'https://fixture.invalid', 'ca_certificate': str(fixture.ca)}
        principal = {'tenant_id': fixture.agent['tenant_id'], 'alias': fixture.agent['alias'], 'channel': 'adapter',
                     'session_id': 'adapter-physical-a', 'roles': ['adapter'], 'permissions': ['route', 'read']}
        # What this start never issued: the legacy base records and the normal pair of an earlier operation.
        for name, digit in (('base_mtls', '1'), ('base_token', '2'), ('fleet_mtls', '3'), ('fleet_token', '4')):
            field = 'certificate_sha256' if name.endswith('mtls') else 'token_sha256'
            location = pathlib.Path(fixture.registries[name])
            document = json.loads(location.read_text())
            document['identities'].append({field: digit * 64, 'principal': principal, 'expires_at': '2099-01-01T00:00:00Z'})
            location.write_text(json.dumps(document))
        earlier = pathlib.Path(fixture.policy['roots']['pki']) / 'normal' / 'physical-a'
        earlier.mkdir(parents=True, mode=0o700)
        (earlier / '.authority-request.json').write_text(json.dumps({'scope': {'operation_id': '51000000-0000-4000-8000-0000000000aa'}}))
        self.earlier = earlier
        proof = fixture.prepare()
        self.issued = {'phase': 'bootstrap', 'certificate_sha256': proof['certificate_fingerprint'],
                       'token_sha256': proof['provenance']['token_sha256']}
        self.before = self.records(exclude=self.issued)
        context = {**fixture.context, 'request': {'kind': 'start', 'target': {'resource': 'agent',
            'tenant_id': fixture.agent['tenant_id'], 'alias': fixture.agent['alias']}, 'parameters': {}},
            'fenced_targets': [], 'previous_agents': [], 'desired_memberships': []}
        self.executor = steps.Executor(fixture.policy, context)
        self.executor.journal.update(attempted=['runtime', 'authenticate', 'profile', 'verify', 'admission'], stopped=True,
            bootstrap_credentials=proof['certificate_fingerprint'], credential_provenance={'bootstrap': proof['provenance']},
            expected_applied='5' * 64, admission_pending_generation='6' * 64, generation='7' * 64)
        self.executor.save()

    def records(self, exclude=None):
        rows = {}
        for name, location in self.fixture.registries.items():
            field = 'agents' if name == 'pty' else 'identities'
            entries = json.loads(pathlib.Path(location).read_text())[field]
            if exclude is not None:
                entries = [entry for entry in entries if entry.get('certificate_sha256') != exclude['certificate_sha256']
                           and entry.get('token_sha256') != exclude['token_sha256']]
            rows[name] = entries
        return rows

    def compensate(self, rejected=True):
        with mock.patch.object(fleet_provider_revoke, 'rejected', return_value=rejected) as probe, \
                mock.patch.object(fleet_provider_revoke, 'expired', return_value=False), \
                mock.patch('fleet_executor_retirement.remove_runtime_credentials') as runtime:
            result = start_compensation.compensate_baseline_start(self.executor, [self.fixture.agent])
        return result, probe, runtime

    def test_cancelled_baseline_start_revokes_only_its_own_issuance_and_replays(self):
        bootstrap = pathlib.Path(self.fixture.policy['roots']['pki']) / 'bootstrap' / 'physical-a'
        token = pathlib.Path(self.fixture.policy['roots']['tokens']) / 'bootstrap' / 'physical-a.token'
        self.assertTrue(bootstrap.is_dir() and token.is_file())
        result, probe, runtime = self.compensate()
        self.assertEqual(result, {'stopped_verified': True, 'revocation_verified': True})
        self.assertEqual(self.records(), self.before)
        self.assertEqual(probe.call_count, 2)
        runtime.assert_called_once()
        self.assertFalse(bootstrap.exists() or token.exists())
        self.assertTrue((self.earlier / '.authority-request.json').is_file())
        self.assertEqual(self.executor.journal['start_compensation']['physical-a'], {'revoked': [self.issued], 'complete': True})
        self.assertIn('revoke_issued', [request['action'] for request in self.fixture.requests])
        self.assertNotIn('revoke', [request['action'] for request in self.fixture.requests])
        # A replay (lost reply, new claim) revokes nothing more and reports the same verified effect.
        self.fixture.scope.update(claim_epoch=2, worker_id='replacement', claim_token='51000000-0000-4000-8000-000000000003')
        result, probe, _ = self.compensate()
        self.assertEqual(result, {'stopped_verified': True, 'revocation_verified': True})
        self.assertEqual(self.records(), self.before)
        probe.assert_not_called()
        # The cancelled scope never issues again.
        with self.assertRaises(SafeFailure):
            self.fixture.prepare()

    def test_unobserved_rejection_fails_and_keeps_the_local_files_for_a_retry(self):
        bootstrap = pathlib.Path(self.fixture.policy['roots']['pki']) / 'bootstrap' / 'physical-a'
        with self.assertRaisesRegex(SafeFailure, 'was not rejected'):
            self.compensate(rejected=False)
        self.assertTrue(bootstrap.is_dir())
        self.assertEqual(self.records(), self.before)
        self.assertEqual(self.compensate()[0], {'stopped_verified': True, 'revocation_verified': True})
        self.assertFalse(bootstrap.exists())

    def test_journal_with_effects_a_start_never_makes_fails_honestly(self):
        for changes in ({'attempted': ['stop']}, {'revocation_complete': True}, {'compensated': {'physical-a': True}},
                        {'admission': {'generation': '8' * 64}}):
            executor = copy.deepcopy(self.executor.journal)
            self.executor.journal.update(changes)
            with self.assertRaisesRegex(SafeFailure, 'inspect its journal'):
                self.compensate()
            self.executor.journal = executor
        self.assertEqual(self.records(exclude=None)['fleet_mtls'][-1]['certificate_sha256'], self.issued['certificate_sha256'])

    def test_a_published_admission_is_not_silently_undone(self):
        pending = self.executor.journal['admission_pending_generation']
        with mock.patch('fleet_runtime_materialization.load_applied_fleet', return_value={'generation': pending}):
            (self.executor.state / 'applied-fleet.json').write_text('{}')
            with self.assertRaisesRegex(SafeFailure, 'already published'):
                self.compensate()

    def test_executor_routes_a_baseline_start_away_from_the_full_revocation(self):
        with mock.patch.object(steps, 'scoped_agents', return_value=[self.fixture.agent]), \
                mock.patch.object(steps, 'stop'), mock.patch('fleet_executor_container.discard_operation'), \
                mock.patch.object(steps, 'credential_references', side_effect=AssertionError('full revocation path')), \
                mock.patch.object(steps.Executor, 'physical_placements', return_value=[self.fixture.agent]), \
                mock.patch('fleet_executor_replacement_rollback.compensate', return_value=None), \
                mock.patch.object(start_compensation, 'compensate_baseline_start',
                                  return_value={'stopped_verified': True, 'revocation_verified': True}) as routed:
            self.assertEqual(self.executor.compensate(), {'stopped_verified': True, 'revocation_verified': True})
        routed.assert_called_once()


if __name__ == '__main__':
    unittest.main()
