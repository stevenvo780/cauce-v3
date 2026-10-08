from __future__ import annotations

import pathlib
import sys
import tempfile
import unittest

from test_fleet_runtime_materialization import dynamic_source

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))

from container_alias_lib import load_container_aliases  # noqa: E402
from fleet_runtime_materialization import materialize  # noqa: E402
from manifest_lib import ManifestError, load_manifests  # noqa: E402


class RuntimeFleetCanonicalManifestsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-runtime-manifests-", dir="/var/tmp")
        self.state = pathlib.Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def generation(self, payload: dict) -> pathlib.Path:
        receipt = materialize(payload, {}, self.state)
        return self.state / "generations" / receipt["generation"]

    def test_canonical_readers_preserve_wire_alias_and_quoted_room_labels(self) -> None:
        for room in ("room.one", "Sala café: equipo", "Sala\u0085equipo", "Sala\u2028equipo"):
            with self.subTest(room=room):
                payload = dynamic_source()
                payload["agents"][0]["primary_room_id"] = room
                payload["memberships"][0]["room_id"] = room
                generation = self.generation(payload)
                aliases = load_container_aliases(generation)
                self.assertEqual(aliases["physical-one"]["alias"], "shared_alias")
                document = load_manifests(generation)[0]
                self.assertEqual(document["spec"]["room"], room)
                self.assertEqual(document["spec"]["alias"], "shared_alias")

    def test_dynamic_policy_role_survives_materialization_and_canonical_read(self) -> None:
        payload = dynamic_source()
        payload["rolePolicies"].append({"role": "observer"})
        payload["memberships"][0]["role"] = "observer"
        aliases = load_container_aliases(self.generation(payload))
        self.assertEqual(aliases["physical-one"]["membershipRole"], "observer")

    def test_yaml_reserved_identifiers_remain_strings_in_canonical_reader(self) -> None:
        payload = dynamic_source()
        payload["agents"][0].update({"tenant_id": "True", "alias": "null", "runtime_key": "on",
                                    "state_directory": "/home/dev/.local/state/cauce-v3/on"})
        for row in payload["memberships"]:
            row.update({"tenant_id": "True", "alias": "null"})
        document = load_manifests(self.generation(payload))[0]
        self.assertEqual(document["metadata"]["name"], "on")
        self.assertEqual(document["spec"]["tenant"], "True")
        self.assertEqual(document["spec"]["alias"], "null")

    def test_physical_key_cannot_be_substituted_for_the_logical_wire_alias(self) -> None:
        generation = self.generation(dynamic_source())
        manifest = generation / "manifests/physical-one.yaml"
        manifest.write_text(manifest.read_text().replace("  alias: shared_alias\n", "  alias: physical-one\n"))
        with self.assertRaisesRegex(ManifestError, "wire identity"):
            load_manifests(generation)


if __name__ == "__main__":
    unittest.main()
