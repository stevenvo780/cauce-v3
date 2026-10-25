from __future__ import annotations

import contextlib
import io
import json
import pathlib
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / '.delegados/v4'))
import live_adapter_v3 as tool


class NativeAbsentTuiChecks(unittest.TestCase):
    def setUp(self):
        self.agent = {'alias': 'astra', 'kind': 'native', 'harness': 'codex', 'unit': 'owned.service',
                      'uid': 1000, 'state_directory': '/owned/state'}
        self.absent = {'adapter_pid': 123, 'identity': None, 'tui': 'absent',
                       'absence': {'adapter_starttime': '456', 'active_deliveries': 0}}
        self.present = {'adapter_pid': 234, 'tui': 'present', 'identity': {
            'pane': ['$1', '@1', '%1', '345'], 'pane_start': '567', 'conversation_sha256': 'a' * 64}}

    def test_existing_tui_keeps_the_original_snapshot_path(self):
        with mock.patch.object(tool.core, 'python', return_value=json.dumps(self.present)) as remote:
            self.assertEqual(tool.snapshot(self.agent), self.present)
        remote.assert_called_once_with(self.agent, tool.SNAPSHOT, 'owned.service', 'astra')

    def test_unknown_transport_completion_cannot_turn_into_absence(self):
        with mock.patch.object(tool.core, 'python', side_effect=tool.core.CompletionUnknown('unknown')) as remote:
            with self.assertRaises(tool.core.CompletionUnknown):
                tool.snapshot(self.agent)
        self.assertEqual(remote.call_count, 1)

    def test_original_failure_requires_the_separate_absence_proof(self):
        with mock.patch.object(tool.core, 'python', side_effect=[tool.core.Failure('no TUI'), json.dumps(self.absent)]) as remote:
            self.assertEqual(tool.snapshot(self.agent), self.absent)
        self.assertEqual(remote.call_args.args[2:], ('owned.service', 'astra', '1000', '/owned/state'))

    def test_tui_created_during_absence_measurement_is_not_silently_accepted(self):
        with mock.patch.object(tool.core, 'python', side_effect=[tool.core.Failure('no TUI'), json.dumps(self.present)]):
            with self.assertRaisesRegex(tool.core.Failure, 'changed during absence'):
                tool.snapshot(self.agent)

    def test_privileged_read_requires_explicit_agent_option(self):
        agent = {**self.agent, 'privileged_proc_read': True}
        with mock.patch.object(tool.core, 'python', side_effect=[tool.core.Failure('no TUI'), json.dumps(self.absent)]) as remote:
            self.assertEqual(tool.snapshot(agent), self.absent)
        self.assertEqual(remote.call_args.args[-1], '--privileged-proc-read')

    def invoke_probe(self, receipt, snapshots, *, roundtrip=None):
        captured = []

        def core_main():
            value = tool.core.probe(SimpleNamespace(revertir=False), self.agent, 'owned-release')
            captured.append(value)
            print('{}')
            return 0

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, 'argv', ['tool', '--agente', 'astra', '--ref', 'a' * 40,
                                                               '--ejecutar', '--parada-recibo', '/owned/receipt.json']))
            stack.enter_context(mock.patch.object(tool.core, 'main', side_effect=core_main))
            stack.enter_context(mock.patch.object(tool.core, 'save'))
            stack.enter_context(mock.patch.object(tool.core, 'before'))
            stack.enter_context(mock.patch.object(tool.core, 'probe'))
            stack.enter_context(mock.patch.object(tool.core, 'stop'))
            stack.enter_context(mock.patch.object(tool, 'validate_receipt', return_value=receipt))
            stack.enter_context(mock.patch.object(tool, 'snapshot', side_effect=snapshots))
            probe = stack.enter_context(mock.patch.object(tool, 'BASE_PROBE', side_effect=roundtrip,
                                                           return_value={'delivery_done': True, 'lease_valid': True}))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            tool.main()
        return captured[0], probe

    def test_first_update_admits_tui_created_at_start_and_records_its_identity(self):
        receipt = {'tui_before': self.absent}
        result, probe = self.invoke_probe(receipt, [self.present, self.present])
        self.assertTrue(result['tui_created'])
        self.assertIsNone(result['same_pane'])
        self.assertEqual(receipt['tui_current'], self.present)
        probe.assert_called_once()

    def test_first_probe_may_create_the_tui_when_start_has_not_created_it(self):
        receipt = {'tui_before': self.absent}
        result, _probe = self.invoke_probe(receipt, [{**self.absent, 'adapter_pid': 234}, self.present])
        self.assertTrue(result['tui_created'])
        self.assertTrue(result['adapter_restarted'])

    def test_claimed_roundtrip_success_does_not_replace_the_physical_tui_proof(self):
        with self.assertRaisesRegex(tool.core.Failure, 'conversation changed'):
            self.invoke_probe({'tui_before': self.absent}, [{**self.absent, 'adapter_pid': 234}] * 2)

    def test_second_update_requires_the_created_pane_and_conversation(self):
        receipt = {'tui_before': self.absent, 'tui_current': self.present}
        next_adapter = {**self.present, 'adapter_pid': 345}
        result, _probe = self.invoke_probe(receipt, [next_adapter, next_adapter])
        self.assertFalse(result['tui_created'])
        self.assertTrue(result['same_pane'])
        changed = {**next_adapter, 'identity': {**self.present['identity'], 'conversation_sha256': 'b' * 64}}
        with self.assertRaisesRegex(tool.core.Failure, 'continuity'):
            self.invoke_probe(receipt, [changed])

    def invoke_stop(self, receipt, observed, stop):
        def core_main():
            tool.core.stop(self.agent)
            print('{}')
            return 0

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(sys, 'argv', ['tool', '--agente', 'astra', '--ref', 'a' * 40,
                                                               '--ejecutar', '--parada-recibo', '/owned/receipt.json']))
            stack.enter_context(mock.patch.object(tool.core, 'main', side_effect=core_main))
            for name in ('before', 'probe', 'stop'):
                stack.enter_context(mock.patch.object(tool.core, name))
            stack.enter_context(mock.patch.object(tool, 'BASE_STOP', stop))
            stack.enter_context(mock.patch.object(tool, 'validate_receipt', return_value=receipt))
            stack.enter_context(mock.patch.object(tool, 'snapshot', return_value=observed))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            tool.main()

    def test_second_stop_preserves_the_identity_created_by_the_first_probe(self):
        stop = mock.Mock()
        self.invoke_stop({'tui_before': self.absent, 'tui_current': self.present}, self.present, stop)
        stop.assert_called_once_with(self.agent)

    def test_changed_runtime_or_tui_prevents_the_stop_effect(self):
        changed = [
            {**self.present, 'adapter_pid': 999},
            {**self.present, 'identity': {**self.present['identity'], 'pane_start': '999'}},
            {**self.present, 'identity': {**self.present['identity'], 'conversation_sha256': 'b' * 64}},
            self.absent,
        ]
        for observed in changed:
            stop = mock.Mock()
            with self.subTest(observed=observed), self.assertRaisesRegex(tool.core.Failure, 'before stop'):
                self.invoke_stop({'tui_before': self.absent, 'tui_current': self.present}, observed, stop)
            stop.assert_not_called()


if __name__ == '__main__':
    unittest.main()
