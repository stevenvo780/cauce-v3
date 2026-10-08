from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

from test_fleet_runtime_materialization import dynamic_source

SCRIPTS = pathlib.Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPTS))
from fleet_runtime_materialization import materialize  # noqa: E402


class RuntimeFleetQueryTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-runtime-query-", dir="/var/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.state = pathlib.Path(self.temporary.name) / "state"
        self.payload = dynamic_source()
        second = dict(self.payload["agents"][0], tenant_id="Otro", runtime_key="physical-two",
                      state_directory="/home/dev/.local/state/cauce-v3/physical-two")
        self.payload["agents"].append(second)
        self.payload["memberships"].extend(dict(row, tenant_id="Otro") for row in list(self.payload["memberships"]))
        self.apply()

    def apply(self, placement: dict | None = None) -> None:
        receipt = materialize(self.payload, placement or {}, self.state)
        (self.state / "applied-fleet.json").write_text(json.dumps(receipt), encoding="utf-8")

    def query(self, selector: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run([sys.executable, str(SCRIPTS / "container-alias-query.py"), selector, *arguments],
                              capture_output=True, text=True, check=False,
                              env={**os.environ, "CAUCE_FLEET_RUNTIME_STATE": str(self.state),
                                   "PYTHONDONTWRITEBYTECODE": "1"})

    def test_tenant_wire_selector_resolves_the_physical_key(self) -> None:
        result = self.query("Otro/shared_alias", "--runtime-key")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "physical-two\n")
        identity = self.query("physical-one", "--identity")
        self.assertEqual(identity.returncode, 0, identity.stderr)
        self.assertEqual(identity.stdout, "physical-one\tEquipo_42\tshared_alias\n")

    def test_legacy_stdout_keeps_seven_fields_and_physical_paths(self) -> None:
        result = self.query("physical-one")
        self.assertEqual(result.returncode, 0, result.stderr)
        fields = result.stdout.strip().split("\t")
        self.assertEqual(len(fields), 7)
        self.assertEqual(fields[0:2], ["Equipo_42", "grp.primary"])
        self.assertEqual(fields[5], "/home/dev/.local/state/cauce-v3/physical-one")

    def test_bare_logical_alias_is_rejected_when_tenants_share_it(self) -> None:
        result = self.query("shared_alias", "--runtime-key")
        self.assertEqual(result.returncode, 2)
        self.assertIn("ambiguous", result.stderr)

    def test_tampered_desired_artifact_fails_without_falling_back_to_repository(self) -> None:
        receipt = json.loads((self.state / "desired-fleet.json").read_bytes())
        (self.state / "generations" / receipt["generation"] / "container-aliases.json").write_text("{}")
        result = self.query("kant", "--runtime-key")
        self.assertEqual(result.returncode, 2)
        self.assertIn("digest", result.stderr)

    def test_retired_runtime_cannot_be_resolved_from_an_old_generation(self) -> None:
        self.payload["agents"][0]["enabled"] = False
        self.apply()
        result = self.query("physical-one", "--runtime-key")
        self.assertEqual(result.returncode, 2)
        self.assertIn("not declared", result.stderr)

    def test_desired_generation_alone_does_not_authorize_runtime_routing(self) -> None:
        (self.state / "applied-fleet.json").unlink()
        result = self.query("physical-one", "--runtime-key")
        self.assertEqual(result.returncode, 2)
        self.assertIn("applied-fleet.json", result.stderr)

    def test_applied_remote_route_keeps_the_selected_systemd_user(self) -> None:
        self.apply({"physical-two": {"dockerHost": "server2", "systemdUser": "server"}})
        result = self.query("Otro/shared_alias", "--route")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "ssh:server@server2\n")

    def test_unit_generator_selects_the_physical_key_and_exports_wire_identity(self) -> None:
        output = pathlib.Path(self.temporary.name) / "units"
        result = subprocess.run([sys.executable, str(SCRIPTS / "generate-units.py"), "--output", str(output),
                                 "--alias", "physical-one"], capture_output=True, text=True, check=False,
                                env={**os.environ, "CAUCE_FLEET_RUNTIME_STATE": str(self.state),
                                     "PYTHONDONTWRITEBYTECODE": "1"})
        self.assertEqual(result.returncode, 0, result.stderr)
        unit = output / "cauce-v3-alias-physical-one.service"
        self.assertTrue(unit.exists(), "physical selection did not produce the runtime unit")
        content = unit.read_text()
        self.assertIn("Environment=CAUCE_ALIAS=shared_alias\n", content)
        self.assertIn("Environment=CAUCE_RUNTIME_KEY=physical-one\n", content)
        self.assertIn("Environment=CAUCE_TENANT_ID=Equipo_42\n", content)
        self.assertIn("ExecStart=/opt/cauce-v3/ops/scripts/alias-runner.sh physical-one\n", content)
        self.assertIn("StateDirectory=cauce-v3/aliases/physical-one\n", content)
        self.assertIn("User=dev\n", content)
        self.assertNotIn("Group=cauce-v3\n", content)


if __name__ == "__main__":
    unittest.main()
