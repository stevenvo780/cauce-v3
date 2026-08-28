#!/usr/bin/env python3
"""Unit tests for ops/scripts/register-agent-identity.py against synthetic identity files."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import ssl
import stat
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "register-agent-identity.py"
SPEC = importlib.util.spec_from_file_location("register_agent_identity", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def _write_json(path: pathlib.Path, document: object, mode: int) -> None:
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    path.chmod(mode)


def _write_certificate(path: pathlib.Path, common_name: str) -> str:
    """Issues a throwaway self-signed leaf and returns its expected certificate_sha256."""
    key_path = path.with_suffix(".key")
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-keyout", str(key_path), "-out", str(path), "-subj", f"/CN={common_name}",
        ],
        capture_output=True, text=True, check=True,
    )
    key_path.unlink()
    path.chmod(0o444)
    der = ssl.PEM_cert_to_DER_cert(path.read_text(encoding="ascii"))
    return hashlib.sha256(der).hexdigest()


def _record(alias: str, certificate_sha256: str) -> dict[str, object]:
    return {
        "certificate_sha256": certificate_sha256,
        "expires_at": "2028-01-01T00:00:00Z",
        "principal": {
            "tenant_id": "Steven",
            "alias": alias,
            "session_id": f"adapter-{alias}",
            "channel": "adapter",
            "roles": ["adapter"],
            "permissions": ["route", "read"],
        },
    }


class RegisterAgentIdentityTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="cauce-register-agent-identity-")
        self.root = pathlib.Path(self.temp.name)
        self.cert_dir = self.root / "pki"
        self.cert_dir.mkdir(mode=0o700)
        self.identities_dir = self.root / "identities"
        self.identities_dir.mkdir(mode=0o750)

        self.flota_json = self.root / "flota.json"
        self.flota_json.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "fleet": {
                        "argos": {
                            "tenant": "Steven",
                            "harness": "openclaw",
                            "enabled": True,
                            "container": "ctrl-infra",
                            "home": "/home/claw",
                            "role": "agent",
                            "room": "grp.steven",
                            "user": "claw",
                            "runtimeStateDirectory": "/home/claw/.openclaw/cauce-v3/argos",
                        },
                        "retirado": {
                            "tenant": "Steven",
                            "harness": "codex",
                            "enabled": False,
                            "container": "ctrl-infra",
                            "home": "/home/dev",
                            "role": "agent",
                            "room": "grp.steven",
                            "user": "dev",
                            "runtimeStateDirectory": "/home/dev/.local/state/cauce-v3/retirado",
                        },
                    },
                    "placement": {},
                    "retired": {},
                    "systemPrincipals": {},
                }
            ),
            encoding="utf-8",
        )

        self.argos_sha256 = _write_certificate(self.cert_dir / "agent-argos.crt", "agent-argos")

        self.mtls_identities = self.identities_dir / "mtls_identities.json"
        _write_json(
            self.mtls_identities,
            {"version": 1, "identities": [_record("jarvis", "a" * 64)]},
            0o400,
        )
        self.token_hashes = self.identities_dir / "token_hashes.json"
        _write_json(self.token_hashes, {"version": 1, "identities": []}, 0o400)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _register(self, alias: str = "argos", ttl_days: int = 730) -> dict[str, object]:
        return MODULE.register(alias, self.cert_dir, self.identities_dir, self.flota_json, ttl_days)

    def test_computes_sha256_of_der_not_pem_text(self) -> None:
        pem_text = (self.cert_dir / "agent-argos.crt").read_text(encoding="ascii")
        naive_pem_digest = hashlib.sha256(pem_text.encode("ascii")).hexdigest()
        self.assertNotEqual(self.argos_sha256, naive_pem_digest)

        result = self._register()

        self.assertEqual(result["certificate_sha256"], self.argos_sha256)

    def test_registers_identity_with_gateway_matching_schema(self) -> None:
        result = self._register()

        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(document["version"], 1)
        self.assertEqual(len(document["identities"]), 2)
        self.assertEqual(document["identities"][0]["principal"]["alias"], "jarvis")  # untouched
        new_record = document["identities"][1]
        self.assertEqual(new_record["certificate_sha256"], self.argos_sha256)
        self.assertEqual(
            new_record["principal"],
            {
                "tenant_id": "Steven",
                "alias": "argos",
                "session_id": "adapter-argos",
                "channel": "adapter",
                "roles": ["adapter"],
                "permissions": ["route", "read"],
            },
        )
        self.assertEqual(stat.S_IMODE(self.mtls_identities.stat().st_mode), 0o400)
        self.assertFalse(result["already_registered"])

    def test_never_touches_token_hashes_file(self) -> None:
        before = self.token_hashes.read_bytes()
        self._register()
        self.assertEqual(self.token_hashes.read_bytes(), before)

    def test_rerunning_for_the_same_unchanged_certificate_is_a_noop(self) -> None:
        first = self._register()
        before = self.mtls_identities.read_bytes()

        second = self._register()

        self.assertTrue(second["already_registered"])
        self.assertEqual(second["certificate_sha256"], first["certificate_sha256"])
        self.assertEqual(self.mtls_identities.read_bytes(), before)
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 2)  # jarvis + argos, not tripled

    def test_rejects_a_different_certificate_for_an_already_registered_alias(self) -> None:
        self._register()
        rotated_sha256 = _write_certificate(self.cert_dir / "agent-argos.crt", "agent-argos")
        self.assertNotEqual(rotated_sha256, self.argos_sha256)
        before = self.mtls_identities.read_bytes()

        with self.assertRaises(MODULE.RegisterIdentityError):
            self._register()

        self.assertEqual(self.mtls_identities.read_bytes(), before)

    def test_rejects_disabled_alias_and_writes_nothing(self) -> None:
        _write_certificate(self.cert_dir / "agent-retirado.crt", "agent-retirado")
        with self.assertRaises(MODULE.RegisterIdentityError):
            self._register(alias="retirado")
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)

    def test_rejects_unknown_alias(self) -> None:
        with self.assertRaises(MODULE.RegisterIdentityError):
            self._register(alias="fantasma")

    def test_rejects_missing_certificate(self) -> None:
        with self.assertRaises(MODULE.RegisterIdentityError):
            MODULE.register("argos", self.root / "empty-pki", self.identities_dir, self.flota_json, 730)

    def test_dry_run_leaves_filesystem_untouched(self) -> None:
        message = MODULE.describe_dry_run("argos", self.cert_dir, self.identities_dir, self.flota_json, 730)
        self.assertIn("dry-run", message)
        self.assertIn(self.argos_sha256, message)
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)

    def test_cli_dry_run_exits_zero_and_prints_plan(self) -> None:
        completed = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "argos",
                "--cert-dir", str(self.cert_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
                "--dry-run",
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn("dry-run", completed.stdout)
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)

    def test_cli_registers_then_second_run_is_a_clean_noop(self) -> None:
        first = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "argos",
                "--cert-dir", str(self.cert_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(first.returncode, 0, first.stderr)
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 2)

        second = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "argos",
                "--cert-dir", str(self.cert_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertIn("already registered", second.stdout)
        document_after = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document_after["identities"]), 2)

    def test_cli_rejects_unknown_alias_without_leaking_internals(self) -> None:
        completed = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--alias", "fantasma",
                "--cert-dir", str(self.cert_dir),
                "--identities-dir", str(self.identities_dir),
                "--flota-json", str(self.flota_json),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertIn("register agent identity failed", completed.stderr)


if __name__ == "__main__":
    unittest.main()
