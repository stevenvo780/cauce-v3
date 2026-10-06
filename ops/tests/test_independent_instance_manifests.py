import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

import yaml

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / "scripts"))
SPEC = importlib.util.spec_from_file_location("generic_manifests", OPS / "scripts/generate-manifests.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class GenericManifestTest(unittest.TestCase):
    def test_unambiguous_room_scalars_round_trip_and_central_bytes_stay_identical(self):
        row = json.loads((OPS / "flota.json").read_text())["fleet"]["socrates"]
        for room in ("Sala de atención 42", "null", "true", "42", "2026-01-01", "sala.42"):
            changed = dict(row, room=room)
            with tempfile.TemporaryDirectory(prefix="cauce-manifest-") as root:
                snapshot = pathlib.Path(root) / "flota.json"
                snapshot.write_text(json.dumps({"schemaVersion": 1, "fleet": {"operador": changed}}))
                loaded = MODULE.load_fleet(snapshot)
                manifest = yaml.safe_load(MODULE.render_manifest("operador", loaded["operador"]))
                self.assertEqual(manifest["spec"]["room"], room)
                self.assertIsInstance(manifest["spec"]["room"], str)
        for alias, existing in json.loads((OPS / "flota.json").read_text())["fleet"].items():
            path = OPS / "manifests" / (alias + ".yaml")
            if path.exists():
                self.assertEqual(MODULE.render_manifest(alias, existing), path.read_text())

    def test_yaml_newline_injection_rejected(self):
        row = json.loads((OPS / "flota.json").read_text())["fleet"]["socrates"]
        with tempfile.TemporaryDirectory(prefix="cauce-manifest-") as root:
            path = pathlib.Path(root) / "flota.json"
            path.write_text(json.dumps({"schemaVersion": 1, "fleet": {"operador": dict(row, room="room\nalias: attacker")}}))
            with self.assertRaises(MODULE.GeneratorError):
                MODULE.load_fleet(path)


if __name__ == "__main__":
    unittest.main()
