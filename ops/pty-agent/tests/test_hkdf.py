#!/usr/bin/env python3
"""Tests for ops/pty-agent/derive-alias-key.py.

Pins the golden derivation the gateway must reproduce in TypeScript: from the documented 32 byte
master, Steven/jarvis derives the very key that signs the golden ticket in test_ticket.py. The
master and the key are NOT copied here: both are read from tests/terminal-pty/vectors.json, the
frozen contract gateway, relay and agent share, so there are never two truths free to diverge.
It also proves the derivation is per alias, so the key copied to kratos for one agent authorises
none of the other thirteen.

Runs standalone (`python3 ops/pty-agent/tests/test_hkdf.py`) or under
`python3 -m unittest discover ops/pty-agent/tests`.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from unittest import mock

AGENT_DIR = pathlib.Path(__file__).resolve().parents[1]
VECTORS_PATH = pathlib.Path(__file__).resolve().parents[3] / "tests" / "terminal-pty" / "vectors.json"


def _load(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, AGENT_DIR / filename)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


derive = _load("derive_alias_key", "derive-alias-key.py")

VECTORS = json.loads(VECTORS_PATH.read_text(encoding="utf-8"))
MASTER_B64 = VECTORS["master_key_b64"]
MASTER = base64.b64decode(MASTER_B64)
GOLDEN = VECTORS["keys"]["Steven:jarvis"]


def _remove_tree(directory: pathlib.Path) -> None:
    for path in directory.iterdir():
        os.chmod(path, 0o600)
        path.unlink()
    directory.rmdir()


class GoldenVectorTests(unittest.TestCase):
    def test_steven_jarvis_matches_the_golden_key(self) -> None:
        self.assertEqual(derive.alias_key(MASTER, "Steven", "jarvis").hex(), GOLDEN)

    def test_the_derived_key_is_32_bytes(self) -> None:
        self.assertEqual(len(derive.alias_key(MASTER, "Steven", "jarvis")), 32)

    def test_the_derivation_is_rfc5869_extract_then_expand(self) -> None:
        prk = hmac.new(b"cauce-v3/pty-ticket/v1", MASTER, hashlib.sha256).digest()
        expected = hmac.new(prk, b"pty:Steven:jarvis" + b"\x01", hashlib.sha256).digest()
        self.assertEqual(expected.hex(), GOLDEN)

    def test_the_salt_and_info_labels_are_pinned(self) -> None:
        self.assertEqual(derive.TICKET_SALT, b"cauce-v3/pty-ticket/v1")
        self.assertEqual(derive.INFO_PREFIX, "pty:")

    def test_the_derivation_parameters_come_from_the_frozen_vectors(self) -> None:
        hkdf = VECTORS["hkdf"]
        self.assertEqual(hkdf["salt_utf8"].encode("utf-8"), derive.TICKET_SALT)
        self.assertEqual(hkdf["info_template"], derive.INFO_PREFIX + "<tenant>:<alias>")
        self.assertEqual(hkdf["length"], derive.KEY_LENGTH)
        self.assertEqual(len(MASTER), 32)


class SeparationTests(unittest.TestCase):
    def test_every_alias_gets_a_different_key(self) -> None:
        keys = {alias: derive.alias_key(MASTER, "Steven", alias).hex() for alias in ("argos", "jarvis", "kant", "socrates")}
        self.assertEqual(len(set(keys.values())), len(keys))

    def test_the_tenant_is_part_of_the_derivation(self) -> None:
        self.assertNotEqual(
            derive.alias_key(MASTER, "Steven", "jarvis").hex(),
            derive.alias_key(MASTER, "Miguel", "jarvis").hex(),
        )

    def test_a_different_master_gives_a_different_key(self) -> None:
        other = bytes(32)
        self.assertNotEqual(derive.alias_key(other, "Steven", "jarvis").hex(), GOLDEN)

    def test_a_master_of_the_wrong_length_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            derive.alias_key(MASTER[:16], "Steven", "jarvis")

    def test_an_injected_separator_in_the_alias_is_refused(self) -> None:
        # ':' in the alias would let two different (tenant, alias) pairs collide on one info label.
        with self.assertRaises(ValueError):
            derive.alias_key(MASTER, "Steven", "jarvis:kant")


class CommandLineTests(unittest.TestCase):
    def test_only_the_derived_key_reaches_stdout(self) -> None:
        directory = pathlib.Path(tempfile.mkdtemp(prefix="pty-hkdf-"))
        self.addCleanup(_remove_tree, directory)
        master_file = directory / "master.b64"
        master_file.write_text(MASTER_B64 + "\n", encoding="utf-8")
        os.chmod(master_file, 0o400)
        with mock.patch("sys.stdout") as stdout:
            self.assertEqual(derive.main(["--tenant", "Steven", "--alias", "jarvis", "--master-file", str(master_file)]), 0)
        stdout.write.assert_called_once_with(GOLDEN + "\n")

    def test_a_hex_master_is_accepted_too(self) -> None:
        with mock.patch.dict(os.environ, {"CAUCE_PTY_MASTER": MASTER.hex()}), mock.patch("sys.stdout") as stdout:
            derive.main(["--tenant", "Steven", "--alias", "jarvis", "--master-env", "CAUCE_PTY_MASTER"])
        stdout.write.assert_called_once_with(GOLDEN + "\n")

    def test_a_master_of_the_wrong_size_is_refused(self) -> None:
        with mock.patch.dict(os.environ, {"CAUCE_PTY_MASTER": "00" * 16}):
            with self.assertRaises(SystemExit):
                derive.main(["--tenant", "Steven", "--alias", "jarvis", "--master-env", "CAUCE_PTY_MASTER"])


if __name__ == "__main__":
    unittest.main()
