from __future__ import annotations

import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import pathlib
import runpy
import sys
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'container-runtime'))
sys.path.insert(0, str(OPS / 'cli'))
import fleet_executor_container as container  # noqa: E402
import fleet_executor_recovery as recovery  # noqa: E402
import test_fleet_executor_rebind as fixtures  # noqa: E402
from fleet_executor_policy import SafeFailure  # noqa: E402

CLI = pathlib.Path(__file__).resolve().parents[1] / 'cli/fleet-executor.py'


class RecoveryPreflightTest(fixtures.ReleaseFixture):
    def setUp(self):
        super().setUp()
        self.policy['bundles']['codex']['shared_tui'] = True
        self.raw_agent = {key: value for key, value in self.agent.items() if not key.startswith('_')}
        self.document = {key: self.raw_agent[key] for key in ('tenant_id', 'alias', 'runtime_key')}
        self.document['agent'] = self.raw_agent
        self.fake = fixtures.FakeDocker()
        self.fake.add(self.name, container.expected_labels(self.policy, self.agent), self.mounts(self.old), running=True)
        self.patch_docker = mock.patch.object(container, 'docker', self.fake)
        self.patch_docker.start()
        self.addCleanup(self.patch_docker.stop)
        self.identity = {'container_id': '1' * 64, 'generation': '2' * 64,
                         'writer_instance_id': '00000000-0000-4000-8000-000000000001'}
        self.session = {'type': 'session', 'state': 'present', 'resumable': True,
                        'fingerprint': '3' * 64, 'reason': 'La conversación puede reanudarse.'}

    def assert_read_only(self):
        self.assertTrue(all(call[0] in {'ps', 'inspect'} for call in self.fake.calls), self.fake.calls)
        self.assertEqual(list(pathlib.Path(self.policy['roots']['state']).glob('operations/*')), [])

    def test_previous_trusted_release_mounts_require_update_without_observing_or_replacing_process(self):
        with mock.patch.object(container, 'process_proof', side_effect=AssertionError('process helper launched')):
            result = recovery.preflight(self.policy, self.document)
        self.assertEqual(result, {'status': 'update_required', 'reason_code': 'runtime_mounts_differ',
                                 'reason': recovery.REASONS['runtime_mounts_differ'], 'next_action': 'update'})
        self.assertNotIn('identity', result)
        self.assert_read_only()

    def test_mount_drift_does_not_hide_security_or_identity_failures(self):
        original = copy.deepcopy(self.fake.containers[self.name])
        mutations = {
            'foreign_image': lambda row: row.update(Image='sha256:' + 'e' * 64),
            'foreign_alias': lambda row: row['Config']['Labels'].update({'cauce.fleet.alias': 'foreign'}),
            'privileged': lambda row: row['HostConfig'].update(Privileged=True),
            'foreign_state': lambda row: row['Mounts'][0].update(Name='foreign-state'),
            'writable_release': lambda row: row['Mounts'][1].update(RW=True),
            'foreign_bind': lambda row: row['Mounts'][-1].update(Source='/tmp/foreign-adapter'),
            'extra_bind': lambda row: row['Mounts'].append({'Type': 'bind', 'Source': '/tmp/foreign',
                                                          'Destination': '/foreign', 'RW': True}),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                self.fake.containers[self.name] = copy.deepcopy(original)
                mutate(self.fake.containers[self.name])
                with self.assertRaises(SafeFailure) as raised:
                    recovery.preflight(self.policy, self.document)
                self.assertNotIsInstance(raised.exception, recovery.RecoveryFailure)
                self.assertIsNone(recovery.failure_reason(raised.exception))
                self.assert_read_only()

    def test_untrusted_previous_release_is_not_an_update_offer(self):
        (self.old / 'ops/cli').chmod(0o777)
        with self.assertRaisesRegex(SafeFailure, 'ownership or mode') as raised:
            recovery.preflight(self.policy, self.document)
        self.assertNotIsInstance(raised.exception, recovery.RecoveryFailure)
        self.assert_read_only()

    def test_missing_previous_release_fails_closed_without_update_marker(self):
        self.old.rename(self.old.with_name(self.old.name + '-missing'))
        with self.assertRaises(SafeFailure) as raised:
            recovery.preflight(self.policy, self.document)
        self.assertIsNone(recovery.failure_reason(raised.exception))
        self.assert_read_only()

    def test_unexplained_current_release_mount_change_fails_closed(self):
        self.fake.containers[self.name]['Mounts'] = self.mounts(self.new)[:-1]
        with self.assertRaisesRegex(SafeFailure, 'mounts differ') as raised:
            recovery.preflight(self.policy, self.document)
        self.assertNotIsInstance(raised.exception, recovery.RecoveryFailure)
        self.assert_read_only()

    def test_shared_tui_disabled_is_explained_without_runtime_identity_or_process_probe(self):
        self.policy['bundles']['codex']['shared_tui'] = False
        with mock.patch.object(recovery, 'observe', side_effect=AssertionError('runtime probe launched')):
            result = recovery.preflight(self.policy, self.document)
        self.assertEqual(result['status'], 'unsupported')
        self.assertEqual(result['reason_code'], 'shared_tui_disabled')
        self.assertEqual(result['next_action'], 'stop_start')
        self.assertNotIn('identity', result)
        self.assert_read_only()

    def test_unsupported_harness_is_explained_without_launching_helper(self):
        self.raw_agent['harness_id'] = 'openclaw'
        self.policy['bundles']['openclaw'] = {**self.policy['bundles']['codex'], 'shared_tui': False}
        result = recovery.preflight(self.policy, self.document)
        self.assertEqual(result['reason_code'], 'harness_unsupported')
        self.assert_read_only()

    def test_native_placement_does_not_require_container_name_and_still_uses_policy_approval(self):
        self.policy['bundles']['codex']['shared_tui'] = False
        executable = pathlib.Path(sys.executable).resolve()
        self.policy['bundles']['codex'].update(executable=str(executable),
            executable_sha256=hashlib.sha256(executable.read_bytes()).hexdigest())
        self.policy['native'] = [self.policy['containers'][self.name]]
        self.raw_agent['runtime_mode'] = 'native'
        for container_name in (None, 'absent'):
            with self.subTest(container_name=container_name):
                self.raw_agent.pop('container_name', None)
                if container_name is None:
                    self.raw_agent['container_name'] = None
                result = recovery.preflight(self.policy, self.document)
                self.assertEqual(result['reason_code'], 'shared_tui_disabled')
        self.raw_agent['runtime_user'] = 'foreign'
        with self.assertRaisesRegex(SafeFailure, 'not approved'):
            recovery.preflight(self.policy, self.document)
        self.assertEqual(self.fake.calls, [])

    def test_verified_headless_process_needs_update_under_shared_tui_policy_without_recovery_effect(self):
        bundle = self.policy['bundles']['codex']
        with mock.patch.object(recovery, 'observe', return_value=(self.identity, {}, bundle)), \
                mock.patch.object(recovery, 'run_helper', side_effect=AssertionError('recovery helper launched')):
            result = recovery.preflight(self.policy, self.document)
        self.assertEqual(result['status'], 'update_required')
        self.assertEqual(result['reason_code'], 'runtime_without_shared_tui')
        self.assertEqual(result['next_action'], 'update')
        self.assertNotIn('identity', result)
        self.assert_read_only()

    def test_ready_preview_preserves_exact_runtime_session_and_uses_only_read_command(self):
        for state in ('present', 'absent', 'conflict', 'failed'):
            with self.subTest(state=state):
                session = {**self.session, 'state': state}
                with mock.patch.object(recovery, 'observe', return_value=(self.identity,
                        {'CAUCE_SHARED_SESSION': '1'}, self.policy['bundles']['codex'])), \
                        mock.patch.object(recovery, 'run_helper', return_value=session) as helper:
                    result = recovery.preflight(self.policy, self.document)
                self.assertEqual(result['status'], 'ready')
                self.assertEqual(result['recovery']['identity'], self.identity)
                self.assertEqual(result['recovery']['session'], session)
                self.assertFalse(result['recovery']['recreates_container'])
                self.assertEqual(helper.call_args.args[-1], 'recovery-preview')
                self.assert_read_only()

    def test_preflight_rejects_operation_authority_spoofed_identity_and_internal_fields(self):
        variants = [
            {**self.document, 'operation_id': '00000000-0000-4000-8000-000000000001'},
            {**self.document, 'alias': 'other'},
            {**self.document, 'agent': {**self.raw_agent, '_placement': self.agent['_placement']}},
            {**self.document, 'trusted_accounts': [{'secret': 'rejected'}]},
        ]
        for document in variants:
            with self.subTest(document_keys=sorted(document)):
                with self.assertRaises(SafeFailure):
                    recovery.preflight(self.policy, document)
        self.assertEqual(self.fake.calls, [])

    def test_operation_preview_remains_strict_and_returns_only_typed_known_reason(self):
        context = {'request': {'kind': 'recover', 'target': {'resource': 'agent',
                       'tenant_id': self.agent['tenant_id'], 'alias': self.agent['alias']}, 'parameters': {'action': 'probe'}},
                   'snapshot': {'agents': [self.raw_agent]}, 'previous_agents': []}
        with self.assertRaises(recovery.RecoveryFailure) as raised:
            recovery.preview(self.policy, context)
        self.assertEqual(recovery.failure_reason(raised.exception), 'runtime_mounts_differ')
        self.assertIsNone(recovery.failure_reason(SafeFailure('container runtime mounts differ')))
        self.assert_read_only()


class RecoveryPreflightCliTest(unittest.TestCase):
    def test_preflight_dispatch_requires_no_operation_payload_or_image_lifecycle(self):
        spec = importlib.util.spec_from_file_location('recovery_preflight_cli', CLI)
        cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cli)
        result = {'status': 'unsupported', 'reason_code': 'shared_tui_disabled',
                  'reason': recovery.REASONS['shared_tui_disabled'], 'next_action': 'stop_start'}
        stdin = mock.Mock(buffer=io.BytesIO(b'{"no_operation":"fixture"}'))
        with mock.patch.object(sys, 'argv', [str(CLI), '--policy', '/tmp/fixture-policy', '--recovery-preflight']), \
                mock.patch.object(sys, 'stdin', stdin), mock.patch.object(cli, 'load_policy', return_value={}), \
                mock.patch.object(cli, 'executor_lock', return_value=contextlib.nullcontext()), \
                mock.patch.object(cli.signal, 'signal'), \
                mock.patch.object(cli, 'validate_payload', side_effect=AssertionError('operation validation launched')), \
                mock.patch.object(cli, 'image_operation', side_effect=AssertionError('image lifecycle launched')), \
                mock.patch.object(cli, 'perform', side_effect=AssertionError('operation launched')), \
                mock.patch.object(recovery, 'preflight', return_value=result) as preflight, \
                contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(cli.main(), 0)
        self.assertEqual(json.loads(output.getvalue()), result)
        self.assertEqual(preflight.call_args.args[1], {'no_operation': 'fixture'})

    def test_cli_failure_marker_is_emitted_only_for_a_typed_known_recovery_failure(self):
        context = {'operation_id': '00000000-0000-4000-8000-000000000001',
                   'request': {'kind': 'recover', 'target': {'resource': 'agent'}}}
        for error, expected in ((recovery.RecoveryFailure('runtime_mounts_differ'), True),
                                (SafeFailure('container runtime mounts differ'), False)):
            with self.subTest(expected_marker=expected):
                stdin = mock.Mock(buffer=io.BytesIO(b'{}'))
                with mock.patch.object(sys, 'argv', [str(CLI), '--policy', '/tmp/fixture-policy', '--step', 'runtime']), \
                        mock.patch.object(sys, 'stdin', stdin), mock.patch('fleet_executor_policy.load_policy', return_value={}), \
                        mock.patch('fleet_executor_policy.validate_payload', return_value=context), \
                        mock.patch('fleet_executor_image.image_operation', return_value=contextlib.nullcontext()), \
                        mock.patch('fleet_executor_steps.perform', side_effect=error), mock.patch('signal.signal'), \
                        contextlib.redirect_stderr(io.StringIO()) as output, self.assertRaises(SystemExit) as exited:
                    runpy.run_path(str(CLI), run_name='__main__')
                self.assertEqual(exited.exception.code, 2)
                lines = output.getvalue().splitlines()
                self.assertEqual('CAUCE_RECOVERY_FAILURE=runtime_mounts_differ' in lines, expected)


if __name__ == '__main__':
    unittest.main()
