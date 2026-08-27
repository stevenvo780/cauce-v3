from __future__ import annotations

import ast
import pathlib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "_legado" / "ops-scripts"


class ReleaseSchemaErrorSanitizationTests(unittest.TestCase):
    def test_release_scripts_route_jsonschema_errors_through_safe_formatter(self) -> None:
        for name in ("validate-release-evidence.py", "release-candidate.py"):
            source = (SCRIPTS / name).read_text(encoding="utf-8")
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
