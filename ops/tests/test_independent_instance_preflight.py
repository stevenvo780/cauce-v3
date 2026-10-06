from __future__ import annotations

import copy
import importlib
import json
import pathlib
import sys
import tempfile
import unittest
from unittest.mock import patch

from jsonschema.exceptions import ValidationError
from test_independent_instance import CODE, InstanceError, canonical, make_descriptor, plan_instance

sys.path.insert(0, str(CODE / "ops/scripts"))
aliases = importlib.import_module("container_alias_lib")


class ArtifactPreflightTest(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-preflight-")
        self.addCleanup(self.temporary.cleanup)
        self.document = make_descriptor(self.temporary.name)

    def test_underscore_alias_is_canonical_through_all_derived_artifacts(self):
        bootstrap_path = pathlib.Path(self.document["identityRefs"]["bootstrap"])
        bootstrap = json.loads(bootstrap_path.read_text())
        bootstrap["agents"][0]["alias"] = "operador_uno"
        bootstrap["agents"][0]["state_directory"] = "/home/dev/.local/state/cauce-v3/operador_uno"
        bootstrap["memberships"][0]["alias"] = "operador_uno"
        bootstrap_path.write_bytes(canonical(bootstrap))
        plan = plan_instance(self.document)
        self.assertIn("operador_uno", plan["bootstrapInventory"]["fleet"])
        self.assertIn("operador_uno", plan["bootstrapAliases"]["aliases"])
        fleet_derive = importlib.import_module("fleet_derive")
        root = pathlib.Path(self.temporary.name) / "derived"
        root.mkdir()
        (root / "flota.json").write_bytes(canonical(plan["bootstrapInventory"]))
        (root / "container-aliases.json").write_bytes(canonical(plan["bootstrapAliases"]))
        self.assertIn("operador_uno", fleet_derive.load_fleet_assignments(root))
        self.assertIn("operador_uno", aliases.load_container_aliases(root))
        self.assertTrue(aliases.ALIAS_RE.fullmatch("a" + "_" * 63))
        for invalid in ("a.b", "A", "_a", "a" * 65):
            self.assertIsNone(aliases.ALIAS_RE.fullmatch(invalid))
        self.assertIsNone(aliases.NAME_RE.fullmatch("user_name"))

    def test_json_schema_rejection_is_reported_before_install_effects(self):
        planning = importlib.import_module("planning")
        instance = importlib.import_module("instance")
        with patch.object(planning.Draft202012Validator, "validate", side_effect=ValidationError("invalid manifest")):
            with self.assertRaises(InstanceError):
                plan_instance(self.document)
            with patch.object(instance.resources, "reservation_lock", side_effect=AssertionError("install mutation reached")):
                with self.assertRaises(InstanceError):
                    instance.apply_instance({"descriptor": self.document})
        self.assertFalse(pathlib.Path(self.document["inventoryRoot"]).exists())
        self.assertFalse(pathlib.Path(self.document["paths"]["state"]).exists())

    def test_unsupported_inventory_fields_fail_before_install_effects(self):
        instance = importlib.import_module("instance")
        original = json.loads(pathlib.Path(self.document["identityRefs"]["bootstrap"]).read_text())
        for field, value in (("runtime_user", "user_name"), ("container_name", "container_name"),
                             ("harness_id", "unsupported"), ("harness_id", "hermes"),
                             ("home_directory", "/home/user name"), ("state_directory", "/state/user name")):
            with self.subTest(field=field):
                descriptor = make_descriptor(self.temporary.name, "invalid-" + field.replace("_", "-") + "-" + str(len(value)))
                bootstrap_path = pathlib.Path(descriptor["identityRefs"]["bootstrap"])
                changed = copy.deepcopy(original)
                changed["agents"][0][field] = value
                bootstrap_path.write_bytes(canonical(changed))
                inventory = pathlib.Path(descriptor["inventoryRoot"])
                state = pathlib.Path(descriptor["paths"]["state"])
                with self.assertRaises(InstanceError) as rejected:
                    plan_instance(descriptor)
                if value == "hermes":
                    self.assertIn("Hermes requires", str(rejected.exception))
                with patch.object(instance.resources, "reservation_lock", side_effect=AssertionError("install mutation reached")):
                    with self.assertRaises(InstanceError):
                        instance.apply_instance({"descriptor": descriptor})
                self.assertFalse(inventory.exists())
                self.assertFalse(state.exists())


if __name__ == "__main__":
    unittest.main()
