import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "container-runtime"))

from cauce_container_base import PermanentError
from cauce_container_restart import RestartPane, assert_empty_composer, restart_fence


class RestartGuardTests(unittest.TestCase):
    def test_empty_prompt_and_dim_placeholder(self):
        for pane in ("❯ \n", "› \x1b[2mTry an owned prompt\x1b[22m\n",
                     "❯ \n──────\n\x1b[2mbypass permissions on (shift+tab to cycle)\x1b[22m\n"):
            with self.subTest(pane=repr(pane)):
                assert_empty_composer(pane, 2, 0)

    def test_drafts_and_unknown_states_hold_without_disclosing_text(self):
        cases = [("❯ owned unsent text\n", 2, 0),
                 ("› \x1b[2mplaceholder\x1b[22mowned draft\n", 2, 0),
                 ("❯ \n  owned wrapped draft\n", 2, 0),
                 ("❯ first line\n  \n", 2, 1),
                 ("❯ owned draft\n› \n", 2, 1),
                 ("❯ owned draft\n──────\n› \n", 2, 2),
                 ("────────\nowned draft\n› \n", 2, 2),
                 ("owned wrapped input\n› \n", 2, 1),
                 ("old response\n", 2, 0), ("\n", 0, 0),
                 ("❯ \n", 5, 0), ("❯ \n", 2, 3),
                 ("❯ [Pasted text #1]\n", 2, 0),
                 ("esc to interrupt\n❯ \n", 2, 1),
                 ("❯ \nunknown status footer\n", 2, 0)]
        for pane, x, y in cases:
            with self.subTest(kind=cases.index((pane, x, y))):
                with self.assertRaisesRegex(PermanentError, r"^RESTART_HOLD_[A-Z_]+$") as raised:
                    assert_empty_composer(pane, x, y)
                self.assertNotIn("owned", str(raised.exception))

    def test_capture_hooks_are_rejected_before_any_pane_capture(self):
        pane = object.__new__(RestartPane)
        pane.target = "=cauce-zz-canary-guard:agente"
        calls = []

        def run(*arguments):
            calls.append(arguments)
            return "after-capture-pane[0] run-shell foreign-command\n"

        pane.run = run
        with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_HOOKS$"):
            pane.read()
        self.assertEqual(calls, [("show-hooks", "-g", "-t", pane.target)])

    def test_command_alias_cannot_replace_a_read_command(self):
        pane = object.__new__(RestartPane)
        pane.target = "=cauce-zz-canary-guard:agente"
        calls = []

        def run(*arguments):
            calls.append(arguments)
            return 'command-alias[0] "capture-pane=kill-server"\n' if arguments[0] == "show-options" else "after-capture-pane\n"

        pane.run = run
        with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_COMMAND_ALIAS$"):
            pane.read()
        self.assertFalse(any(call[0] in {"capture-pane", "list-panes"} for call in calls))

    def test_draft_holds_before_input_fence(self):
        pane = Mock()
        pane.read.side_effect = PermanentError("RESTART_HOLD_COMPOSER_NOT_EMPTY")
        with patch("cauce_container_restart.shared_pane", return_value=pane):
            with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_NOT_EMPTY$"):
                with restart_fence({}):
                    self.fail("draft reached the signal boundary")
        pane.barrier.assert_not_called()

    def fenced_pane(self):
        pane = Mock(uid=1000)
        pane.read.return_value = (("%1", "101", "0", "0", "2", "1", "80", "102", "7", "7"), "❯ ")
        pane.fields.return_value = ("%1", "101", "0", "0", "2", "1", "", "0", "80", "102")
        return pane

    def test_input_fence_lasts_through_signal_boundary_and_restores(self):
        pane = self.fenced_pane()
        with patch("cauce_container_restart.shared_pane", return_value=pane), \
                patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                patch("cauce_container_restart.open_pidfd", side_effect=[21, 22]), \
                patch("cauce_container_restart.pidfd_matches_starttime", return_value=True), \
                patch("cauce_container_restart.os.close") as close:
            with restart_fence({}):
                self.assertEqual(pane.barrier.call_count, 1)
                self.assertFalse(pane.barrier.call_args.kwargs["release"])
            self.assertEqual(pane.barrier.call_count, 2)
            self.assertTrue(pane.barrier.call_args.kwargs["release"])
            self.assertEqual(close.call_count, 2)

    def test_input_arriving_before_fence_holds_and_restores(self):
        pane = self.fenced_pane()
        initial = pane.read.return_value
        pane.read.side_effect = [initial, initial, PermanentError("RESTART_HOLD_COMPOSER_NOT_EMPTY")]
        with patch("cauce_container_restart.shared_pane", return_value=pane), \
                patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                patch("cauce_container_restart.open_pidfd", side_effect=[21, 22]), \
                patch("cauce_container_restart.pidfd_matches_starttime", return_value=True), \
                patch("cauce_container_restart.os.close"):
            with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_NOT_EMPTY$"):
                with restart_fence({}):
                    self.fail("changed draft reached the signal boundary")
        self.assertEqual(pane.barrier.call_count, 2)
        self.assertTrue(pane.barrier.call_args.kwargs["release"])


if __name__ == "__main__":
    unittest.main()
