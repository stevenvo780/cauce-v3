#!/usr/bin/env python3
from __future__ import annotations

import os
import pathlib
import fcntl
import stat
import subprocess
import sys
import tempfile
import time
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
HELPER = ROOT / "scripts" / "alias-lock-exec.py"


class AliasLockExecTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-alias-lock-")
        self.lock_root = pathlib.Path(self.temporary.name) / "locks"
        self.lock_root.mkdir(mode=0o700)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def command(self, alias: str, child: list[str]) -> list[str]:
        return [
            sys.executable,
            os.fspath(HELPER),
            "run",
            "--lock-root",
            os.fspath(self.lock_root),
            "--alias",
            alias,
            "--",
            *child,
        ]

    def test_inherited_descriptor_verifies_by_inode_and_lock(self) -> None:
        result = subprocess.run(
            self.command(
                "iza",
                [
                    sys.executable,
                    os.fspath(HELPER),
                    "verify",
                    "--lock-root",
                    os.fspath(self.lock_root),
                    "--alias",
                    "iza",
                ],
            ),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_second_writer_fails_while_first_process_owns_lock(self) -> None:
        marker = pathlib.Path(self.temporary.name) / "ready"
        first = subprocess.Popen(
            self.command(
                "iza",
                [
                    sys.executable,
                    "-c",
                    "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(10)",
                    os.fspath(marker),
                ],
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists(), "first lock owner never started")
            second = subprocess.run(
                self.command("iza", [sys.executable, "-c", "raise SystemExit(0)"]),
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(second.returncode, 73)
            self.assertIn("already held", second.stderr)
        finally:
            first.terminate()
            first.wait(timeout=5)
            if first.stderr is not None:
                first.stderr.close()

    def test_symlink_lock_never_truncates_target(self) -> None:
        private = self.lock_root / f"cauce-v3-alias-locks-{os.geteuid()}"
        private.mkdir(mode=0o700)
        target = pathlib.Path(self.temporary.name) / "target"
        target.write_text("intacto\n", encoding="utf-8")
        (private / "iza.lock").symlink_to(target)
        result = subprocess.run(
            self.command("iza", [sys.executable, "-c", "raise SystemExit(0)"]),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 73)
        self.assertEqual(target.read_text(encoding="utf-8"), "intacto\n")

    def test_legacy_supervisor_lock_blocks_new_writer(self) -> None:
        legacy = self.lock_root / "cauce-v3-container-iza.lock"
        descriptor = os.open(legacy, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            os.chmod(legacy, 0o600)
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result = subprocess.run(
                self.command("iza", [sys.executable, "-c", "raise SystemExit(0)"]),
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 73)
            self.assertIn("legacy alias lock is already held", result.stderr)
        finally:
            os.close(descriptor)

    def test_missing_root_is_created_without_following_ancestors(self) -> None:
        missing_root = pathlib.Path(self.temporary.name) / "new" / "nested" / "locks"
        self.lock_root = missing_root
        result = subprocess.run(
            self.command("iza", [sys.executable, "-c", "raise SystemExit(0)"]),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(missing_root.stat().st_mode), 0o700)

    def test_restrictive_umask_cannot_poison_new_lock_paths(self) -> None:
        missing_root = pathlib.Path(self.temporary.name) / "umask" / "locks"
        self.lock_root = missing_root
        result = subprocess.run(
            self.command("iza", [sys.executable, "-c", "raise SystemExit(0)"]),
            capture_output=True,
            text=True,
            check=False,
            preexec_fn=lambda: os.umask(0o777),
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        private = missing_root / f"cauce-v3-alias-locks-{os.geteuid()}"
        self.assertEqual(stat.S_IMODE(missing_root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((private / "iza.lock").stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE((missing_root / "cauce-v3-container-iza.lock").stat().st_mode), 0o600)

    def test_different_aliases_do_not_contend(self) -> None:
        marker = pathlib.Path(self.temporary.name) / "first-ready"
        first = subprocess.Popen(
            self.command(
                "iza",
                [sys.executable, "-c", "import pathlib,sys,time; pathlib.Path(sys.argv[1]).touch(); time.sleep(10)", os.fspath(marker)],
            ),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
        )
        try:
            deadline = time.monotonic() + 5
            while not marker.exists() and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertTrue(marker.exists())
            other = subprocess.run(
                self.command("atlas", [sys.executable, "-c", "raise SystemExit(0)"]),
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(other.returncode, 0, other.stderr)
        finally:
            first.terminate()
            first.wait(timeout=5)
            if first.stderr is not None:
                first.stderr.close()

    def test_supervisor_and_provisioner_use_the_same_helper(self) -> None:
        supervisor = (ROOT / "scripts" / "container-adapter-supervisor.sh").read_text(encoding="utf-8")
        provisioner = (ROOT / "scripts" / "provision-hermes-runtime.sh").read_text(encoding="utf-8")
        self.assertIn('ALIAS_LOCK_EXEC="$ROOT/scripts/alias-lock-exec.py"', supervisor)
        self.assertIn('lock_helper="$ops_root/scripts/alias-lock-exec.py"', provisioner)
        self.assertNotIn("flock -n", supervisor)
        self.assertNotIn("flock -n", provisioner)


if __name__ == "__main__":
    unittest.main()
