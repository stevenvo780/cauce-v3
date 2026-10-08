from __future__ import annotations

import pathlib
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "container-runtime"))
import cauce_container_proc as PROC
from cauce_container_base import bundle_digest

HELPER = pathlib.Path(__file__).resolve().parents[1] / "container-runtime/cauce-container-runtime.py"


def metadata() -> dict:
    return {"schemaVersion": 2, "phase": "starting", "alias": "physical-one", "stateDirectory": "/fixture/state",
            "controlDirectory": "/fixture/control", "runtimeUid": 1000, "runtimeGid": 1000,
            "pid": None, "pgid": None, "sid": None, "starttime": None,
            "controllerPid": 12, "controllerStarttime": 34, "containerId": "a" * 64,
            "containerGeneration": "b" * 64, "bundleDigest": "sha256:" + "c" * 64,
            "executable": {"path": "/fixture/adapter", "sha256": "sha256:" + "d" * 64,
                           "device": 1, "inode": 2, "procPath": None, "procDevice": None,
                           "procInode": None, "cmdlineSha256": None}}


class ContainerRuntimeIdentityTests(unittest.TestCase):
    @unittest.skipIf(os.geteuid() == 0, "real process fixture requires an unprivileged controller")
    def test_wire_runtime_starts_and_stops_with_physical_metadata_ownership(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cauce-wire-lifecycle-", dir="/var/tmp") as temporary:
            root = pathlib.Path(temporary)
            state, control, bundle = root / "state", root / "control", root / "bundle"
            for directory in (state, control, bundle):
                directory.mkdir(mode=0o700)
            (bundle / "fixture").write_text("fixture\n")
            common = ["--alias", "physical-one", "--state", str(state), "--control-dir", str(control),
                      "--container-id", "a" * 64, "--generation", "b" * 64,
                      "--term-seconds", "0.2", "--kill-seconds", "1"]
            environment = {**os.environ, "CAUCE_ALIAS": "shared_alias", "CAUCE_RUNTIME_KEY": "physical-one",
                           "CAUCE_TENANT_ID": "Equipo_42", "CAUCE_STATE_DIR": str(state),
                           "CAUCE_CONTROL_DIR": str(control), "CAUCE_CONTAINER_ID": "a" * 64,
                           "CAUCE_CONTAINER_GENERATION": "b" * 64}
            command = [sys.executable, str(HELPER), "run", *common, "--wire-alias", "shared_alias",
                       "--tenant", "Equipo_42", "--runtime-uid", str(os.getuid()), "--runtime-gid", str(os.getgid()),
                       "--bundle", str(bundle), "--bundle-digest", bundle_digest(str(bundle)),
                       str(pathlib.Path(sys.executable).resolve()), "-c", "import time; time.sleep(60)"]
            controller = subprocess.Popen(command, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 10
                document = None
                while time.monotonic() < deadline and controller.poll() is None:
                    receipt = control / "cauce-v3-adapter.json"
                    if receipt.exists():
                        observed = json.loads(receipt.read_bytes())
                        if observed["phase"] == "running":
                            document = observed
                            break
                    time.sleep(0.02)
                diagnostic = controller.communicate(timeout=1)[1].decode() if controller.poll() is not None else "still running"
                self.assertIsNotNone(document, f"wire runtime never published running metadata: {diagnostic}")
                self.assertEqual((document["alias"], document["wireAlias"], document["tenantId"]),
                                 ("physical-one", "shared_alias", "Equipo_42"))
                stopped = subprocess.run([sys.executable, str(HELPER), "stop", *common], capture_output=True,
                                         text=True, timeout=15, check=False)
                self.assertEqual(stopped.returncode, 0, stopped.stderr)
                controller.wait(timeout=10)
                self.assertFalse((control / "cauce-v3-adapter.json").exists())
            finally:
                if controller.poll() is None:
                    controller.terminate()
                controller.communicate(timeout=10)

    def test_legacy_metadata_and_environment_remain_valid(self) -> None:
        document = metadata()
        self.assertEqual(PROC.validate_metadata(document), document)
        self.assertEqual(PROC.expected_environment(document)["CAUCE_ALIAS"], "physical-one")
        self.assertNotIn("CAUCE_RUNTIME_KEY", PROC.expected_environment(document))

    def test_wire_identity_pair_keeps_physical_lifecycle_ownership(self) -> None:
        document = dict(metadata(), wireAlias="shared_alias", tenantId="Equipo_42")
        self.assertEqual(PROC.validate_metadata(document), document)
        environment = PROC.expected_environment(document)
        self.assertEqual(environment["CAUCE_ALIAS"], "shared_alias")
        self.assertEqual(environment["CAUCE_RUNTIME_KEY"], "physical-one")
        self.assertEqual(environment["CAUCE_TENANT_ID"], "Equipo_42")

    def test_wire_identity_is_an_exact_validated_pair(self) -> None:
        for extra in ({"wireAlias": "shared_alias"}, {"tenantId": "Equipo_42"},
                      {"wireAlias": "bad.alias", "tenantId": "Equipo_42"},
                      {"wireAlias": "shared_alias", "tenantId": "bad tenant"},
                      {"wireAlias": "shared_alias", "tenantId": "Equipo_42", "extra": True}):
            with self.subTest(extra=extra), self.assertRaises(PROC.PermanentError):
                PROC.validate_metadata(dict(metadata(), **extra))

    def test_ambiguous_process_scan_uses_physical_key_before_wire_alias(self) -> None:
        documents = {
            21: {"CAUCE_ALIAS": "shared_alias", "CAUCE_RUNTIME_KEY": "physical-one"},
            22: {"CAUCE_ALIAS": "physical-one", "CAUCE_RUNTIME_KEY": "physical-two"},
            23: {"CAUCE_ALIAS": "physical-one"},
        }
        for environment in documents.values():
            environment.update(CAUCE_CONTAINER_GENERATION="b" * 64, CAUCE_STATE_DIR="/fixture/state")
        with mock.patch.object(PROC.os, "listdir", return_value=list(map(str, documents))), \
                mock.patch.object(PROC, "selected_environment", side_effect=documents.__getitem__):
            self.assertEqual(PROC.alias_generation_pids("physical-one", "b" * 64, "/fixture/state"), [21, 23])


if __name__ == "__main__":
    unittest.main()
