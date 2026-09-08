#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import pathlib
import runpy
import subprocess
import sys
import tempfile
import unittest

OPS_ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPTS = OPS_ROOT / "scripts"
SNAPSHOT = pathlib.Path(__file__).resolve().parent / "fixtures" / "fleet_snapshot" / "minimal" / "flota.json"


def run_script(name: str, *arguments: str) -> subprocess.CompletedProcess[str]:
    environment = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    return subprocess.run(
        [sys.executable, str(SCRIPTS / name), *arguments],
        check=True,
        capture_output=True,
        text=True,
        env=environment,
    )


class FleetGeneratorTests(unittest.TestCase):
    def test_generators_emit_the_exact_synthetic_fleet(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary)
            aliases = output / "container-aliases.json"
            manifests = output / "manifests"
            runtime_fleet = output / "fleet.json"
            run_script(
                "generate-container-aliases.py",
                "--snapshot",
                str(SNAPSHOT),
                "--output",
                str(aliases),
            )
            run_script(
                "generate-manifests.py",
                "--snapshot",
                str(SNAPSHOT),
                "--output",
                str(manifests),
            )
            run_script(
                "generate-runtime-fleet.py",
                "--snapshot",
                str(SNAPSHOT),
                "--output",
                str(runtime_fleet),
            )
            document = json.loads(aliases.read_text(encoding="utf-8"))
            expected = {"fixture-codex", "fixture-hermes", "fixture-openclaw"}
            self.assertEqual(set(document["aliases"]), expected - {"fixture-codex"})
            self.assertEqual(
                document["historicalAliases"],
                {"fixture-retired": {"expectedEnabled": False}},
            )
            self.assertEqual(
                {path.stem for path in manifests.glob("*.yaml")},
                expected,
            )
            runtime_document = json.loads(runtime_fleet.read_text(encoding="utf-8"))
            self.assertEqual(set(runtime_document), {"aliases", "schemaVersion"})
            self.assertEqual(set(runtime_document["aliases"]), expected)
            self.assertNotIn("fixture-retired", runtime_document["aliases"])
            self.assertEqual(
                runtime_document["aliases"]["fixture-codex"]["container"],
                "host:fixture-host",
            )
            for entry in runtime_document["aliases"].values():
                self.assertEqual(
                    set(entry),
                    {
                        "container",
                        "enabled",
                        "harness",
                        "home",
                        "room",
                        "stateDirectory",
                        "tenant",
                        "user",
                    },
                )
                self.assertIs(entry["enabled"], True)

    def test_global_reader_preserves_the_declared_remote_placement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            document = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
            document["placement"]["fixture-hermes"] = {"dockerHost": "server2", "systemdUser": "server"}
            (root / "flota.json").write_text(json.dumps(document), encoding="utf-8")
            sys.path.insert(0, str(SCRIPTS))
            try:
                load = runpy.run_path(str(SCRIPTS / "fleet_derive.py"))["load_fleet_assignments"]
                entry = load(root)["fixture-hermes"]
            finally:
                sys.path.pop(0)
            self.assertEqual(entry["dockerHost"], "server2")
            self.assertEqual(entry["systemdUser"], "server")

    def test_vm_identity_survives_runtime_generation_without_a_docker_alias(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = pathlib.Path(temporary)
            document = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
            document["fleet"]["fixture-codex"]["container"] = "vm:fixture-machine"
            source = output / "flota.json"
            source.write_text(json.dumps(document), encoding="utf-8")
            run_script("generate-container-aliases.py", "--snapshot", str(source),
                       "--output", str(output / "container-aliases.json"))
            run_script("generate-runtime-fleet.py", "--snapshot", str(source),
                       "--output", str(output / "fleet.json"))
            self.assertNotIn("fixture-codex", json.loads((output / "container-aliases.json").read_text())["aliases"])
            self.assertEqual(json.loads((output / "fleet.json").read_text())["aliases"]["fixture-codex"]["container"],
                             "vm:fixture-machine")

    def test_manifest_generation_unlinks_orphans(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            manifests = pathlib.Path(temporary)
            orphan = manifests / "orphan.yaml"
            orphan.write_text("not a fleet manifest\n", encoding="utf-8")
            result = run_script(
                "generate-manifests.py",
                "--snapshot",
                str(SNAPSHOT),
                "--output",
                str(manifests),
            )
            self.assertFalse(orphan.exists())
            self.assertIn(f"retired {orphan}", result.stdout)

    def test_manifest_generation_rejects_unsafe_yaml_before_writing(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            snapshot = json.loads(SNAPSHOT.read_text(encoding="utf-8"))
            snapshot["fleet"]["fixture-openclaw"]["home"] = "/home/claw # invalid"
            source = root / "flota.json"
            source.write_text(json.dumps(snapshot), encoding="utf-8")
            output = root / "manifests"
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS / "generate-manifests.py"),
                    "--snapshot",
                    str(source),
                    "--output",
                    str(output),
                ],
                check=False,
                capture_output=True,
                text=True,
                env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
            )
            self.assertEqual(result.returncode, 1)
            self.assertFalse(list(output.glob("*.yaml")))


if __name__ == "__main__":
    unittest.main()
