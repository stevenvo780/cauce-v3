from __future__ import annotations

import copy
import json
import pathlib
import sys
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'container-runtime'))
sys.path.insert(0, str(OPS / 'cli'))
import fleet_executor_container as container  # noqa: E402
import fleet_executor_recovery as recovery  # noqa: E402
import fleet_executor_recovery_relaunch as relaunch  # noqa: E402
import fleet_executor_resume  # noqa: E402
import fleet_executor_runtime  # noqa: E402
import test_fleet_executor_rebind as fixtures  # noqa: E402
from cauce_container_base import bundle_digest  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402

WRITER = '00000000-0000-4000-8000-0000000000a1'
PLANNED = '00000000-0000-4000-8000-0000000000b2'
OPERATION = '00000000-0000-4000-8000-0000000000c3'
RESUME = '9' * 64
EFFECTS = {'create', 'rm', 'start', 'stop', 'rename', 'run'}


class RelaunchFixture(fixtures.ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.docker = fixtures.FakeDocker()
        self.agent['primary_room_id'] = 'fixture'
        for patch in (mock.patch.object(container, 'docker', self.docker), mock.patch.object(fixtures.rebind, 'docker', self.docker),
                      mock.patch.object(container, 'checked_command', lambda command, **_kwargs: self.docker(*command[1:]))):
            patch.start()
            self.addCleanup(patch.stop)
        self.docker.volumes[self.name + '-state'] = dict(container.expected_labels(self.policy, self.agent))
        self.policy['bundles']['codex']['shared_tui'] = True
        (self.old / 'adapter/release').write_text('previous\n')
        self.previous_digest = bundle_digest(str(self.old / 'adapter'))
        self.resume = mock.patch.object(fleet_executor_resume, 'resume_proof', return_value={'resumable': True, 'fingerprint': RESUME})
        self.proof = self.resume.start()
        self.addCleanup(self.resume.stop)
        planned = mock.patch.object(fleet_executor_runtime, 'sdk_environment', return_value={'CAUCE_INSTANCE_ID': PLANNED})
        self.planned = planned.start()
        self.addCleanup(planned.stop)

    def adapter(self, root, *, digest=None, live=True):
        row = self.docker.add(self.name, container.expected_labels(self.policy, self.agent), self.mounts(root), running=True)
        if digest is not None:
            self.docker.register_adapter(self.agent, row, digest)
            self.docker.adapters[row['Id']]['environment'].update(CAUCE_INSTANCE_ID=WRITER, CAUCE_FLEET_OPERATION_ID=OPERATION)
            if live:
                self.docker.live.add(self.name)
        return row

    def effects(self):
        return [call for call in self.docker.calls if call[0] in EFFECTS or call[:2] in {('helper', 'stop'), ('helper', 'run')}]


class RelaunchPreviewTests(RelaunchFixture):
    def test_adapter_on_the_previous_bundle_is_offered_a_relaunch_without_effects(self):
        row = self.adapter(self.new, digest=self.previous_digest)
        preview, plan = relaunch.observe(self.policy, self.agent)
        identity = container.identity_for(self.agent, row)
        self.assertEqual(preview['identity'], {'container_id': identity['container_id'], 'generation': identity['generation'],
                                               'writer_instance_id': WRITER})
        self.assertEqual((preview['strategy'], preview['recreates_container']), ('relaunch', False))
        self.assertEqual(preview['session']['state'], 'present')
        self.assertTrue(preview['session']['resumable'])
        self.assertRegex(preview['session']['fingerprint'], '^[0-9a-f]{64}$')
        self.assertEqual(plan, {'bootstrap': False, 'operation_id': OPERATION, 'resume': RESUME})
        self.assertEqual(self.effects(), [])
        self.assertEqual(relaunch.observe(self.policy, self.agent)[0], preview)

    def test_previous_release_mounts_recreate_the_container_and_change_the_confirmation(self):
        self.adapter(self.old, digest=self.policy['bundles']['codex']['digest'])
        preview, _ = relaunch.observe(self.policy, self.agent)
        self.assertTrue(preview['recreates_container'])
        self.assertEqual(self.effects(), [])

    def test_stopped_adapter_relaunches_with_the_planned_normal_instance(self):
        self.adapter(self.new)
        preview, plan = relaunch.observe(self.policy, self.agent)
        self.assertEqual(preview['identity']['writer_instance_id'], PLANNED)
        self.assertEqual(preview['session']['state'], 'absent')
        self.assertEqual(plan, {'bootstrap': False, 'operation_id': None, 'resume': RESUME})
        self.assertEqual(self.planned.call_args.args[2:], (False, None))

    def test_current_adapter_keeps_the_shared_tui_recovery(self):
        self.adapter(self.new, digest=self.policy['bundles']['codex']['digest'])
        self.assertIsNone(relaunch.observe(self.policy, self.agent))
        self.proof.assert_not_called()

    def test_unresumable_conversation_blocks_the_relaunch(self):
        self.adapter(self.new, digest=self.previous_digest)
        self.proof.side_effect = SafeFailure('current SDK did not accredit an exact shared resume')
        preview, _ = relaunch.observe(self.policy, self.agent)
        self.assertEqual(preview['session'], {'type': 'session', 'state': 'unsupported', 'resumable': False,
                                              'fingerprint': None, 'reason': relaunch.UNRESUMABLE})

    def test_foreign_container_fails_closed_before_any_process_observation(self):
        row = self.adapter(self.new, digest=self.previous_digest)
        row['HostConfig']['Privileged'] = True
        with self.assertRaises(SafeFailure):
            relaunch.observe(self.policy, self.agent)
        self.assertFalse(any(call[0] == 'helper' for call in self.docker.calls))
        self.proof.assert_not_called()

    def test_recovery_parameters_accept_only_the_relaunch_strategy(self):
        apply = {'action': 'apply', 'expected_fingerprint': 'a' * 64, 'force': True,
                 'identity': {'generation': 'b' * 64, 'container_id': 'c' * 64, 'writer_instance_id': WRITER}}
        recovery.validate_parameters(apply)
        recovery.validate_parameters({**apply, 'strategy': 'relaunch'})
        for strategy in ('shared_tui', None, 'restart'):
            with self.subTest(strategy=strategy), self.assertRaises(SafeFailure):
                recovery.validate_parameters({**apply, 'strategy': strategy})


class RelaunchApplyTests(RelaunchFixture):
    def setUp(self):
        super().setUp()
        self.row = self.adapter(self.new, digest=self.previous_digest)
        self.preview, _ = relaunch.observe(self.policy, self.agent)
        self.parameters = {'action': 'apply', 'identity': self.preview['identity'], 'force': True,
                           'expected_fingerprint': self.preview['session']['fingerprint'], 'strategy': 'relaunch'}
        self.journal, self.saved = {}, []
        self.started = mock.patch.object(container, 'start_container', side_effect=self.start)
        self.start_container = self.started.start()
        self.addCleanup(self.started.stop)
        self.proven = mock.patch.object(container, 'process_proof', return_value={'runtime_digest': 'f' * 64})
        self.process_proof = self.proven.start()
        self.addCleanup(self.proven.stop)
        self.docker.calls.clear()

    def start(self, _policy, agent, **_options):
        self.assertTrue(agent['_require_shared_resume'])
        self.assertNotIn(self.name, self.docker.live)
        self.docker.containers[self.name]['State']['StartedAt'] = 'relaunched'
        return {'runtime_digest': 'f' * 64}

    def perform(self, step='runtime', parameters=None):
        return relaunch.perform(self.policy, self.agent, parameters or self.parameters, self.journal,
                                lambda: self.saved.append(copy.deepcopy(self.journal)), step)

    def test_relaunch_stops_the_exact_adapter_then_starts_the_current_bundle_and_resumes(self):
        evidence = self.perform()['evidence']
        receipt = evidence['recovery']
        self.assertEqual(receipt['identity'], self.parameters['identity'])
        self.assertEqual(receipt['session']['state'], 'resumed')
        self.assertEqual(receipt['session']['fingerprint'], self.parameters['expected_fingerprint'])
        self.assertEqual(evidence['runtime_digest'], recovery.fingerprint(receipt))
        self.assertEqual(self.start_container.call_args.kwargs, {'bootstrap': False, 'operation_id': OPERATION})
        self.assertEqual(self.process_proof.call_args.kwargs, {'bootstrap': False, 'operation_id': OPERATION})
        self.assertEqual([call[1] for call in self.docker.calls if call[0] == 'helper'],
                         ['stopped', 'observe', 'stopped', 'observe', 'stop', 'stopped'])
        self.assertEqual(self.saved[0]['relaunch'], {'bootstrap': False, 'operation_id': OPERATION, 'resume': RESUME})
        self.assertNotIn('receipt', self.saved[0])
        relaunched = container.identity_for(self.agent, self.docker.containers[self.name])
        self.assertEqual(self.journal['relaunched'], {'container_id': relaunched['container_id'], 'generation': relaunched['generation']})
        self.assertEqual(self.perform('verify'), {'evidence': evidence})

    def test_changed_confirmation_is_rejected_before_stopping_the_adapter(self):
        variants = {'fingerprint': {'expected_fingerprint': 'e' * 64}, 'force': {'force': False},
                    'identity': {'identity': {**self.parameters['identity'], 'writer_instance_id': PLANNED}}}
        for name, change in variants.items():
            with self.subTest(name=name), self.assertRaisesRegex(SafeFailure, 'changed after confirmation'):
                self.perform(parameters={**self.parameters, **change})
        self.assertEqual(self.effects(), [])
        self.assertEqual(self.saved, [])
        self.start_container.assert_not_called()

    def test_a_current_adapter_no_longer_matches_a_relaunch_confirmation(self):
        self.docker.adapters[self.row['Id']]['metadata']['bundleDigest'] = self.policy['bundles']['codex']['digest']
        with self.assertRaisesRegex(SafeFailure, 'strategy changed'):
            self.perform()
        self.assertEqual(self.effects(), [])

    def test_relaunch_without_the_confirmed_conversation_is_not_a_receipt(self):
        self.proof.side_effect = [{'resumable': True, 'fingerprint': RESUME}, {'resumable': True, 'fingerprint': '8' * 64}]
        with self.assertRaisesRegex(SafeFailure, 'does not resume the confirmed conversation'):
            self.perform()
        self.assertNotIn('receipt', self.journal)
        with self.assertRaisesRegex(SafeFailure, 'no verified receipt'):
            self.perform('verify')

    def test_verify_rejects_a_runtime_replaced_after_the_receipt(self):
        self.perform()
        self.docker.containers[self.name]['State']['StartedAt'] = 'replaced'
        with self.assertRaisesRegex(SafeFailure, 'changed before its receipt'):
            self.perform('verify')

    def test_compensation_starts_the_adapter_only_after_an_attempt(self):
        self.assertEqual(self.perform('compensate'), {'evidence': {'recovery_compensated': True}})
        self.start_container.assert_not_called()
        self.journal['relaunch'] = {'bootstrap': False, 'operation_id': OPERATION, 'resume': RESUME}
        self.docker.live.discard(self.name)
        self.assertEqual(self.perform('compensate'), {'evidence': {'recovery_compensated': True}})
        self.assertEqual(self.start_container.call_args.kwargs, {'bootstrap': False, 'operation_id': OPERATION})

    def test_recovery_dispatches_a_confirmed_relaunch_with_its_own_journal(self):
        context = {'operation_id': '00000000-0000-4000-8000-0000000000d4',
                   'request': {'kind': 'recover', 'target': {'resource': 'agent', 'tenant_id': self.agent['tenant_id'],
                                                             'alias': self.agent['alias']}, 'parameters': self.parameters}}
        raw = {key: value for key, value in self.agent.items() if not key.startswith('_')}
        with mock.patch.object(recovery, 'target_agent', return_value=raw):
            evidence = recovery.perform(self.policy, context, 'runtime')['evidence']
        journal = json.loads((pathlib.Path(self.policy['roots']['state']) / 'operations' / context['operation_id']
                              / 'recovery.json').read_text())
        self.assertEqual(journal['receipt'], evidence)
        self.assertEqual(journal['request_sha256'], recovery.fingerprint(context['request']))


if __name__ == '__main__':
    unittest.main()
