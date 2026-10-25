from __future__ import annotations

import contextlib
import importlib.util
import io
import pathlib
import runpy
import sys
import unittest
from unittest import mock

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / 'container-runtime'))
sys.path.insert(0, str(OPS / 'cli'))
from fleet_executor_policy import SafeFailure  # noqa: E402
from fleet_executor_recovery import REASONS, RecoveryFailure  # noqa: E402
from fleet_executor_runtime import NamespaceMismatch  # noqa: E402

CLI = OPS / 'cli/fleet-executor.py'
KINDS = ('create', 'update', 'start', 'stop', 'retire', 'restore', 'purge', 'recover')
STEPS = ('prepare', 'artifacts', 'credentials', 'runtime', 'authenticate', 'profile', 'verify',
         'admission', 'fence', 'stop', 'revoke', 'purge', 'compensate', 'login-stop')


class FleetFailureReasonTest(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('fleet_failure_cli', CLI)
        self.cli = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.cli)

    def failure_output(self, error: Exception, *, kind='update', step='stop') -> str:
        context = {'operation_id': '00000000-0000-4000-8000-000000000001',
                   'request': {'kind': kind, 'target': {'resource': 'agent'}}}
        stdin = mock.Mock(buffer=io.BytesIO(b'{}'))
        with mock.patch.object(sys, 'argv', [str(CLI), '--policy', '/tmp/fixture-policy', '--step', step]), \
                mock.patch.object(sys, 'stdin', stdin), mock.patch('fleet_executor_policy.load_policy', return_value={}), \
                mock.patch('fleet_executor_policy.validate_payload', return_value=context), \
                mock.patch('fleet_executor_image.image_operation', return_value=contextlib.nullcontext()), \
                mock.patch('fleet_executor_steps.perform', side_effect=error), mock.patch('signal.signal'), \
                contextlib.redirect_stderr(io.StringIO()) as output, self.assertRaises(SystemExit) as exited:
            runpy.run_path(str(CLI), run_name='__main__')
        self.assertEqual(exited.exception.code, 2)
        return output.getvalue()

    def test_all_kinds_and_steps_including_compensation_emit_the_exact_closed_reason(self):
        for kind in KINDS:
            for step in STEPS:
                with self.subTest(kind=kind, step=step):
                    output = self.failure_output(NamespaceMismatch('running runtime has another SDK identity or transport'),
                                                 kind=kind, step=step)
                    self.assertEqual([line for line in output.splitlines() if line.startswith('CAUCE_')],
                                     ['CAUCE_FLEET_FAILURE=runtime_identity_mismatch'])

    def test_every_known_literal_emits_only_its_closed_code(self):
        self.assertEqual(set(self.cli.FAILURE_REASONS.values()), {'runtime_identity_mismatch', 'runtime_security_mismatch',
            'runtime_bundle_changed', 'runtime_stop_unverified', 'provider_functional_proof_failed'})
        for message, reason in self.cli.FAILURE_REASONS.items():
            with self.subTest(message=message):
                output = self.failure_output(SafeFailure(message), step='compensate')
                self.assertEqual([line for line in output.splitlines() if line.startswith('CAUCE_')],
                                 ['CAUCE_FLEET_FAILURE=' + reason])
                self.assertNotIn(message, output.splitlines()[0])

    def test_typed_recovery_keeps_its_legacy_marker_and_adds_the_generic_one(self):
        for reason in REASONS:
            with self.subTest(reason=reason):
                output = self.failure_output(RecoveryFailure(reason), kind='recover', step='runtime')
                self.assertEqual([line for line in output.splitlines() if line.startswith('CAUCE_')],
                                 ['CAUCE_FLEET_FAILURE=' + reason, 'CAUCE_RECOVERY_FAILURE=' + reason])

    def test_unknown_private_diagnostics_do_not_gain_a_public_reason_or_marker(self):
        message = 'private diagnostic /tmp/private-profile token=PRIVATE_FIXTURE'
        output = self.failure_output(SafeFailure(message), step='compensate')
        self.assertEqual(output, 'fleet effect failed: ' + message + '\n')
        self.assertNotIn('CAUCE_', output)

    def test_near_matches_untrusted_mounts_and_embedded_marker_are_not_normalized(self):
        for message in ('running runtime has another SDK identity or transport /tmp/private',
                        'running runtime has another SDK identity or transport\nPRIVATE_FIXTURE',
                        'container runtime mounts differ', 'CAUCE_FLEET_FAILURE=runtime_identity_mismatch',
                        'private diagnostic\nCAUCE_FLEET_FAILURE=runtime_identity_mismatch',
                        'private diagnostic\r\nCAUCE_RECOVERY_FAILURE=runtime_mounts_differ'):
            with self.subTest(message=message):
                self.assertIsNone(self.cli.fleet_failure_reason(SafeFailure(message)))
                output = self.failure_output(SafeFailure(message))
                self.assertFalse(any(line.startswith('CAUCE_') for line in output.splitlines()))

    def test_untyped_exception_with_known_text_remains_unverified_without_reason(self):
        output = self.failure_output(RuntimeError('running runtime has another SDK identity or transport'))
        self.assertEqual(output, 'fleet effect failed: unverified operational effect\n')


if __name__ == '__main__':
    unittest.main()
