from __future__ import annotations

import argparse
import ast
import errno
import fcntl
import json
import os
import pathlib
import signal
import subprocess
import sys
import tempfile
import types
import unittest
from contextlib import ExitStack, contextmanager
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "container-runtime"))
import cauce_container_lease as LEASE
from cauce_container_adoption import mutation_guard
from cauce_container_base import PermanentError
from cauce_container_proc import open_lock

RUNTIME = pathlib.Path(__file__).resolve().parents[1] / "container-runtime"


@contextmanager
def child_process(command: str, *arguments: str, environment: dict[str, str] | None = None):
    child = subprocess.Popen([sys.executable, "-I", "-B", "-c", command, *arguments],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    try:
        if child.stdout.readline() != b"ready\n":
            raise AssertionError("owned child did not become ready")
        yield child
    finally:
        if child.poll() is None:
            child.kill()
        child.communicate(timeout=3)


def runtime_module() -> types.ModuleType:
    source = RUNTIME / "cauce-container-runtime.py"
    tree = ast.parse(source.read_text(encoding="utf-8"), str(source))
    boundary = next(index for index, node in enumerate(tree.body) if isinstance(node, ast.Assign)
                    and any(isinstance(target, ast.Name) and target.id == "parser" for target in node.targets))
    module = types.ModuleType("owned_consumer_lease_runtime")
    exec(compile(ast.Module(body=tree.body[:boundary], type_ignores=[]), str(source), "exec"), module.__dict__)
    return module


class ConsumerLeaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-consumer-lease-")
        self.addCleanup(self.temporary.cleanup)
        self.state = pathlib.Path(self.temporary.name)
        self.uid, self.gid = os.getuid() or 65534, os.getgid() or 65534
        if os.geteuid() == 0:
            os.chown(self.state, self.uid, self.gid)
        self.state_fd = os.open(self.state, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        self.addCleanup(os.close, self.state_fd)
        self.path = self.state / ".consumer-visible_alias.lock"
        self.body = json.dumps({"pid": os.getpid(), "instance_id": "owned-instance"}).encode() + b"\n"
        self.process_scan = mock.patch.object(LEASE, "assert_alias_quiescent")
        self.scan = self.process_scan.start()
        self.addCleanup(self.process_scan.stop)

    def write(self, body: bytes | None = None):
        self.path.write_bytes(self.body if body is None else body)
        self.path.chmod(0o600)
        if os.geteuid() == 0:
            os.chown(self.path, self.uid, self.gid)

    def retire(self):
        return LEASE.retire_consumer_lease(self.state_fd, str(self.state), "physical-runtime", "visible_alias",
                                           self.uid, self.gid)

    def test_absence_is_idempotent_and_closed_legacy_does_not_use_pid_liveness(self):
        self.assertFalse(self.retire())
        self.write()
        self.assertTrue(self.retire())
        self.assertFalse(self.path.exists())
        self.assertFalse(self.retire())

    def test_another_open_description_is_preserved(self):
        self.write()
        with self.path.open("rb"), self.assertRaises(PermanentError):
            self.retire()
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_live_legacy_child_blocks_and_sigkill_releases_the_kernel_proof(self):
        self.write()
        with child_process("import os,sys; fd=os.open(sys.argv[1],os.O_RDWR); print('ready',flush=True); sys.stdin.read()",
                           str(self.path)) as child:
            with self.assertRaises(PermanentError):
                self.retire()
            self.assertEqual(self.path.read_bytes(), self.body)
            child.kill()
            child.wait(timeout=3)
            self.assertTrue(self.retire())

    def test_malformed_unknown_and_oversized_records_are_preserved(self):
        records = (b"", b"not-json", b"[]", b'{"pid":1,"pid":2,"instance_id":"owned"}',
                   b'{"pid":true,"instance_id":"owned"}', b'{"pid":0,"instance_id":"owned"}',
                   b'{"pid":1,"instance_id":"x"}', b'{"pid":1,"instance_id":"owned","extra":1}',
                   b'{"pid":1,"instance_id":"owned"}\xff', b" " * (LEASE.MAX_LEASE_BYTES + 1))
        for body in records:
            with self.subTest(body=body[:30]):
                self.write(body)
                with self.assertRaises(PermanentError):
                    self.retire()
                self.assertEqual(self.path.read_bytes(), body)

    def test_symlink_hardlink_and_wrong_mode_are_preserved(self):
        target = self.state / "foreign"
        target.write_bytes(self.body)
        target.chmod(0o600)
        self.path.symlink_to(target)
        with self.assertRaises(PermanentError):
            self.retire()
        self.assertTrue(self.path.is_symlink())
        self.path.unlink()
        os.link(target, self.path)
        with self.assertRaises(PermanentError):
            self.retire()
        self.assertEqual(target.stat().st_nlink, 2)
        self.path.unlink()
        self.write()
        self.path.chmod(0o640)
        with self.assertRaises(PermanentError):
            self.retire()
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_inode_swap_during_proof_preserves_both_files(self):
        self.write()
        previous = self.state / "preserved"

        def swap(*_arguments):
            if self.scan.call_count == 2:
                self.path.rename(previous)
                self.write()

        self.scan.side_effect = swap
        with self.assertRaises(PermanentError):
            self.retire()
        self.assertEqual(previous.read_bytes(), self.body)
        self.assertEqual(self.path.read_bytes(), self.body)
        self.assertNotEqual(previous.stat().st_ino, self.path.stat().st_ino)

    def test_bytes_change_during_readback_is_preserved(self):
        self.write()
        pread = os.pread
        calls = 0

        def change(fd, size, offset):
            nonlocal calls
            calls += 1
            if calls == 2:
                os.pwrite(fd, self.body.replace(b"owned-instance", b"other-instance"), 0)
            return pread(fd, size, offset)

        with mock.patch.object(LEASE.os, "pread", side_effect=change), self.assertRaises(PermanentError):
            self.retire()
        self.assertIn(b"other-instance", self.path.read_bytes())

    def test_unsupported_filesystem_does_not_fall_back_to_pid_or_age(self):
        self.write()
        with mock.patch.object(LEASE.fcntl, "fcntl", side_effect=OSError(errno.EINVAL, "unsupported")), \
                self.assertRaises(PermanentError):
            self.retire()
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_foreign_ownership_and_invalid_identity_are_preserved(self):
        self.write()
        for uid, gid in ((self.uid + 1, self.gid), (self.uid, self.gid + 1), (0, self.gid), (self.uid, 0)):
            with self.subTest(uid=uid, gid=gid), self.assertRaises(PermanentError):
                LEASE.retire_consumer_lease(self.state_fd, str(self.state), "physical-runtime", "visible_alias", uid, gid)
            self.assertEqual(self.path.read_bytes(), self.body)
        for runtime_alias, wire_alias in (("other/path", "visible_alias"), ("physical-runtime", "../other"),
                                          ("physical-runtime", None)):
            with self.subTest(runtime_alias=runtime_alias, wire_alias=wire_alias), self.assertRaises(PermanentError):
                LEASE.retire_consumer_lease(self.state_fd, str(self.state), runtime_alias, wire_alias, self.uid, self.gid)
            self.assertEqual(self.path.read_bytes(), self.body)

    def test_sigio_from_a_concurrent_open_preserves_the_lease_and_restores_handler(self):
        self.write()
        previous = signal.getsignal(signal.SIGIO)

        def competing_open(*_arguments):
            if self.scan.call_count == 2:
                result = subprocess.run([sys.executable, "-I", "-B", "-c",
                    "import os,sys\ntry: os.open(sys.argv[1],os.O_RDONLY|os.O_NONBLOCK)\n"
                    "except BlockingIOError: sys.exit(0)\nsys.exit(1)", str(self.path)],
                    capture_output=True, timeout=3, check=False)
                self.assertEqual(result.returncode, 0)

        self.scan.side_effect = competing_open
        with self.assertRaises(PermanentError):
            self.retire()
        self.assertEqual(signal.getsignal(signal.SIGIO), previous)
        self.assertEqual(self.path.read_bytes(), self.body)
        self.scan.side_effect = None
        self.assertTrue(self.retire())

    def test_real_residual_process_of_another_generation_is_preserved(self):
        self.write()
        self.process_scan.stop()
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CAUCE_ALIAS": "visible_alias",
            "CAUCE_RUNTIME_KEY": "physical-runtime", "CAUCE_STATE_DIR": str(self.state),
            "CAUCE_CONTAINER_GENERATION": "a" * 64}
        with child_process("import sys; print('ready',flush=True); sys.stdin.read()", environment=environment) as child:
            with mock.patch.object(LEASE.os, "listdir", return_value=[str(os.getpid()), str(child.pid)]), \
                    self.assertRaisesRegex(PermanentError, "residual process"):
                self.retire()
        self.assertEqual(self.path.read_bytes(), self.body)

    def assert_nominal_legacy_process_is_preserved(self, runtime_key: str | None):
        self.write()
        self.process_scan.stop()
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CAUCE_ALIAS": "visible_alias",
            "CAUCE_STATE_DIR": str(self.state), "CAUCE_CONTAINER_GENERATION": "d" * 64}
        if runtime_key is not None:
            environment["CAUCE_RUNTIME_KEY"] = runtime_key
        with child_process("import sys; print('ready',flush=True); sys.stdin.read()", environment=environment) as child:
            with mock.patch.object(LEASE.os, "listdir", return_value=[str(os.getpid()), str(child.pid)]), \
                    self.assertRaisesRegex(PermanentError, "residual process"):
                self.retire()
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_nominal_legacy_process_without_runtime_key_preserves_the_closed_lease(self):
        self.assert_nominal_legacy_process_is_preserved(None)

    def test_nominal_legacy_process_with_discordant_runtime_key_preserves_the_closed_lease(self):
        self.assert_nominal_legacy_process_is_preserved("different-physical-runtime")

    def test_unreadable_process_identity_preserves_an_existing_record(self):
        self.write()
        self.process_scan.stop()
        with mock.patch.object(LEASE.os, "listdir", return_value=["987654"]), \
                mock.patch.object(LEASE, "selected_environment", side_effect=PermissionError), \
                self.assertRaisesRegex(PermanentError, "absence could not be verified"):
            self.retire()
        self.assertEqual(self.path.read_bytes(), self.body)

    def test_absent_legacy_record_does_not_block_a_surviving_tui(self):
        self.process_scan.stop()
        environment = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "CAUCE_ALIAS": "visible_alias",
            "CAUCE_RUNTIME_KEY": "physical-runtime", "CAUCE_STATE_DIR": str(self.state)}
        with child_process("import sys; print('ready',flush=True); sys.stdin.read()", environment=environment) as child:
            with mock.patch.object(LEASE.os, "listdir", return_value=[str(child.pid)]) as listing:
                self.assertFalse(self.retire())
                listing.assert_not_called()

    def test_historical_helper_bundle_loads_without_the_optional_lease_module(self):
        historical = self.state / "historical"
        historical.mkdir()
        for filename in ("cauce-container-runtime.py", "cauce_container_base.py", "cauce_container_proc.py",
                         "cauce_container_restart.py", "cauce_container_tree.py", "cauce_container_adoption.py"):
            (historical / filename).write_bytes((RUNTIME / filename).read_bytes())
        entry = str(historical / "cauce-container-runtime.py")
        bootstrap = (f"import runpy,sys;sys.path.insert(0,{str(historical)!r});"
                     f"sys.argv=[{entry!r},'bundle-digest',{str(historical)!r}];runpy.run_path({entry!r},run_name='__main__')")
        result = subprocess.run([sys.executable, "-I", "-B", "-c", bootstrap], capture_output=True, timeout=3, check=False)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertRegex(result.stdout.decode("ascii"), r"^sha256:[0-9a-f]{64}\n$")
        self.assertFalse((historical / "cauce_container_lease.py").exists())

    def test_run_holds_mutation_and_lifecycle_locks_through_retirement_and_spawn(self):
        self.write()
        module = runtime_module()
        control = self.state / "control"
        control.mkdir(mode=0o700)
        control_fd = os.open(control, os.O_RDONLY | os.O_DIRECTORY)
        self.addCleanup(os.close, control_fd)
        args = argparse.Namespace(command=[sys.executable], runtime_uid=self.uid, runtime_gid=self.gid,
            control_dir=str(control), state=str(self.state), alias="physical-runtime", wire_alias="visible_alias",
            tenant="Owned", container_id="a" * 64, generation="b" * 64, bundle="/owned/bundle",
            bundle_digest="sha256:" + "c" * 64, term_seconds=0.1, kill_seconds=0.1, retire_consumer_lease=True)
        events = []

        def assert_locks():
            with self.assertRaises(PermanentError):
                mutation_guard(control_fd, exclusive=True)
            probe = open_lock(control_fd)
            try:
                with self.assertRaises(BlockingIOError):
                    fcntl.flock(probe, fcntl.LOCK_EX | fcntl.LOCK_NB)
            finally:
                os.close(probe)

        def retire(*arguments):
            assert_locks()
            events.append("retire")
            return original_retire(*arguments)

        def spawn(*_arguments, **_keywords):
            assert_locks()
            self.assertFalse(self.path.exists())
            events.append("spawn")
            raise OSError("owned spawn failure")

        original_retire = LEASE.retire_consumer_lease
        with ExitStack() as stack:
            for name in ("set_dumpable", "set_subreaper", "startup_metadata", "phase_gate", "validate_metadata",
                         "atomic_metadata", "remove_metadata"):
                stack.enter_context(mock.patch.object(module, name))
            stack.enter_context(mock.patch.object(module, "bundle_digest", return_value=args.bundle_digest))
            stack.enter_context(mock.patch.object(LEASE, "retire_consumer_lease", side_effect=retire))
            stack.enter_context(mock.patch.object(module.signal, "signal"))
            stack.enter_context(mock.patch.object(module.subprocess, "Popen", side_effect=spawn))
            with self.assertRaisesRegex(OSError, "owned spawn failure"):
                module.run_adapter(args)
        self.assertEqual(events, ["retire", "spawn"])
        released = mutation_guard(control_fd, exclusive=True)
        os.close(released)
        released = open_lock(control_fd)
        fcntl.flock(released, fcntl.LOCK_EX | fcntl.LOCK_NB)
        os.close(released)


if __name__ == "__main__":
    unittest.main()
