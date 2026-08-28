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
SNAPSHOT = pathlib.Path(__file__).resolve().parent / "fixtures" / "fleet_snapshot" / "real-11" / "flota.json"
EXPECTED_ALIASES = {
    "argos",
    "atlas",
    "hegel",
    "iza",
    "janus",
    "jarvis",
    "kant",
    "kratos",
    "salva",
    "socrates",
    "zeus",
}


def run_script(name: str, *arguments: str) -> None:
    subprocess.run(
        [sys.executable, str(SCRIPTS / name), *arguments],
        check=True,
        capture_output=True,
        text=True,
        env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
    )


class FleetPhaseATests(unittest.TestCase):
    def test_real_eleven_snapshot_reproduces_committed_artifacts_byte_for_byte(self) -> None:
        snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
        self.assertEqual(set(snapshot["fleet"]), EXPECTED_ALIASES)
        self.assertEqual(
            {alias for alias, row in snapshot["fleet"].items() if row["harness"] == "claude"},
            {"argos", "zeus"},
        )

        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary)
            generated_aliases = output / "container-aliases.json"
            generated_manifests = output / "manifests"
            run_script(
                "generate-container-aliases.py",
                "--snapshot",
                str(SNAPSHOT),
                "--output",
                str(generated_aliases),
            )
            run_script(
                "generate-manifests.py",
                "--snapshot",
                str(SNAPSHOT),
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
