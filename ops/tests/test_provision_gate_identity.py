#!/usr/bin/env python3
"""Exercise dedicated gate issuance with disposable, local cryptographic fixtures."""

import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts" / "provision-gate-identity.py"
SPEC = importlib.util.spec_from_file_location("provision_gate_identity", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GateIdentityTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.ca_temp = tempfile.TemporaryDirectory(prefix="cauce-gate-test-ca-")
        cls.ca = pathlib.Path(cls.ca_temp.name)
        cls.ca_cert, cls.ca_key = cls.ca / "ca.crt", cls.ca / "ca.key"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3",
            "-keyout", str(cls.ca_key), "-out", str(cls.ca_cert), "-subj", "/CN=disposable-gate-test",
            "-addext", "basicConstraints=critical,CA:TRUE",
        ], check=True, capture_output=True)
        cls.ca_key.chmod(0o400)

    @classmethod
    def tearDownClass(cls):
        cls.ca_temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="cauce-gate-test-")
        self.root = pathlib.Path(self.temp.name)
        self.identities = self.root / "identities"
        self.identities.mkdir(mode=0o700)
        self.registry = self.identities / "mtls_identities.json"
        self.previous = {"certificate_sha256": "a" * 64, "principal": {"alias": "unrelated"}}
        self.document = {"version": 1, "identities": [self.previous]}
        self.save()
        self.output = self.root / "gate-probe"

    def tearDown(self):
        self.temp.cleanup()

    def save(self):
        if self.registry.exists():
            self.registry.chmod(0o600)
        self.registry.write_text(json.dumps(self.document))
        self.registry.chmod(0o400)

    def provision(self):
        return MODULE.provision(self.output, self.ca_cert, self.ca_key, self.identities)

    def test_issues_only_fixed_principal_preserves_registry_and_is_idempotent(self):
        before_ca = self.ca_key.stat()
        self.assertEqual(self.provision()["identities_added"], 1)
        data = json.loads(self.registry.read_text())
        self.assertEqual(data["identities"][0], self.previous)
        self.assertEqual(data["identities"][1]["principal"], MODULE.PRINCIPAL)
        self.assertLessEqual(MODULE.certificate_expiry(self.output / "gate-probe.crt"), MODULE.certificate_expiry(self.ca_cert))
        self.assertEqual(stat.S_IMODE((self.output / "gate-probe.key").stat().st_mode), 0o400)
        self.assertEqual(stat.S_IMODE(self.registry.stat().st_mode), 0o400)
        self.assertEqual(before_ca.st_mtime_ns, self.ca_key.stat().st_mtime_ns)
        registry_before = self.registry.stat()
        key_before = (self.output / "gate-probe.key").stat()
        self.assertTrue(self.provision()["already_registered"])
        self.assertEqual(registry_before.st_ino, self.registry.stat().st_ino)
        self.assertEqual(key_before.st_ino, (self.output / "gate-probe.key").stat().st_ino)

    def test_conflicting_reserved_principal_does_not_issue(self):
        self.document["identities"].append({"principal": {"alias": "gate-probe", "roles": ["operator"]}})
        self.save()
        with self.assertRaisesRegex(RuntimeError, "conflicting reserved"):
            self.provision()
        self.assertFalse(self.output.exists())

    def test_registered_missing_credential_is_not_rotated(self):
        self.document["identities"].append({"principal": MODULE.PRINCIPAL})
        self.save()
        with self.assertRaisesRegex(RuntimeError, "registered credential is missing"):
            self.provision()
        self.assertFalse(self.output.exists())

    def test_output_symlink_is_rejected_without_issuing(self):
        self.output.symlink_to(self.identities, target_is_directory=True)
        with self.assertRaises(OSError):
            self.provision()
        self.assertFalse((self.identities / "gate-probe.key").exists())

    def test_existing_empty_directory_is_not_overwritten(self):
        self.output.mkdir()
        inode = self.output.stat().st_ino
        with self.assertRaises(FileNotFoundError):
            self.provision()
        self.assertEqual(self.output.stat().st_ino, inode)

    def test_registry_failure_preserves_new_pair_for_exact_retry(self):
        with patch.object(MODULE.REGISTRY, "publish_identity_document", side_effect=RuntimeError("injected")):
            with self.assertRaisesRegex(RuntimeError, "injected"):
                self.provision()
        key_inode = (self.output / "gate-probe.key").stat().st_ino
        self.assertEqual(self.provision()["identities_added"], 1)
        self.assertEqual((self.output / "gate-probe.key").stat().st_ino, key_inode)

    def test_key_hardlink_or_broad_mode_is_rejected(self):
        self.provision()
        key = self.output / "gate-probe.key"
        os.link(key, self.output / "extra-link")
        with self.assertRaisesRegex(RuntimeError, "unsafe credential"):
            self.provision()
        (self.output / "extra-link").unlink()
        key.chmod(0o644)
        with self.assertRaisesRegex(RuntimeError, "unsafe credential"):
            self.provision()

    def test_short_lived_ca_is_rejected_before_issuance(self):
        short_cert = self.root / "short-ca.crt"
        subprocess.run([
            "openssl", "req", "-x509", "-key", str(self.ca_key), "-days", "2", "-out", str(short_cert),
            "-subj", "/CN=short-lived-test", "-addext", "basicConstraints=critical,CA:TRUE",
        ], check=True, capture_output=True)
        with self.assertRaises(RuntimeError):
            MODULE.provision(self.output, short_cert, self.ca_key, self.identities)
        self.assertFalse(self.output.exists())
        self.assertEqual(json.loads(self.registry.read_text()), self.document)

    def test_cli_never_echoes_unknown_arguments(self):
        sentinel = "private-argument-must-not-be-echoed"
        result = subprocess.run([
            sys.executable, str(SCRIPT), "--output-dir", str(self.output), "--ca-cert", str(self.ca_cert),
            "--ca-key", str(self.ca_key), "--identities-dir", str(self.identities), "--unknown", sentinel,
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(sentinel, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
