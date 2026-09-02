#!/usr/bin/env python3
"""Unit tests for the hardened inventory read of ops/scripts/container_alias_lib.py."""

from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


import container_alias_lib as LIB  # noqa: E402  ops library resolved through sys.path above
import update_alias_lib as UPDATE  # noqa: E402  ops library resolved through sys.path above

ENTRY = {
    "tenant": "steven",
    "room": "grp.steven",
    "container": "ws-fixture",
    "user": "dev",
    "home": "/home/dev",
    "stateDirectory": "/home/dev/.cauce",
    "harness": "claude",
    "membershipRole": "agent",
    "systemdUser": "dev",
}


def _write(path: pathlib.Path, padding: str = "") -> pathlib.Path:
    document = {"schemaVersion": 2, "aliases": {"fixture": dict(ENTRY)}}
    if padding:
        document["padding"] = padding
    path.write_text(json.dumps(document), encoding="utf-8")
    path.chmod(0o644)
    return path


class HardenedReadTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.root = pathlib.Path(self._temp.name)
        self.inventory = _write(self.root / "container-aliases.json")

    def test_hardened_read_accepts_a_regular_private_inventory(self) -> None:
        aliases, entry = LIB.read_alias_entry(self.inventory, "fixture", hardened=True)
        self.assertEqual(sorted(aliases), ["fixture"])
        self.assertEqual(entry["harness"], "claude")

    def test_hardened_read_rejects_a_group_writable_inventory(self) -> None:
        self.inventory.chmod(0o664)
        with self.assertRaises(LIB.InventoryAccessError):
            LIB.read_alias_entry(self.inventory, "fixture", hardened=True)
        self.assertEqual(
            LIB.read_alias_entry(self.inventory, "fixture")[1]["harness"], "claude"
        )

    def test_hardened_read_rejects_a_symlinked_inventory(self) -> None:
        link = self.root / "linked.json"
        link.symlink_to(self.inventory)
        with self.assertRaises(OSError):
            LIB.read_alias_entry(link, "fixture", hardened=True)

    def test_hardened_read_rejects_an_oversized_inventory(self) -> None:
        _write(self.inventory, padding="x" * (LIB.MAX_INVENTORY_BYTES + 1))
        with self.assertRaises(LIB.InventorySizeError):
            LIB.read_alias_entry(self.inventory, "fixture", hardened=True)

    def test_undeclared_alias_raises_its_own_class(self) -> None:
        with self.assertRaises(LIB.AliasNotDeclaredError):
            LIB.read_alias_entry(self.inventory, "ausente", hardened=True)


class LoadInventoryMessageTests(unittest.TestCase):
    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.root = pathlib.Path(self._temp.name)
        self.inventory = _write(self.root / "container-aliases.json")
        self.hermes = self.root / "hermes-runtime.json"

    def _error(self, alias: str = "fixture") -> str:
        with self.assertRaises(UPDATE.ConfigUpdateError) as captured:
            UPDATE.load_inventory(self.inventory, alias, self.hermes)
        return str(captured.exception)

    def test_oversized_inventory_reports_the_size_limit(self) -> None:
        _write(self.inventory, padding="x" * (LIB.MAX_INVENTORY_BYTES + 1))
        self.assertEqual(self._error(), "inventario excede el limite permitido")

    def test_group_writable_inventory_reports_the_permissions(self) -> None:
        self.inventory.chmod(0o664)
        self.assertEqual(
            self._error(),
            "el inventario debe ser regular y no escribible por grupo u otros",
        )

    def test_unknown_alias_reports_the_missing_declaration(self) -> None:
        self.assertEqual(self._error("ausente"), "el alias no existe en el inventario activo")

    def test_document_without_aliases_reports_an_invalid_inventory(self) -> None:
        self.inventory.write_text(json.dumps({"schemaVersion": 2}), encoding="utf-8")
        self.inventory.chmod(0o644)
        self.assertEqual(self._error(), "el inventario no declara aliases validos")

    def test_truncated_inventory_reports_an_unreadable_inventory(self) -> None:
        self.inventory.write_text('{"aliases":', encoding="utf-8")
        self.inventory.chmod(0o644)
        self.assertEqual(self._error(), "no se pudo leer un inventario valido")

    def test_valid_inventory_returns_the_policy(self) -> None:
        policy = UPDATE.load_inventory(self.inventory, "fixture", self.hermes)
        self.assertEqual(policy.harness, "claude")
        self.assertEqual(policy.home, "/home/dev")
        self.assertFalse(policy.requires_isolated_config)


if __name__ == "__main__":
    unittest.main()
