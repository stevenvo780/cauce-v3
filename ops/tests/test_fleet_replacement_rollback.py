from __future__ import annotations

import copy
import hashlib
import json
import pathlib
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'cli'))
import fleet_executor_authority as authority
import fleet_executor_container as container
import fleet_executor_replacement_rollback as rollback
import test_fleet_authority_issuer as issuer_fixtures
import test_fleet_executor_authority as adapter_fixtures
from fleet_executor_policy import SafeFailure

issuer = issuer_fixtures.issuer


class ReplacementCredentialRollbackTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        issuer_fixtures.FleetAuthorityIssuerTest.setUpClass()

    @classmethod
    def tearDownClass(cls):
        issuer_fixtures.FleetAuthorityIssuerTest.tearDownClass()

    def setUp(self):
        self.fixture = issuer_fixtures.FleetAuthorityIssuerTest(methodName='runTest')
        self.fixture.setUp()
        self.addCleanup(self.fixture.tearDown)
        self.normal = self.fixture.issue(phase='normal')
        self.fixture.scope = {**self.fixture.scope, 'operation_id': '72000000-0000-4000-8000-000000000002'}
        self.fields = {'snapshot_sha256': 'b' * 64, 'original_container_id': 'c' * 64}
        self.checkpoint = issuer.perform(self.fixture.policy, self.packet('checkpoint_credentials',
            normal_certificate_sha256=self.normal['certificate_sha256'], normal_token_sha256=self.normal['token_sha256']))

    def packet(self, action, **extra):
        current = issuer.perform(self.fixture.policy, self.fixture.packet('inventory'))
        return self.fixture.packet(action, expected_inventory=[{key: row[key] for key in ('id', 'sha256')}
            for row in current['authorities']], **self.fields, **extra)

    def restore(self, **extra):
        return issuer.perform(self.fixture.policy, self.packet('rollback_credentials',
            **{**self.checkpoint, **extra}))

    def records(self):
        return {name: json.loads(pathlib.Path(path).read_text()) for name, path in self.fixture.registries.items()}

    def test_reused_authority_is_preserved_and_proof_replays_identically(self):
        before = self.records()
        result = self.restore()
        self.assertEqual(self.records(), before)
        self.assertEqual(result, self.restore())
        self.assertIs(result['shared_authority_preserved'], True)
        self.assertIs(result['created_authority_revoked'], True)
        self.assertIsNotNone(self.fixture.lookup(self.normal['certificate_sha256'])['identity'])
        self.assertEqual(result['checkpoint_sha256'], self.checkpoint['checkpoint_sha256'])

    def test_only_this_operations_issued_credential_is_removed(self):
        before = self.records()
        self.fixture.issue()
        self.restore()
        self.assertEqual(self.records(), before)
        with self.assertRaises(issuer.AuthorityError):
            self.fixture.issue()

    def test_an_expired_bootstrap_retired_by_this_operations_issue_does_not_block_rollback(self):
        """Production, 26-oct (Praxis teseo): the checkpoint held the bootstrap of an earlier start, expired since; the
        update's own bootstrap issue retired it, and the rollback refused it as a change by another operation."""
        self.fixture.scope = {**self.fixture.scope, 'operation_id': '72000000-0000-4000-8000-000000000001'}
        self.fixture.issue()
        for name in ('fleet_mtls', 'fleet_token'):
            location = pathlib.Path(self.fixture.registries[name])
            document = json.loads(location.read_text())
            document['identities'] = [{**row, 'expires_at': '2026-01-01T00:00:00Z'}
                                      if row['principal']['channel'] == 'bootstrap' else row for row in document['identities']]
            location.write_text(json.dumps(document))
        self.fixture.scope = {**self.fixture.scope, 'operation_id': '72000000-0000-4000-8000-000000000003'}
        self.checkpoint = issuer.perform(self.fixture.policy, self.packet('checkpoint_credentials',
            normal_certificate_sha256=self.normal['certificate_sha256'], normal_token_sha256=self.normal['token_sha256']))
        expired = self.records()
        self.fixture.issue()
        result = self.restore()
        self.assertEqual(result, self.restore())
        after = self.records()
        for name in ('fleet_mtls', 'fleet_token'):
            self.assertEqual(after[name]['identities'],
                             [row for row in expired[name]['identities'] if row['principal']['channel'] != 'bootstrap'])

    def test_an_unexpired_bootstrap_of_another_operation_still_blocks_rollback(self):
        self.fixture.scope = {**self.fixture.scope, 'operation_id': '72000000-0000-4000-8000-000000000001'}
        self.fixture.issue()
        self.fixture.scope = {**self.fixture.scope, 'operation_id': '72000000-0000-4000-8000-000000000003'}
        self.checkpoint = issuer.perform(self.fixture.policy, self.packet('checkpoint_credentials',
            normal_certificate_sha256=self.normal['certificate_sha256'], normal_token_sha256=self.normal['token_sha256']))
        for name in ('fleet_mtls', 'fleet_token'):
            location = pathlib.Path(self.fixture.registries[name])
            document = json.loads(location.read_text())
            document['identities'] = [row for row in document['identities'] if row['principal']['channel'] != 'bootstrap']
            location.write_text(json.dumps(document))
        with self.assertRaisesRegex(issuer.AuthorityError, 'another operation'):
            self.restore()

    def test_partial_registration_after_issuance_journal_is_reconciled(self):
        before = self.records()
        publish = issuer.publish
        def interrupt(location, document, *args):
            if location == pathlib.Path(self.fixture.registries['fleet_token']):
                raise RuntimeError('interrupted registry publication')
            return publish(location, document, *args)
        with mock.patch.object(issuer, 'publish', side_effect=interrupt), self.assertRaises(RuntimeError):
            self.fixture.issue()
        self.restore()
        self.assertEqual(self.records(), before)

    def test_partial_rollback_replays_without_restoring_removed_authority(self):
        before = self.records()
        self.fixture.issue()
        publish = issuer.publish
        def interrupt(location, document, *args):
            if location == pathlib.Path(self.fixture.registries['fleet_token']):
                raise RuntimeError('interrupted credential rollback')
            return publish(location, document, *args)
        with mock.patch.object(issuer, 'publish', side_effect=interrupt), self.assertRaises(RuntimeError):
            self.restore()
        self.restore()
        self.assertEqual(self.records(), before)

    def test_missing_original_authority_fails_without_reinsertion(self):
        location = pathlib.Path(self.fixture.registries['fleet_mtls'])
        location.write_text(json.dumps({'version': 1, 'identities': []}))
        before = self.records()
        with self.assertRaises(issuer.AuthorityError):
            self.restore()
        self.assertEqual(self.records(), before)

    def test_new_foreign_authority_is_not_mistaken_for_an_owned_effect(self):
        location = pathlib.Path(self.fixture.registries['fleet_token'])
        document = json.loads(location.read_text())
        document['identities'].append({**document['identities'][0], 'token_sha256': 'f' * 64})
        location.write_text(json.dumps(document))
        before = self.records()
        with self.assertRaises(issuer.AuthorityError):
            self.restore()
        self.assertEqual(self.records(), before)

    def test_checkpoint_and_snapshot_identity_cannot_be_substituted(self):
        for changed in ({'checkpoint_sha256': '0' * 64}, {'snapshot_sha256': '0' * 64}, {'original_container_id': '0' * 64}):
            packet = self.packet('rollback_credentials', **self.checkpoint)
            packet.update(changed)
            with self.assertRaises(issuer.AuthorityError):
                issuer.perform(self.fixture.policy, packet)


