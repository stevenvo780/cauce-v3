from __future__ import annotations

import datetime as dt
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "scripts/cutover.sh"


class CutoverAliasBoundaryTest(unittest.TestCase):
    def invoke(self, alias, installation=None):
        with tempfile.TemporaryDirectory(prefix="cauce-cutover-alias-") as directory:
            env = {**os.environ, "HOME": directory, "CAUCE_CHANGE_ID": "synthetic"}
            env.pop("CAUCE_CUTOVER_CONFIRM", None)
            env.pop("CAUCE_INSTALLATION_ID", None)
            if installation is not None:
                env["CAUCE_INSTALLATION_ID"] = installation
            result = subprocess.run(
                ["bash", str(SCRIPT), "container", alias, str(pathlib.Path(directory) / "missing.json")],
                env=env, text=True, capture_output=True, check=False,
            )
            self.assertEqual(list(pathlib.Path(directory).iterdir()), [])
            return result

    def test_canonical_alias_reaches_confirmation_before_effects(self):
        for alias in ("operador_principal", "a" + "_" * 63):
            with self.subTest(alias=alias):
                result = self.invoke(alias)
                self.assertEqual(result.returncode, 2)
                self.assertIn("cutover refused", result.stderr)
                self.assertNotIn("invalid alias", result.stderr)

    def test_invalid_alias_rejected_before_effects(self):
        for alias in ("../operador", "a" * 65, "operador\n", "Operador"):
            with self.subTest(alias=alias):
                result = self.invoke(alias)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid alias", result.stderr)


    def test_invalid_installation_rejected_before_locks(self):
        for installation in ("", "empresa_uno", "../empresa", "a" * 49, "empresa\n"):
            with self.subTest(installation=installation):
                result = self.invoke("operador_principal", installation)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid installation identifier", result.stderr)

    def test_units_and_locks_are_scoped_per_installation(self):
        with tempfile.TemporaryDirectory(prefix="cauce-cutover-namespace-") as directory:
            root = pathlib.Path(directory)
            binaries = root / "bin"
            binaries.mkdir()
            locks = root / "locks"
            locks.mkdir()
            log = root / "systemctl.log"
            systemctl = binaries / "systemctl"
            systemctl.write_text(
                '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CUTOVER_TEST_LOG"\n'
                'case "$*" in *is-enabled*) exit 0;; *) exit 1;; esac\n'
            )
            systemctl.chmod(0o700)
            collector = binaries / "collector"
            collector.write_text("#!/bin/sh\nexit 99\n")
            collector.chmod(0o700)
            alias = "operador_principal"
            snapshot = {
                "schemaVersion": 2, "tenant": "Empresa", "alias": alias,
                "capturedAt": dt.datetime.now(dt.UTC).isoformat(),
                "v2": dict.fromkeys(("consumers", "pollers", "leaseOwners"), 0),
                "v3": dict.fromkeys(("consumers", "pollers", "leaseOwners"), 0),
                "drain": dict.fromkeys(("inflight", "overdueInflight", "ownershipMismatch"), 0),
                "acks": dict.fromkeys(("rejectedRecent", "staleAccepted"), 0),
                "queues": dict.fromkeys(("wakePending", "outboxPending", "relayPending", "dlqOpen", "dlqNewSinceBaseline"), 0),
                "roundTrip": {"status": "not-run", "completedAt": None, "terminalAckApplied": False, "activeLeaseMatch": False},
            }
            drain = root / "drain.json"
            drain.write_text(json.dumps(snapshot))
            for installation in (None, "empresa-a", "empresa-b"):
                env = {**os.environ, "HOME": directory, "PATH": str(binaries) + os.pathsep + os.environ["PATH"],
                       "CAUCE_CHANGE_ID": "synthetic", "CAUCE_CUTOVER_CONFIRM": "cutover:container:" + alias + ":synthetic",
                       "CAUCE_GATE_CAPTURE_PATH": str(collector), "CAUCE_GATE_PROBE_PATH": str(collector),
                       "CAUCE_CUTOVER_LOCK_DIR": str(locks), "CAUCE_SYSTEMD_SCOPE": "user", "CUTOVER_TEST_LOG": str(log)}
                env.pop("CAUCE_INSTALLATION_ID", None)
                if installation is not None:
                    env["CAUCE_INSTALLATION_ID"] = installation
                result = subprocess.run(
                    ["bash", str(SCRIPT), "container", alias, str(drain)],
                    env=env, text=True, capture_output=True, check=False,
                )
                self.assertEqual(result.returncode, 73, result.stderr)
                self.assertIn("runtime family is already enabled", result.stderr)
                prefix = "cauce-" + installation if installation else "cauce-v3"
                self.assertTrue((locks / (prefix + "-cutover-" + alias + ".lock")).is_file())
                calls = log.read_text()
                self.assertIn(prefix + "-alias-" + alias + ".service", calls)
                self.assertIn(prefix + "-container-" + alias + ".service", calls)
                self.assertNotIn(" start ", calls)
            self.assertEqual(len(list(locks.iterdir())), 3)


if __name__ == "__main__":
    unittest.main()
