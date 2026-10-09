#!/usr/bin/env python3
"""ops/scripts/publish-telegram-token.py: the token lands where the generated row points."""
from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
SPEC = importlib.util.spec_from_file_location("publish_telegram_token", SCRIPTS / "publish-telegram-token.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
GENERATOR = MODULE.GENERATOR
MOUNT = "/run/cauce-telegram"
TOKEN = "123456789:" + "A" * 35
ROTATED = "987654321:" + "B" * 35


class PublishTelegramTokenTests(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = pathlib.Path(scratch.name)
        self.ops = self.root / "ops"
        self.ops.mkdir()
        fleet = {
            alias: {"tenant": tenant, "room": f"grp.{tenant.lower()}", "container": alias, "enabled": True,
                    "user": alias, "home": f"/home/{alias}", "runtimeStateDirectory": f"/home/{alias}/.state",
                    "harness": "claude", "role": "agent"}
            for alias, tenant in {"argos": "Steven", "atlas": "Miguel"}.items()
        }
        (self.ops / "flota.json").write_text(json.dumps({"schemaVersion": 1, "fleet": fleet}), encoding="utf-8")
        self.runtime = self.root / "runtime"
        self.runtime.mkdir(mode=0o750)
        self.live = self.runtime / "config.json"

    def publish(self, *extra: str, stdin: str = "") -> tuple[int, str, str]:
        argv = ["--runtime-dir", str(self.runtime), "--ops-dir", str(self.ops), "--no-cross-check",
                "--owner", f"{os.getuid()}:{os.getgid()}", "--reuse-existing-allowlist", *extra]
        out, err = io.StringIO(), io.StringIO()
        with mock.patch("sys.stdin", io.StringIO(stdin)), contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            code = MODULE.main(argv)
        self.assertNotIn(TOKEN, out.getvalue() + err.getvalue())
        self.assertNotIn(ROTATED, out.getvalue() + err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def host_path(self, alias: str) -> pathlib.Path:
        row = next(row for row in json.loads(self.live.read_bytes())["aliases"] if row["alias"] == alias)
        return self.runtime / pathlib.PurePosixPath(row["token_file"]).relative_to(MOUNT)

    def seed_flat_layout(self) -> None:
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(GENERATOR.main(["--ops-dir", str(self.ops), "--no-cross-check", "--output",
                                             str(self.live), "--allow-user-id", "111", "--allow-chat-id", "-222"]), 0)
        document = json.loads(self.live.read_bytes())
        for row in document["aliases"]:
            row["token_file"] = f"{MOUNT}/{row['alias']}.token"
            flat = self.runtime / f"{row['alias']}.token"
            flat.write_text(TOKEN, encoding="utf-8")
            flat.chmod(0o600)
        self.live.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
        self.live.chmod(0o640)

    def test_the_writer_creates_exactly_the_path_the_generator_emits(self) -> None:
        code, out, error = self.publish("--alias", "argos", "--token-stdin", stdin=TOKEN + "\n")
        self.assertEqual(code, 0, error)
        fleet = GENERATOR.load_fleet(self.ops, cross_check=False)
        emitted = GENERATOR.build_config(fleet, ["argos"])["aliases"][0]["token_file"]
        self.assertEqual(emitted, f"{MOUNT}/Steven/argos.token")
        created = self.runtime / pathlib.PurePosixPath(emitted).relative_to(MOUNT)
        self.assertEqual(self.host_path("argos"), created)
        self.assertEqual(created.read_text(encoding="utf-8"), TOKEN)
        self.assertEqual(stat.S_IMODE(created.lstat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(created.parent.lstat().st_mode), 0o750)
        self.assertFalse((self.runtime / "argos.token").exists(), "no flat layout is referenced")
        self.assertEqual(stat.S_IMODE(self.live.lstat().st_mode), 0o640)
        self.assertIn(str(created), out)

    def test_adopts_a_flat_token_and_keeps_its_flat_name_while_the_flat_layout_is_referenced(self) -> None:
        self.seed_flat_layout()
        code, _, error = self.publish("--alias", "argos")
        self.assertEqual(code, 0, error)
        rows = {row["alias"]: row for row in json.loads(self.live.read_bytes())["aliases"]}
        self.assertEqual(rows["argos"]["token_file"], f"{MOUNT}/Steven/argos.token")
        self.assertEqual(rows["atlas"]["token_file"], f"{MOUNT}/atlas.token")
        self.assertEqual(rows["argos"]["allowed_user_ids"], ["111"])
        self.assertTrue(os.path.samefile(self.host_path("argos"), self.runtime / "argos.token"))
        self.assertFalse((self.runtime / "Miguel").exists())
        self.assertEqual(stat.S_IMODE(self.live.lstat().st_mode), 0o640)

        rotated = self.root / "rotated.token"
        rotated.write_text(ROTATED + "\n", encoding="utf-8")
        code, _, error = self.publish("--alias", "argos", "--token-file", str(rotated))
        self.assertEqual(code, 0, error)
        self.assertEqual(self.host_path("argos").read_text(encoding="utf-8"), ROTATED)
        self.assertTrue(os.path.samefile(self.host_path("argos"), self.runtime / "argos.token"))

    def test_an_invalid_token_or_a_failed_preflight_never_touches_config_json(self) -> None:
        code, _, error = self.publish("--alias", "argos", "--token-stdin", stdin="pasted half a token\n")
        self.assertEqual(code, 1)
        self.assertIn("BotFather", error)
        self.assertFalse(self.live.exists())
        self.assertFalse((self.runtime / "Steven" / "argos.token").exists())

        self.seed_flat_layout()
        before = self.live.read_bytes()
        code, _, error = self.publish("--alias", "argos", "--preflight")
        self.assertEqual(code, 1)
        self.assertIn("marker missing", error)
        self.assertEqual(self.live.read_bytes(), before)

    def test_dry_run_reports_the_destination_and_writes_nothing(self) -> None:
        self.seed_flat_layout()
        before = {path: path.read_bytes() for path in self.runtime.rglob("*")}
        code, out, error = self.publish("--alias", "atlas", "--dry-run")
        self.assertEqual(code, 0, error)
        self.assertIn(f"{self.runtime}/Miguel/atlas.token (adopt flat)", out)
        self.assertEqual({path: path.read_bytes() for path in self.runtime.rglob("*")}, before)

    def test_a_missing_token_without_a_terminal_fails_closed(self) -> None:
        command = [sys.executable, str(SCRIPTS / "publish-telegram-token.py"), "--runtime-dir", str(self.runtime),
                   "--ops-dir", str(self.ops), "--no-cross-check", "--alias", "argos",
                   "--owner", f"{os.getuid()}:{os.getgid()}"]
        result = subprocess.run(command, capture_output=True, text=True, stdin=subprocess.DEVNULL,
                                start_new_session=True, check=False, timeout=60)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn("token is missing", result.stderr)
        self.assertFalse(self.live.exists())


if __name__ == "__main__":
    unittest.main()