class ReplacementPhysicalRollbackTest(unittest.TestCase):
    def setUp(self):
        self.agent = {'tenant_id': 'Tenant', 'alias': 'agent', 'runtime_key': 'runtime', 'host_id': 'host',
                      'runtime_mode': 'container', 'container_name': 'original', 'enabled': True, 'lifecycle_state': 'ready'}
        self.context = {'operation_id': '72000000-0000-4000-8000-000000000002', 'previous_agents': [self.agent],
            'request': {'kind': 'update', 'target': {'resource': 'agent', 'tenant_id': 'Tenant', 'alias': 'agent'},
                        'parameters': {'runtime_key': 'runtime', 'placement': {'mode': 'container', 'host_id': 'host', 'container_name': 'new'}}}}
        body = {'version': 1, 'operation_id': self.context['operation_id'], 'company_id': 'company',
                'target': self.context['request']['target'], 'previous_agents': [copy.deepcopy(self.agent)], 'previous_memberships': []}
        encoded = rollback.canonical(body)
        self.value = {**body, 'snapshot_canonical': encoded, 'snapshot_sha256': hashlib.sha256(encoded.encode()).hexdigest()}
        self.context['snapshot'] = {'compensation_snapshot': self.value}
        self.entry = {'snapshot_sha256': self.value['snapshot_sha256'], 'original_container_id': 'a' * 64,
                      'checkpoint_sha256': 'b' * 64, 'normal_certificate_sha256': 'c' * 64,
                      'normal_token_sha256': 'd' * 64, 'adapter_state': {'adapter_operation_id': None}, 'phase': 'captured'}
        self.executor = types.SimpleNamespace(context=self.context, policy={}, journal={'replacement_compensation': self.entry},
            save=mock.Mock(), agent=lambda: {**self.agent, 'container_name': 'new'})

    def test_snapshot_uses_literal_unicode_and_javascript_float_encoding(self):
        self.value['previous_agents'][0]['display_name'] = 'Árbol 🌳'
        self.value['previous_agents'][0]['extensions'] = [{'cpus': 1e-7}]
        body = {key: child for key, child in self.value.items() if key not in {'snapshot_canonical', 'snapshot_sha256'}}
        encoded = rollback.canonical(body).replace('1e-07', '1e-7')
        self.value.update(snapshot_canonical=encoded, snapshot_sha256=hashlib.sha256(encoded.encode()).hexdigest())
        self.assertEqual(rollback.snapshot(self.context), self.value)
        self.value['previous_agents'][0]['enabled'] = 1
        with self.assertRaisesRegex(SafeFailure, 'snapshot missing'):
            rollback.snapshot(self.context)

    def test_added_trusted_baseline_metadata_does_not_change_raw_preimage(self):
        self.context['previous_agents'][0] = {**self.agent, 'fleet_baseline': False}
        self.assertEqual(rollback.snapshot(self.context), self.value)

    def test_missing_original_never_removes_destination_or_revokes_authority(self):
        with mock.patch.object(rollback, 'original', side_effect=SafeFailure('replacement original unverified')), \
                mock.patch.object(container, 'discard_operation') as discard, \
                mock.patch.object(authority, 'rollback_credentials') as revoke:
            with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                rollback.compensate(self.executor)
        discard.assert_not_called()
        revoke.assert_not_called()

    def test_same_container_after_credentials_preserves_original_during_rollback(self):
        self.context['request']['parameters']['placement']['container_name'] = 'original'
        self.executor.agent = lambda: self.agent
        self.executor.journal.update(attempted=['credentials', 'stop'], bootstrap_credentials='9' * 64)
        result = {'checkpoint_sha256': 'b' * 64, 'authority_sha256': 'e' * 64,
                  'shared_authority_preserved': True, 'created_authority_revoked': True, 'revoked_credentials': []}
        state = {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': None}
        with mock.patch.object(rollback, 'original', return_value=(self.agent, {'Id': 'a' * 64})), \
                mock.patch.object(rollback, 'normal_pins', return_value={key: self.entry[key] for key in ('normal_certificate_sha256', 'normal_token_sha256')}), \
                mock.patch.object(rollback, 'restore_source', return_value={'generation': 'f' * 64}), \
                mock.patch.object(container, 'adapter_restart_state', return_value=state), \
                mock.patch.object(container, 'stop_running_adapter') as stop, \
                mock.patch.object(container, 'discard_operation') as discard, \
                mock.patch.object(container, 'restore_existing_adapter', return_value={'runtime_digest': '1' * 64}), \
                mock.patch.object(authority, 'rollback_credentials', return_value=result) as revoke:
            proof = rollback.compensate(self.executor)
        self.assertIsNotNone(proof)
        self.assertEqual(proof['replacement_restored']['original_container_id'], 'a' * 64)
        self.assertEqual(revoke.call_count, 2)
        discard.assert_not_called()
        stop.assert_not_called()

    def test_same_container_without_checkpoint_never_falls_back_to_generic_revocation(self):
        self.context['request']['parameters']['placement']['container_name'] = 'original'
        self.executor.journal.clear()
        with mock.patch.object(container, 'discard_operation') as discard, \
                mock.patch.object(authority, 'rollback_credentials') as revoke:
            with self.assertRaisesRegex(SafeFailure, 'authority unverified'):
                rollback.compensate(self.executor)
        discard.assert_not_called()
        revoke.assert_not_called()

    def test_same_container_without_an_admitted_original_keeps_its_existing_compensation_path(self):
        self.context['request']['parameters']['placement']['container_name'] = 'original'
        self.context['snapshot'].pop('compensation_snapshot')
        for lifecycle in ('draft', 'failed', 'auth_pending'):
            with self.subTest(lifecycle=lifecycle), mock.patch.object(authority, 'checkpoint_credentials') as checkpoint:
                self.agent.update(enabled=False, lifecycle_state=lifecycle)
                rollback.capture(self.executor)
                self.assertIsNone(rollback.compensate(self.executor))
            checkpoint.assert_not_called()

    def test_legacy_early_restore_requires_absent_snapshot_and_no_credential_effects(self):
        self.context['request']['parameters']['placement']['container_name'] = 'original'
        self.context['restore_previous_runtime'] = True
        self.context['snapshot'].pop('compensation_snapshot')
        self.executor.journal.clear()
        self.executor.journal['attempted'] = ['prepare', 'stop']
        self.assertIsNone(rollback.compensate(self.executor))
        self.executor.journal['bootstrap_credentials'] = '9' * 64
        with self.assertRaisesRegex(SafeFailure, 'snapshot missing'):
            rollback.compensate(self.executor)
        self.executor.journal.pop('bootstrap_credentials')
        self.context['snapshot']['compensation_snapshot'] = {}
        with self.assertRaisesRegex(SafeFailure, 'snapshot missing'):
            rollback.compensate(self.executor)

    def test_same_container_captures_authority_before_effects_without_a_retirement_receipt(self):
        import fleet_executor_replacement as replacement
        self.context['request']['parameters']['placement']['container_name'] = 'original'
        self.executor.journal.clear()
        receipt = {'previous': {'container_id': 'a' * 64}}
        state = {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': None}
        with mock.patch.object(replacement, 'capture_previous', return_value=receipt), \
                mock.patch.object(rollback, 'original', return_value=(self.agent, {})), \
                mock.patch.object(rollback, 'normal_pins', return_value={key: self.entry[key] for key in ('normal_certificate_sha256', 'normal_token_sha256')}), \
                mock.patch.object(container, 'adapter_restart_state', return_value=state), \
                mock.patch.object(authority, 'checkpoint_credentials', return_value={'checkpoint_sha256': 'b' * 64}) as checkpoint:
            rollback.capture(self.executor)
        checkpoint.assert_called_once()
        self.assertEqual(self.executor.journal['replacement_compensation']['phase'], 'captured')
        self.assertNotIn('replacement_retirement', self.executor.journal)
        self.assertNotIn('attempted', self.executor.journal)

    def test_an_update_that_failed_before_its_capture_restores_the_stopped_original(self):
        import fleet_executor_replacement as replacement
        self.context['request']['parameters']['placement']['container_name'] = 'original'
        self.executor.agent = lambda: self.agent
        self.executor.journal.clear()
        self.executor.journal.update(expected_applied='1' * 64, request_sha256='2' * 64)
        stopped = {'adapter_running': False}
        with mock.patch.object(replacement, 'capture_previous', return_value={'previous': {'container_id': 'a' * 64}}), \
                mock.patch.object(container, 'adapter_restart_state', return_value=stopped):
            with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                rollback.capture(self.executor)
        self.assertNotIn('replacement_compensation', self.executor.journal)
        result = {'checkpoint_sha256': 'b' * 64, 'authority_sha256': 'e' * 64,
                  'shared_authority_preserved': True, 'created_authority_revoked': True, 'revoked_credentials': []}
        with mock.patch.object(replacement, 'capture_previous', return_value={'previous': {'container_id': 'a' * 64}}), \
                mock.patch.object(rollback, 'original', return_value=(self.agent, {'Id': 'a' * 64})), \
                mock.patch.object(rollback, 'normal_pins', return_value={key: self.entry[key] for key in ('normal_certificate_sha256', 'normal_token_sha256')}), \
                mock.patch.object(rollback, 'restore_source', return_value={'generation': 'f' * 64}), \
                mock.patch.object(container, 'adapter_restart_state', return_value=stopped), \
                mock.patch.object(container, 'stop_running_adapter') as stop, \
                mock.patch.object(container, 'discard_operation') as discard, \
                mock.patch.object(container, 'docker', return_value='a' * 64), \
                mock.patch.object(container, 'restore_existing_adapter', return_value={'runtime_digest': '1' * 64}) as restore, \
                mock.patch.object(authority, 'checkpoint_credentials', return_value={'checkpoint_sha256': 'b' * 64}), \
                mock.patch.object(authority, 'rollback_credentials', return_value=result):
            proof = rollback.compensate(self.executor)
        entry = self.executor.journal['replacement_compensation']
        self.assertIs(entry['late_capture'], True)
        self.assertEqual(entry['phase'], 'restored')
        self.assertEqual(proof['replacement_restored']['original_container_id'], 'a' * 64)
        self.assertIs(restore.call_args.kwargs['was_running'], True)
        self.assertIsNone(restore.call_args.kwargs['operation_id'])
        discard.assert_not_called()
        stop.assert_not_called()

    def test_a_late_capture_never_runs_after_any_effect(self):
        self.context['request']['parameters']['placement']['container_name'] = 'original'
        for journal in ({'attempted': ['stop']}, {'runtime_launch_attempted': True}, {'compensated': {'runtime': True}}):
            with self.subTest(journal=journal), mock.patch.object(rollback, 'capture') as capture:
                self.executor.journal.clear()
                self.executor.journal.update(journal)
                with self.assertRaisesRegex(SafeFailure, 'authority unverified'):
                    rollback.compensate(self.executor)
                capture.assert_not_called()

    def test_same_container_stops_only_the_current_operations_adapter(self):
        state = {'adapter_running': True, 'adapter_bootstrap': True, 'adapter_operation_id': self.context['operation_id']}
        with mock.patch.object(container, 'adapter_restart_state', return_value=state), \
                mock.patch.object(container, 'stop_running_adapter') as stop:
            rollback.preserve_container(self.executor, self.agent, {'Id': 'a' * 64}, self.entry)
        stop.assert_called_once_with(self.agent, {'Id': 'a' * 64})
        self.assertEqual(self.entry['phase'], 'stopping_operation_adapter')
        state['adapter_operation_id'] = '73000000-0000-4000-8000-000000000003'
        with mock.patch.object(container, 'adapter_restart_state', return_value=state), \
                mock.patch.object(container, 'stop_running_adapter') as stop:
            with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                rollback.preserve_container(self.executor, self.agent, {'Id': 'a' * 64}, self.entry)
        stop.assert_not_called()
        with mock.patch.object(container, 'adapter_restart_state', return_value={}), \
                mock.patch.object(container, 'stop_running_adapter') as stop:
            with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                rollback.preserve_container(self.executor, self.agent, {'Id': 'a' * 64}, self.entry)
        stop.assert_not_called()

    def test_restoration_receipt_and_restart_intent_survive_replay(self):
        from fleet_executor_templates import resolve_profile
        self.context['trusted_accounts'] = [{'id': 'account', 'provider': 'codex', 'external_account_id': 'provider-identity',
            'payer_tenant_id': 'Tenant', 'shared_with_pool': False, 'enabled': True}]
        self.executor.policy.update(profiles={}, profile_templates=[{'provider': 'codex', 'runtime_user': 'cauce',
            'path_root': '/profiles', 'command': '/bin/provider', 'command_sha256': '1' * 64,
            'runtime_mode': 'container', 'container_name': 'original'}])
        approved = {**self.agent, 'harness_id': 'codex', 'runtime_user': 'cauce', 'primary_account_id': 'account',
                    '_placement': {'profile_root': '/profiles'}}
        observed = []
        def original(executor, entry, *, restarting=False):
            observed.append(restarting)
            return approved, {}
        def restore(policy, agent, **kwargs):
            binding = resolve_profile(policy, agent)
            self.assertEqual(binding['identity'], 'provider-identity')
            self.assertEqual(binding['container_name'], 'original')
            self.assertIs(kwargs['allow_refresh'], False)
            return {'runtime_digest': '1' * 64}
        result = {'checkpoint_sha256': 'b' * 64, 'authority_sha256': 'e' * 64,
                  'shared_authority_preserved': True, 'created_authority_revoked': True, 'revoked_credentials': []}
        with mock.patch.object(rollback, 'original', side_effect=original), \
                mock.patch.object(rollback, 'normal_pins', return_value={key: self.entry[key] for key in ('normal_certificate_sha256', 'normal_token_sha256')}), \
                mock.patch.object(rollback, 'restore_source', return_value={'generation': 'f' * 64}), \
                mock.patch.object(container, 'discard_operation'), mock.patch.object(container, 'inspect_container', return_value=None), \
                mock.patch.object(container, 'restore_existing_adapter', side_effect=restore), \
                mock.patch.object(authority, 'rollback_credentials', return_value=result):
            first = rollback.compensate(self.executor)
            second = rollback.compensate(self.executor)
        self.assertEqual(first, second)
        self.assertEqual(observed, [False, True, True, True])
        self.assertIs(self.entry['original_restart_attempted'], True)
        binding = ['fleet-replacement-restored:v1', self.value['snapshot_sha256'], 'a' * 64, 'b' * 64, 'e' * 64]
        self.assertEqual(first['runtime_digest'], hashlib.sha256('\n'.join(binding).encode()).hexdigest())


class RestoreSourceRebaseTest(unittest.TestCase):
    """Production, 26-oct: while Hades waited to be compensated, the retire of zz-canary-144 on the same host published
    its own applied generation. The restoration was rendered from the current fleet (it already lacked the canary), yet
    restore_source refused every attempt with replacement_original_unverified because the applied generation was not
    one Hades' journal knew. It rebases only when nothing but Hades differs."""

    def setUp(self):
        import tempfile
        sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
        from fleet_runtime_materialization import load_applied_fleet, materialize
        from test_export_fleet_snapshot import agent, membership, source
        self.materialize, self.load_applied = materialize, load_applied_fleet
        self.agent, self.membership, self.source = agent, membership, source
        directory = tempfile.TemporaryDirectory(dir='/var/tmp')
        self.addCleanup(directory.cleanup)
        self.state = pathlib.Path(directory.name)

    def row(self, alias, **changes):
        return {**self.agent(alias), 'runtime_key': alias, 'primary_room_id': 'grp.steven', 'lifecycle_state': 'ready',
                **changes}

    def fleet(self, *rows):
        return self.source(agents=list(rows), memberships=[self.membership(row['alias']) for row in rows])

    def publish(self, snapshot):
        from fleet_runtime_apply import publish_applied
        receipt = self.materialize(snapshot, {}, self.state)
        current = self.load_applied(self.state)['generation'] if (self.state / 'applied-fleet.json').exists() else None
        publish_applied(self.state, receipt['generation'], current)
        return receipt['generation']

    def executor(self, snapshot, expected):
        executor = types.SimpleNamespace(state=self.state, saves=0,
            journal={'expected_applied': expected, 'replacement_compensation': {}},
            context={'snapshot': snapshot, 'request': {'parameters': {'runtime_key': 'hades'}}},
            materialize_snapshot=lambda value: self.materialize(
                {key: child for key, child in value.items() if key != 'compensation_snapshot'}, {}, self.state))
        executor.save = lambda: setattr(executor, 'saves', executor.saves + 1)
        return executor

    def restore(self, current_fleet, expected):
        before = self.row('hades')
        value = {'previous_agents': [before], 'previous_memberships': [self.membership('hades')]}
        executor = self.executor(current_fleet, expected)
        return executor, lambda: rollback.restore_source(executor, value)

    def test_a_later_operation_on_another_agent_is_kept_and_hades_is_restored(self):
        failed = self.row('hades', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), self.row('hades'), self.row('canary')))
        # The canary was retired by another operation after Hades' update started; the database fleet already says so.
        later = self.publish(self.fleet(self.row('kant'), failed, self.row('canary', enabled=False, lifecycle_state='failed')))
        self.assertNotEqual(expected, later)
        current = self.fleet(self.row('kant'), failed, self.row('canary', enabled=False, lifecycle_state='failed'))
        executor, restore = self.restore(current, expected)
        receipt = restore()
        applied = self.load_applied(self.state)
        self.assertEqual(applied['generation'], receipt['generation'])
        snapshot = json.loads((self.state / 'generations' / receipt['generation'] / 'flota.json').read_bytes())
        self.assertIn('hades', snapshot['fleet'])
        self.assertIn('canary', snapshot['retired'])
        self.assertEqual(executor.journal['replacement_compensation']['rebased_applied'],
                         [{'from': later, 'to': receipt['generation']}])
        # A replay finds its own generation applied and neither rebases again nor republishes anything else.
        self.assertEqual(restore(), receipt)
        self.assertEqual(len(executor.journal['replacement_compensation']['rebased_applied']), 1)

    def test_an_applied_change_to_another_agent_that_the_restoration_lacks_is_refused(self):
        failed = self.row('hades', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), self.row('hades')))
        # The host applied a fleet where kant is disabled; the restoration would silently re-enable it.
        foreign = self.publish(self.fleet(self.row('kant', enabled=False, lifecycle_state='failed'), failed))
        executor, restore = self.restore(self.fleet(self.row('kant'), failed), expected)
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
            restore()
        self.assertEqual(self.load_applied(self.state)['generation'], foreign)
        self.assertNotIn('rebased_applied', executor.journal['replacement_compensation'])

    def test_an_extra_agent_only_on_the_host_is_refused(self):
        failed = self.row('hades', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), self.row('hades')))
        foreign = self.publish(self.fleet(self.row('kant'), failed, self.row('argos')))
        _, restore = self.restore(self.fleet(self.row('kant'), failed), expected)
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
            restore()
        self.assertEqual(self.load_applied(self.state)['generation'], foreign)

    def test_a_system_principal_only_on_the_host_is_refused(self):
        failed = self.row('hades', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), self.row('hades')))
        # A principal without an agent row sits under a map the rebase never strips: it must match verbatim.
        extra = self.source(agents=[self.row('kant'), failed],
                            memberships=[self.membership('kant'), self.membership('hades'), self.membership('ops-bot')])
        foreign = self.publish(extra)
        _, restore = self.restore(self.fleet(self.row('kant'), failed), expected)
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
            restore()
        self.assertEqual(self.load_applied(self.state)['generation'], foreign)

    def test_an_artifact_edited_on_disk_after_publication_is_not_compared(self):
        failed = self.row('hades', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), self.row('hades'), self.row('canary')))
        later = self.publish(self.fleet(self.row('kant'), failed))
        receipt = self.materialize(self.fleet(self.row('kant'), self.row('hades')), {}, self.state)
        applied = self.load_applied(self.state)
        self.assertNotEqual(expected, later)
        self.assertTrue(rollback.differs_only_in_runtime(self.state, applied, receipt, 'hades'))
        edited = self.state / 'generations' / later / 'flota.json'
        edited.write_bytes(edited.read_bytes().replace(b'kant', b'kanz'))
        with self.assertRaises(ValueError):
            rollback.differs_only_in_runtime(self.state, applied, receipt, 'hades')

    def test_a_tampered_applied_artifact_is_refused(self):
        failed = self.row('hades', enabled=False, lifecycle_state='failed')
        expected = self.publish(self.fleet(self.row('kant'), self.row('hades'), self.row('canary')))
        later = self.publish(self.fleet(self.row('kant'), failed))
        current = self.fleet(self.row('kant'), failed)
        executor, restore = self.restore(current, expected)
        with mock.patch.object(rollback, '_artifact', side_effect=ValueError):
            with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
                restore()
        self.assertEqual(self.load_applied(self.state)['generation'], later)


