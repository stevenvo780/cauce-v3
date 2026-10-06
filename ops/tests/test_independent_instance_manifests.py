import importlib.util
import json
import pathlib
import sys
import tempfile
import unittest

import yaml
from jsonschema import Draft202012Validator

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

    def test_protocol_underscore_alias_round_trips_through_manifest_loader(self):
        from manifest_lib import load_manifests

        row = json.loads((OPS / "flota.json").read_text())["fleet"]["socrates"]
        with tempfile.TemporaryDirectory(prefix="cauce-manifest-") as temporary:
            root = pathlib.Path(temporary)
            (root / "manifests").mkdir()
            (root / "schemas").mkdir()
            schema = (OPS / "schemas/alias-manifest.schema.json").read_text()
            (root / "schemas/alias-manifest.schema.json").write_text(schema)
            snapshot = root / "flota.json"
            snapshot.write_text(json.dumps({"schemaVersion": 1, "fleet": {"operador_uno": row}}))
            loaded = MODULE.load_fleet(snapshot)
            rendered = MODULE.render_manifest("operador_uno", loaded["operador_uno"])
            (root / "manifests/operador_uno.yaml").write_text(rendered)
            document = yaml.safe_load(rendered)
            Draft202012Validator(json.loads(schema)).validate(document)
            self.assertEqual(load_manifests(root)[0]["spec"]["alias"], "operador_uno")
            for alias in ("operador.uno", "_operador", "Operador", "a" * 65):
                snapshot.write_text(json.dumps({"schemaVersion": 1, "fleet": {alias: row}}))
                with self.assertRaises(MODULE.GeneratorError):
                    MODULE.load_fleet(snapshot)

    def test_yaml_newline_injection_rejected(self):
        row = json.loads((OPS / "flota.json").read_text())["fleet"]["socrates"]
        with tempfile.TemporaryDirectory(prefix="cauce-manifest-") as root:
            path = pathlib.Path(root) / "flota.json"
            path.write_text(json.dumps({"schemaVersion": 1, "fleet": {"operador": dict(row, room="room\nalias: attacker")}}))
            with self.assertRaises(MODULE.GeneratorError):
                MODULE.load_fleet(path)


if __name__ == "__main__":
    unittest.main()
