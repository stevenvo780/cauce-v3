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
