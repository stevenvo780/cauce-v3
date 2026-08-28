#!/usr/bin/env python3
"""Tests for ops/pty-agent/publish-alias-key.sh.

Verifies atomic publication of alias-key.hex with mode 0400 and refusal to overwrite.
Runs under `python3 -m unittest discover -s ops/pty-agent`.
"""
from __future__ import annotations

import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
PUBLISH_SCRIPT = AGENT_DIR / "publish-alias-key.sh"

MASTER_B64 = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8="
GOLDEN_JARVIS = "33ab99cc766ee43031f9c22b8db78aeae5b04bc0ebedddfe8539330af7233efa"


def _remove_tree(directory: pathlib.Path) -> None:
    def _onerror(func, path, exc_info):
        try:
            os.chmod(path, 0o700)
            func(path)
        except OSError:
            pass

    shutil.rmtree(directory, onerror=_onerror)


class PublishAliasKeyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = pathlib.Path(tempfile.mkdtemp(prefix="pty-pub-key-"))
        self.addCleanup(_remove_tree, self.temp_dir)
        self.master_file = self.temp_dir / "master.b64"
        self.master_file.write_text(MASTER_B64 + "\n", encoding="utf-8")
        os.chmod(self.master_file, 0o400)
        self.out_dir = self.temp_dir / "issued"

    def test_publishes_alias_key_with_master_file(self) -> None:
        cmd = [
            str(PUBLISH_SCRIPT),
            "--tenant", "Steven",
            "--alias", "jarvis",
            "--output-dir", str(self.out_dir),
            "--master-file", str(self.master_file),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, msg=f"stderr: {res.stderr}")
        self.assertIn("alias key publishing passed", res.stdout)

        final_key = self.out_dir / "alias-key.hex"
        self.assertTrue(final_key.exists())
        self.assertEqual(final_key.read_text(encoding="utf-8").strip(), GOLDEN_JARVIS)
        mode = stat.S_IMODE(final_key.stat().st_mode)
        self.assertEqual(mode, 0o400)

    def test_publishes_alias_key_with_master_env(self) -> None:
        cmd = [
            str(PUBLISH_SCRIPT),
            "--tenant", "Steven",
            "--alias", "jarvis",
            "--output-dir", str(self.out_dir),
            "--master-env", "TEST_PTY_MASTER",
        ]
        env = {**os.environ, "TEST_PTY_MASTER": MASTER_B64}
        res = subprocess.run(cmd, capture_output=True, text=True, env=env)
        self.assertEqual(res.returncode, 0, msg=f"stderr: {res.stderr}")

        final_key = self.out_dir / "alias-key.hex"
        self.assertTrue(final_key.exists())
        self.assertEqual(final_key.read_text(encoding="utf-8").strip(), GOLDEN_JARVIS)

    def test_publishes_alias_key_positional_args(self) -> None:
        cmd = [
            str(PUBLISH_SCRIPT),
            "Steven",
            "jarvis",
            str(self.out_dir),
            str(self.master_file),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, msg=f"stderr: {res.stderr}")

        final_key = self.out_dir / "alias-key.hex"
        self.assertTrue(final_key.exists())
        self.assertEqual(final_key.read_text(encoding="utf-8").strip(), GOLDEN_JARVIS)

    def test_refuses_overwrite_and_preserves_existing_key(self) -> None:
        self.out_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        final_key = self.out_dir / "alias-key.hex"
        final_key.write_text("existing-key-content\n", encoding="utf-8")
        os.chmod(final_key, 0o400)

        cmd = [
            str(PUBLISH_SCRIPT),
            "--tenant", "Steven",
            "--alias", "jarvis",
            "--output-dir", str(self.out_dir),
            "--master-file", str(self.master_file),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 1)
        self.assertIn("destination credential already exists", res.stderr)
        self.assertEqual(final_key.read_text(encoding="utf-8"), "existing-key-content\n")

    def test_rejects_invalid_identifiers(self) -> None:
        cmd = [
            str(PUBLISH_SCRIPT),
            "--tenant", "Invalid/Tenant",
            "--alias", "jarvis",
            "--output-dir", str(self.out_dir),
            "--master-file", str(self.master_file),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 2)
        self.assertIn("invalid tenant identifier", res.stderr)

    def test_rejects_non_absolute_output_dir(self) -> None:
        cmd = [
            str(PUBLISH_SCRIPT),
            "--tenant", "Steven",
            "--alias", "jarvis",
            "--output-dir", "relative/path",
            "--master-file", str(self.master_file),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True)
        self.assertEqual(res.returncode, 2)
        self.assertIn("output directory must be absolute", res.stderr)


if __name__ == "__main__":
    unittest.main()
