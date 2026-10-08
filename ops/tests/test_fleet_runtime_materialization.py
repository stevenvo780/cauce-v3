from __future__ import annotations

import hashlib
import importlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from test_export_fleet_snapshot import agent, membership, source

OPS = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = OPS / "scripts/materialize-fleet-runtime.py"
sys.path.insert(0, str(SCRIPT.parent))


def dynamic_source() -> dict[str, object]:
    row = {**agent("shared_alias", tenant="Equipo_42"), "runtime_key": "physical-one",
           "primary_room_id": "grp.primary"}
    row["state_directory"] = "/home/dev/.local/state/cauce-v3/physical-one"
    return source(agents=[row], memberships=[
        membership("shared_alias", tenant="Equipo_42", room="grp.primary"),
        membership("shared_alias", tenant="Equipo_42", room="grp.other", role="operator"),
    ])


class RuntimeFleetMaterializationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-desired-fleet-", dir="/var/tmp")
        self.root = pathlib.Path(self.temporary.name)
        self.state = self.root / "runtime"
        self.input = self.root / "source.json"
        self.input.write_text(json.dumps(dynamic_source()), encoding="utf-8")
        self.overlay = self.root / "overlay.json"
        self.overlay.write_text('{"schemaVersion":1,"placement":{}}', encoding="utf-8")

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_cli(self, state: pathlib.Path | None = None) -> subprocess.CompletedProcess[str]:
        return subprocess.run([
            sys.executable, str(SCRIPT), "--source", str(self.input),
            "--placement", str(self.overlay), "--state-directory", str(state or self.state),
        ], capture_output=True, text=True, check=False,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})

    def receipt(self) -> dict[str, object]:
        return json.loads((self.state / "desired-fleet.json").read_bytes())

    def test_cli_materializes_wire_and_physical_identity_with_verified_file_digests(self) -> None:
        completed = self.run_cli()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        receipt = self.receipt()
        self.assertEqual(receipt["schemaVersion"], 1)
        self.assertRegex(str(receipt["generation"]), r"^[0-9a-f]{64}$")
        generation = self.state / "generations" / str(receipt["generation"])
        files = receipt["files"]
        self.assertIsInstance(files, dict)
        for path, digest in files.items():
            self.assertEqual(hashlib.sha256((generation / path).read_bytes()).hexdigest(), digest)
        snapshot = json.loads((generation / "flota.json").read_bytes())
        self.assertEqual(receipt["snapshotSha256"], files["flota.json"])
        self.assertEqual(snapshot["fleet"]["physical-one"]["alias"], "shared_alias")
        self.assertEqual(len(snapshot["fleet"]["physical-one"]["memberships"]), 2)
        aliases = json.loads((generation / "container-aliases.json").read_bytes())
        self.assertEqual(aliases["aliases"]["physical-one"]["alias"], "shared_alias")
        runtime = json.loads((generation / "generated/fleet.json").read_bytes())
        self.assertEqual(runtime["aliases"]["physical-one"]["alias"], "shared_alias")
        manifest = (generation / "manifests/physical-one.yaml").read_text()
        self.assertIn("  alias: shared_alias\n", manifest)
        self.assertIn("CAUCE_PHYSICAL_ONE_TOKEN_PATH", manifest)

    def test_same_source_keeps_the_descriptor_and_generation_byte_identical(self) -> None:
        self.assertEqual(self.run_cli().returncode, 0)
        original = (self.state / "desired-fleet.json").read_bytes()
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual((self.state / "desired-fleet.json").read_bytes(), original)
        self.assertEqual(len(list((self.state / "generations").iterdir())), 1)

    def test_existing_generation_is_verified_without_rewriting_artifacts(self) -> None:
        module = importlib.import_module("fleet_runtime_materialization")
        module.materialize(dynamic_source(), {}, self.state)
        with mock.patch.object(module, "atomic_write", wraps=module.atomic_write) as write:
            module.materialize(dynamic_source(), {}, self.state)
        self.assertEqual([call.args[0] for call in write.call_args_list], [self.state / "desired-fleet.json"])

    def test_symlinked_new_generation_cannot_corrupt_a_published_generation(self) -> None:
        module = importlib.import_module("fleet_runtime_materialization")
        receipt = module.materialize(dynamic_source(), {}, self.state)
        original = (self.state / "desired-fleet.json").read_bytes()
        previous = self.state / "generations" / receipt["generation"]
        previous_files = {name: (previous / name).read_bytes() for name in receipt["files"]}
        updated = dynamic_source()
        updated["agents"][0]["primary_room_id"] = "grp.other"
        digest = module._receipt(module.render_artifacts(updated, {}))["generation"]
        (self.state / "generations" / digest).symlink_to(previous, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "symlink"):
            module.materialize(updated, {}, self.state)
        self.assertEqual((self.state / "desired-fleet.json").read_bytes(), original)
        self.assertEqual({name: (previous / name).read_bytes() for name in receipt["files"]}, previous_files)
        self.assertEqual(module.load_desired_fleet(self.state), receipt)

    def test_reader_and_writer_reject_symlinks_in_each_artifact_directory(self) -> None:
        module = importlib.import_module("fleet_runtime_materialization")
        receipt = module.materialize(dynamic_source(), {}, self.state)
        generation = self.state / "generations" / receipt["generation"]
        for relative in ("generated/fleet.json", "generated", "."):
            with self.subTest(relative=relative):
                target = generation / relative
                original = target.with_name(target.name + ".original")
                target.rename(original)
                target.symlink_to(original, target_is_directory=original.is_dir())
                try:
                    with self.assertRaisesRegex(ValueError, "symlink"):
                        module.load_desired_fleet(self.state)
                    with self.assertRaisesRegex(ValueError, "symlink"):
                        module.materialize(dynamic_source(), {}, self.state)
                finally:
                    target.unlink()
                    original.rename(target)

    def test_retiring_the_last_runtime_publishes_empty_desired_fleet_and_keeps_prior_generation(self) -> None:
        self.assertEqual(self.run_cli().returncode, 0)
        previous = self.receipt()
        payload = dynamic_source()
        payload["agents"][0]["enabled"] = False
        self.input.write_text(json.dumps(payload), encoding="utf-8")
        self.overlay.write_text(json.dumps({"schemaVersion": 1,
                                           "placement": {"physical-one": {"dockerHost": "server2"}}}))
        completed = self.run_cli()
        self.assertEqual(completed.returncode, 0, completed.stderr)
        receipt = self.receipt()
        generation = self.state / "generations" / str(receipt["generation"])
        snapshot = json.loads((generation / "flota.json").read_bytes())
        self.assertEqual(snapshot["fleet"], {})
        self.assertEqual(snapshot["placement"], {})
        self.assertFalse((generation / "manifests").exists())
        self.assertTrue((self.state / "generations" / str(previous["generation"]) /
                         "manifests/physical-one.yaml").exists())

    def test_invalid_source_keeps_the_previously_published_generation(self) -> None:
        self.assertEqual(self.run_cli().returncode, 0)
        original = (self.state / "desired-fleet.json").read_bytes()
        payload = dynamic_source()
        payload["agents"][0]["primary_room_id"] = "grp.missing"
        self.input.write_text(json.dumps(payload), encoding="utf-8")
        completed = self.run_cli()
        self.assertEqual(completed.returncode, 1)
        self.assertEqual((self.state / "desired-fleet.json").read_bytes(), original)

    def test_runtime_state_cannot_be_written_inside_a_repository_or_through_its_symlink(self) -> None:
        repository = self.root / "repo"
        repository.mkdir()
        (repository / ".git").write_text("gitdir: unused\n")
        link = self.root / "link"
        link.symlink_to(repository, target_is_directory=True)
        for destination in (repository / "runtime", link / "runtime", pathlib.Path("relative")):
            with self.subTest(destination=destination):
                completed = self.run_cli(destination)
                self.assertEqual(completed.returncode, 1)
                self.assertIn("external", completed.stderr)
                self.assertFalse((repository / "runtime").exists())

    def test_partial_write_never_replaces_the_published_descriptor(self) -> None:
        module = importlib.import_module("fleet_runtime_materialization")
        module.materialize(dynamic_source(), {}, self.state)
        original = (self.state / "desired-fleet.json").read_bytes()
        updated = dynamic_source()
        updated["agents"][0]["primary_room_id"] = "grp.other"
        original_write = module.atomic_write

        def fail_manifest(path: pathlib.Path, body: bytes) -> None:
            if path.suffix == ".yaml":
                raise OSError("synthetic write failure")
            original_write(path, body)

        with mock.patch.object(module, "atomic_write", side_effect=fail_manifest), self.assertRaises(OSError):
            module.materialize(updated, {}, self.state)
        self.assertEqual((self.state / "desired-fleet.json").read_bytes(), original)
        self.assertEqual(len(list((self.state / "generations").iterdir())), 1)
        module.load_desired_fleet(self.state)

    def test_reader_rejects_tampered_artifact_instead_of_accepting_the_receipt(self) -> None:
        module = importlib.import_module("fleet_runtime_materialization")
        receipt = module.materialize(dynamic_source(), {}, self.state)
        self.assertEqual(module.load_desired_fleet(self.state), receipt)
        generation = self.state / "generations" / receipt["generation"]
        (generation / "generated/fleet.json").write_bytes(b"tampered\n")
        with self.assertRaisesRegex(ValueError, "digest"):
            module.load_desired_fleet(self.state)

    def test_reader_rejects_a_receipt_that_omits_required_artifacts(self) -> None:
        module = importlib.import_module("fleet_runtime_materialization")
        receipt = module.materialize(dynamic_source(), {}, self.state)
        del receipt["files"]["container-aliases.json"]
        receipt["generation"] = hashlib.sha256(
            (json.dumps(receipt["files"], sort_keys=True, indent=2) + "\n").encode(),
        ).hexdigest()
        (self.state / "desired-fleet.json").write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError, "required"):
            module.load_desired_fleet(self.state)


if __name__ == "__main__":
    unittest.main()
