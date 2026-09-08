from __future__ import annotations

import pathlib
import sys
import unittest
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
if str(AGENT_DIR) not in sys.path:
    sys.path.insert(0, str(AGENT_DIR))

from cauce_pty_agent.openclaw_input import OpenClawInput  # noqa: E402
from cauce_pty_agent.session import PtySession, SessionMixin  # noqa: E402


class OpenClawInputTests(unittest.TestCase):
    def test_only_governed_openclaw_keyboard_is_translated(self) -> None:
        for mode, native, refusal, expected in [
            ("harness_rw", True, None, b"\x1b[127;2u"),
            ("harness_rw", False, None, b"\x7f"),
            ("shell", True, None, b"\x7f"),
            ("harness", True, None, None),
            ("harness_rw", True, "governance_busy", None),
        ]:
            with self.subTest(mode=mode, native=native, refusal=refusal):
                instance = SessionMixin()
                instance.bundle = {"openclaw_tui": {} if native else None}
                instance.sessions = {"session": PtySession("session", 1, -1, mode, ["/node"])}
                instance.pending_writes = instance.pending_write_batches = {}
                instance.input_barrier = mock.Mock()
                instance.input_barrier.refusal.return_value = refusal
                instance._enqueue_session_input = mock.Mock()
                instance._queue = mock.Mock()
                with mock.patch("cauce_pty_agent.session.resolve_openclaw_tui_command", return_value=["/node"]):
                    instance._on_stdin("session", b"\x7f")
                if expected is None:
                    instance._enqueue_session_input.assert_not_called()
                else:
                    instance._enqueue_session_input.assert_called_once_with(instance.sessions["session"], expected)

    def test_network_coalescing_does_not_collapse_repeated_delete_events(self) -> None:
        translator = OpenClawInput()
        self.assertEqual(translator.translate(b"\x7f" * 13), b"\x1b[127;2u" * 13)

    def test_fragmented_paste_alt_backspace_and_terminal_sequences_keep_their_meaning(self) -> None:
        preserved = "é".encode() + b"\x1b\x7f\x1b[1;5D\x1b]title\x7f\x1b\\\x1b[200~pasted\x7f\x1b[201~"
        source = b"\x7f" + preserved + b"\x7f"
        expected = b"\x1b[127;2u" + preserved + b"\x1b[127;2u"
        for split in range(len(source) + 1):
            with self.subTest(split=split):
                translator = OpenClawInput()
                self.assertEqual(translator.translate(source[:split]) + translator.translate(source[split:]), expected)
        translator = OpenClawInput()
        self.assertEqual(b"".join(translator.translate(bytes([byte])) for byte in source), expected)


if __name__ == "__main__":
    unittest.main()
