from __future__ import annotations

import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/cutover.sh"


class CutoverAliasBoundaryTest(unittest.TestCase):
    def invoke(self, alias):
        with tempfile.TemporaryDirectory(prefix="cauce-cutover-alias-") as directory:
            env = {**os.environ, "HOME": directory, "CAUCE_CHANGE_ID": "synthetic"}
            env.pop("CAUCE_CUTOVER_CONFIRM", None)
            result = subprocess.run(
                ["bash", str(SCRIPT), "container", alias, str(pathlib.Path(directory) / "missing.json")],
                env=env, text=True, capture_output=True, check=False,
            )
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [])
            return result

    def test_canonical_alias_reaches_confirmation_before_effects(self):
        for alias in ("operador_principal", "a" + "_" * 63):
            with self.subTest(alias=alias):
                result = self.invoke(alias)
                self.assertEqual(result.returncode, 2)
                self.assertIn("cutover refused", result.stderr)
                self.assertNotIn("invalid alias", result.stderr)

    def test_invalid_alias_rejected_before_effects(self):
        for alias in ("../operador", "a" * 65, "operador\n", "Operador"):
            with self.subTest(alias=alias):
                result = self.invoke(alias)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid alias", result.stderr)


if __name__ == "__main__":
    unittest.main()
