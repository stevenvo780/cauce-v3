import pathlib
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "container-runtime"))

from cauce_container_base import PermanentError
from cauce_container_restart import RestartPane, assert_empty_composer, process_environment, restart_fence, shared_pane


class RestartGuardTests(unittest.TestCase):
    def shared_identity(self, *, wire=True):
        document = {"alias": "zz-canary-restart-physical", "stateDirectory": "/tmp/cauce-state/physical-one",
                    "controlDirectory": "/run/cauce-fleet/physical-one", "containerId": "a" * 64,
                    "containerGeneration": "b" * 64, "runtimeUid": 1000, "runtimeGid": 1000,
                    "pid": 101, "starttime": 7}
        environment = {"HOME": "/home/fixture", "CAUCE_SHARED_SESSION": "1", "CAUCE_ALIAS": document["alias"],
                       "CAUCE_STATE_DIR": document["stateDirectory"], "CAUCE_CONTROL_DIR": document["controlDirectory"],
                       "CAUCE_CONTAINER_ID": document["containerId"], "CAUCE_CONTAINER_GENERATION": document["containerGeneration"]}
        if wire:
            document.update(wireAlias="logical_alias", tenantId="Equipo_42")
            environment.update(CAUCE_ALIAS="logical_alias", CAUCE_RUNTIME_KEY=document["alias"],
                               CAUCE_TENANT_ID="Equipo_42", TMUX_TMPDIR=document["stateDirectory"])
        return document, environment

    def test_shared_fleet_uses_the_physical_target_and_pinned_socket_directory(self):
        document, environment = self.shared_identity()
        with patch("cauce_container_restart.os.geteuid", return_value=0), \
                patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                patch("cauce_container_restart.process_environment", return_value=environment), \
                patch("cauce_container_restart.subprocess.run", return_value=Mock(returncode=0, stdout=b"")) as run:
            pane = shared_pane(document)
            self.assertEqual(pane.target, "=cauce-zz-canary-restart-physical:agente")
            pane.run("list-panes", "-t", pane.target)
        arguments, options = run.call_args
        self.assertEqual(arguments[0], ["/usr/bin/tmux", "-N", "-L", "cauce", "list-panes", "-t", pane.target])
        self.assertEqual(options["env"], {"HOME": "/home/fixture", "PATH": "/usr/local/bin:/usr/bin:/bin",
                                          "LANG": "C.UTF-8", "TMUX_TMPDIR": document["stateDirectory"]})
        self.assertEqual((options["user"], options["group"], options["extra_groups"]), (1000, 1000, [1000]))
        self.assertEqual(options["cwd"], "/")

    def test_shared_fleet_rejects_missing_or_foreign_core_identity_before_tmux(self):
        document, environment = self.shared_identity()
        keys = ("CAUCE_ALIAS", "CAUCE_RUNTIME_KEY", "CAUCE_TENANT_ID", "CAUCE_STATE_DIR",
                "CAUCE_CONTROL_DIR", "CAUCE_CONTAINER_ID", "CAUCE_CONTAINER_GENERATION")
        signal = Mock()
        with patch("cauce_container_restart.os.geteuid", return_value=0), \
                patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                patch("cauce_container_restart.subprocess.run") as run:
            for key in keys:
                for value in (None, "foreign"):
                    observed = dict(environment)
                    if value is None:
                        observed.pop(key)
                    else:
                        observed[key] = value
                    with self.subTest(key=key, value=value), \
                            patch("cauce_container_restart.process_environment", return_value=observed), \
                            self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_SESSION_IDENTITY_UNKNOWN$"):
                        with restart_fence(document):
                            signal()
            run.assert_not_called()
        signal.assert_not_called()

    def test_shared_fleet_requires_the_metadata_socket_directory(self):
        document, environment = self.shared_identity()
        signal = Mock()
        for value in (None, "", "/foreign", "relative"):
            observed = dict(environment)
            if value is None:
                observed.pop("TMUX_TMPDIR")
            else:
                observed["TMUX_TMPDIR"] = value
            with self.subTest(value=value), patch("cauce_container_restart.os.geteuid", return_value=0), \
                    patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                    patch("cauce_container_restart.process_environment", return_value=observed), \
                    patch("cauce_container_restart.subprocess.run") as run, \
                    self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_DIRECTORY_UNKNOWN$"):
                with restart_fence(document):
                    signal()
            run.assert_not_called()
        signal.assert_not_called()

    def test_legacy_shared_runtime_keeps_its_alias_and_default_or_pinned_socket(self):
        document, environment = self.shared_identity(wire=False)
        for temporary in ({}, {"TMUX_TMPDIR": document["stateDirectory"]}):
            with self.subTest(temporary=temporary), patch("cauce_container_restart.os.geteuid", return_value=0):
                pane = RestartPane(document, {**environment, **temporary})
                self.assertEqual(pane.target, "=cauce-zz-canary-restart-physical:agente")
                self.assertEqual(pane.environment.get("TMUX_TMPDIR"), temporary.get("TMUX_TMPDIR"))
        for change in ({"TMUX_TMPDIR": "/foreign"}, {"CAUCE_RUNTIME_KEY": document["alias"]},
                       {"CAUCE_TENANT_ID": "Equipo_42"}, {"CAUCE_ALIAS": "foreign"}):
            with self.subTest(change=change), patch("cauce_container_restart.os.geteuid", return_value=0), \
                    self.assertRaises(PermanentError):
                RestartPane(document, {**environment, **change})

    def test_process_environment_captures_core_identity_and_rejects_selected_duplicates(self):
        document, environment = self.shared_identity()
        signal = Mock()
        data = b"\0".join(f"{key}={value}".encode() for key, value in environment.items()) + b"\0"
        with patch("cauce_container_restart.matched_fs_credentials") as credentials, \
                patch("cauce_container_restart.pathlib.Path.read_bytes", return_value=data + b"IGNORED=one\0IGNORED=two\0"):
            self.assertEqual(process_environment(101, 1000, 1000), environment)
            credentials.assert_called_once_with(1000, 1000)
        for key, value in environment.items():
            for repeated in (value, "foreign"):
                with self.subTest(key=key, identical=repeated == value), \
                        patch("cauce_container_restart.matched_fs_credentials"), \
                        patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                        patch("cauce_container_restart.subprocess.run") as run, \
                        patch("cauce_container_restart.pathlib.Path.read_bytes", return_value=data + f"{key}={repeated}\0".encode()), \
                        self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_PROCESS_ENVIRONMENT_UNKNOWN$"):
                    with restart_fence(document):
                        signal()
                run.assert_not_called()
        signal.assert_not_called()

    def test_shared_pane_rejects_a_changed_process_identity_before_environment_access(self):
        document, _environment = self.shared_identity()
        for identity in ((8, 1000), (7, 1001)):
            with self.subTest(identity=identity), \
                    patch("cauce_container_restart.process_identity", return_value=identity), \
                    patch("cauce_container_restart.process_environment") as environment, \
                    self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_PROCESS_IDENTITY_CHANGED$"):
                shared_pane(document)
            environment.assert_not_called()

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
