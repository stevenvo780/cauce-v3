#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

OPS_ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = OPS_ROOT / "scripts"
FLEET = OPS_ROOT / "flota.json"
EXPECTED_BY_HARNESS = {
    "claude": {"heraclito", "kratos", "salva", "zeus"},
    "codex": {"atlas", "kant", "socrates", "tales"},
    "openclaw": {"argos", "gaia", "hegel", "iza", "janus", "jarvis"},
}
EXPECTED_ALIASES = set().union(*EXPECTED_BY_HARNESS.values())


def run_script(name: str, *arguments: str) -> None:
    subprocess.run(
        [sys.executable, str(SCRIPTS / name), *arguments],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


class FleetPhaseATests(unittest.TestCase):
    def test_current_fleet_reproduces_committed_artifacts_byte_for_byte(self) -> None:
        snapshot = json.loads(FLEET.read_text(encoding="utf-8"))
        self.assertEqual(set(snapshot["fleet"]), EXPECTED_ALIASES)
        for harness, aliases in EXPECTED_BY_HARNESS.items():
            self.assertEqual(
                {alias for alias, row in snapshot["fleet"].items() if row["harness"] == harness},
                aliases,
                harness,
            )
        self.assertEqual(
            {row["harness"] for row in snapshot["fleet"].values()},
            set(EXPECTED_BY_HARNESS),
            "un arnés nuevo exige una expectativa explícita",
        )

        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary)
            generated_aliases = output / "container-aliases.json"
            generated_manifests = output / "manifests"
            run_script(
                "generate-container-aliases.py",
                "--snapshot",
                str(FLEET),
                "--output",
                str(generated_aliases),
            )
            run_script(
                "generate-manifests.py",
                "--snapshot",
                str(FLEET),
                "--output",
                str(generated_manifests),
            )

            self.assertEqual(
                generated_aliases.read_bytes(),
                (OPS_ROOT / "container-aliases.json").read_bytes(),
            )
            expected_names = {f"{alias}.yaml" for alias in EXPECTED_ALIASES}
            self.assertEqual(
                {path.name for path in (OPS_ROOT / "manifests").glob("*.yaml")},
                expected_names,
            )
            self.assertEqual(
                {path.name for path in generated_manifests.glob("*.yaml")},
                expected_names,
            )
            for name in sorted(expected_names):
                self.assertEqual(
                    (generated_manifests / name).read_bytes(),
                    (OPS_ROOT / "manifests" / name).read_bytes(),
                    name,
                )


if __name__ == "__main__":
    unittest.main()
