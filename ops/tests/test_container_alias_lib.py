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


class NativeProfileContextPolicyTests(unittest.TestCase):
    """The second gate for the native profile context flag: the sanctioned writer of <alias>.env.

    The writer mirrors both supervisor rules BY VALUE and never by the presence of the key, so an
    alias whose .env already carries the flag switched off keeps receiving configuration updates
    instead of being locked out of every future write.
    """

    def setUp(self) -> None:
        self._temp = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp.cleanup)
        self.root = pathlib.Path(self._temp.name)
        self.pki_root = self.root / "pki"
        self.inventory = self.root / "container-aliases.json"
        self.hermes = self.root / "hermes-runtime.json"

    def _policy(self, harness: str) -> UPDATE.AliasPolicy:
        entry = dict(ENTRY, harness=harness)
        if harness == "openclaw":
            entry["workspace"] = "/home/dev/clawd"
        self.inventory.write_text(
            json.dumps({"schemaVersion": 2, "aliases": {"fixture": entry}}), encoding="utf-8"
        )
        self.inventory.chmod(0o644)
        return UPDATE.load_inventory(self.inventory, "fixture", self.hermes)

    def _validate(self, harness: str, *extra: str) -> None:
        lines = [
            "BUNDLE_RELEASE=release-1",
            f"BUNDLE_SHA256=sha256:{'a' * 64}",
            f"PKI_DIR={self.pki_root / 'fixture'}",
            "RELAY_URL=wss://gateway.example.invalid/v3/ws",
            f"EXPECTED_IMAGE_ID=sha256:{'b' * 64}",
            "CAUCE_SEMBRAR_PERFIL=1",
        ]
        if harness == "claude":
            lines.append("EXPECTED_CLI_VERSION=2.1.220")
        if harness == "openclaw":
            lines.append("OPENCLAW_WORKSPACE=/home/dev/clawd")
        lines.extend(extra)
        document = UPDATE.parse_document("".join(f"{line}\n" for line in lines).encode("utf-8"))
        UPDATE.validate_policy(document, self._policy(harness), self.pki_root)

    def test_the_supported_harnesses_admit_the_flag(self) -> None:
        for harness in ("claude", "openclaw"):
            for value in ("0", "1"):
                with self.subTest(harness=harness, value=value):
                    self._validate(harness, f"CAUCE_NATIVE_PROFILE_CONTEXT={value}")

    def test_the_baseline_configuration_stays_valid_without_the_flag(self) -> None:
        for harness in ("claude", "codex", "openclaw"):
            with self.subTest(harness=harness):
                self._validate(harness)

    def test_an_unsupported_harness_rejects_the_flag(self) -> None:
        with self.assertRaises(UPDATE.ConfigUpdateError) as captured:
            self._validate("codex", "CAUCE_NATIVE_PROFILE_CONTEXT=1")
        self.assertEqual(
            str(captured.exception),
            "la configuracion conserva claves incompatibles: CAUCE_NATIVE_PROFILE_CONTEXT",
        )

    def test_a_value_outside_zero_or_one_is_rejected(self) -> None:
        with self.assertRaises(UPDATE.ConfigUpdateError) as captured:
            self._validate("claude", "CAUCE_NATIVE_PROFILE_CONTEXT=true")
        self.assertEqual(str(captured.exception), "CAUCE_NATIVE_PROFILE_CONTEXT debe ser 0 o 1")

    def test_the_flag_switched_on_beside_shared_session_is_rejected(self) -> None:
        with self.assertRaises(UPDATE.ConfigUpdateError) as captured:
            self._validate("claude", "SHARED_SESSION=1", "CAUCE_NATIVE_PROFILE_CONTEXT=1")
        self.assertEqual(
            str(captured.exception),
            "CAUCE_NATIVE_PROFILE_CONTEXT es incompatible con SHARED_SESSION",
        )

    def test_the_flag_switched_off_beside_shared_session_stays_updatable(self) -> None:
        self._validate("claude", "SHARED_SESSION=1", "CAUCE_NATIVE_PROFILE_CONTEXT=0")


if __name__ == "__main__":
    unittest.main()
