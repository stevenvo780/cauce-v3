from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "export-fleet-snapshot.py"
QUERY = SCRIPT.with_name("fleet-query.sql")
GENERATOR = SCRIPT.with_name("generate-container-aliases.py")
sys.path.insert(0, os.fspath(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("export_fleet_snapshot", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def agent(
    alias: str,
    *,
    tenant: str = "Steven",
    enabled: bool = True,
    harness: str | None = "codex",
) -> dict[str, object]:
    runtime = {
        "container_name": "ctrl-infra",
        "runtime_user": "dev",
        "home_directory": "/home/dev",
        "state_directory": f"/home/dev/.local/state/cauce-v3/{alias}",
    }
    return {
        "tenant_id": tenant,
        "alias": alias,
        "harness_id": harness,
        "enabled": enabled,
        **runtime,
    }


def membership(
    alias: str,
    *,
    tenant: str = "Steven",
    room: str = "grp.steven",
    role: str = "agent",
    enabled: bool = True,
) -> dict[str, object]:
    return {
        "tenant_id": tenant,
        "alias": alias,
        "room_id": room,
        "role": role,
        "enabled": enabled,
    }


def source(
    *,
    agents: list[dict[str, object]] | None = None,
    memberships: list[dict[str, object]] | None = None,
    roles: tuple[str, ...] = ("agent", "operator"),
) -> dict[str, object]:
    return {
        "agents": agents if agents is not None else [agent("kant")],
        "memberships": memberships if memberships is not None else [membership("kant")],
        "rolePolicies": [{"role": role} for role in roles],
    }


class FleetSnapshotDocumentTest(unittest.TestCase):
    def test_prunes_only_proven_purged_runtime_overlays_without_exporting_tombstones(self) -> None:
        payload = {**source(agents=[], memberships=[]), "purgedRuntimeKeys": ["purged-runtime"]}
        overlay = {"purged-runtime": {"dockerHost": "server2"}}
        document = MODULE.snapshot_document(payload, overlay)
        self.assertEqual(document, MODULE.snapshot_document(source(agents=[], memberships=[])))
        self.assertEqual(overlay, {"purged-runtime": {"dockerHost": "server2"}})
        with self.assertRaisesRegex(MODULE.SnapshotError, "non-fleet"):
            MODULE.snapshot_document(payload, {**overlay, "never-seen": {"dockerHost": "server2"}})

    def test_durable_placement_overrides_overlay_fields_and_preserves_native_manager(self) -> None:
        row = {**agent("kant"), "host_id": "new-host", "runtime_mode": "container", "systemd_user": "server"}
        document = MODULE.snapshot_document(source(agents=[row]),
            {"kant": {"dockerHost": "old-host", "systemdUser": "ubuntu", "registryContainer": "proxy"}})
        self.assertEqual(document["placement"]["kant"],
                         {"dockerHost": "new-host", "systemdUser": "server", "registryContainer": "proxy"})
        self.assertEqual(document["fleet"]["kant"]["hostId"], "new-host")
        self.assertEqual(document["fleet"]["kant"]["runtimeMode"], "container")
        row.update(host_id="fedora", runtime_mode="native", container_name="host:fedora", systemd_user="stev",
                   state_directory="/var/lib/cauce-v3/aliases/kant")
        document = MODULE.snapshot_document(source(agents=[row]))
        self.assertEqual(document["placement"], {"kant": {"dockerHost": "fedora"}})
        self.assertEqual(document["fleet"]["kant"]["systemdUser"], "stev")

    def test_runtime_keys_separate_repeated_wire_aliases_across_tenants(self) -> None:
        first = {**agent("kant"), "runtime_key": "kant", "primary_room_id": "grp.steven"}
        second = {**agent("kant", tenant="Pablo"), "runtime_key": "pablo-kant",
                  "primary_room_id": "grp.pablo"}
        second["state_directory"] = "/home/dev/.local/state/cauce-v3/pablo-kant"
        document = MODULE.snapshot_document(source(
            agents=[second, first],
            memberships=[membership("kant"), membership("kant", tenant="Pablo", room="grp.pablo")],
        ), {"pablo-kant": {"dockerHost": "server2"}})
        self.assertEqual(set(document["fleet"]), {"kant", "pablo-kant"})
        self.assertNotIn("alias", document["fleet"]["kant"])
        self.assertEqual(document["fleet"]["pablo-kant"]["alias"], "kant")
        self.assertEqual(document["placement"], {"pablo-kant": {"dockerHost": "server2"}})

    def test_fails_loud_on_every_unrepresentable_database_row(self) -> None:
        cases = {
            "missing membership": source(agents=[agent("kant")], memberships=[]),
            "multiple memberships": source(
                memberships=[
                    membership("kant"),
                    membership("kant", room="grp.other"),
                ]
            ),
            "unknown role": source(memberships=[membership("kant", role="missing")]),
            "duplicate policy": source(roles=("agent", "agent")),
        }
        for label, payload in cases.items():
            with self.subTest(label=label), self.assertRaises(MODULE.SnapshotError):
                MODULE.snapshot_document(
                    payload,
                    allowed_tenants=frozenset({"Steven", "Miguel"}),
                )

    def test_snapshot_has_no_secret_or_machine_metadata_keys(self) -> None:
        document = MODULE.snapshot_document(
            source(),
            allowed_tenants=frozenset({"Steven"}),
        )
        keys: list[str] = []

        def collect(value: object) -> None:
            if isinstance(value, dict):
                keys.extend(str(key) for key in value)
                for nested in value.values():
                    collect(nested)
            elif isinstance(value, list):
                for nested in value:
                    collect(nested)

        collect(document)
        prohibited = re.compile(r"token|secret|password|generatedAt|hostname", re.IGNORECASE)
        self.assertFalse([key for key in keys if prohibited.search(key)])


class PhysicalFleetOverlayTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-fleet-overlay-")
        self.root = pathlib.Path(self.temporary.name)
        self.path = self.root / "flota-fisica.json"

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def write(self, document: object) -> None:
        self.path.write_text(json.dumps(document), encoding="utf-8")

class FleetQueryTest(unittest.TestCase):
    def test_sql_is_one_read_only_query_over_all_three_tables(self) -> None:
        query = QUERY.read_text(encoding="utf-8")
        self.assertEqual(query.count(";"), 1)
        self.assertRegex(query.lstrip(), r"^SELECT\b")
        for table in ("agents", "memberships", "role_policies"):
            self.assertRegex(query, rf"\bFROM\s+{table}\b")
        self.assertNotRegex(query, r"\b(?:WHERE|AND)\s+(?:agent\.|membership\.)?enabled\b")
        self.assertNotRegex(query, r"\b(?:INSERT|UPDATE|DELETE|MERGE|COPY|CALL)\b")

class FleetSnapshotCliTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="cauce-fleet-export-")
        self.root = pathlib.Path(self.temporary.name)
        self.output = self.root / "flota.json"
        self.overlay = self.root / "absent-overlay.json"
        self.arguments = [
            "--database-url-file",
            "/private/database-url",
            "--placement",
            str(self.overlay),
            "--out",
            str(self.output),
        ]

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def run_main(self, extra: list[str] | None = None) -> tuple[int, str]:
        stderr = io.StringIO()
        with mock.patch.object(MODULE, "query_database", return_value=source()), contextlib.redirect_stderr(stderr):
            result = MODULE.main([*self.arguments, *(extra or [])])
        return result, stderr.getvalue()

    def test_writes_canonical_snapshot_atomically_with_public_mode(self) -> None:
        with mock.patch.object(MODULE.os, "fsync", wraps=os.fsync) as fsync:
            result, stderr = self.run_main()
        self.assertEqual((result, stderr), (0, ""))
        document = MODULE.snapshot_document(source())
        self.assertEqual(self.output.read_bytes(), MODULE.canonical_bytes(document))
        self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o644)
        self.assertEqual(fsync.call_count, 2)

    def test_check_returns_three_on_missing_or_different_bytes_without_writing(self) -> None:
        result, stderr = self.run_main(["--check"])
        self.assertEqual(result, 3)
        self.assertIn("differs", stderr)
        self.assertFalse(self.output.exists())

        self.assertEqual(self.run_main()[0], 0)
        original = self.output.read_bytes()
        self.assertEqual(self.run_main(["--check"]), (0, ""))
        self.output.write_bytes(original + b"\n")
        result, _ = self.run_main(["--check"])
        self.assertEqual(result, 3)
        self.assertEqual(self.output.read_bytes(), original + b"\n")


if __name__ == "__main__":
    unittest.main()
