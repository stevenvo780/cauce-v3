from __future__ import annotations

import copy
import hashlib
import json
import pathlib
import sys
import unittest
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import test_fleet_executor as fixtures


class PhysicalLifecycleTest(unittest.TestCase):
    setUp = fixtures.PhysicalExecutorTest.setUp
    tearDown = fixtures.PhysicalExecutorTest.tearDown
    run_step = fixtures.PhysicalExecutorTest.run_step
    save_policy = fixtures.PhysicalExecutorTest.save_policy
    configure_signer = fixtures.PhysicalExecutorTest.configure_signer
    configure_hooks = fixtures.PhysicalExecutorTest.configure_hooks

    def prepare(self):
        self.configure_signer()
        for step in ('artifacts', 'credentials', 'runtime'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')

    def lifecycle(self, kind):
        self.context['operation_id'] = str(uuid.uuid4())
        self.context['request'].update(kind=kind, parameters={})
        self.context['previous_agents'] = [copy.deepcopy(self.agent)]
        self.context['fenced_targets'] = [self.context['request']['target'].copy()]

    def revoke_hook(self, accepted=True, empty=False):
        driver = self.root / 'revoke.py'
        driver.write_text('import json,sys,pathlib\np=json.load(sys.stdin)\n'
            'r={k:p[k] for k in ("nonce","account_id","identity")}\n'
            'r.update({k:p["agent"][k] for k in ("tenant_id","alias","runtime_key")})\n'
            + ('r={}\n' if empty else 'r["revocation_verified"]=' + str(accepted) + '\n')
            + 'print(json.dumps(r))\n')
        self.policy['hooks']['revoke'] = {'executable': str(self.executable),
            'sha256': hashlib.sha256(self.executable.read_bytes()).hexdigest(), 'argv': [str(driver)],
            'files': {str(driver): hashlib.sha256(driver.read_bytes()).hexdigest()}, 'user': self.user}
        self.save_policy()

    def test_start_new_operation_prepares_bootstrap_without_prior_artifacts_step(self):
        self.configure_signer()
        self.lifecycle('start')
        result = self.run_step('runtime')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.roots['tokens'] / 'bootstrap/physical-one.token').exists())
        self.assertFalse((self.roots['state'] / 'applied-fleet.json').exists())

    def test_stop_artifacts_apply_fenced_snapshot_without_bootstrap_activation(self):
        self.prepare()
        self.lifecycle('stop')
        stopped = self.run_step('stop')
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.agent['lifecycle_state'] = 'draft'
        result = self.run_step('artifacts')
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.roots['state'] / 'applied-fleet.json').read_bytes())
        snapshot = json.loads((self.roots['state'] / 'generations' / receipt['generation'] / 'flota.json').read_bytes())
        self.assertNotIn('physical-one', snapshot['fleet'])

    def test_purge_requires_observed_revocation_and_preserves_provider_profile(self):
        self.prepare()
        self.lifecycle('purge')
        protected = self.root / 'shared-provider-profile'
        protected.mkdir(mode=0o700)
        protected_file = protected / 'auth.fixture'
        protected_file.write_text('private fixture')
        self.revoke_hook()
        self.assertNotEqual(self.run_step('purge').returncode, 0)
        self.assertEqual(self.run_step('stop').returncode, 0)
        self.assertNotEqual(self.run_step('purge').returncode, 0)
        for step in ('revoke', 'purge'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        self.assertFalse((self.roots['runtime'] / 'physical-one').exists())
        self.assertFalse((self.roots['pki'] / 'bootstrap/physical-one').exists())
        self.assertTrue(protected_file.exists())
        self.assertEqual(self.run_step('purge').returncode, 0)

    def test_revoke_rejects_empty_or_negative_hook_proof_and_keeps_raw_until_observed(self):
        self.prepare()
        self.lifecycle('retire')
        self.assertEqual(self.run_step('stop').returncode, 0)
        token = self.roots['tokens'] / 'bootstrap/physical-one.token'
        for empty, accepted in ((True, True), (False, False)):
            self.revoke_hook(accepted=accepted, empty=empty)
            result = self.run_step('revoke')
            self.assertNotEqual(result.returncode, 0)
            self.assertTrue(token.exists())
            self.assertNotIn('revocation_verified', result.stdout)

    def test_revoke_preserves_another_tenant_and_another_physical_session(self):
        self.prepare()
        self.lifecycle('retire')
        self.revoke_hook()
        registry = self.roots['identities'] / 'token_hashes.json'
        document = json.loads(registry.read_bytes())
        other_tenant = copy.deepcopy(document['identities'][0])
        other_tenant['principal']['tenant_id'] = 'Other'
        other_tenant['token_sha256'] = 'b' * 64
        other_session = copy.deepcopy(document['identities'][0])
        other_session['principal']['session_id'] = 'bootstrap-other-physical'
        other_session['token_sha256'] = 'c' * 64
        document['identities'] += [other_tenant, other_session]
        registry.chmod(0o600)
        registry.write_text(json.dumps(document))
        registry.chmod(0o400)
        self.assertEqual(self.run_step('stop').returncode, 0)
        result = self.run_step('revoke')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['evidence']['revocation_verified'])
        self.assertEqual(json.loads(registry.read_bytes())['identities'], [other_tenant, other_session])

    def test_room_scope_cannot_stop_another_room_agent_in_same_tenant(self):
        self.prepare()
        self.lifecycle('retire')
        self.context['request']['target'] = {'resource': 'room', 'tenant_id': 'Equipo_42', 'room_id': 'other-room'}
        result = self.run_step('stop')
        self.assertNotEqual(result.returncode, 0)
        metadata = self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json'
        self.assertTrue(metadata.exists())
        self.context['request']['target'] = {'resource': 'agent', 'tenant_id': 'Equipo_42', 'alias': 'shared_alias'}
        self.context['operation_id'] = str(uuid.uuid4())

    def empty_room_purge(self):
        self.prepare()
        self.lifecycle('purge')
        self.context['request']['target'] = {'resource': 'room', 'tenant_id': 'Pablo', 'room_id': 'grp.pablo'}
        self.context['previous_agents'] = []
        self.context['fenced_targets'] = []
        self.revoke_hook()

    def journal_files(self):
        return [path for path in self.root.rglob('effects.json') if self.context['operation_id'] in str(path)]

    def test_room_purge_without_scoped_agents_passes_artifacts_and_publishes_applied(self):
        self.empty_room_purge()
        for step in ('stop', 'revoke', 'purge', 'artifacts'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        journal = json.loads(self.journal_files()[0].read_bytes())
        self.assertEqual((journal['revoked'], journal['revocation_complete']), ({}, True))
        receipt = json.loads((self.roots['state'] / 'applied-fleet.json').read_bytes())
        self.assertEqual(receipt['generation'], journal['generation'])
        self.assertEqual(self.run_step('artifacts').returncode, 0)

    def assert_artifacts_need_completed_revocation(self, kind):
        self.prepare()
        self.lifecycle(kind)
        self.revoke_hook()
        self.assertEqual(self.run_step('stop').returncode, 0)
        self.assertNotEqual(self.run_step('artifacts').returncode, 0)
        path = self.journal_files()[0]
        journal = json.loads(path.read_bytes())
        journal['revoked'] = {'physical-one': {'legacy': None, 'credentials': {}}}
        path.write_text(json.dumps(journal))
        result = self.run_step('artifacts')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('fenced artifacts require observed stop and revocation', result.stderr)
        self.assertFalse((self.roots['state'] / 'applied-fleet.json').exists())

    def test_retire_artifacts_require_completed_revocation_not_revoked_truthiness(self):
        self.assert_artifacts_need_completed_revocation('retire')

    def test_purge_artifacts_require_completed_revocation_not_revoked_truthiness(self):
        self.assert_artifacts_need_completed_revocation('purge')

    def test_agent_purge_with_agents_still_reaches_artifacts(self):
        self.prepare()
        self.lifecycle('purge')
        self.revoke_hook()
        for step in ('stop', 'revoke', 'purge', 'artifacts'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        journal = json.loads(self.journal_files()[0].read_bytes())
        self.assertEqual(list(journal['revoked']), ['physical-one'])
        receipt = json.loads((self.roots['state'] / 'applied-fleet.json').read_bytes())
        snapshot = json.loads((self.roots['state'] / 'generations' / receipt['generation'] / 'flota.json').read_bytes())
        self.assertNotIn('physical-one', snapshot['fleet'])

    def prepared_update(self):
        self.prepare()
        original = copy.deepcopy(self.agent)
        parameters = copy.deepcopy(self.context['request']['parameters'])
        destination = self.root / 'new-runtime'
        destination.mkdir(mode=0o700)
        self.policy['native'].append({**self.policy['native'][0], 'state_root': str(destination)})
        self.context['operation_id'] = str(uuid.uuid4())
        self.context['request'].update(kind='update', parameters=parameters)
        self.context['request']['parameters']['placement']['state_directory'] = str(destination / 'physical-one')
        self.context['previous_agents'] = [original]
        self.context['fenced_targets'] = [self.context['request']['target'].copy()]
        self.agent['state_directory'] = str(destination / 'physical-one')
        self.save_policy()
        for step in ('stop', 'artifacts', 'credentials', 'runtime'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')
        return original

    def test_compensation_stops_current_update_and_original_without_changing_inputs(self):
        original = self.prepared_update()
        self.revoke_hook()
        metadata = self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json'
        pid = json.loads(metadata.read_bytes())['pid']
        before = copy.deepcopy(self.context['previous_agents'])
        result = self.run_step('compensate')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['evidence'], {'stopped_verified': True, 'revocation_verified': True})
        self.assertFalse(pathlib.Path('/proc/' + str(pid)).exists())
        self.assertFalse((pathlib.Path(original['state_directory']) / '.cauce-credentials').exists())
        self.assertFalse((pathlib.Path(self.agent['state_directory']) / '.cauce-credentials').exists())
        self.assertEqual(self.context['previous_agents'], before)
        self.assertEqual(self.run_step('compensate').returncode, 0)

    def test_login_stop_stops_current_update_without_revoking_cauce(self):
        self.prepared_update()
        token = self.roots['tokens'] / 'bootstrap/physical-one.token'
        original = token.read_bytes()
        result = self.run_step('login-stop')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['evidence']['stopped_verified'])
        self.assertEqual(token.read_bytes(), original)
        self.assertFalse((self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json').exists())

    def verified(self):
        self.configure_hooks()
        self.prepare()
        for step in ('authenticate', 'profile', 'verify'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, f'{step}: {result.stderr}')

    def test_normal_functional_proof_failure_stops_runtime_and_does_not_publish_applied(self):
        self.configure_hooks()
        driver = self.root / 'driver.py'
        driver.write_text(driver.read_text().replace('print(json.dumps(r))',
            'if p.get("phase")=="normal":r["roundtrip_verified"]=False\nprint(json.dumps(r))'))
        for hook in self.policy['hooks'].values():
            hook['files'][str(driver)] = hashlib.sha256(driver.read_bytes()).hexdigest()
        self.save_policy()
        self.prepare()
        for step in ('authenticate', 'profile', 'verify'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, result.stderr)
        admission = self.run_step('admission')
        self.assertNotEqual(admission.returncode, 0)
        self.assertFalse((self.roots['state'] / 'applied-fleet.json').exists())
        self.assertFalse((self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json').exists())

    def test_admission_cas_conflict_does_not_mint_normal_credentials_or_replace_process(self):
        self.verified()
        sys.path.insert(0, str(fixtures.OPS / 'scripts'))
        from fleet_runtime_apply import publish_applied
        from fleet_runtime_materialization import materialize
        source = copy.deepcopy(self.context['snapshot'])
        # Private baseline authority never enters public fleet artifacts.
        source['agents'][0].pop('fleet_baseline')
        source['agents'][0]['lifecycle_state'] = 'auth_pending'
        receipt = materialize(source, {}, self.roots['state'])
        publish_applied(self.roots['state'], receipt['generation'], None)
        metadata = self.roots['runtime'] / '.control/physical-one/cauce-v3-adapter.json'
        pid = json.loads(metadata.read_bytes())['pid']
        result = self.run_step('admission')
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.roots['pki'] / 'normal/physical-one').exists())
        self.assertEqual(json.loads(metadata.read_bytes())['pid'], pid)

    def test_restore_room_applies_membership_intent_without_starting_agents(self):
        self.lifecycle('restore')
        self.context['request']['target'] = {'resource': 'room', 'tenant_id': 'Equipo_42', 'room_id': 'room: one'}
        for step in ('artifacts', 'admission'):
            result = self.run_step(step)
            self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.roots['state'] / 'applied-fleet.json').read_bytes())
        snapshot = json.loads((self.roots['state'] / 'generations' / receipt['generation'] / 'flota.json').read_bytes())
        self.assertEqual(snapshot['fleet'], {})
        self.assertFalse((self.roots['runtime'] / '.control').exists())


if __name__ == '__main__':
    unittest.main()
