"""Native snapshot safety regressions using owned files and Unix sockets."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
SOURCE = ROOT / ".delegados/v4/live_adapter_v3_snapshot.py"
SPEC = importlib.util.spec_from_file_location("native_snapshot", SOURCE)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
TX = "b1ec2d38-177a-47b3-882c-fd22acf0e32d"
UNIT = "cauce-v3-host-astra.service"


class SnapshotTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="native-snapshot-")
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.uid = os.getuid()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.proc = self.root / "proc"
        self.proc.mkdir()
        self.cgroup = self.root / "cgroup"
        self.cgroup.mkdir()
        self.base = self.root / "sockets"
        self.base.mkdir(mode=0o700)
        self.profile = self.root / "astra-profile"
        self.workspace = self.root / "astra-workspace"
        self.other_profile = self.root / "other-profile"
        self.other_workspace = self.root / "other-workspace"
        for directory in (self.profile, self.workspace, self.other_profile, self.other_workspace):
            directory.mkdir(mode=0o700)
        self.pid = 901
        self.group = "/user.slice/user-1000.slice/user@1000.service/app.slice/" + UNIT
        self.env = {b"CAUCE_STATE_DIR": os.fsencode(self.state), b"CAUCE_SHARED_SESSION": b"1",
                    b"TMUX_TMPDIR": os.fsencode(self.base), b"CODEX_HOME": os.fsencode(self.profile),
                    b"HOME": os.fsencode(self.root)}
        self.make_process(self.pid, self.group, env=self.env)
        self.write("inbox.json", {"version": 1, "deliveries": {}})
        self.write("outbox.json", {"version": 1, "pending": []})
        self.patch = mock.patch.object(MODULE, "PROC", self.proc)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        self.cgroup_patch = mock.patch.object(MODULE, "CGROUP", self.cgroup)
        self.cgroup_patch.start()
        self.addCleanup(self.cgroup_patch.stop)
        self.command_patch = mock.patch.object(MODULE, "command", side_effect=self.command)
        self.command_patch.start()
        self.addCleanup(self.command_patch.stop)
        self.addCleanup(mock.patch.stopall)
        self.pane_output = "$1|@1|agente|%1|902"

    def write(self, name, value):
        target = self.state / name
        target.write_text(json.dumps(value))
        target.chmod(0o600)
        return target

    def make_process(self, pid, group, argv=None, exe="/usr/bin/node", env=None, cwd=None, start="42"):
        path = self.proc / str(pid)
        path.mkdir()
        (path / "stat").write_text(str(pid) + " (node (worker)) S " + " ".join(["0"] * 18 + [start] + ["0"] * 5))
        (path / "status").write_text("Uid:\t" + "\t".join([str(self.uid)] * 4) + "\n")
        (path / "cgroup").write_text("0::" + group + "\n")
        (path / "cmdline").write_bytes(b"\0".join(os.fsencode(item) for item in (argv or [exe])) + b"\0")
        (path / "environ").write_bytes(b"\0".join(key + b"=" + value for key, value in (env or {}).items()) + b"\0")
        (path / "exe").symlink_to(exe)
        (path / "cwd").symlink_to(cwd or self.workspace)
        (path / "net").mkdir()
        (path / "net/unix").write_text("Num RefCount Protocol Flags Type St Inode Path\n")
        if group == self.group or group.startswith(self.group + "/"):
            directory = self.cgroup / group.lstrip("/")
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / "cgroup.procs"
            previous = target.read_text() if target.exists() else ""
            target.write_text(previous + str(pid) + "\n")

    def command(self, *args):
        if args[0] == "systemctl":
            return "MainPID=" + str(self.pid) + "\nControlGroup=" + self.group + "\nActiveState=active"
        if args[0] == "tmux":
            return self.pane_output
        raise AssertionError("unexpected command")

    def snapshot(self):
        return MODULE.snapshot(UNIT, "astra", self.uid, str(self.state))

    def socket(self, listening):
        parent = self.base / ("tmux-" + str(self.uid))
        parent.mkdir(mode=0o700)
        target = parent / "cauce"
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(target))
        target.chmod(0o600)
        if listening:
            server.listen(8)
            (self.proc / str(self.pid) / "net/unix").write_text(
                "Num RefCount Protocol Flags Type St Inode Path\n"
                "000: 00000002 00000000 00010000 0001 01 123 " + str(target) + "\n")
            self.addCleanup(server.close)
        else:
            server.close()
        return target

    def terminal(self, state="failed", secret="private output and claim token"):
        return {"delivery_id": "delivery-one", "state": state, "claim_token": secret,
                "output": {"reply": secret}}

    def test_missing_tmux_and_terminal_inbox_are_stable_without_private_content(self):
        secret = "password-canary-body-claim-never-log"
        self.write("inbox.json", {"version": 1, "deliveries": {"delivery-one": self.terminal(secret=secret)}})
        first = self.snapshot()
        self.assertEqual(first, self.snapshot())
        self.assertEqual(first, self.snapshot())
        self.assertEqual((first["tui"], first["identity"]), ("absent", None))
        self.assertEqual(first["absence"]["local_deliveries"]["inbox_states"]["failed"], 1)
        self.assertNotIn(secret, json.dumps(first))
        self.assertNotIn("delivery-one", json.dumps(first))

    def test_existing_refused_socket_is_absent_only_without_kernel_registration(self):
        target = self.socket(False)
        self.assertEqual(self.snapshot()["absence"]["socket"]["status"], "refused")
        (self.proc / str(self.pid) / "net/unix").write_text(
            "Num RefCount Protocol Flags Type St Inode Path\n"
            "000: 00000002 00000000 00010000 0001 01 123 " + str(target) + "\n")
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_present_canonical_pane_keeps_original_identity(self):
        self.socket(True)
        self.make_process(902, self.group, exe="/usr/bin/codex", start="123")
        self.write("sessions.json", {"version": 1, "sessions": {
            "codex:astra:shared:astra": {"initialized": True, "native_id": TX}}})
        result = self.snapshot()
        self.assertEqual(result, {"adapter_pid": self.pid, "tui": "present", "identity": {
            "pane": ["$1", "@1", "%1", "902"], "pane_start": "123",
            "conversation_sha256": MODULE.digest(TX.encode())}})

    def test_present_missing_or_noncanonical_conversation_retains(self):
        self.socket(True)
        self.make_process(902, self.group, exe="/usr/bin/codex")
        for native in ("not-a-uuid", TX.upper(), None):
            with self.subTest(native=native):
                self.write("sessions.json", {"version": 1, "sessions": {
                    "codex:astra:shared:astra": {"initialized": True, "native_id": native}}})
                with self.assertRaises(MODULE.Retain):
                    self.snapshot()

    def test_present_multiple_canonical_panes_retains(self):
        self.socket(True)
        self.pane_output += "\n$1|@2|agente|%2|903"
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_local_accepted_started_and_unknown_states_retain(self):
        for state in ("accepted", "started", "unknown"):
            with self.subTest(state=state):
                self.write("inbox.json", {"version": 1, "deliveries": {"delivery-one": self.terminal(state)}})
                with self.assertRaises(MODULE.Retain):
                    self.snapshot()

    def test_shared_session_and_state_uid_are_pinned(self):
        with mock.patch.object(MODULE, "environment", return_value={**self.env, b"CAUCE_SHARED_SESSION": b"0"}):
            with self.assertRaises(MODULE.Retain):
                self.snapshot()
        with self.assertRaises(MODULE.Retain):
            MODULE.snapshot(UNIT, "astra", self.uid, str(self.root / "wrong"))
        with self.assertRaises(MODULE.Retain):
            MODULE.snapshot(UNIT, "astra", self.uid + 1, str(self.state))

    def test_unit_subgroup_process_retains_without_alias_environment(self):
        self.make_process(902, self.group + "/child", exe="/usr/bin/bash", env={})
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_direct_cgroup_membership_retains_pid_hidden_from_uid_scan(self):
        directory = self.cgroup / self.group.lstrip("/")
        (directory / "cgroup.procs").write_text(str(self.pid) + "\n999\n")
        self.assertFalse((self.proc / "999").exists())
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_root_owned_nondumpable_uid_process_outside_unit_retains(self):
        self.make_process(902, "/other.service", exe="/usr/bin/codex")
        uid = 12345
        for pid in (self.pid, 902):
            (self.proc / str(pid) / "status").write_text("Uid:\t" + "\t".join([str(uid)] * 4) + "\n")
        adapter = {"pid": self.pid, "uid": uid, "start": "42", "cgroups": [self.group]}
        unit = {"process": adapter, "control_group": self.group}
        original_stat = pathlib.Path.stat

        def root_owned(path, *args, **kwargs):
            info = original_stat(path, *args, **kwargs)
            if path in (self.proc / str(self.pid), self.proc / "902"):
                return mock.Mock(st_uid=0)
            return info

        def process(pid):
            if pid == self.pid:
                return adapter
            raise PermissionError("nondumpable")

        with mock.patch.object(pathlib.Path, "stat", root_owned), mock.patch.object(MODULE, "process_identity", process):
            with self.assertRaises(MODULE.Retain):
                MODULE.process_absence(unit, uid, self.env, str(self.workspace))

    def test_stable_root_owned_proc_directory_preserves_status_uid(self):
        original_stat = pathlib.Path.stat

        def root_owned(path, *args, **kwargs):
            if path == self.proc / str(self.pid):
                return mock.Mock(st_uid=0)
            return original_stat(path, *args, **kwargs)

        with mock.patch.object(pathlib.Path, 'stat', root_owned):
            self.assertEqual(MODULE.process_identity(self.pid)['uid'], self.uid)

    def test_unknown_or_unreadable_cgroup_membership_retains(self):
        target = self.cgroup / self.group.lstrip("/") / "cgroup.procs"
        for raw in ("unknown\n", "", "0\n"):
            with self.subTest(raw=raw):
                target.write_text(raw)
                with self.assertRaises(MODULE.Retain):
                    self.snapshot()
        target.unlink()
        with self.assertRaises(OSError):
            self.snapshot()

    def test_cgroup_subgroup_without_readable_membership_retains(self):
        target = self.cgroup / self.group.lstrip("/") / "child"
        target.mkdir()
        with self.assertRaises(OSError):
            self.snapshot()

    def test_codex_outside_unit_is_ambiguous_without_independent_attribution(self):
        self.make_process(902, "/user.slice", exe="/usr/bin/codex", env={b"HOME": b"/other"}, cwd="/other")
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_codex_independent_unit_with_separate_home_workspace_is_excluded(self):
        self.make_process(902, "/user.slice/other.service", exe="/usr/bin/codex",
                          env={b"CODEX_HOME": os.fsencode(self.other_profile)}, cwd=self.other_workspace)
        self.assertEqual(self.snapshot()["tui"], "absent")

    def test_codex_other_unit_profile_trailing_slash_or_realpath_alias_retains(self):
        self.make_process(902, "/user.slice/other.service", exe="/usr/bin/codex",
                          env={b"CODEX_HOME": os.fsencode(self.profile) + b"/"}, cwd=self.other_workspace)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        alias = str(self.other_profile / ".." / self.profile.name)
        (self.proc / "902/environ").write_bytes(b"CODEX_HOME=" + os.fsencode(alias) + b"\0")
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_codex_other_unit_symlink_to_same_profile_retains(self):
        alias = self.root / "profile-link"
        alias.symlink_to(self.profile)
        self.make_process(902, "/user.slice/other.service", exe="/usr/bin/codex",
                          env={b"CODEX_HOME": os.fsencode(alias)}, cwd=self.other_workspace)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_codex_other_unit_missing_attribution_directory_retains(self):
        self.make_process(902, "/user.slice/other.service", exe="/usr/bin/codex",
                          env={b"CODEX_HOME": os.fsencode(self.root / "missing")}, cwd=self.other_workspace)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_codex_other_unit_matching_home_or_workspace_or_argv_retains(self):
        self.make_process(902, "/user.slice/other.service", exe="/usr/bin/codex",
                          env={b"CODEX_HOME": os.fsencode(self.profile)}, cwd=self.other_workspace)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        (self.proc / "902/environ").write_bytes(b"CODEX_HOME=" + os.fsencode(self.other_profile) + b"\0")
        (self.proc / "902/cwd").unlink()
        (self.proc / "902/cwd").symlink_to(self.workspace)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        (self.proc / "902/cwd").unlink()
        (self.proc / "902/cwd").symlink_to(self.other_workspace)
        (self.profile / "config.toml").touch()
        (self.proc / "902/cmdline").write_bytes(b"codex\0--config\0" + os.fsencode(self.profile / "config.toml") + b"\0")
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_process_read_failure_and_pid_reuse_retain(self):
        self.make_process(902, "/other.service", exe="/usr/bin/python3")
        (self.proc / "902/exe").unlink()
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        original = MODULE.unit_identity
        calls = 0

        def changed(*args):
            nonlocal calls
            value = original(*args)
            calls += 1
            if calls > 1:
                value["process"]["start"] = "changed"
            return value

        (self.proc / "902/exe").symlink_to("/usr/bin/python3")
        with mock.patch.object(MODULE, "unit_identity", side_effect=changed):
            with self.assertRaises(MODULE.Retain):
                self.snapshot()

    def test_applied_persistent_wal_is_not_a_live_delivery(self):
        self.write("inbox.json", {"version": 1, "last_transaction_id": TX, "deliveries": {
            "delivery-one": self.terminal()}})
        self.write("outbox.json", {"version": 1, "last_transaction_id": TX, "pending": []})
        self.write("delivery-transaction.json", {"version": 1, "transaction_id": TX,
                   "inbox_updates": {"delivery-one": self.terminal()}, "outbox_pending": []})
        self.assertEqual(self.snapshot()["absence"]["local_deliveries"]["wal"], "settled")

    def test_wal_mismatch_unknown_schema_targets_and_active_update_retain(self):
        values = [
            {"version": 1, "transaction_id": TX, "inbox_updates": {}},
            {"version": 1, "transaction_id": TX, "outbox_pending": []},
            {"version": 2, "transaction_id": TX, "inbox_updates": {}},
            {"version": 1, "transaction_id": TX, "future_work": []},
            {"version": 1, "transaction_id": "bad", "inbox_updates": {}},
            {"version": 1, "transaction_id": TX},
            {"version": 1, "transaction_id": TX, "inbox_updates": {"delivery-one": self.terminal("started")}},
        ]
        for value in values:
            with self.subTest(value=value):
                self.write("delivery-transaction.json", value)
                with self.assertRaises(MODULE.Retain):
                    self.snapshot()

    def test_atomic_artifact_duplicate_json_and_world_writable_file_retain(self):
        artifact = self.state / "inbox.json.some.atomic-committed"
        artifact.touch()
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        artifact.unlink()
        inbox = self.state / "inbox.json"
        inbox.write_text('{"version":1,"deliveries":{},"version":1}')
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        self.write("inbox.json", {"version": 1, "deliveries": {}}).chmod(0o606)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_group_writable_durable_file_retains(self):
        (self.state / "inbox.json").chmod(0o660)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_unrelated_sibling_directory_does_not_change_parent_identity(self):
        original = MODULE.Files.read
        created = False

        def sibling(files, name, optional=False):
            nonlocal created
            value = original(files, name, optional)
            if not created:
                (self.root / "unrelated-sibling").mkdir()
                created = True
            return value

        with mock.patch.object(MODULE.Files, "read", sibling):
            self.assertEqual(self.snapshot()["tui"], "absent")

    def test_symlink_parent_socket_or_durable_file_and_hardlink_retain(self):
        inbox = self.state / "inbox.json"
        inbox.rename(self.state / "other.json")
        inbox.symlink_to(self.state / "other.json")
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        inbox.unlink()
        os.link(self.state / "other.json", inbox)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        inbox.unlink()
        (self.state / "other.json").rename(inbox)
        parent = self.base / ("tmux-" + str(self.uid))
        parent.symlink_to(self.state)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()
        parent.unlink()
        parent.mkdir(mode=0o700)
        (parent / "cauce").symlink_to(inbox)
        with self.assertRaises(MODULE.Retain):
            self.snapshot()

    def test_socket_permission_timeout_and_unexpected_errors_retain(self):
        for error in (PermissionError(13, "private-canary"), TimeoutError("private-canary"),
                      OSError(5, "private-canary")):
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(socket.socket, "connect", side_effect=error):
                    with self.assertRaises(MODULE.Retain):
                        self.snapshot()

    def test_busy_file_read_or_change_before_final_validation_retains(self):
        original = MODULE.Files.read
        calls = 0

        def changing(files, name, optional=False):
            nonlocal calls
            value = original(files, name, optional)
            calls += 1
            if calls == 3:
                self.write("inbox.json", {"version": 1, "deliveries": {"delivery-one": self.terminal("accepted")}})
            return value

        with mock.patch.object(MODULE.Files, "read", changing):
            with self.assertRaises(MODULE.Retain):
                self.snapshot()

    def test_large_132mib_inbox_is_read_without_exposing_payload(self):
        target = self.state / "inbox.json"
        with target.open("wb") as stream:
            stream.write(b'{"version":1,"deliveries":{},"padding":"')
            for _ in range(132):
                stream.write(b"x" * (1024 * 1024))
            stream.write(b'"}')
        result = self.snapshot()
        self.assertGreater(result["absence"]["files"]["inbox.json"]["bytes"], 132 * 1024 * 1024)
        self.assertLess(len(json.dumps(result)), 3000)

    def test_source_is_standalone_and_failure_never_logs_private_paths(self):
        result = subprocess.run([sys.executable, "-I", "-B", "-c", SOURCE.read_text(), "unit", "bad alias", str(self.uid)],
                                capture_output=True, text=True, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stderr), {"status": "retained", "reason": "native TUI snapshot is ambiguous"})
        self.assertEqual(result.stdout, "")

    def test_main_output_is_json_with_no_diagnostics(self):
        with mock.patch.object(sys, "argv", ["snapshot", UNIT, "astra", str(self.uid), str(self.state)]):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                MODULE.main()
        self.assertEqual(json.loads(output.getvalue())["tui"], "absent")


class PrivilegedExecutableReadTest(unittest.TestCase):
    def setUp(self):
        self.proc = mock.patch.object(MODULE, 'PROC', pathlib.Path('/proc'))
        self.proc.start()
        self.addCleanup(self.proc.stop)

    def test_readable_executable_never_invokes_sudo(self):
        with mock.patch.object(os, 'readlink', return_value='/usr/bin/codex'), \
                mock.patch.object(subprocess, 'run') as elevated:
            self.assertEqual(MODULE.process_executable(42, True), '/usr/bin/codex')
        elevated.assert_not_called()

    def test_permission_error_without_opt_in_retains(self):
        with mock.patch.object(os, 'readlink', side_effect=PermissionError()), \
                mock.patch.object(subprocess, 'run') as elevated:
            with self.assertRaises(MODULE.Retain):
                MODULE.process_executable(42)
        elevated.assert_not_called()

    def test_opt_in_only_reads_the_numeric_process_executable(self):
        result = subprocess.CompletedProcess([], 0, '/usr/bin/codex\n', '')
        with mock.patch.object(os, 'readlink', side_effect=PermissionError()), \
                mock.patch.object(subprocess, 'run', return_value=result) as elevated:
            self.assertEqual(MODULE.process_executable(42, True), '/usr/bin/codex')
        self.assertEqual(elevated.call_args.args[0], ['/usr/bin/sudo', '-n', '--', '/usr/bin/readlink', '--', '/proc/42/exe'])

    def test_failed_or_ambiguous_privileged_read_retains(self):
        for result in [subprocess.CompletedProcess([], 1, '', ''),
                       subprocess.CompletedProcess([], 0, '/usr/bin/node\n/other\n', '')]:
            with self.subTest(result=result), mock.patch.object(os, 'readlink', side_effect=PermissionError()), \
                    mock.patch.object(subprocess, 'run', return_value=result):
                with self.assertRaises(MODULE.Retain):
                    MODULE.process_executable(42, True)

    def test_privileged_timeout_cannot_prove_absence(self):
        with mock.patch.object(os, 'readlink', side_effect=PermissionError()), \
                mock.patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('readlink', 5)):
            with self.assertRaises(subprocess.TimeoutExpired):
                MODULE.process_executable(42, True)


if __name__ == "__main__":
    unittest.main()
