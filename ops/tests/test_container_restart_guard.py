import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from contextlib import nullcontext
from unittest.mock import Mock, patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "container-runtime"))

from cauce_container_base import PermanentError, framed_hash
from cauce_container_restart import (
    RestartPane,
    adapter_harness,
    assert_empty_composer,
    process_environment,
    restart_fence,
    shared_pane,
    tmux_absent,
)


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
                patch("cauce_container_restart.tmux_absent", return_value=False), \
                patch("cauce_container_restart.RestartPane.session_absent", return_value=False), \
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

    def test_shared_fleet_rejects_unpinned_socket_directories(self):
        document, environment = self.shared_identity()
        signal = Mock()
        for value in ("", "/foreign", "relative"):
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

    def test_shared_wire_supervisor_keeps_the_observed_default_socket(self):
        document, environment = self.shared_identity()
        environment.pop("TMUX_TMPDIR")
        with patch("cauce_container_restart.os.geteuid", return_value=0):
            pane = RestartPane(document, environment)
        self.assertEqual(pane.target, "=cauce-zz-canary-restart-physical:agente")
        self.assertNotIn("TMUX_TMPDIR", pane.environment)

    def test_pane_identity_uses_printable_separators(self):
        pane = object.__new__(RestartPane)
        pane.target = "=cauce-zz-canary-restart:agente"
        pane.uid = 1000
        pane.hooks = Mock()

        def run(*arguments):
            self.assertEqual(arguments[:3], ("list-panes", "-t", pane.target))
            fields = {"pane_id": "%1", "pane_pid": "101", "pane_in_mode": "0", "pane_dead": "0",
                      "cursor_x": "2", "cursor_y": "0", "@cauce_input_barrier": "", "pane_input_off": "0",
                      "pane_width": "80", "pid": "102"}
            expanded = arguments[4].replace("\t", "_")
            for key, value in fields.items():
                expanded = expanded.replace("#{" + key + "}", value)
            return expanded + "\n"

        pane.run = run
        with patch("cauce_container_restart.process_identity", return_value=(7, 1000)):
            self.assertEqual(pane.fields(), ("%1", "101", "0", "0", "2", "0", "", "0", "80", "102"))

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

    def fake_proc(self, root, processes):
        for pid, comm in processes.items():
            (root / pid).mkdir()
            if comm is not None:
                (root / pid / "comm").write_bytes(comm)
        (root / "self").mkdir()

    def test_shared_session_without_any_tmux_process_stops_without_a_pane(self):
        document, environment = self.shared_identity()
        signal = Mock()
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.fake_proc(root, {"1": b"python3\n", "944": b"node\n", "950": b"codex\n", "951": None})
            with patch("cauce_container_restart.PROC", temporary), \
                    patch("cauce_container_restart.os.geteuid", return_value=0), \
                    patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                    patch("cauce_container_restart.process_environment", return_value=environment), \
                    patch("cauce_container_restart.subprocess.run") as run:
                self.assertIsNone(shared_pane(document))
                with restart_fence(document):
                    signal()
            run.assert_not_called()
        signal.assert_called_once_with()

    def test_any_tmux_process_keeps_the_pane_checks(self):
        for comm in (b"tmux: server\n", b"tmux: client\n", b"tmux\n"):
            with self.subTest(comm=comm), tempfile.TemporaryDirectory() as temporary:
                self.fake_proc(pathlib.Path(temporary), {"1": b"python3\n", "70": comm})
                with patch("cauce_container_restart.PROC", temporary), \
                        patch("cauce_container_restart.proc_stat", return_value={"state": "S"}):
                    self.assertFalse(tmux_absent())

    def tmux_answers(self, has_session, *, hooks=b"after-capture-pane\nsession-created\n", aliases=b""):
        calls = []

        def run(command, **_options):
            calls.append(tuple(command[4:]))
            if command[4] == "show-hooks":
                return Mock(returncode=0, stdout=hooks, stderr=b"")
            if command[4] == "show-options":
                return Mock(returncode=0, stdout=aliases, stderr=b"")
            return Mock(returncode=has_session[0], stdout=b"", stderr=has_session[1])
        return run, calls

    def test_tmux_without_the_exact_agent_session_has_no_composer_to_protect(self):
        document, environment = self.shared_identity()
        signal = Mock()
        absent = (1, b"can't find session: cauce-zz-canary-restart-physical\n")
        run, calls = self.tmux_answers(absent)
        with patch("cauce_container_restart.tmux_absent", return_value=False), \
                patch("cauce_container_restart.os.geteuid", return_value=0), \
                patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                patch("cauce_container_restart.process_environment", return_value=environment), \
                patch("cauce_container_restart.subprocess.run", side_effect=run):
            self.assertIsNone(shared_pane(document))
            with restart_fence(document):
                signal()
        signal.assert_called_once_with()
        self.assertEqual(calls, [("show-hooks", "-g", "-t", "=cauce-zz-canary-restart-physical:agente"),
                                 ("show-options", "-s", "command-alias"),
                                 ("has-session", "-t", "=cauce-zz-canary-restart-physical")] * 2)
        run, _calls = self.tmux_answers((0, b""))
        with patch("cauce_container_restart.tmux_absent", return_value=False), \
                patch("cauce_container_restart.os.geteuid", return_value=0), \
                patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                patch("cauce_container_restart.process_environment", return_value=environment), \
                patch("cauce_container_restart.subprocess.run", side_effect=run):
            self.assertIsInstance(shared_pane(document), RestartPane)

    def test_unreadable_tmux_or_another_missing_session_keeps_failing_closed(self):
        document, environment = self.shared_identity()
        answers = {
            "no_server": (1, b"no server running on /tmp/cauce-state/physical-one/tmux-1000/cauce\n"),
            "refused_socket": (1, b"error connecting to /tmp/cauce-state/physical-one/tmux-1000/cauce (Permission denied)\n"),
            "other_session": (1, b"can't find session: cauce-zz-canary-restart-physical-two\n"),
            "prefix_without_newline": (1, b"can't find session: cauce-zz-canary-restart-physical"),
            "other_status": (2, b"can't find session: cauce-zz-canary-restart-physical\n"),
            "present_with_noise": (0, b"warning\n"),
        }
        for name, answer in answers.items():
            run, _calls = self.tmux_answers(answer)
            with self.subTest(answer=name), patch("cauce_container_restart.tmux_absent", return_value=False), \
                    patch("cauce_container_restart.os.geteuid", return_value=0), \
                    patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                    patch("cauce_container_restart.process_environment", return_value=environment), \
                    patch("cauce_container_restart.subprocess.run", side_effect=run), \
                    self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_UNREADABLE$"):
                shared_pane(document)

    def test_session_probe_inspects_global_hooks_and_aliases_before_running(self):
        document, environment = self.shared_identity()
        absent = (1, b"can't find session: cauce-zz-canary-restart-physical\n")
        cases = {"TMUX_HOOKS": {"hooks": b"command-error[0] run-shell foreign-command\n"},
                 "TMUX_COMMAND_ALIAS": {"aliases": b'command-alias[0] "has-session=kill-server"\n'}}
        for reason, answer in cases.items():
            run, calls = self.tmux_answers(absent, **answer)
            with self.subTest(reason=reason), patch("cauce_container_restart.tmux_absent", return_value=False), \
                    patch("cauce_container_restart.os.geteuid", return_value=0), \
                    patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                    patch("cauce_container_restart.process_environment", return_value=environment), \
                    patch("cauce_container_restart.subprocess.run", side_effect=run), \
                    self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_" + reason + "$"):
                shared_pane(document)
            self.assertFalse(any(call[0] == "has-session" for call in calls))

    @unittest.skipUnless(pathlib.Path("/usr/bin/tmux").is_file(), "tmux is not installed")
    def test_real_tmux_neighbor_session_does_not_hide_the_missing_agent_session(self):
        document, environment = self.shared_identity()
        with tempfile.TemporaryDirectory(prefix="zz-canary-restart-") as temporary:
            document.update(stateDirectory=temporary, runtimeUid=os.getuid(), runtimeGid=os.getgid())
            environment.update(TMUX_TMPDIR=temporary, CAUCE_STATE_DIR=temporary)
            with patch("cauce_container_restart.os.geteuid", return_value=os.getuid() or 1):
                pane = RestartPane(document, environment)
            if os.getuid() == 0:
                pane.credentials = {}
            server = ["/usr/bin/tmux", "-L", "cauce"]
            options = {"env": pane.environment, "cwd": "/", "check": True, "capture_output": True, "timeout": 10}
            try:
                with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_UNREADABLE$"):
                    pane.session_absent()
                subprocess.run([*server, "new-session", "-d", "-s", "zz-canary-neighbor", "sleep 60"], **options)
                self.assertTrue(pane.session_absent())
                subprocess.run([*server, "new-session", "-d", "-s", "cauce-" + document["alias"] + "-two", "sleep 60"], **options)
                self.assertTrue(pane.session_absent())
                subprocess.run([*server, "new-session", "-d", "-s", "cauce-" + document["alias"], "-n", "agente", "sleep 60"],
                               **options)
                self.assertFalse(pane.session_absent())
            finally:
                subprocess.run([*server, "kill-server"], env=pane.environment, cwd="/", check=False, capture_output=True)

    def test_zombie_tmux_has_no_composer_and_allows_the_pinned_stop(self):
        document, environment = self.shared_identity()
        signal = Mock()
        with tempfile.TemporaryDirectory() as temporary:
            self.fake_proc(pathlib.Path(temporary), {"1": b"python3\n", "787": b"tmux: server\n"})
            with patch("cauce_container_restart.PROC", temporary), \
                    patch("cauce_container_restart.proc_stat", return_value={"state": "Z"}), \
                    patch("cauce_container_restart.os.geteuid", return_value=0), \
                    patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                    patch("cauce_container_restart.process_environment", return_value=environment), \
                    patch("cauce_container_restart.subprocess.run") as run:
                self.assertIsNone(shared_pane(document))
                with restart_fence(document):
                    signal()
            run.assert_not_called()
        signal.assert_called_once_with()

    def test_zombie_does_not_hide_another_live_tmux_process(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fake_proc(pathlib.Path(temporary), {"787": b"tmux: server\n", "788": b"tmux: client\n"})
            for state in ("S", "R", "D", "T", "I", "X", "?"):
                with self.subTest(state=state), patch("cauce_container_restart.PROC", temporary), \
                        patch("cauce_container_restart.proc_stat", side_effect=lambda pid, observed_state=state: {
                            "state": "Z" if pid == 787 else observed_state}):
                    self.assertFalse(tmux_absent())

    def test_disappeared_tmux_does_not_keep_a_pane_alive(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fake_proc(pathlib.Path(temporary), {"787": b"tmux: server\n"})
            with patch("cauce_container_restart.PROC", temporary), \
                    patch("cauce_container_restart.proc_stat", side_effect=ProcessLookupError(787)):
                self.assertTrue(tmux_absent())

    def test_unreadable_tmux_state_holds(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fake_proc(pathlib.Path(temporary), {"787": b"tmux: server\n"})
            for error in (PermissionError("denied"), PermanentError("malformed stat"), ValueError("invalid stat")):
                with self.subTest(error=type(error).__name__), patch("cauce_container_restart.PROC", temporary), \
                        patch("cauce_container_restart.proc_stat", side_effect=error), \
                        self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_PROCESS_UNKNOWN$"):
                    tmux_absent()

    def test_absence_still_requires_the_pinned_identity(self):
        document, environment = self.shared_identity()
        environment["TMUX_TMPDIR"] = "/foreign"
        with patch("cauce_container_restart.tmux_absent", return_value=True), \
                patch("cauce_container_restart.os.geteuid", return_value=0), \
                patch("cauce_container_restart.process_identity", return_value=(7, 1000)), \
                patch("cauce_container_restart.process_environment", return_value=environment), \
                self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_DIRECTORY_UNKNOWN$"):
            shared_pane(document)

    def test_unreadable_process_table_holds(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.fake_proc(root, {"1": b"python3\n"})
            (root / "80").mkdir()
            (root / "80" / "comm").mkdir()
            with patch("cauce_container_restart.PROC", temporary), \
                    self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_PROCESS_UNKNOWN$"):
                tmux_absent()
        with patch("cauce_container_restart.PROC", "/nonexistent-proc-root"), \
                self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_TMUX_PROCESS_UNKNOWN$"):
            tmux_absent()

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
        assert_empty_composer("› \x1b[2mTry an owned prompt\x1b[22m\n", 2, 0)
        assert_empty_composer("──────\n❯ \n──────\nbypass permissions on\n", 2, 1, "claude")

    def test_truecolor_and_indexed_input_are_not_dim_placeholders(self):
        for color in ("38;2;225;225;225", "38;2;2;22;0", "48;2;225;225;225", "58;5;2",
                      "38:2::225:225:225", "38:5:2"):
            with self.subTest(color=color):
                with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_NOT_EMPTY$"):
                    assert_empty_composer("❯ \x1b[" + color + "mowned draft\x1b[39m\n", 2, 0)

    def test_dim_placeholders_keep_intensity_across_color_components(self):
        for color in ("38;2;0;22;2", "48;5;22", "38:2::0:22:2", "38:5:0"):
            with self.subTest(color=color):
                assert_empty_composer("neutral history\n\n› \x1b[2m\x1b[" + color
                                      + "mTry an owned prompt\x1b[22m\n", 2, 2)

    def test_grok_truecolor_frame_with_owner_text_holds(self):
        pane = ("neutral history\n\n  \x1b[38;2;80;80;88m╭────────────────╮\n"
                "  \x1b[38;2;80;80;88m│\x1b[38;2;225;225;225m \x1b[38;2;200;200;200m❯ "
                "\x1b[38;2;225;225;225mowned draft\x1b[38;2;80;80;88m│\n"
                "  \x1b[38;2;80;80;88m╰──────────── Grok\n")
        with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_NOT_EMPTY$"):
            assert_empty_composer(pane, 6, 3, "grok")

    def test_quoted_box_cannot_replace_the_pinned_codex_composer(self):
        pane = ("neutral history\n\n› quote this UI:\n  ╭──────────╮\n  │ >        │\n"
                "  ╰──────────╯\n\n  GPT ultra · Context 67% left\n  ? for shortcuts\n")
        with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_FAMILY_UNKNOWN$"):
            assert_empty_composer(pane, 6, 4, "codex")

    def test_harness_family_comes_from_the_pinned_adapter_command(self):
        for entry in (b"/opt/owned/packages/adapter-sdk/dist/src/bin/codex.js",
                      b"/opt/owned/adapter/src/bin/codex.js"):
            raw = b"node\0" + entry + b"\0"
            document = {"pid": 101, "runtimeUid": 1000, "runtimeGid": 1000,
                        "executable": {"cmdlineSha256": framed_hash([raw])}}
            with self.subTest(entry=entry), \
                    patch("cauce_container_restart.matched_fs_credentials", return_value=nullcontext()), \
                    patch("cauce_container_restart.pathlib.Path.read_bytes", return_value=raw):
                self.assertEqual(adapter_harness(document), "codex")
                document["executable"]["cmdlineSha256"] = framed_hash([b"changed"])
                with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_PROCESS_COMMAND_CHANGED$"):
                    adapter_harness(document)

    def test_harness_family_rejects_unrecognized_or_noncanonical_entries(self):
        for entry in (b"/opt/owned/codex.js", b"/opt/../owned/adapter/src/bin/codex.js",
                      b"relative/adapter/src/bin/codex.js"):
            raw = b"node\0" + entry + b"\0"
            document = {"pid": 101, "runtimeUid": 1000, "runtimeGid": 1000,
                        "executable": {"cmdlineSha256": framed_hash([raw])}}
            with self.subTest(entry=entry), \
                    patch("cauce_container_restart.matched_fs_credentials", return_value=nullcontext()), \
                    patch("cauce_container_restart.pathlib.Path.read_bytes", return_value=raw), \
                    self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_ADAPTER_ENTRY_UNKNOWN$"):
                adapter_harness(document)

    def test_input_rules_and_footer_words_do_not_close_the_composer(self):
        cases = [("neutral history\n\n› \n  ───────\n  owned draft\n", 2, 2),
                 ("neutral history\n\n› \n\n  explain context left with examples\n", 2, 2),
                 ("neutral history\n\n› \n\n  Context 67% left\n", 2, 2)]
        for pane, x, y in cases:
            with self.subTest(case=cases.index((pane, x, y))):
                with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_[A-Z_]+$"):
                    assert_empty_composer(pane, x, y)

    def test_bounded_families_reject_owner_continuations(self):
        for harness in ("claude", "muse", "gemini"):
            for continuation in ("  ───────\n  owned draft", "\n  ? for shortcuts"):
                with self.subTest(harness=harness, continuation=continuation), \
                        self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_CONTINUATION_UNKNOWN$"):
                    assert_empty_composer("neutral history\n────────\n❯ \n" + continuation
                                          + "\n────────\n", 2, 2, harness)
        with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_CONTINUATION_UNKNOWN$"):
            assert_empty_composer("╭──────╮\n│ ❯ │\n│   owned │\n╰──────╯\n", 4, 1, "grok")

    def test_unbounded_empty_viewport_does_not_prove_an_empty_buffer(self):
        for pane in ("❯ \n", "neutral history\n\n› \n\n\n"):
            with self.subTest(history="history" in pane):
                with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_[A-Z_]+$"):
                    assert_empty_composer(pane, 2, 2 if "history" in pane else 0)

    def test_pending_remote_images_hold_but_separated_history_survives(self):
        image = "  \x1b[36m[Image #1]\x1b[39m\n"
        prompt = "› \x1b[2mTry an owned prompt\x1b[22m\n"
        with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_ATTACHMENT_PENDING$"):
            assert_empty_composer("neutral history\n\n" + image + "\n" + prompt, 2, 4)
        assert_empty_composer("neutral history\n" + image + "\n\n" + prompt, 2, 4)

    def test_dim_paste_and_image_widgets_are_not_placeholders(self):
        for widget in ("[Pasted text #1 +20 lines]", "[Image #1]"):
            with self.subTest(widget=widget):
                with self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_ATTACHMENT_PENDING$"):
                    assert_empty_composer("› \x1b[2m" + widget + "\x1b[22m\n" + "\n" * 30, 2, 0)

    def codex_status_frame(self, status, *, gap=1):
        prompt = "\x1b[0;1m›\x1b[0;39;49m \x1b[2mAsk an owned question\x1b[0;39;49m"
        shortcuts = ("  \x1b[1m?\x1b[0;39;49m for shortcuts" + " " * 30
                     + "\x1b[38;5;179m⚠ 2 warnings \x1b[39m· \x1b[1mf2\x1b[0;39;49m to view")
        return "neutral completed output\n" + "\n" * 45 + prompt + "\n" * (gap + 1) + status + "\n" + shortcuts + "\n"

    def test_codex_styled_status_with_no_context_percentage_is_idle(self):
        status = ("  \x1b[38;5;223mOwnedModel default\x1b[39m · \x1b[38;5;151m~/owned/projects"
                  "\x1b[39m · \x1b[38;5;225mOwned thread")
        frame = self.codex_status_frame(status)
        self.assertEqual(len(frame.splitlines()), 50)
        assert_empty_composer(frame, 2, 46, "codex")

    def test_codex_styled_status_variants_preserve_the_segment_structure(self):
        model = "\x1b[38;5;223mOwnedModel high"
        cwd = "\x1b[38;5;151m~/owned/projects"
        variants = [
            "  " + model + "\x1b[39m · " + cwd,
            "  " + model + "\x1b[39m · " + cwd + "\x1b[39m · \x1b[38;5;225mOwned title…",
            "  " + model + "\x1b[39m · " + cwd + "\x1b[39m · \x1b[38;5;225mOwned · title",
            "  " + model + "\x1b[39m · " + cwd + "\x1b[39m · \x1b[38;5;153mowned-branch"
            + "\x1b[39m · \x1b[38;5;225mOwned title",
            "  " + model + "\x1b[39m · " + cwd + "\x1b[39m · \x1b[38;5;144mContext 67% left",
            "  \x1b[38;2;220;180;140mOwnedModel default\x1b[38;2;100;110;120m · "
            "\x1b[38;2;140;220;160m~/owned/projects\x1b[38;2;100;110;120m · "
            "\x1b[38;2;210;150;230mOwned title",
        ]
        for status in variants:
            with self.subTest(variant=variants.index(status)):
                assert_empty_composer(self.codex_status_frame(status), 2, 46, "codex")

    def test_codex_status_rejects_unstyled_or_incomplete_impostors(self):
        cases = [
            "  \x1b[38;5;223m \x1b[39m · \x1b[38;5;151mOwned title",
            "  \x1b[38;5;223m\u00a0\x1b[39m · \x1b[38;5;151mOwned title",
            "  \x1b[38;5;223mOwnedModel\x1b[39m · \x1b[38;5;151m\u00a0",
            "  OwnedModel default · ~/owned/projects · Owned title",
            "  \x1b[1mOwnedModel default · ~/owned/projects · Owned title\x1b[22m",
            "  \x1b[38;5;223mOwnedModel default\x1b[39m · ~/owned/projects",
            "  \x1b[38;5;223mOwnedModel default · ~/owned/projects · Owned title",
            "  \x1b[38;5;223mOwnedModel default\x1b[39m · ",
            "  \x1b[38;5;223mOwnedModel default\x1b[39m · \x1b[38;5;151m~/owned/projects\x1b[39m ·",
            "  \x1b[38;5;999mOwnedModel default\x1b[39m · \x1b[38;5;151m~/owned/projects",
            "  \x1b[38;5;223mOwnedModel default\x1b[39m · \x1b[38;5;151m~/owned/projects\x1b[2J",
        ]
        for status in cases:
            with self.subTest(case=cases.index(status)), \
                    self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_COMPOSER_CONTINUATION_UNKNOWN$"):
                assert_empty_composer(self.codex_status_frame(status), 2, 46, "codex")

    def test_codex_status_requires_its_position_and_does_not_hide_drafts(self):
        styled = "  \x1b[38;5;223mOwnedModel default\x1b[39m · \x1b[38;5;151m~/owned/projects"
        for gap in (0, 2):
            with self.subTest(gap=gap), self.assertRaises(PermanentError):
                assert_empty_composer(self.codex_status_frame(styled, gap=gap), 2, 46, "codex")
        frame = self.codex_status_frame(styled)
        for x, y in ((7, 46), (2, 48)):
            with self.subTest(cursor=(x, y)), self.assertRaises(PermanentError):
                assert_empty_composer(frame, x, y, "codex")
        for draft in ("OwnedModel default · ~/owned/projects · Owned title",
                      "\n\n  OwnedModel default · ~/owned/projects · Owned title",
                      "[Pasted text #1 +3 lines]", "\n  > Owned title"):
            candidate = "neutral history\n\n› " + draft + "\n\n" + styled + "\n"
            with self.subTest(draft=draft), self.assertRaises(PermanentError):
                assert_empty_composer(candidate, 2, 2, "codex")

    def test_claude_measured_composer_states_are_unchanged(self):
        def frame(draft):
            return "neutral history\n────────────\n❯\u00a0" + draft + "\n────────────\n  auto mode on (shift+tab)\n"

        assert_empty_composer(frame(""), 2, 2, "claude")
        for draft, x, y, reason in (
            ("owned draft", 13, 2, "COMPOSER_CURSOR_AMBIGUOUS"),
            ("owned draft", 2, 2, "COMPOSER_NOT_EMPTY"),
            ("owned first\n  owned second", 14, 3, "PROMPT_UNKNOWN"),
            ("owned first\n  owned second", 2, 2, "COMPOSER_NOT_EMPTY"),
            ("\n  owned second", 2, 2, "COMPOSER_CONTINUATION_UNKNOWN"),
        ):
            with self.subTest(reason=reason), self.assertRaisesRegex(PermanentError, "^RESTART_HOLD_" + reason + "$"):
                assert_empty_composer(frame(draft), x, y, "claude")

    def test_idle_harness_layouts_with_history_and_status_footers(self):
        # Idle composers as each TUI drew them on 25-oct, with their history replaced.
        codex = ("• Ran the last command\n  Worked for 1h 27m\n\n\n"
                 "\x1b[1m\x1b[38;2;186;130;255m»\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n\n"
                 "  \x1b[38;2;246;226;183mGPT ultra\x1b[39m · \x1b[38;2;242;181;144mContext 67% left\x1b[39m · branch\n"
                 "  \x1b[1m?\x1b[0m for shortcuts\n")
        grok = ("     Worked for 11m18s\n\n  \x1b[38;2;80;80;88m╭────────────────╮\n"
                "  \x1b[38;2;80;80;88m│\x1b[38;2;225;225;225m \x1b[38;2;200;200;200m❯ \x1b[38;2;225;225;225m"
                "            \x1b[38;2;80;80;88m│\n"
                "  \x1b[38;2;80;80;88m╰──────────── \x1b[38;2;128;128;128mGrok 4.7 (xhigh)\n\n"
                "  \x1b[1mShift+Tab\x1b[0m:mode  │  \x1b[1mCtrl+x\x1b[0m:shortcuts\n")
        gemini = ("> previous request\n\x1b[90m────────────\n\x1b[94m>\x1b[39m\n\x1b[90m────────────\n"
                  "? for shortcuts\x1b[39m        \x1b[2mGemini · high\n")
        muse = ("◆ Worked for 1h 26m\n\x1b[2m\x1b[38;2;103;108;116m──────────────\n"
                "\x1b[0m\x1b[38;2;251;191;36m❯ \x1b[39m\n\x1b[2m──────────────\n\x1b[0m  muse-wonder · max · YOLO\n")
        claude = ("neutral completed response\n──────────────── neutral mode ─\n❯ \n"
                  "────────────────────────────────\n  neutral model · bypass permissions on\n")
        synthetic = "STANDARD_READY:0000\n\n› \x1b[2mTry an owned prompt\x1b[22m\n\n\n"
        for harness, pane, x, y in (("codex", codex, 2, 4), ("grok", grok, 6, 3), ("gemini", gemini, 2, 2),
                                    ("muse", muse, 2, 2), ("claude", claude, 2, 2), ("synthetic", synthetic, 2, 2)):
            with self.subTest(harness=harness):
                assert_empty_composer(pane, x, y, "codex" if harness == "synthetic" else harness)

    def test_drafts_and_unknown_states_hold_without_disclosing_text(self):
        cases = [("❯ owned unsent text\n", 2, 0),
                 ("› \x1b[2mplaceholder\x1b[22mowned draft\n", 2, 0),
                 ("❯ \n  owned wrapped draft\n", 2, 0),
                 ("❯ first line\n  \n", 2, 1),
                 ("❯ owned draft\n› \n", 2, 1),
                 ("────────\nowned draft\n› \n", 2, 2),
                 ("owned wrapped input\n› \n", 2, 1),
                 ("› owned quote\n  \n  > \n", 4, 2),
                 ("› \n\n  owned second paragraph\n", 2, 0),
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
