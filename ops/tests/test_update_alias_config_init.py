#!/usr/bin/env python3
"""Unit tests for the ``init`` mode of ops/scripts/update-alias-config.py against a temp root."""

from __future__ import annotations

import importlib.util
import json
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "update-alias-config.py"
SPEC = importlib.util.spec_from_file_location("cauce_update_alias_config", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)

CA_BODY = b"-----BEGIN CERTIFICATE-----\nCA-BODY-PLACEHOLDER\n-----END CERTIFICATE-----\n"
LEAF_CERT_BODY = b"-----BEGIN CERTIFICATE-----\nLEAF-CERT-PLACEHOLDER\n-----END CERTIFICATE-----\n"
LEAF_KEY_BODY = b"-----BEGIN PRIVATE KEY-----\nLEAF-KEY-PLACEHOLDER-NEVER-PRINTED\n-----END PRIVATE KEY-----\n"
EXAMPLE_BODY = (
    b"BUNDLE_RELEASE=REPLACE_WITH_IMMUTABLE_RELEASE_NAME\n"
    b"BUNDLE_SHA256=sha256:REPLACE_WITH_64_LOWERCASE_HEX\n"
    b"PKI_DIR=/etc/cauce-v3/container-pki/argos\n"
    b"RELAY_URL=wss://gateway.example.invalid/v3/ws\n"
    b"EXPECTED_IMAGE_ID=sha256:REPLACE_WITH_64_LOWERCASE_HEX\n"
    b"CAUCE_SEMBRAR_PERFIL=1\n"
)


def _write(path: pathlib.Path, body: bytes, mode: int) -> None:
    path.write_bytes(body)
    path.chmod(mode)


class InitAliasTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cauce-update-alias-config-init-")
        self.root = pathlib.Path(self.temp.name)

        # config_root/pki_root are deliberately NOT pre-created: init must create them.
        self.config_root = self.root / "container-aliases"
        self.pki_root = self.root / "container-pki"
        self.agent_pki_root = self.root / "pki"
        self.examples_root = self.root / "examples"
        self.agent_pki_root.mkdir(mode=0o700)
        self.examples_root.mkdir(mode=0o700)

        self.flota_json = self.root / "flota.json"
        _write(
            self.flota_json,
            json.dumps(
                {
                    "schemaVersion": 1,
                    "fleet": {
                        "argos": {"tenant": "Steven", "enabled": True, "harness": "openclaw"},
                        "retirado": {"tenant": "Steven", "enabled": False, "harness": "codex"},
                    },
                    "retired": {},
                }
            ).encode("utf-8"),
            0o600,
        )

        _write(self.agent_pki_root / "ca.crt", CA_BODY, 0o644)
        _write(self.agent_pki_root / "agent-argos.crt", LEAF_CERT_BODY, 0o444)
        _write(self.agent_pki_root / "agent-argos.key", LEAF_KEY_BODY, 0o400)
        _write(self.examples_root / "argos.env.example", EXAMPLE_BODY, 0o644)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _init(self, alias: str = "argos", dry_run: bool = False) -> dict[str, object]:
        return MODULE.init_alias(
            self.config_root, self.pki_root, self.agent_pki_root, self.flota_json,
            self.examples_root, alias, dry_run=dry_run,
        )

    def test_creates_pki_dir_and_env_file_with_expected_permissions(self) -> None:
        result = self._init()
        self.assertEqual(result["status"], "created")

        pki_dir = self.pki_root / "argos"
        self.assertEqual(stat.S_IMODE(pki_dir.stat().st_mode), 0o700)
        for name, body in (
            ("ca.crt", CA_BODY), ("client.crt", LEAF_CERT_BODY), ("client.key", LEAF_KEY_BODY),
        ):
            path = pki_dir / name
            self.assertEqual(path.read_bytes(), body)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

        env_path = self.config_root / "argos.env"
        self.assertEqual(env_path.read_bytes(), EXAMPLE_BODY)
        self.assertEqual(stat.S_IMODE(env_path.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(self.config_root.stat().st_mode), 0o700)

    def test_dry_run_leaves_filesystem_untouched(self) -> None:
        result = self._init(dry_run=True)
        self.assertEqual(result["status"], "dry-run")
        self.assertFalse(result["pkiDirConflict"])
        self.assertFalse(result["configFileConflict"])
        self.assertFalse((self.pki_root / "argos").exists())
        self.assertFalse((self.config_root / "argos.env").exists())
        self.assertFalse(self.pki_root.exists())
        self.assertFalse(self.config_root.exists())

    def test_rejects_disabled_alias_and_writes_nothing(self) -> None:
        with self.assertRaises(MODULE.ConfigUpdateError):
            self._init(alias="retirado")
        self.assertFalse(self.pki_root.exists())
        self.assertFalse(self.config_root.exists())

    def test_rejects_unknown_alias(self) -> None:
        with self.assertRaises(MODULE.ConfigUpdateError):
            self._init(alias="fantasma")
        self.assertFalse(self.pki_root.exists())

    def test_missing_leaf_identity_fails_with_clear_message(self) -> None:
        (self.agent_pki_root / "agent-argos.crt").unlink()
        with self.assertRaises(MODULE.ConfigUpdateError) as ctx:
            self._init()
        self.assertIn("corre provision-agent-identity primero", str(ctx.exception))
        self.assertFalse(self.pki_root.exists())
        self.assertFalse(self.config_root.exists())

    def test_missing_leaf_key_fails_with_clear_message(self) -> None:
        (self.agent_pki_root / "agent-argos.key").unlink()
        with self.assertRaises(MODULE.ConfigUpdateError) as ctx:
            self._init()
        self.assertIn("corre provision-agent-identity primero", str(ctx.exception))

    def test_missing_ca_fails_closed(self) -> None:
        (self.agent_pki_root / "ca.crt").unlink()
        with self.assertRaises(MODULE.ConfigUpdateError):
            self._init()
        self.assertFalse(self.pki_root.exists())

    def test_missing_example_fails_with_clear_message(self) -> None:
        (self.examples_root / "argos.env.example").unlink()
        with self.assertRaises(MODULE.ConfigUpdateError) as ctx:
            self._init()
        self.assertIn("generate-container-units.py", str(ctx.exception))
        self.assertFalse(self.pki_root.exists())
        self.assertFalse(self.config_root.exists())

    def test_does_not_overwrite_an_existing_pki_dir(self) -> None:
        self.pki_root.mkdir(mode=0o700)
        (self.pki_root / "argos").mkdir(mode=0o700)
        with self.assertRaises(MODULE.ConfigUpdateError) as ctx:
            self._init()
        self.assertIn("ya existe", str(ctx.exception))
        self.assertFalse((self.pki_root / "argos" / "ca.crt").exists())
        self.assertFalse((self.config_root / "argos.env").exists())

    def test_does_not_overwrite_an_existing_env_file(self) -> None:
        # The pki side is published first; a stale env file surfaces only afterwards, and the
        # already-published pki material is left standing rather than silently touched again.
        self.config_root.mkdir(mode=0o700)
        stale = self.config_root / "argos.env"
        _write(stale, b"STALE=1\n", 0o600)
        with self.assertRaises(MODULE.ConfigUpdateError) as ctx:
            self._init()
        self.assertIn("ya existe", str(ctx.exception))
        self.assertEqual(stale.read_bytes(), b"STALE=1\n")
        self.assertEqual((self.pki_root / "argos" / "ca.crt").read_bytes(), CA_BODY)

    def test_rerunning_after_success_fails_closed_without_touching_anything(self) -> None:
        self._init()
        pki_before = (self.pki_root / "argos" / "client.key").read_bytes()
        env_before = (self.config_root / "argos.env").read_bytes()
        with self.assertRaises(MODULE.ConfigUpdateError):
            self._init()
        self.assertEqual((self.pki_root / "argos" / "client.key").read_bytes(), pki_before)
        self.assertEqual((self.config_root / "argos.env").read_bytes(), env_before)

    def _cli_args(self, *extra: str) -> list[str]:
        return [
            sys.executable, str(SCRIPT),
            "--config-root", str(self.config_root),
            "--pki-root", str(self.pki_root),
            "init", "--alias", "argos",
            "--flota-json", str(self.flota_json),
            "--agent-pki-root", str(self.agent_pki_root),
            "--examples-root", str(self.examples_root),
            *extra,
        ]

    def test_cli_dry_run_exits_zero_and_writes_nothing(self) -> None:
        completed = subprocess.run(
            self._cli_args("--dry-run"), capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        document = json.loads(completed.stdout)
        self.assertEqual(document["status"], "dry-run")
        self.assertFalse((self.pki_root / "argos").exists())

    def test_cli_creates_then_second_run_fails_without_overwrite(self) -> None:
        first = subprocess.run(self._cli_args(), capture_output=True, text=True, check=False)
        self.assertEqual(first.returncode, 0, first.stderr)
        document = json.loads(first.stdout)
        self.assertEqual(document["status"], "created")
        self.assertNotIn("LEAF-KEY-PLACEHOLDER", first.stdout)
        self.assertNotIn("LEAF-KEY-PLACEHOLDER", first.stderr)
        client_key = self.pki_root / "argos" / "client.key"
        self.assertEqual(stat.S_IMODE(client_key.stat().st_mode), 0o600)
        self.assertEqual(client_key.read_bytes(), LEAF_KEY_BODY)

        second = subprocess.run(self._cli_args(), capture_output=True, text=True, check=False)
        self.assertEqual(second.returncode, 2)
        self.assertIn("config update failed", second.stderr)
        self.assertNotIn("LEAF-KEY-PLACEHOLDER", second.stderr)
        self.assertEqual(client_key.read_bytes(), LEAF_KEY_BODY)

    def test_cli_missing_identity_reports_the_exact_next_step(self) -> None:
        (self.agent_pki_root / "agent-argos.key").unlink()
        completed = subprocess.run(self._cli_args(), capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("corre provision-agent-identity primero", completed.stderr)
        self.assertFalse((self.pki_root / "argos").exists())

    def test_cli_rejects_disabled_alias(self) -> None:
        args = [
            sys.executable, str(SCRIPT),
            "--config-root", str(self.config_root), "--pki-root", str(self.pki_root),
            "init", "--alias", "retirado",
            "--flota-json", str(self.flota_json),
            "--agent-pki-root", str(self.agent_pki_root),
            "--examples-root", str(self.examples_root),
        ]
        completed = subprocess.run(args, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("no esta habilitado", completed.stderr)

    def test_cli_rejects_invalid_alias_format(self) -> None:
        args = [
            sys.executable, str(SCRIPT),
            "--config-root", str(self.config_root), "--pki-root", str(self.pki_root),
            "init", "--alias", "Argos",
            "--flota-json", str(self.flota_json),
            "--agent-pki-root", str(self.agent_pki_root),
            "--examples-root", str(self.examples_root),
        ]
        completed = subprocess.run(args, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 2)
        self.assertIn("formato invalido", completed.stderr)
        self.assertFalse((self.pki_root / "argos").exists())

    def test_cli_config_root_override_after_init_wins_over_global_default(self) -> None:
        # init --config-root R must win over --config-root passed before the subcommand too:
        # both spellings are supported, and the one closest to "init" is authoritative.
        overridden = self.root / "overridden-config-root"
        args = [
            sys.executable, str(SCRIPT),
            "--config-root", str(self.config_root), "--pki-root", str(self.pki_root),
            "init", "--alias", "argos", "--config-root", str(overridden),
            "--flota-json", str(self.flota_json),
            "--agent-pki-root", str(self.agent_pki_root),
            "--examples-root", str(self.examples_root),
        ]
        completed = subprocess.run(args, capture_output=True, text=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertTrue((overridden / "argos.env").exists())
        self.assertFalse(self.config_root.exists())


if __name__ == "__main__":
    unittest.main()
