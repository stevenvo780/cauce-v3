from __future__ import annotations

import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'cli'))
import fleet_executor_authority as authority  # noqa: E402
import fleet_executor_container as container  # noqa: E402
import fleet_executor_maintenance_checkpoint as checkpoint  # noqa: E402
import fleet_executor_replacement as replacement  # noqa: E402
import fleet_executor_replacement_rollback as rollback  # noqa: E402
from fleet_executor_policy import SafeFailure, approve_agent, validate_payload  # noqa: E402
from fleet_executor_steps import Executor  # noqa: E402


class MaintenanceCheckpointTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='h13b-maintenance-checkpoint-')
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        ca = self.root / 'ca.crt'
        ca.write_text('synthetic public authority pin')
        self.policy = {'host_id': 'host', 'executor_user': 'owner', 'roots': {'state': str(self.root)},
            'bundles': {'codex': {}}, 'containers': {'original': {'runtime_user': 'runner', 'systemd_user': 'runner',
                'home_directory': '/home/runner', 'state_root': '/state', 'image': 'sha256:' + 'b' * 64}},
            'authority': {'host_id': 'host', 'identity_directory': str(self.root / 'identity'), 'ca_certificate': str(ca)}}
        self.previous = {'tenant_id': 'Tenant', 'alias': 'agent', 'runtime_key': 'physical', 'harness_id': 'codex',
            'host_id': 'host', 'runtime_mode': 'container', 'container_name': 'original', 'runtime_user': 'runner',
            'systemd_user': 'runner', 'home_directory': '/home/runner', 'state_directory': '/state/physical',
            'primary_room_id': 'office', 'primary_account_id': 'account', 'model_id': 'gpt-5.4',
            'reasoning_effort': None, 'enabled': True, 'lifecycle_state': 'ready'}
        self.agent = approve_agent(self.policy, self.previous)
        operation = '72000000-0000-4000-8000-000000000002'
        self.valid_claim = '72000000-0000-4000-8000-000000000003'
        target = {'resource': 'agent', 'tenant_id': 'Tenant', 'alias': 'agent'}
        self.context = {'operation_id': operation, 'request': {'kind': 'update', 'target': target,
            'expected_revision': 4, 'idempotency_key': 'checkpoint-key', 'parameters': {
                'runtime_key': 'physical', 'harness_id': 'codex', 'primary_room_id': 'office',
                'primary_account_id': 'account', 'model_id': 'gpt-5.4', 'reasoning_effort': None,
                'memberships': [{'room_id': 'office', 'role': 'agent', 'enabled': True}],
                'placement': {'host_id': 'host', 'mode': 'container', 'container_name': 'original',
                    'runtime_user': 'runner', 'systemd_user': 'runner', 'home_directory': '/home/runner',
                    'state_directory': '/state/physical'}}}, 'fenced_targets': [target],
            'previous_agents': [copy.deepcopy(self.previous)], 'desired_memberships': [],
            'fleet_scope': {'operation_id': operation, 'host_id': 'host', 'scope_sha256': 'f' * 64,
                'prepared_revision': 5, 'worker_id': 'worker', 'claim_token': self.valid_claim, 'claim_epoch': 1}}
        body = {'version': 1, 'operation_id': operation, 'company_id': 'company', 'target': target,
                'previous_agents': copy.deepcopy(self.context['previous_agents']), 'previous_memberships': []}
        encoded = rollback.canonical(body)
        self.context['snapshot'] = {'compensation_snapshot': {**body, 'snapshot_canonical': encoded,
            'snapshot_sha256': hashlib.sha256(encoded.encode()).hexdigest()}}
        validate_payload(self.context)
        self.observed = {'Id': 'a' * 64, 'Created': '2026-10-25T00:00:00Z',
            'State': {'StartedAt': '2026-10-25T00:00:01Z'}, 'Image': 'sha256:' + 'b' * 64,
            'Name': '/original', 'Config': {}, 'HostConfig': {}, 'Mounts': []}
        self.live = True
        self.events = []
        self.actions = []
        for patch in (mock.patch.object(authority, 'signed_channel'),
                      mock.patch.object(authority, 'signed_call', side_effect=self.signed_call),
                      mock.patch.object(replacement, 'approved_observation', return_value=(self.agent, self.observed)),
                      mock.patch.object(replacement, 'volume_pins', return_value=[]),
                      mock.patch.object(container, 'adapter_restart_state', side_effect=self.adapter_state),
                      mock.patch.object(rollback, 'normal_pins', return_value={
                          'normal_certificate_sha256': 'c' * 64, 'normal_token_sha256': 'd' * 64})):
            patch.start()
            self.addCleanup(patch.stop)

    def adapter_state(self, *_args):
        self.events.append('observe-adapter')
        return {'adapter_running': True, 'adapter_bootstrap': False} if self.live else {'adapter_running': False}

    def signed_call(self, _configuration, packet):
        if packet['scope']['claim_token'] != self.valid_claim:
            raise SafeFailure('signed authority rejected the current claim')
        self.actions.append(packet['action'])
        self.events.append('signed-' + packet['action'])
        if packet['action'] == 'inventory':
            return {'authorities': [{'id': name, 'sha256': 'e' * 64, 'matching_records': []}
                                    for name in authority.AUTHORITIES]}
        self.assertEqual(packet['action'], 'checkpoint_credentials')
        return {'checkpoint_sha256': 'e' * 64}

    def journal(self):
        return self.root / 'operations' / self.context['operation_id'] / 'effects.json'

    def test_live_checkpoint_precedes_stop_and_regular_stop_reuses_it(self):
        receipt = checkpoint.checkpoint(self.policy, self.context)
        self.assertEqual(set(receipt), {'snapshot_sha256', 'original_container_id', 'checkpoint_sha256', 'generation'})
        self.assertEqual(receipt['original_container_id'], self.observed['Id'])
        self.assertEqual(receipt['generation'], hashlib.sha256(
            (self.observed['Id'] + '\0' + self.observed['State']['StartedAt']).encode()).hexdigest())
        self.assertNotIn('attempted', json.loads(self.journal().read_bytes()))
        self.events.append('guard-stop')
        self.live = False
        with mock.patch.object(Executor, 'stop', return_value={'stopped_verified': True}) as stop:
            self.assertEqual(Executor(self.policy, self.context).perform('stop')['evidence'], {'stopped_verified': True})
            stop.assert_called_once_with()
        self.assertLess(self.events.index('signed-checkpoint_credentials'), self.events.index('guard-stop'))
        self.assertEqual(self.events.count('observe-adapter'), 1)
        self.assertEqual(self.actions, ['inventory', 'checkpoint_credentials'])

    def test_stopping_before_capture_reproduces_the_original_failure(self):
        self.live = False
        with self.assertRaisesRegex(SafeFailure, 'replacement original unverified'):
            Executor(self.policy, self.context).perform('stop')
        self.assertEqual(self.actions, [])
        self.assertNotIn('replacement_compensation', json.loads(self.journal().read_bytes()))

    def test_stopped_replay_uses_only_stored_checkpoint_and_signed_current_inventory(self):
        receipt = checkpoint.checkpoint(self.policy, self.context)
        before = self.journal().read_bytes()
        self.live = False
        with mock.patch.object(rollback, 'capture', side_effect=AssertionError('stopped replay cannot capture')), \
                mock.patch.object(container, 'adapter_restart_state', side_effect=AssertionError('dead adapter cannot be observed')):
            self.assertEqual(checkpoint.checkpoint(self.policy, self.context, require_existing=True), receipt)
        self.assertEqual(self.journal().read_bytes(), before)
        self.assertEqual(self.actions, ['inventory', 'checkpoint_credentials', 'inventory'])

    def test_missing_stopped_checkpoint_never_captures_or_contacts_authority(self):
        with mock.patch.object(rollback, 'capture') as capture, self.assertRaises(SafeFailure):
            checkpoint.checkpoint(self.policy, self.context, require_existing=True)
        capture.assert_not_called()
        self.assertEqual(self.actions, [])

    def test_denied_signed_checkpoint_never_publishes_capture_or_marks_stop_attempted(self):
        def deny(configuration, packet):
            if packet['action'] == 'checkpoint_credentials':
                raise SafeFailure('signed checkpoint was denied')
            return self.signed_call(configuration, packet)
        with mock.patch.object(authority, 'signed_call', side_effect=deny), self.assertRaises(SafeFailure):
            checkpoint.checkpoint(self.policy, self.context)
        journal = json.loads(self.journal().read_bytes())
        self.assertNotIn('replacement_compensation', journal)
        self.assertNotIn('attempted', journal)
        self.assertTrue(self.live)

    def test_stopped_replay_rejects_an_invalid_current_signed_claim(self):
        checkpoint.checkpoint(self.policy, self.context)
        self.context['fleet_scope']['claim_token'] = '72000000-0000-4000-8000-000000000004'
        with self.assertRaisesRegex(SafeFailure, 'signed authority rejected'):
            checkpoint.checkpoint(self.policy, self.context, require_existing=True)
        self.assertEqual(self.actions, ['inventory', 'checkpoint_credentials'])

    def test_rejects_unprepared_foreign_or_non_update_contexts_before_capture(self):
        for mutation in ('missing-scope', 'foreign-host', 'unprepared', 'wrong-kind', 'wrong-snapshot', 'unsigned'):
            with self.subTest(mutation=mutation):
                context, policy = copy.deepcopy(self.context), copy.deepcopy(self.policy)
                if mutation == 'missing-scope':
                    context.pop('fleet_scope')
                elif mutation == 'foreign-host':
                    context['fleet_scope']['host_id'] = 'foreign'
                elif mutation == 'unprepared':
                    context['fleet_scope']['prepared_revision'] = 0
                elif mutation == 'wrong-kind':
                    context['request']['kind'] = 'create'
                elif mutation == 'wrong-snapshot':
                    context['snapshot']['compensation_snapshot']['snapshot_sha256'] = '0' * 64
                else:
                    policy['authority'].pop('identity_directory')
                with self.assertRaises(SafeFailure):
                    checkpoint.checkpoint(policy, context)
                self.assertEqual(self.actions, [])

    def test_corrupt_stored_bindings_fail_before_readonly_authority(self):
        checkpoint.checkpoint(self.policy, self.context)
        original = json.loads(self.journal().read_bytes())
        self.actions.clear()
        for field, value in (('snapshot_sha256', '0' * 64), ('original_container_id', '0' * 64),
                             ('checkpoint_sha256', 'invalid'), ('phase', 'capturing')):
            with self.subTest(field=field):
                changed = copy.deepcopy(original)
                changed['replacement_compensation'][field] = value
                self.journal().write_text(json.dumps(changed))
                with self.assertRaises(SafeFailure):
                    checkpoint.checkpoint(self.policy, self.context, require_existing=True)
                self.assertEqual(self.actions, [])

    def test_cli_uses_validated_context_and_rejects_replay_flag_on_other_actions(self):
        specification = importlib.util.spec_from_file_location('maintenance_checkpoint_cli', OPS / 'cli/fleet-executor.py')
        cli = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(cli)
        arguments = [str(OPS / 'cli/fleet-executor.py'), '--policy', str(self.root / 'policy'), '--maintenance-checkpoint']
        with mock.patch.object(cli, 'load_policy', return_value=self.policy), mock.patch.object(sys, 'argv', arguments), \
                mock.patch.object(sys, 'stdin', mock.Mock(buffer=io.BytesIO(json.dumps(self.context).encode()))), \
                mock.patch('signal.signal'), mock.patch.object(sys, 'stdout', new_callable=io.StringIO) as output:
            self.assertEqual(cli.main(), 0)
        receipt = json.loads(output.getvalue())
        self.assertEqual(receipt['checkpoint_sha256'], 'e' * 64)
        self.live = False
        with mock.patch.object(cli, 'load_policy', return_value=self.policy), \
                mock.patch.object(sys, 'argv', arguments + ['--require-existing-checkpoint']), \
                mock.patch.object(sys, 'stdin', mock.Mock(buffer=io.BytesIO(json.dumps(self.context).encode()))), \
                mock.patch('signal.signal'), mock.patch.object(sys, 'stdout', new_callable=io.StringIO) as replay:
            self.assertEqual(cli.main(), 0)
        self.assertEqual(json.loads(replay.getvalue()), receipt)
        with mock.patch.object(sys, 'argv', arguments[:-1] + ['--capabilities', '--require-existing-checkpoint']), \
                mock.patch.object(cli, 'load_policy') as load, self.assertRaises(SafeFailure):
            cli.main()
        load.assert_not_called()

    def test_cli_help_exposes_checkpoint_and_strict_replay_without_loading_policy(self):
        result = subprocess.run([sys.executable, '-B', str(OPS / 'cli/fleet-executor.py'), '--help'],
                                capture_output=True, text=True, check=False, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--maintenance-checkpoint', result.stdout)
        self.assertIn('--require-existing-checkpoint', result.stdout)


if __name__ == '__main__':
    unittest.main()
