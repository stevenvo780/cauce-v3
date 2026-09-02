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

from schema_diagnostics import safe_schema_diagnostic  # noqa: E402

SANITIZER = "schema_diagnostics.py"
KNOWN_CONSUMERS = frozenset({"manifest_lib.py", "validate-testcontainers-evidence.py"})


def jsonschema_consumers() -> list[pathlib.Path]:
    """List the ops scripts that import jsonschema, discovered rather than hardcoded.

    A hardcoded roster lets the next schema consumer escape the guard entirely, so the roster
    is derived from the imports themselves and only cross-checked against the known ones.
    """
    consumers = []
    for path in sorted((OPS / "scripts").glob("*.py")):
        if path.name == SANITIZER:
            continue
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=path.name)
        modules = {
            node.module for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)
        } | {
            alias.name
            for node in ast.walk(tree)
            if isinstance(node, ast.Import)
            for alias in node.names
        }
        if any((module or "").split(".")[0] == "jsonschema" for module in modules):
            consumers.append(path)
    return consumers


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
        consumers = jsonschema_consumers()
        self.assertTrue(
            KNOWN_CONSUMERS.issubset({path.name for path in consumers}),
            "jsonschema consumer discovery stopped seeing the known consumers",
        )
        for path in [*consumers, OPS / "scripts" / SANITIZER]:
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=path.name)
            attributes = {
                node.attr for node in ast.walk(tree) if isinstance(node, ast.Attribute)
            }
            if path.name != SANITIZER:
                self.assertIn("safe_schema_diagnostic", source, path.name)
            self.assertTrue(
                {"message", "instance", "validator_value"}.isdisjoint(attributes),
                f"{path.name} accesses unsafe jsonschema rendering fields",
            )


if __name__ == "__main__":
    unittest.main()
