#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

OPS = pathlib.Path(__file__).resolve().parents[1]
LOCK = OPS / "scripts/alias-lock-exec.py"
SUPERVISOR = OPS / "scripts/container-adapter-supervisor.sh"
SPEC = importlib.util.spec_from_file_location("canonical_control_base", OPS / "container-runtime/cauce_container_base.py")
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
VALID = ("operador_principal", "a" * 64, "a", "agent-1")
INVALID = ("../operador", "a/b", "/agent", "a\n", "A", "_a", "a" * 65)


class CanonicalAliasTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-canonical-alias-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.environment = dict(os.environ)
        for name in ("CAUCE_INSTALLATION_ID", "CAUCE_ALIAS_LOCK_FD", "CAUCE_ALIAS_LEGACY_LOCK_FD", "CAUCE_ALIAS_LOCK_ALIAS"):
            self.environment.pop(name, None)

    def lock(self, alias):
        return subprocess.run([
            sys.executable, str(LOCK), "run", "--lock-root", str(self.root / "locks"), "--alias", alias,
            "--", sys.executable, str(LOCK), "verify", "--lock-root", str(self.root / "locks"), "--alias", alias,
        ], env=self.environment, capture_output=True, text=True)

    def test_lock_accepts_canonical_alias_and_preserves_default_names(self):
        for alias in VALID:
            with self.subTest(alias=alias):
                result = self.lock(alias)
                self.assertEqual(result.returncode, 0, result.stderr)
                private = self.root / "locks" / f"cauce-v3-alias-locks-{os.getuid()}" / f"{alias}.lock"
                legacy = self.root / "locks" / f"cauce-v3-container-{alias}.lock"
                self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(legacy.stat().st_mode), 0o600)

    def test_lock_rejects_unsafe_alias_before_creating_root(self):
        for alias in INVALID:
            with self.subTest(alias=alias):
                result = self.lock(alias)
                self.assertEqual(result.returncode, 73)
                self.assertIn("invalid alias", result.stderr)
                self.assertFalse((self.root / "locks").exists())

    def supervisor(self, alias, installation_id=None):
        code = self.root / "code"
        scripts = code / "scripts"
        scripts.mkdir(parents=True, exist_ok=True)
        marker = self.root / "inventory-read"
        marker.unlink(missing_ok=True)
        (scripts / "container-alias-query.py").write_text(
            "import pathlib,sys\npathlib.Path(sys.argv[0]).parents[2].joinpath('inventory-read').write_text(sys.argv[1])\nsys.exit(19)\n"
        )
        environment = {**self.environment, "CAUCE_CONTAINER_CODE_ROOT": str(code), "CAUCE_CONTAINER_OPS_ROOT": str(self.root / "data")}
        if installation_id is not None:
            environment["CAUCE_INSTALLATION_ID"] = installation_id
        result = subprocess.run(["bash", str(SUPERVISOR), "check", alias], env=environment, capture_output=True, text=True)
        return result, marker

    def test_supervisor_accepts_alias_before_trusted_inventory_lookup(self):
        for alias in VALID:
            with self.subTest(alias=alias):
                result, marker = self.supervisor(alias)
                self.assertEqual(result.returncode, 19, result.stderr)
                self.assertEqual(marker.read_text(), alias)

    def test_supervisor_rejects_unsafe_alias_before_inventory_lookup(self):
        for alias in INVALID:
            with self.subTest(alias=alias):
                result, marker = self.supervisor(alias)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid container adapter alias", result.stderr)
                self.assertFalse(marker.exists())

    def test_supervisor_installation_id_contract_stays_distinct(self):
        result, marker = self.supervisor("operador_principal", "empresa_principal")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(marker.exists())

    def test_control_accepts_canonical_alias_and_keeps_root_boundary(self):
        details = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
        for alias in VALID:
            with self.subTest(alias=alias), patch.object(BASE.os, "geteuid", return_value=0), \
                    patch.object(BASE, "open_directory", return_value=73) as opened, \
                    patch.object(BASE.os, "fstat", return_value=details), \
                    patch.object(BASE.os, "fchown") as owner, patch.object(BASE.os, "fchmod") as mode, \
                    patch.object(BASE.os, "fsync"), patch.object(BASE.os, "close"):
                BASE.prepare_control("/run/cauce-v3-supervisor", alias)
                opened.assert_called_once_with(f"/run/cauce-v3-supervisor/{alias}", create_below="/run", uid=0, gid=0)
                owner.assert_called_once_with(73, 0, 0)
                mode.assert_called_once_with(73, 0o700)

    def test_control_rejects_unsafe_alias_before_directory_open(self):
        for alias in INVALID:
            with self.subTest(alias=alias), patch.object(BASE.os, "geteuid", return_value=0), \
                    patch.object(BASE, "open_directory") as opened:
                with self.assertRaisesRegex(BASE.PermanentError, "alias is invalid"):
                    BASE.prepare_control("/run/cauce-v3-supervisor", alias)
                opened.assert_not_called()

    def test_control_still_requires_root(self):
        with patch.object(BASE.os, "geteuid", return_value=1000), patch.object(BASE, "open_directory") as opened:
            with self.assertRaisesRegex(BASE.PermanentError, "requires root"):
                BASE.prepare_control("/run/cauce-v3-supervisor", "operador_principal")
            opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
