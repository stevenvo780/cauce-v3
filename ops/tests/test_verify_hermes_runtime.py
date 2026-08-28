#!/usr/bin/env python3
from __future__ import annotations

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest


OPS = pathlib.Path(__file__).resolve().parents[1]
VERIFIER = OPS / "scripts" / "verify-hermes-runtime.py"


class HermesRuntimeVerifierTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-hermes-runtime-")
        self.base = pathlib.Path(self.temporary.name)
        self.root = self.base / "runtime-root"
        self.runtime = self.root / "iza" / "runtime-1"
        self.source = self.runtime / "source"
        self.venv = self.runtime / "venv"
        self.source.mkdir(parents=True)
        subprocess.run([sys.executable, "-m", "venv", os.fspath(self.venv)], check=True)
        (self.source / "hermes_cli").mkdir()
        (self.source / "hermes_cli" / "__init__.py").write_text("", encoding="utf-8")
        (self.source / "hermes_cli" / "oneshot.py").write_text("", encoding="utf-8")
        (self.source / "uv.lock").write_text("locked\n", encoding="utf-8")
        subprocess.run(["git", "init", "-q", os.fspath(self.source)], check=True)
        subprocess.run(["git", "-C", os.fspath(self.source), "config", "user.email", "test@example.invalid"], check=True)
        subprocess.run(["git", "-C", os.fspath(self.source), "config", "user.name", "Cauce test"], check=True)
        subprocess.run(["git", "-C", os.fspath(self.source), "add", "."], check=True)
        subprocess.run(["git", "-C", os.fspath(self.source), "commit", "-qm", "fixture"], check=True)
        self.commit = subprocess.check_output(
            ["git", "-C", os.fspath(self.source), "rev-parse", "HEAD"], text=True
        ).strip()
        site = next(self.venv.glob("lib/python*/site-packages"))
        (site / "hermes-source.pth").write_text(f"{self.source}\n", encoding="utf-8")
        dist = site / "hermes_agent-0.20.5.dist-info"
        dist.mkdir()
        (dist / "METADATA").write_text("Metadata-Version: 2.1\nName: hermes-agent\nVersion: 0.20.5\n", encoding="utf-8")
        (dist / "direct_url.json").write_text(
            json.dumps({"url": self.source.as_uri(), "dir_info": {"editable": True}}), encoding="utf-8"
        )
        self.uv = self.runtime / "uv"
        self.uv.write_bytes(b"uv fixture\n")
        self.uv_sha = hashlib.sha256(self.uv.read_bytes()).hexdigest()
        self.lock_sha = hashlib.sha256((self.source / "uv.lock").read_bytes()).hexdigest()
        marker = "\n".join(
            (self.commit, "0.20.5", "0.11.21", "test-target", self.uv_sha, self.lock_sha, "https://example.invalid/uv.tgz", "a" * 64)
        ) + "\n"
        (self.runtime / ".cauce-runtime").write_text(marker, encoding="utf-8")
        self.seal()

    def tearDown(self) -> None:
        for current, directories, files in os.walk(self.base):
            for name in directories:
                path = pathlib.Path(current) / name
                if not path.is_symlink():
                    path.chmod(0o755)
            for name in files:
                path = pathlib.Path(current) / name
                if not path.is_symlink():
                    path.chmod(0o644)
        self.temporary.cleanup()

    def seal(self) -> None:
        for current, directories, files in os.walk(self.root):
            for name in directories:
                path = pathlib.Path(current) / name
                if not path.is_symlink():
                    path.chmod(0o555)
            for name in files:
                path = pathlib.Path(current) / name
                if not path.is_symlink():
                    executable = bool(path.stat().st_mode & 0o111)
                    path.chmod(0o555 if executable else 0o444)
        self.root.chmod(0o555)

    def command(self) -> list[str]:
        return [
            sys.executable, os.fspath(VERIFIER),
            "--allowed-root", os.fspath(self.root),
            "--runtime-dir", os.fspath(self.runtime),
            "--source-commit", self.commit,
            "--package-version", "0.20.5",
            "--uv-version", "0.11.21",
            "--uv-target", "test-target",
            "--uv-sha256", self.uv_sha,
            "--uv-lock-sha256", self.lock_sha,
            "--uv-archive-url", "https://example.invalid/uv.tgz",
            "--uv-archive-sha256", "a" * 64,
            "--owner-uid", str(os.geteuid()),
            "--system-python", sys.executable,
        ]

    def execute_verifier(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(self.command(), capture_output=True, text=True, check=False)

    def test_standard_venv_links_and_final_editable_path_are_accepted(self) -> None:
        result = self.execute_verifier()
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_symlink_escape_is_rejected(self) -> None:
        escape = self.runtime / "escape"
        self.runtime.chmod(0o755)
        escape.symlink_to("/etc/passwd")
        self.runtime.chmod(0o555)
        result = self.execute_verifier()
        self.assertEqual(result.returncode, 78)

    def test_ignored_entry_is_rejected(self) -> None:
        self.source.chmod(0o755)
        ignored = self.source / "ignored-runtime-state"
        exclude = self.source / ".git/info/exclude"
        exclude.chmod(0o644)
        with exclude.open("a", encoding="utf-8") as destination:
            destination.write("ignored-runtime-state\n")
        exclude.chmod(0o444)
        ignored.write_text("unexpected\n", encoding="utf-8")
        ignored.chmod(0o444)
        self.source.chmod(0o555)
        result = self.execute_verifier()
        self.assertEqual(result.returncode, 78)

    def test_editable_path_to_deleted_staging_is_rejected(self) -> None:
        site = next(self.venv.glob("lib/python*/site-packages"))
        pth = site / "hermes-source.pth"
        pth.chmod(0o644)
        pth.write_text(f"{self.base / 'deleted-stage'}\n", encoding="utf-8")
        pth.chmod(0o444)
        result = self.execute_verifier()
        self.assertEqual(result.returncode, 78)

    def test_uv_and_ready_marker_mismatch_are_rejected(self) -> None:
        self.uv.chmod(0o644)
        self.uv.write_bytes(b"tampered\n")
        self.uv.chmod(0o444)
        result = self.execute_verifier()
        self.assertEqual(result.returncode, 78)


if __name__ == "__main__":
    unittest.main()
