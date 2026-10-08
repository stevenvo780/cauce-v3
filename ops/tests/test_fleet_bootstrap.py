from __future__ import annotations

import json
import pathlib
import sys
import tempfile
import unittest

from test_fleet_runtime_materialization import dynamic_source

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from container_alias_lib import ContainerAliasError, load_container_aliases
from fleet_runtime_materialization import EXPORTER, load_desired_fleet, materialize


class FleetBootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-fleet-bootstrap-", dir="/var/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.state = pathlib.Path(self.temporary.name) / "state"
        self.payload = dynamic_source()
        self.payload["agents"][0].update(enabled=False, lifecycle_state="draft", host_id="new-host",
                                         runtime_mode="container", systemd_user="stev")
        for row in self.payload["memberships"]:
            row["enabled"] = False

    def test_disabled_draft_with_full_placement_exports_a_separate_non_admitted_catalog(self) -> None:
        snapshot = EXPORTER.snapshot_document(self.payload)
        self.assertEqual(snapshot["fleet"], {})
        self.assertEqual(snapshot["retired"], {})
        row = snapshot["bootstrap"]["physical-one"]
        self.assertEqual(row["alias"], "shared_alias")
        self.assertEqual(row["room"], "grp.primary")
        self.assertIs(row["enabled"], False)
        self.assertIs(row["admission"], False)
        self.assertEqual(len(row["memberships"]), 2)
        self.assertTrue(all(member["enabled"] is False for member in row["memberships"]))

    def test_only_preparation_lifecycles_export_bootstrap_and_incomplete_drafts_do_not(self) -> None:
        for lifecycle in ("draft", "provisioning", "auth_pending", "verifying"):
            self.payload["agents"][0]["lifecycle_state"] = lifecycle
            with self.subTest(lifecycle=lifecycle):
                self.assertIn("physical-one", EXPORTER.snapshot_document(self.payload)["bootstrap"])
        for lifecycle in ("retiring", "retired", "failed", "ready"):
            self.payload["agents"][0]["lifecycle_state"] = lifecycle
            with self.subTest(lifecycle=lifecycle):
                self.assertNotIn("bootstrap", EXPORTER.snapshot_document(self.payload))
        self.payload["agents"][0]["lifecycle_state"] = "draft"
        for field in ("runtime_key", "harness_id", "container_name", "runtime_user", "home_directory",
                      "state_directory", "primary_room_id", "host_id", "runtime_mode", "systemd_user"):
            original = self.payload["agents"][0][field]
            self.payload["agents"][0][field] = None
            with self.subTest(field=field):
                self.assertNotIn("bootstrap", EXPORTER.snapshot_document(self.payload))
            self.payload["agents"][0][field] = original

    def test_bootstrap_artifacts_are_verified_but_normal_launch_reader_rejects_them(self) -> None:
        receipt = materialize(self.payload, {}, self.state)
        self.assertEqual(load_desired_fleet(self.state), receipt)
        generation = self.state / "generations" / receipt["generation"]
        self.assertEqual(load_container_aliases(generation, allow_empty=True), {})
        bootstrap = generation / "bootstrap"
        with self.assertRaisesRegex(ContainerAliasError, "bootstrap"):
            load_container_aliases(bootstrap)
        aliases = load_container_aliases(bootstrap, allow_bootstrap=True)
        self.assertIs(aliases["physical-one"]["admission"], False)
        self.assertIs(aliases["physical-one"]["enabled"], False)
        manifest = (bootstrap / "manifests/physical-one.yaml").read_text()
        self.assertIn("  bootstrap: true\n  admission: false\n", manifest)
        self.assertFalse((generation / "manifests/physical-one.yaml").exists())
        self.assertIn("bootstrap/container-aliases.json", receipt["files"])
        self.assertIn("bootstrap/manifests/physical-one.yaml", receipt["files"])
        runtime = json.loads((generation / "generated/fleet.json").read_bytes())
        self.assertEqual(runtime["aliases"], {})


if __name__ == "__main__":
    unittest.main()
