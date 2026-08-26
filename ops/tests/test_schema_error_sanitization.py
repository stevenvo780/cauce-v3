#!/usr/bin/env python3
from __future__ import annotations

import ast
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

from jsonschema import Draft202012Validator


OPS = pathlib.Path(__file__).resolve().parents[1]
ROOT = OPS.parent
sys.path.insert(0, str(OPS / "scripts"))

from manifest_lib import safe_schema_diagnostic  # noqa: E402


SCRIPTS = (
    "manifest_lib.py",
    "validate-fleet-release-evidence.py",
    "validate-release-evidence.py",
    "release-candidate.py",
)


class SchemaErrorSanitizationTests(unittest.TestCase):
    def test_formatter_emits_only_bounded_path_and_validator_keyword(self) -> None:
        private_id = "d9428888-122b-4f8d-9a28-39e03a0f347a"
        expected_id = "6ba7b810-9dad-41d1-80b4-00c04fd430c8"
        private_digest = "sha256:" + "a" * 64
        expected_digest = "sha256:" + "b" * 64
        private_text = "PRIVATE-INSTANCE-MUST-NOT-APPEAR"
        schema = {
            "type": "object",
            "properties": {
                "deliveryId": {"const": expected_id},
                "sourceDigest": {"const": expected_digest},
                "payload": {"type": "integer"},
            },
        }
        instance = {
            "deliveryId": private_id,
            "sourceDigest": private_digest,
            "payload": private_text,
        }

        diagnostics = "\n".join(
            safe_schema_diagnostic(error)
            for error in Draft202012Validator(schema).iter_errors(instance)
        )

        self.assertIn("deliveryId: schema rule const", diagnostics)
        self.assertIn("sourceDigest: schema rule const", diagnostics)
        self.assertIn("payload: schema rule type", diagnostics)
        for forbidden in (
            private_id, expected_id, private_digest, expected_digest, private_text,
        ):
            self.assertNotIn(forbidden, diagnostics)

    def test_formatter_collapses_identifier_and_digest_shaped_path_keys(self) -> None:
        digest_key = "a" * 64
        uuid_key = "d9428888-122b-4f8d-9a28-39e03a0f347a"
        schema = {"type": "object", "additionalProperties": {"type": "integer"}}
        errors = list(Draft202012Validator(schema).iter_errors({
            digest_key: "private",
            uuid_key: "private",
        }))

        diagnostics = [safe_schema_diagnostic(error) for error in errors]

        self.assertEqual(diagnostics, ["<key>: schema rule type", "<key>: schema rule type"])
        self.assertNotIn(digest_key, "\n".join(diagnostics))
        self.assertNotIn(uuid_key, "\n".join(diagnostics))

    def test_all_four_release_scripts_route_jsonschema_errors_through_safe_formatter(self) -> None:
        for name in SCRIPTS:
            source = (OPS / "scripts" / name).read_text(encoding="utf-8")
            tree = ast.parse(source, filename=name)
            attributes = {
                node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
            }
            self.assertIn("safe_schema_diagnostic", source, name)
            self.assertTrue(
                {"message", "instance", "validator_value"}.isdisjoint(attributes),
                f"{name} accesses unsafe jsonschema rendering fields",
            )

    def test_fleet_validator_schema_failure_never_prints_rejected_instance(self) -> None:
        private_id = "d9428888-122b-4f8d-9a28-39e03a0f347a"
        private_digest = "sha256:" + "c" * 64
        with tempfile.TemporaryDirectory(prefix="cauce-schema-sanitize-") as temporary:
            root = pathlib.Path(temporary)
            scripts = root / "ops" / "scripts"
            artifacts = root / "tests" / "fleet-release" / "artifacts"
            scripts.mkdir(parents=True)
            artifacts.mkdir(parents=True)
            for name in (
                "validate-fleet-release-evidence.py", "manifest_lib.py", "container_alias_lib.py",
            ):
                shutil.copy2(OPS / "scripts" / name, scripts / name)
            shutil.copy2(
                ROOT / "tests" / "fleet-release" / "fleet-release-report.schema.json",
                root / "tests" / "fleet-release" / "fleet-release-report.schema.json",
            )
            (artifacts / "report.json").write_text(json.dumps({
                "schemaVersion": private_id,
                "sourceDigest": private_digest,
            }), encoding="utf-8")

            result = subprocess.run(
                [sys.executable, str(scripts / "validate-fleet-release-evidence.py")],
                capture_output=True,
                text=True,
                check=False,
            )

        output = result.stdout + result.stderr
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("schema rule", output)
        self.assertNotIn(private_id, output)
        self.assertNotIn(private_digest, output)


if __name__ == "__main__":
    unittest.main()