class InPlaceRecreationRollbackTest(unittest.TestCase):
    """Production, 25-oct: adding pids 512 to Hades recreated its container under the same name; admission failed and the
    compensation looped on replacement_original_unverified because the captured original no longer existed."""

    OPERATION = '72000000-0000-4000-8000-000000000002'
    IMAGE = 'sha256:' + '1' * 64

    def setUp(self):
        import fleet_executor_replacement as replacement
        self.replacement = replacement
        self.agent = {'tenant_id': 'Tenant', 'alias': 'agent', 'runtime_key': 'runtime', 'host_id': 'host',
                      'runtime_mode': 'container', 'container_name': 'original', 'enabled': True, 'lifecycle_state': 'ready',
                      'extensions': []}
        self.desired = {**self.agent, 'extensions': [{'type': 'resources', 'pids': 512}]}
        self.context = {'operation_id': self.OPERATION, 'previous_agents': [self.agent],
            'request': {'kind': 'update', 'target': {'resource': 'agent', 'tenant_id': 'Tenant', 'alias': 'agent'},
                        'parameters': {'runtime_key': 'runtime', 'placement': {'mode': 'container', 'host_id': 'host',
                                                                                'container_name': 'original'}}}}
        body = {'version': 1, 'operation_id': self.OPERATION, 'company_id': 'company', 'target': self.context['request']['target'],
                'previous_agents': [copy.deepcopy(self.agent)], 'previous_memberships': []}
        encoded = rollback.canonical(body)
        self.value = {**body, 'snapshot_canonical': encoded, 'snapshot_sha256': hashlib.sha256(encoded.encode()).hexdigest()}
        self.context['snapshot'] = {'compensation_snapshot': self.value}
        self.volumes = [{'name': 'original-state', 'created_at': '2026-10-25T22:30:00Z', 'identity_sha256': '5' * 64}]
        self.pins = {'a' * 64: {'container_id': 'a' * 64, 'created_at': 'A', 'started_at': 'A', 'image_id': self.IMAGE,
                                'configuration_sha256': '6' * 64}}
        # Exactly the production journal: captured before stop, every step attempted up to admission.
        self.entry = {'snapshot_sha256': self.value['snapshot_sha256'], 'original_container_id': 'a' * 64,
                      'original': {'previous': self.pins['a' * 64], 'volumes': self.volumes},
                      'checkpoint_sha256': 'b' * 64, 'normal_certificate_sha256': 'c' * 64, 'normal_token_sha256': 'd' * 64,
                      'adapter_state': {'adapter_running': True, 'adapter_bootstrap': False, 'adapter_operation_id': None},
                      'phase': 'captured'}
        self.journal = {'replacement_compensation': self.entry, 'runtime_launch_attempted': True, 'runtime': 'e' * 64,
                        'attempted': ['stop', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify', 'admission']}
        self.policy = {'host_id': 'host', 'executor_user': 'cauce'}
        self.executor = types.SimpleNamespace(context=self.context, policy=self.policy, journal=self.journal,
                                              save=mock.Mock(), agent=lambda: self.desired)
        self.approved = {**self.agent, '_placement': {'image': 'sha256:' + '2' * 64}}
        owner = container.expected_labels(self.policy, self.agent)
        self.destination = {'Id': 'f' * 64, 'Image': 'sha256:' + '2' * 64, 'State': {'Running': True},
                            'Config': {'Labels': {**owner, container.OPERATION_LABEL: self.OPERATION}}}
        self.rebuilt = {'Id': '9' * 64, 'Image': self.IMAGE, 'State': {'Running': False},
                        'Config': {'Labels': {**owner, rollback.RESTORED_LABEL: self.OPERATION},
                                   'Entrypoint': ['/bin/sleep'], 'Cmd': ['infinity'], 'User': '0'}}
        self.pins['9' * 64] = {'container_id': '9' * 64, 'created_at': 'B', 'started_at': 'B',
                               'image_id': self.IMAGE, 'configuration_sha256': '7' * 64}
        self.containers = [self.destination]
        self.started = []

    def docker(self, *arguments):
        if arguments[:2] == ('ps', '-a'):
            return b'' if arguments[-1] == 'id=' + 'a' * 64 else b'x'
        if arguments[:2] == ('image', 'inspect'):
            return json.dumps([{'Id': arguments[2]}]).encode()
        if arguments[0] == 'start' and self.containers and arguments[1] == self.containers[0]['Id']:
            self.started.append(arguments[1])
            self.containers[0]['State'] = {'Running': True}
            return b''
        raise AssertionError(arguments)

    def inspect(self, _name):
        return self.containers[0] if self.containers else None

    def patches(self, stack, **overrides):
        def discard(policy, agent, operation):
            self.assertEqual((agent, operation), (self.desired, self.OPERATION))
            self.containers.clear()
        def create(policy, agent, binds=None, operation_id=None, extra_labels=None):
            self.assertEqual(agent['_placement']['image'], self.IMAGE)
            self.assertEqual(agent['extensions'], [])
            self.assertIsNone(operation_id)
            self.assertEqual(extra_labels, {rollback.RESTORED_LABEL: self.OPERATION})
            self.containers.append(self.rebuilt)
            return self.rebuilt
        values = {'docker': mock.patch.object(container, 'docker', side_effect=self.docker),
                  'inspect': mock.patch.object(container, 'inspect_container', side_effect=self.inspect),
                  'discard': mock.patch.object(container, 'discard_operation', side_effect=discard),
                  'create': mock.patch.object(container, 'create_container', side_effect=create),
                  'validate': mock.patch.object(container, 'validate_container'),
                  'approve': mock.patch.object(rollback, 'approve_agent', return_value=self.approved),
                  'volumes': mock.patch.object(self.replacement, 'volume_pins', return_value=self.volumes),
                  'pin': mock.patch.object(self.replacement, 'container_pin', side_effect=lambda observed: dict(self.pins[observed['Id']]))}
        values.update(overrides)
        return {name: stack.enter_context(patch) for name, patch in values.items()}

    def test_production_journal_rebuilds_the_captured_original_and_completes_the_restoration(self):
        import contextlib
        result = {'checkpoint_sha256': 'b' * 64, 'authority_sha256': 'e' * 64,
                  'shared_authority_preserved': True, 'created_authority_revoked': True, 'revoked_credentials': []}
        def observation(policy, previous):
            self.assertEqual(previous, self.agent)
            return self.approved, self.inspect(previous['container_name'])
        def restore(policy, agent, **options):
            self.assertEqual(options, {'was_running': True, 'bootstrap': False, 'operation_id': None, 'allow_refresh': False,
                                       'original_image': self.IMAGE})
            self.pins['9' * 64]['started_at'] = 'C'
            return {'runtime_digest': '1' * 64}
        with contextlib.ExitStack() as stack:
            mocks = self.patches(stack)
            stack.enter_context(mock.patch.object(self.replacement, 'approved_observation', side_effect=observation))
            stack.enter_context(mock.patch.object(rollback, 'normal_pins', return_value={key: self.entry[key]
                for key in ('normal_certificate_sha256', 'normal_token_sha256')}))
            stack.enter_context(mock.patch.object(rollback, 'restore_source', return_value={'generation': 'f' * 64}))
            stack.enter_context(mock.patch.object(container, 'adapter_restart_state', return_value={'adapter_running': False}))
            stack.enter_context(mock.patch.object(container, 'restore_existing_adapter', side_effect=restore))
            revoke = stack.enter_context(mock.patch.object(authority, 'rollback_credentials', return_value=result))
            proof = rollback.compensate(self.executor)
            replay = rollback.compensate(self.executor)
        self.assertEqual(proof, replay)
        mocks['discard'].assert_called_once()
        mocks['create'].assert_called_once()
        # Started idle once, before it is pinned; the adapter is then restored as for a preserved original.
        self.assertEqual(self.started, ['9' * 64])
        self.assertEqual(self.entry['phase'], 'restored')
        self.assertEqual(self.entry['recreated_original']['container_id'], '9' * 64)
        # The evidence and the authority stay bound to the captured original, never to the rebuild.
        self.assertEqual(proof['replacement_restored']['original_container_id'], 'a' * 64)
        self.assertEqual(revoke.call_args_list[0].args[3]['original_container_id'], 'a' * 64)
        self.assertEqual(self.containers, [self.rebuilt])

    def test_a_failed_adapter_restoration_journals_why_it_failed(self):
        """Production, 26-oct (argos): a stray cache inside the original's release made every restoration fail as
        'original unverified'; the journal named only the function, so the reason had to be rebuilt by hand."""
        import contextlib
        def observation(policy, previous):
            return self.approved, self.inspect(previous['container_name'])
        result = {'checkpoint_sha256': 'b' * 64, 'authority_sha256': 'e' * 64,
                  'shared_authority_preserved': True, 'created_authority_revoked': True, 'revoked_credentials': []}
        failure = SafeFailure('release tree entry is not a trusted regular file or directory')
        with contextlib.ExitStack() as stack:
            self.patches(stack)
            stack.enter_context(mock.patch.object(self.replacement, 'approved_observation', side_effect=observation))
            stack.enter_context(mock.patch.object(rollback, 'normal_pins', return_value={key: self.entry[key]
                for key in ('normal_certificate_sha256', 'normal_token_sha256')}))
            stack.enter_context(mock.patch.object(rollback, 'restore_source', return_value={'generation': 'f' * 64}))
            stack.enter_context(mock.patch.object(container, 'adapter_restart_state', return_value={'adapter_running': False}))
            stack.enter_context(mock.patch.object(container, 'restore_existing_adapter', side_effect=failure))
            stack.enter_context(mock.patch.object(authority, 'rollback_credentials', return_value=result))
            with self.assertRaisesRegex(SafeFailure, 'authority unverified'):
                rollback.compensate(self.executor)
        self.assertEqual(self.entry['diagnostic']['phase'], 'restoring_adapter')
        self.assertEqual(self.entry['diagnostic']['reason'], str(failure))

    def test_an_interrupted_rebuild_is_adopted_only_with_this_operations_provenance(self):
        import contextlib
        self.containers[:] = [self.rebuilt]
        with contextlib.ExitStack() as stack:
            mocks = self.patches(stack)
            rollback.recreate_original(self.executor, self.entry)
        mocks['discard'].assert_not_called()
        mocks['create'].assert_not_called()
        self.assertEqual(self.entry['recreated_original'], self.pins['9' * 64])
        self.entry.pop('recreated_original')
        self.rebuilt['Config']['Labels'][rollback.RESTORED_LABEL] = '73000000-0000-4000-8000-000000000003'
        with contextlib.ExitStack() as stack:
            mocks = self.patches(stack)
            with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                rollback.recreate_original(self.executor, self.entry)
        mocks['discard'].assert_not_called()
        mocks['create'].assert_not_called()
        self.assertNotIn('recreated_original', self.entry)
        self.assertEqual(self.entry['diagnostic']['exception_type'], 'ValueError')

    def test_a_rebuild_interrupted_after_its_start_is_adopted_without_another_start(self):
        import contextlib
        self.rebuilt['State'] = {'Running': True}
        self.containers[:] = [self.rebuilt]
        with contextlib.ExitStack() as stack:
            mocks = self.patches(stack)
            rollback.recreate_original(self.executor, self.entry)
        mocks['create'].assert_not_called()
        self.assertEqual(self.started, [])
        self.assertEqual(self.entry['recreated_original'], self.pins['9' * 64])

    def test_a_rebuild_without_the_idle_command_is_never_started(self):
        import contextlib
        self.rebuilt['Config']['Cmd'] = ['/bin/sh']
        self.containers[:] = [self.rebuilt]
        with contextlib.ExitStack() as stack:
            self.patches(stack)
            with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                rollback.recreate_original(self.executor, self.entry)
        self.assertEqual(self.started, [])
        self.assertNotIn('recreated_original', self.entry)

    def test_unrecoverable_rebuild_keeps_the_destination_and_fails_closed(self):
        import contextlib
        cases = {'foreign container': {'containers': [{**self.destination, 'Config': {'Labels': {
                     **self.destination['Config']['Labels'], container.OPERATION_LABEL: '73000000-0000-4000-8000-000000000003'}}}]},
                 'another owner': {'containers': [{**self.destination, 'Config': {'Labels': {container.OPERATION_LABEL: self.OPERATION}}}]},
                 'runtime never attempted': {'attempted': ['stop', 'artifacts', 'credentials']},
                 'volumes changed': {'volumes': [{**self.volumes[0], 'identity_sha256': '0' * 64}]},
                 'image pruned': {'image': True},
                 'shared placement': {'approved': {**self.approved, '_placement': {'ownership': 'shared'}}}}
        for name, case in cases.items():
            with self.subTest(name), contextlib.ExitStack() as stack:
                self.setUp()
                if 'containers' in case:
                    self.containers[:] = case['containers']
                if 'attempted' in case:
                    self.journal['attempted'] = case['attempted']
                overrides = {}
                if 'volumes' in case:
                    overrides['volumes'] = mock.patch.object(self.replacement, 'volume_pins', return_value=case['volumes'])
                if 'image' in case:
                    def pruned(*arguments):
                        if arguments[:2] == ('image', 'inspect'):
                            raise SafeFailure('docker command failed')
                        return self.docker(*arguments)
                    overrides['docker'] = mock.patch.object(container, 'docker', side_effect=pruned)
                if 'approved' in case:
                    overrides['approve'] = mock.patch.object(rollback, 'approve_agent', return_value=case['approved'])
                mocks = self.patches(stack, **overrides)
                with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                    rollback.recreate_original(self.executor, self.entry)
                mocks['discard'].assert_not_called()
                mocks['create'].assert_not_called()
                self.assertNotIn('recreated_original', self.entry)
                self.assertIn('diagnostic', self.entry)

    def test_a_present_original_or_a_renamed_replacement_never_rebuilds(self):
        import contextlib
        def present(*arguments):
            return b'a' * 64 if arguments[:2] == ('ps', '-a') else self.docker(*arguments)
        with contextlib.ExitStack() as stack:
            mocks = self.patches(stack, docker=mock.patch.object(container, 'docker', side_effect=present))
            rollback.recreate_original(self.executor, self.entry)
        mocks['create'].assert_not_called()
        self.desired = {**self.desired, 'container_name': 'new'}
        with contextlib.ExitStack() as stack:
            mocks = self.patches(stack)
            rollback.recreate_original(self.executor, self.entry)
        mocks['docker'].assert_not_called()
        mocks['create'].assert_not_called()
        self.assertNotIn('recreated_original', self.entry)

    def refreshed(self, root, **changes):
        """Production, 26-oct (Praxis teseo): the update's image refresh recreated the container in place and kept the
        creator's operation label; only the refresh receipt this operation journaled proves it is the destination."""
        self.policy['roots'] = {'state': str(root)}
        self.destination['Config']['Labels'][container.OPERATION_LABEL] = '71000000-0000-4000-8000-000000000001'
        directory = root / 'operations' / self.OPERATION
        directory.mkdir(parents=True, mode=0o700)
        receipt = {'status': 'succeeded', 'container_id': 'f' * 64, 'previous_id': 'a' * 64, 'previous_image': self.IMAGE,
                   'container_name': 'original', 'runtime_key': 'runtime', 'tenant_id': 'Tenant', 'host_id': 'host', **changes}
        filename = directory / 'image-refresh-runtime.json'
        filename.write_text(json.dumps(receipt))
        filename.chmod(0o600)
        removed = []
        def docker(*arguments):
            if arguments[:2] == ('rm', '-f'):
                removed.append(arguments[2])
                self.containers.clear()
                return b''
            return self.docker(*arguments)
        return removed, mock.patch.object(container, 'docker', side_effect=docker)

    def test_an_image_refreshed_destination_is_removed_by_its_receipt_and_the_original_rebuilt(self):
        import contextlib
        import tempfile
        with tempfile.TemporaryDirectory() as root, contextlib.ExitStack() as stack:
            removed, docker = self.refreshed(pathlib.Path(root))
            mocks = self.patches(stack, docker=docker)
            rollback.recreate_original(self.executor, self.entry)
        self.assertEqual(removed, ['f' * 64])
        mocks['create'].assert_called_once()
        self.assertEqual(self.entry['recreated_original']['container_id'], '9' * 64)

    def test_a_refresh_receipt_for_another_container_never_removes_the_destination(self):
        import contextlib
        import tempfile
        for changes in ({'container_id': '8' * 64}, {'previous_id': '8' * 64}, {'status': 'prepared'}, {'tenant_id': 'Other'}):
            with self.subTest(changes=changes), tempfile.TemporaryDirectory() as root, contextlib.ExitStack() as stack:
                self.containers[:] = [self.destination]
                self.entry.pop('diagnostic', None)
                removed, docker = self.refreshed(pathlib.Path(root), **changes)
                mocks = self.patches(stack, docker=docker)
                with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                    rollback.recreate_original(self.executor, self.entry)
                self.assertEqual(removed, [])
                mocks['create'].assert_not_called()
                self.assertNotIn('recreated_original', self.entry)

    def test_the_rebuild_pin_replaces_the_captured_pin_in_original_verification(self):
        observed = {'Id': '9' * 64}
        self.entry['recreated_original'] = dict(self.pins['9' * 64])
        with mock.patch.object(self.replacement, 'approved_observation', return_value=(self.approved, observed)), \
                mock.patch.object(self.replacement, 'volume_pins', return_value=self.volumes), \
                mock.patch.object(self.replacement, 'container_pin', side_effect=lambda value: dict(self.pins[value['Id']])):
            self.assertEqual(rollback.original(self.executor, self.entry), (self.approved, observed))
            self.pins['9' * 64]['configuration_sha256'] = '0' * 64
            with self.assertRaisesRegex(SafeFailure, 'original unverified'):
                rollback.original(self.executor, self.entry)


class ReplacementLocalCredentialCleanupTest(unittest.TestCase):
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
        fixture.snapshot.write_text(json.dumps({'fleet': {'physical-a': {'tenant': 'Equipo_42', 'alias': 'wire_a', 'enabled': True}},
            'bootstrap': {'physical-a': {'tenant': 'Equipo_42', 'alias': 'wire_a', 'enabled': False,
                                         'admission': False, 'lifecycleState': 'provisioning'}}}))
        normal_manifest = fixture.root / 'normal.yaml'
        normal_manifest.write_text('metadata:\n  name: physical-a\nspec:\n  tenant: Equipo_42\n  alias: wire_a\n')
        self.normal = authority.prepare(fixture.policy, fixture.context, fixture.agent,
                                        fixture.snapshot, normal_manifest, bootstrap=False)
        self.advance('52000000-0000-4000-8000-000000000003')
        self.executor = types.SimpleNamespace(policy=fixture.policy, context=fixture.context,
            agent=lambda: fixture.agent, save=mock.Mock())
        self.entry = {'snapshot_sha256': 'b' * 64, 'original_container_id': 'c' * 64,
                      **rollback.normal_pins(self.executor, fixture.agent)}
        self.entry.update(authority.checkpoint_credentials(fixture.policy, fixture.context, fixture.agent, self.entry))
        self.issued = fixture.prepare()
        self.proof = authority.rollback_credentials(fixture.policy, fixture.context, fixture.agent, self.entry)

    def advance(self, identity):
        fixture = self.fixture
        fixture.scope.update(operation_id=identity, claim_epoch=fixture.scope['claim_epoch'] + 1)
        fixture.context.update(operation_id=identity, request={'parameters': {'runtime_key': 'physical-a'}})

    def test_issued_pair_is_removed_and_next_operation_can_prepare_again(self):
        fixture = self.fixture
        rollback.cleanup_credentials(self.executor, self.entry, self.proof['revoked_credentials'])
        self.assertFalse((pathlib.Path(fixture.policy['roots']['pki']) / 'bootstrap' / 'physical-a').exists())
        self.assertFalse((pathlib.Path(fixture.policy['roots']['tokens']) / 'bootstrap' / 'physical-a.token').exists())
        self.assertEqual(authority.proof_for(fixture.policy, fixture.agent, bootstrap=False)['certificate_fingerprint'],
                         self.normal['certificate_fingerprint'])
        self.advance('53000000-0000-4000-8000-000000000004')
        next_proof = fixture.prepare()
        self.assertNotEqual(next_proof['certificate_fingerprint'], self.issued['certificate_fingerprint'])
        self.assertEqual(next_proof['provenance']['source'], 'issued')

    def test_partial_local_cleanup_replays_without_touching_shared_normal_pair(self):
        from fleet_executor_terminal_files import remove_file
        def interrupted(filename, *args):
            if filename.name.endswith('.key'):
                raise OSError('interrupted local cleanup')
            return remove_file(filename, *args)
        with mock.patch('fleet_executor_terminal_files.remove_file', side_effect=interrupted), self.assertRaises(OSError):
            rollback.cleanup_credentials(self.executor, self.entry, self.proof['revoked_credentials'])
        rollback.cleanup_credentials(self.executor, self.entry, self.proof['revoked_credentials'])
        rollback.cleanup_credentials(self.executor, self.entry, self.proof['revoked_credentials'])
        self.assertIs(self.entry['credential_cleanup']['bootstrap']['complete'], True)
        self.assertEqual(authority.proof_for(self.fixture.policy, self.fixture.agent, bootstrap=False)['certificate_fingerprint'],
                         self.normal['certificate_fingerprint'])


if __name__ == '__main__':
    unittest.main()
