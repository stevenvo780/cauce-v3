#!/usr/bin/env python3
"""Tests for ops/scripts/telegram-cutover-preflight.py.

Builds a hermetic runtime directory (config.json + token + marker) under a temp dir
that stands in for the host side of the compose bind mount, then asserts the preflight
passes on a correct layout and fails closed on each activation hazard: missing, empty or
insecure token, wrong marker content, unsafe marker mode, sentinel allowlists, an alias absent
from config, and token/marker paths outside the mount.

Runs standalone (`python3 ops/tests/test_telegram_cutover_preflight.py`) or under pytest.
"""
from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

OPS_DIR = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS_DIR = OPS_DIR / "scripts"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS_DIR / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


pre = _load("telegram_cutover_preflight", "telegram-cutover-preflight.py")
gen = _load("generate_telegram_config", "generate-telegram-config.py")

FLEET = {
    "kant": {"tenant": "Steven", "room": "grp.steven", "harness": "codex"},
    "argos": {"tenant": "Steven", "room": "grp.steven", "harness": "hermes"},
}
MOUNT = "/run/cauce-telegram"


def _config_with_real_allowlists() -> dict:
    options = gen.default_options()
    options["allowed_user_ids"] = ["1001"]
    options["allowed_chat_ids"] = ["1001"]
    return gen.build_config(FLEET, ["kant"], options)


class PreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = pathlib.Path(tempfile.mkdtemp(prefix="tg-preflight-"))
        self.addCleanup(self._cleanup)
        self.uid = os.getuid()
        self.config_path = self.tmp / "config.json"
        self._write_config(_config_with_real_allowlists())
        self._write_token(mode=0o600)
        self._write_marker("v2-poller-disabled:kant", mode=0o644)

    def _cleanup(self) -> None:
        for child in sorted(self.tmp.glob("**/*"), reverse=True):
            child.unlink() if child.is_file() or child.is_symlink() else child.rmdir()
        self.tmp.rmdir()

    def _write_config(self, config: dict) -> None:
        self.config_path.write_text(json.dumps(config), encoding="utf-8")

    def _write_token(self, *, mode: int) -> None:
        path = self.tmp / "kant.token"
        path.write_text("123456:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", encoding="utf-8")
        os.chmod(path, mode)

    def _write_marker(self, content: str, *, mode: int) -> None:
        path = self.tmp / "kant.disabled"
        path.write_text(f"{content}\n", encoding="utf-8")
        os.chmod(path, mode)

    def _run(self, **overrides):
        params = dict(
            selected=["kant"], mount=MOUNT, runtime_dir=self.tmp,
            expected_uid=self.uid, allow_placeholders=False,
        )
        params.update(overrides)
        selected = params.pop("selected")
        return pre.run(self.config_path, selected, **params)

    # --------------------------------------------------------------- happy path
    def test_pass_on_correct_layout(self) -> None:
        report = self._run()
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["aliases"][0]["findings"], [])

    # ------------------------------------------------------------------- token
    def test_missing_token_fails(self) -> None:
        (self.tmp / "kant.token").unlink()
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("token file missing" in f for f in report["aliases"][0]["findings"]))

    def test_empty_token_fails_without_reading_token_contents(self) -> None:
        token_path = self.tmp / "kant.token"
        token_path.write_bytes(b"")
        os.chmod(token_path, 0o600)
        original_read_text = pathlib.Path.read_text

        def reject_token_read(path: pathlib.Path, *args, **kwargs):
            if path == token_path:
                raise AssertionError("preflight must not read token contents")
            return original_read_text(path, *args, **kwargs)

        with mock.patch.object(pathlib.Path, "read_text", reject_token_read):
            report = self._run()

        self.assertFalse(report["ok"])
        findings = report["aliases"][0]["findings"]
        self.assertTrue(any("token file is empty" in finding for finding in findings))

    def test_token_wrong_mode_fails(self) -> None:
        os.chmod(self.tmp / "kant.token", 0o644)
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("mode must be 0600" in f for f in report["aliases"][0]["findings"]))

    def test_token_symlink_fails(self) -> None:
        target = self.tmp / "kant.token"
        target.unlink()
        real = self.tmp / "real.token"
        real.write_text("123456:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n", encoding="utf-8")
        os.chmod(real, 0o600)
        target.symlink_to(real)
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("symlink" in f for f in report["aliases"][0]["findings"]))

    def test_token_wrong_owner_fails(self) -> None:
        report = self._run(expected_uid=self.uid + 1)
        self.assertFalse(report["ok"])
        self.assertTrue(any("owned by uid" in f for f in report["aliases"][0]["findings"]))

    def test_token_owner_check_skipped_with_negative_uid(self) -> None:
        report = self._run(expected_uid=-1)
        self.assertTrue(report["ok"], report)

    # ------------------------------------------------------------------ marker
    def test_marker_wrong_content_fails(self) -> None:
        self._write_marker("v2-poller-disabled:argos", mode=0o644)
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("marker content must be exactly" in f for f in report["aliases"][0]["findings"]))

    def test_marker_group_writable_fails(self) -> None:
        os.chmod(self.tmp / "kant.disabled", 0o664)
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("group/other-writable" in f for f in report["aliases"][0]["findings"]))

    def test_missing_marker_fails(self) -> None:
        (self.tmp / "kant.disabled").unlink()
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("marker missing" in f for f in report["aliases"][0]["findings"]))

    # -------------------------------------------------------------- allowlists
    def test_placeholder_allowlist_fails(self) -> None:
        self._write_config(gen.build_config(FLEET, ["kant"]))  # default sentinels
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("sentinel placeholder" in f for f in report["aliases"][0]["findings"]))

    def test_placeholder_allowlist_allowed_with_flag(self) -> None:
        self._write_config(gen.build_config(FLEET, ["kant"]))
        report = self._run(allow_placeholders=True)
        self.assertTrue(report["ok"], report)

    # ------------------------------------------------------------- config/paths
    def test_absent_alias_fails(self) -> None:
        with self.assertRaises(pre.PreflightError):
            self._run(selected=["ghost"])

    def test_path_outside_mount_fails(self) -> None:
        config = _config_with_real_allowlists()
        config["aliases"][0]["token_file"] = "/elsewhere/kant.token"
        self._write_config(config)
        report = self._run()
        self.assertFalse(report["ok"])
        self.assertTrue(any("not under the compose mount" in f for f in report["aliases"][0]["findings"]))

    def test_invalid_config_raises(self) -> None:
        self.config_path.write_text("{ not json", encoding="utf-8")
        with self.assertRaises(pre.PreflightError):
            self._run()

    # --------------------------------------------------------------------- cli
    def test_cli_json_exit_code(self) -> None:
        rc = pre.main([
            "--config", str(self.config_path), "--aliases", "kant",
            "--runtime-dir", str(self.tmp), "--expected-uid", str(self.uid), "--json",
        ])
        self.assertEqual(rc, 0)

    def test_cli_reports_failure_exit_code(self) -> None:
        os.chmod(self.tmp / "kant.token", 0o644)
        rc = pre.main([
            "--config", str(self.config_path), "--aliases", "kant",
            "--runtime-dir", str(self.tmp), "--expected-uid", str(self.uid),
        ])
        self.assertEqual(rc, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
