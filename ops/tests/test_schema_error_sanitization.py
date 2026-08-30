#!/usr/bin/env python3
from __future__ import annotations

import ast
import pathlib
import sys
import unittest

from jsonschema import Draft202012Validator

OPS = pathlib.Path(__file__).resolve().parents[1]
ROOT = OPS.parent
sys.path.insert(0, str(OPS / "scripts"))

from manifest_lib import safe_schema_diagnostic  # noqa: E402

SCRIPTS = (
    "manifest_lib.py",
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

    def test_live_schema_consumers_route_jsonschema_errors_through_safe_formatter(self) -> None:
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


if __name__ == "__main__":
    unittest.main()
