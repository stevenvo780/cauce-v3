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
    "openclaw": {"operador"},
    "muse": {"perseo", "teseo"},
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
    def test_current_fleet_reproduces_committed_artifacts_byte_for_byte(self) -> None:
        snapshot = json.loads(FLEET.read_text(encoding="utf-8"))
        expected_aliases = set().union(*EXPECTED_BY_HARNESS.values())
        self.assertEqual(set(snapshot["fleet"]), expected_aliases)
        self.assertEqual(snapshot["placement"], {})
        self.assertEqual(set(snapshot["systemPrincipals"]), {"console-proxy"})
        self.assertEqual({row["tenant"] for row in snapshot["fleet"].values()}, {"Hospital"})
        self.assertEqual({row["room"] for row in snapshot["fleet"].values()}, {"grp.hospital"})
        self.assertEqual(snapshot["fleet"]["operador"]["role"], "operator")
        self.assertEqual(snapshot["fleet"]["teseo"]["role"], "agent")
        self.assertEqual(snapshot["fleet"]["perseo"]["role"], "agent")
        self.assertEqual(
            len({row["container"] for row in snapshot["fleet"].values()}),
            len(expected_aliases),
        )
        self.assertEqual(
            len({row["runtimeStateDirectory"] for row in snapshot["fleet"].values()}),
            len(expected_aliases),
        )
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
            expected_names = {f"{alias}.yaml" for alias in expected_aliases}
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
