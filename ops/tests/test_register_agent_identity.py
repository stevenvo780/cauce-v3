#!/usr/bin/env python3
"""Unit tests for ops/scripts/register-agent-identity.py against synthetic identity files."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
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
    if path.exists():
        path.chmod(0o600)
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    path.chmod(mode)


def _write_certificate(path: pathlib.Path, common_name: str) -> str:
    """Issues a throwaway self-signed leaf and returns its expected certificate_sha256."""
    with tempfile.TemporaryDirectory(prefix="certificate-rotation-", dir=path.parent) as work:
        work_path = pathlib.Path(work)
        certificate_path = work_path / path.name
        key_path = work_path / f"{path.stem}.key"
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                "-keyout", str(key_path), "-out", str(certificate_path), "-subj", f"/CN={common_name}",
            ],
            capture_output=True, text=True, check=True,
        )
        certificate_path.chmod(0o444)
        certificate_path.replace(path)
    path.chmod(0o444)
    der = ssl.PEM_cert_to_DER_cert(path.read_text(encoding="ascii"))
    return hashlib.sha256(der).hexdigest()


def _record(alias: str, certificate_sha256: str, tenant: str = "Steven") -> dict[str, object]:
    return {
        "certificate_sha256": certificate_sha256,
        "expires_at": "2028-01-01T00:00:00Z",
        "principal": {
            "tenant_id": tenant,
            "alias": alias,
            "session_id": f"adapter-{alias}",
            "channel": "adapter",
            "roles": ["adapter"],
            "permissions": ["route", "read"],
        },
    }


class _AgentIdentityFixture:
    """setUp/tearDown/helpers shared by the register and revoke test classes below.

    Not itself a TestCase: subclassing it alongside unittest.TestCase (instead of subclassing a
    TestCase directly) keeps each fixture's tests running exactly once.
    """

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

    def _revoke(self, tenant: str = "Steven", alias: str = "argos") -> dict[str, object]:
        return MODULE.revoke(tenant, alias, self.identities_dir)


class RegisterAgentIdentityTest(_AgentIdentityFixture, unittest.TestCase):
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

    def test_cas_rejects_a_replaced_identity_document_with_the_existing_message(self) -> None:
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        original = self.mtls_identities.stat()
        replacement = self.identities_dir / ".mtls_identities.test-race"
        _write_json(replacement, document, 0o400)
        replacement.replace(self.mtls_identities)
        before = self.mtls_identities.read_bytes()
        identities_fd = os.open(self.identities_dir, os.O_RDONLY | os.O_DIRECTORY)
        lock_fd = os.open(
            self.identities_dir / f".{MODULE.MTLS_IDENTITIES_FILE}.lock",
            os.O_RDWR | os.O_CREAT,
            0o600,
        )
        try:
            with self.assertRaisesRegex(
                MODULE.RegisterIdentityError,
                r"compare-and-swap fallo: mtls_identities\.json cambio durante el registro",
            ):
                MODULE.publish_identity_document(identities_fd, lock_fd, document, original)
        finally:
            os.close(lock_fd)
            os.close(identities_fd)
        self.assertEqual(self.mtls_identities.read_bytes(), before)

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

class RevokeAgentIdentityTest(_AgentIdentityFixture, unittest.TestCase):
    def test_revoke_matches_tenant_and_alias_together_not_alias_alone(self) -> None:
        """Same alias, different tenant: alias-only matching would wrongly revoke this one."""
        _write_json(
            self.mtls_identities,
            {
                "version": 1,
                "identities": [
                    _record("jarvis", "a" * 64),
                    _record("argos", "b" * 64, tenant="Miguel"),
                ],
            },
            0o400,
        )

        result = self._revoke(tenant="Steven", alias="argos")

        self.assertEqual(result["identities_removed"], 0)
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 2)
        self.assertEqual(document["identities"][1]["principal"]["tenant_id"], "Miguel")

    def test_cli_revoke_removes_record_then_second_run_is_a_clean_noop(self) -> None:
        self._register()
        first = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--revoke",
                "--tenant", "Steven",
                "--alias", "argos",
                "--identities-dir", str(self.identities_dir),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertIn("agent identity revoked", first.stdout)
        document = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document["identities"]), 1)

        second = subprocess.run(
            [
                sys.executable, str(SCRIPT),
                "--revoke",
                "--tenant", "Steven",
                "--alias", "argos",
                "--identities-dir", str(self.identities_dir),
            ],
            capture_output=True, text=True, check=False,
        )
        self.assertEqual(second.returncode, 0, second.stderr)
        document_after = json.loads(self.mtls_identities.read_text(encoding="utf-8"))
        self.assertEqual(len(document_after["identities"]), 1)

if __name__ == "__main__":
    unittest.main()
