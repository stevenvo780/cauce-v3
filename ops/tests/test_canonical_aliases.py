#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

OPS = pathlib.Path(__file__).resolve().parents[1]
LOCK = OPS / "scripts/alias-lock-exec.py"
SUPERVISOR = OPS / "scripts/container-adapter-supervisor.sh"
SPEC = importlib.util.spec_from_file_location("canonical_control_base", OPS / "container-runtime/cauce_container_base.py")
BASE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BASE)
VALID = ("operador_principal", "a" * 64, "a", "agent-1")
INVALID = ("../operador", "a/b", "/agent", "a\n", "A", "_a", "a" * 65)


class CanonicalAliasTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-canonical-alias-")
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.environment = dict(os.environ)
        for name in ("CAUCE_INSTALLATION_ID", "CAUCE_ALIAS_LOCK_FD", "CAUCE_ALIAS_LEGACY_LOCK_FD", "CAUCE_ALIAS_LOCK_ALIAS"):
            self.environment.pop(name, None)

    def lock(self, alias):
        return subprocess.run([
            sys.executable, str(LOCK), "run", "--lock-root", str(self.root / "locks"), "--alias", alias,
            "--", sys.executable, str(LOCK), "verify", "--lock-root", str(self.root / "locks"), "--alias", alias,
        ], env=self.environment, capture_output=True, text=True)

    def test_lock_accepts_canonical_alias_and_preserves_default_names(self):
        for alias in VALID:
            with self.subTest(alias=alias):
                result = self.lock(alias)
                self.assertEqual(result.returncode, 0, result.stderr)
                private = self.root / "locks" / f"cauce-v3-alias-locks-{os.getuid()}" / f"{alias}.lock"
                legacy = self.root / "locks" / f"cauce-v3-container-{alias}.lock"
                self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(legacy.stat().st_mode), 0o600)

    def test_lock_rejects_unsafe_alias_before_creating_root(self):
        for alias in INVALID:
            with self.subTest(alias=alias):
                result = self.lock(alias)
                self.assertEqual(result.returncode, 73)
                self.assertIn("invalid alias", result.stderr)
                self.assertFalse((self.root / "locks").exists())

    def supervisor(self, alias, installation_id=None):
        code = self.root / "code"
        scripts = code / "scripts"
        scripts.mkdir(parents=True, exist_ok=True)
        marker = self.root / "inventory-read"
        marker.unlink(missing_ok=True)
        (scripts / "container-alias-query.py").write_text(
            "import pathlib,sys\npathlib.Path(sys.argv[0]).parents[2].joinpath('inventory-read').write_text(sys.argv[1])\nsys.exit(19)\n"
        )
        environment = {**self.environment, "CAUCE_CONTAINER_CODE_ROOT": str(code), "CAUCE_CONTAINER_OPS_ROOT": str(self.root / "data")}
        if installation_id is not None:
            environment["CAUCE_INSTALLATION_ID"] = installation_id
        result = subprocess.run(["bash", str(SUPERVISOR), "check", alias], env=environment, capture_output=True, text=True)
        return result, marker

    def test_supervisor_accepts_alias_before_trusted_inventory_lookup(self):
        for alias in VALID:
            with self.subTest(alias=alias):
                result, marker = self.supervisor(alias)
                self.assertEqual(result.returncode, 19, result.stderr)
                self.assertEqual(marker.read_text(), alias)

    def test_supervisor_rejects_unsafe_alias_before_inventory_lookup(self):
        for alias in INVALID:
            with self.subTest(alias=alias):
                result, marker = self.supervisor(alias)
                self.assertEqual(result.returncode, 2)
                self.assertIn("invalid container adapter alias", result.stderr)
                self.assertFalse(marker.exists())

    def test_supervisor_installation_id_contract_stays_distinct(self):
        result, marker = self.supervisor("operador_principal", "empresa_principal")
        self.assertEqual(result.returncode, 2)
        self.assertFalse(marker.exists())

    def runner(self, alias, **settings):
        environment = {name: value for name, value in self.environment.items() if not name.startswith("CAUCE_")}
        environment.update(HOME=str(self.root), CAUCE_ALIAS=alias, **settings)
        return subprocess.run(["bash", str(OPS / "scripts/alias-runner.sh"), alias], env=environment, capture_output=True, text=True)

    def test_runner_accepts_alias_before_transport_boundary(self):
        for alias in VALID:
            with self.subTest(alias=alias):
                result = self.runner(alias)
                self.assertEqual(result.returncode, 2)
                self.assertIn("origin transport must be telegram", result.stderr)
                self.assertEqual(list(self.root.iterdir()), [])

    def test_runner_rejects_unsafe_alias_before_transport_boundary(self):
        for alias in INVALID:
            with self.subTest(alias=alias):
                result = self.runner(alias)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stderr, "invalid alias\n")
                self.assertEqual(list(self.root.iterdir()), [])

    def test_runner_keeps_installation_id_contract(self):
        result = self.runner("operador_principal", CAUCE_ORIGIN_TRANSPORT="telegram", CAUCE_ENVIRONMENT="production", CAUCE_INSTALLATION_ID="empresa_principal")
        self.assertEqual(result.returncode, 2)
        self.assertIn("invalid installation id", result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])

    def test_runner_central_state_root_cannot_be_overridden(self):
        result = self.runner("operador_principal", CAUCE_ORIGIN_TRANSPORT="telegram", CAUCE_ENVIRONMENT="production", CAUCE_INSTANCE_ID="systemd-operador_principal", CAUCE_STATE_DIR=str(self.root))
        self.assertEqual(result.returncode, 2)
        self.assertIn("alias state directory is unavailable", result.stderr)
        self.assertEqual(list(self.root.iterdir()), [])

    def gate_command(self, script, alias, source_room="empresa.ámbito"):
        output = self.root / "output.json"
        environment = {name: value for name, value in self.environment.items() if not name.startswith("CAUCE_")}
        if script == "gate-collector.mjs":
            command = ["node", str(OPS / "scripts" / script), alias, str(output), "preflight"]
        elif script == "canary.sh":
            command = ["bash", str(OPS / "scripts" / script), alias, str(self.root / "absent-baseline.json")]
        else:
            inventory = self.root / "inventory.json"
            inventory.write_text(json.dumps({"fleet": {alias: {"tenant": "EmpresaNueva"}}}))
            environment["CAUCE_GATE_INVENTORY_FILE"] = str(inventory)
            if source_room is not None:
                environment["CAUCE_GATE_SOURCE_ROOM"] = source_room
            command = ["node", str(OPS / "scripts" / script), alias, str(output)]
        result = subprocess.run(command, env=environment, capture_output=True, text=True)
        self.assertFalse(output.exists())
        return result

    def test_gate_entries_accept_alias_before_operational_boundaries(self):
        boundaries = {
            "gate-collector.mjs": "CAUCE_DATABASE_URL is required",
            "gate-roundtrip-probe.mjs": "probe CA path must be absolute",
            "canary.sh": "canary baseline must be a readable regular non-symlink file",
        }
        for alias in VALID:
            for script, boundary in boundaries.items():
                with self.subTest(alias=alias, script=script):
                    result = self.gate_command(script, alias)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(boundary, result.stderr)

    def test_probe_requires_safe_explicit_source_room_before_tls(self):
        for room in (None, "", "a\n", "a\t", "a\u0085", "a" * 129):
            with self.subTest(room=room):
                result = self.gate_command("gate-roundtrip-probe.mjs", "operador_principal", source_room=room)
                self.assertEqual(result.returncode, 2)
                self.assertIn("CAUCE_GATE_SOURCE_ROOM is required", result.stderr)
                self.assertNotIn("probe CA", result.stderr)

    def test_probe_accepts_unicode_source_room_at_protocol_boundary(self):
        for room in ("empresa.ámbito", " sala externa ", "á" * 128):
            with self.subTest(room=room):
                result = self.gate_command("gate-roundtrip-probe.mjs", "operador_principal", source_room=room)
                self.assertEqual(result.returncode, 2)
                self.assertIn("probe CA path must be absolute", result.stderr)

    def test_gate_entries_reject_unsafe_alias_before_operational_boundaries(self):
        for alias in INVALID:
            for script in ("gate-collector.mjs", "gate-roundtrip-probe.mjs", "canary.sh"):
                with self.subTest(alias=alias, script=script):
                    result = self.gate_command(script, alias)
                    self.assertEqual(result.returncode, 2)
                    self.assertIn("invalid alias", result.stderr)

    def migration(self, alias):
        snapshot = self.root / "snapshot.json"
        document = {
            "schemaVersion": 2, "tenant": "EmpresaNueva", "alias": alias,
            "capturedAt": datetime.now(timezone.utc).isoformat(),
            "v2": {"consumers": 0, "pollers": 0, "leaseOwners": 0},
            "v3": {"consumers": 0, "pollers": 0, "leaseOwners": 0},
            "drain": {"inflight": 0, "overdueInflight": 0, "ownershipMismatch": 0},
            "acks": {"rejectedRecent": 0, "staleAccepted": 0},
            "queues": {"wakePending": 0, "outboxPending": 0, "relayPending": 0, "dlqOpen": 0, "dlqNewSinceBaseline": 0},
            "roundTrip": {"status": "not-run", "completedAt": None, "terminalAckApplied": False, "activeLeaseMatch": False},
        }
        encoded = json.dumps(document)
        snapshot.write_text(encoded)
        environment = {name: value for name, value in self.environment.items() if not name.startswith("CAUCE_")}
        result = subprocess.run(["node", str(OPS / "scripts/migration-gate.mjs"), "preflight", str(snapshot), alias], env=environment, capture_output=True, text=True)
        self.assertEqual(snapshot.read_text(), encoded)
        return result

    def test_migration_gate_accepts_canonical_alias_with_complete_snapshot(self):
        for alias in VALID:
            with self.subTest(alias=alias):
                result = self.migration(alias)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertIn(f"gate preflight passed for {alias}", result.stdout)

    def test_migration_gate_rejects_unsafe_alias_without_mutating_snapshot(self):
        for alias in INVALID:
            with self.subTest(alias=alias):
                result = self.migration(alias)
                self.assertEqual(result.returncode, 1)
                self.assertIn("snapshot alias mismatch", result.stderr)

    def test_control_accepts_canonical_alias_and_keeps_root_boundary(self):
        details = SimpleNamespace(st_mode=stat.S_IFDIR | 0o700, st_uid=0, st_gid=0)
        for alias in VALID:
            with self.subTest(alias=alias), patch.object(BASE.os, "geteuid", return_value=0), \
                    patch.object(BASE, "open_directory", return_value=73) as opened, \
                    patch.object(BASE.os, "fstat", return_value=details), \
                    patch.object(BASE.os, "fchown") as owner, patch.object(BASE.os, "fchmod") as mode, \
                    patch.object(BASE.os, "fsync"), patch.object(BASE.os, "close"):
                BASE.prepare_control("/run/cauce-v3-supervisor", alias)
                opened.assert_called_once_with(f"/run/cauce-v3-supervisor/{alias}", create_below="/run", uid=0, gid=0)
                owner.assert_called_once_with(73, 0, 0)
                mode.assert_called_once_with(73, 0o700)

    def test_control_rejects_unsafe_alias_before_directory_open(self):
        for alias in INVALID:
            with self.subTest(alias=alias), patch.object(BASE.os, "geteuid", return_value=0), \
                    patch.object(BASE, "open_directory") as opened:
                with self.assertRaisesRegex(BASE.PermanentError, "alias is invalid"):
                    BASE.prepare_control("/run/cauce-v3-supervisor", alias)
                opened.assert_not_called()

    def test_control_still_requires_root(self):
        with patch.object(BASE.os, "geteuid", return_value=1000), patch.object(BASE, "open_directory") as opened:
            with self.assertRaisesRegex(BASE.PermanentError, "requires root"):
                BASE.prepare_control("/run/cauce-v3-supervisor", "operador_principal")
            opened.assert_not_called()


if __name__ == "__main__":
    unittest.main()
