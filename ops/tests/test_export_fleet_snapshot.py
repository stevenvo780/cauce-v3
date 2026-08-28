from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).parents[1] / "scripts" / "export-fleet-snapshot.py"
QUERY = SCRIPT.with_name("fleet-query.sql")
GENERATOR = SCRIPT.with_name("generate-container-aliases.py")
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
        "state_directory": f"/var/lib/cauce-v3/aliases/{alias}",
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
    def test_maps_enabled_retired_and_system_rows_without_membership_filtering(self) -> None:
        payload = source(
            agents=[agent("kant"), agent("dedalo", enabled=False, harness=None)],
            memberships=[
                membership("kant", role="operator", enabled=False),
                membership("dedalo", enabled=True),
                membership("quota-collector", role="operador-ñ", enabled=False),
            ],
            roles=("agent", "operator", "operador-ñ"),
        )
        document = MODULE.snapshot_document(
            payload,
            {"kant": {"registryContainer": "host:kratos"}},
            frozenset({"Steven"}),
        )

        self.assertEqual(document["schemaVersion"], 1)
        self.assertEqual(document["retired"], {"dedalo": {}})
        self.assertEqual(
            document["systemPrincipals"],
            {
                "quota-collector": {
                    "tenant": "Steven",
                    "room": "grp.steven",
                    "role": "operador-ñ",
                },
            },
        )
        self.assertEqual(
            document["placement"],
            {
                "kant": {"registryContainer": "host:kratos"},
            },
        )
        self.assertEqual(
            document["fleet"]["kant"],
            {
                "tenant": "Steven",
                "room": "grp.steven",
                "role": "operator",
                "harness": "codex",
                "enabled": True,
                "container": "ctrl-infra",
                "user": "dev",
                "home": "/home/dev",
                "runtimeStateDirectory": "/var/lib/cauce-v3/aliases/kant",
            },
        )

    def test_canonical_bytes_are_sorted_utf8_and_newline_terminated(self) -> None:
        document = MODULE.snapshot_document(
            source(
                memberships=[membership("kant", role="operador-ñ")],
                roles=("operador-ñ",),
            ),
            allowed_tenants=frozenset({"Steven"}),
        )
        body = MODULE.canonical_bytes(document)
        self.assertTrue(body.endswith(b"\n"))
        self.assertIn("operador-ñ".encode(), body)
        self.assertNotIn(b"\\u00f1", body)
        self.assertEqual(
            body,
            (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode(),
        )
        self.assertLess(body.index(b'"fleet"'), body.index(b'"schemaVersion"'))

    def test_rejects_tenant_outside_real_schema_enum(self) -> None:
        self.assertEqual(MODULE.tenant_enum(), frozenset({"Steven", "Miguel", "Isa", "Jhon"}))
        with self.assertRaisesRegex(MODULE.SnapshotError, "tenant enum"):
            MODULE.snapshot_document(
                source(
                    agents=[agent("dedalo", tenant="Pablo", enabled=False)],
                    memberships=[membership("dedalo", tenant="Pablo", room="grp.pablo")],
                )
            )

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
            "cross-tenant alias": source(
                agents=[agent("kant")],
                memberships=[
                    membership("kant"),
                    membership("kant", tenant="Miguel", room="grp.miguel"),
                ],
            ),
        }
        for label, payload in cases.items():
            with self.subTest(label=label), self.assertRaises(MODULE.SnapshotError):
                MODULE.snapshot_document(
                    payload,
                    allowed_tenants=frozenset({"Steven", "Miguel"}),
                )

    def test_rejects_incomplete_enabled_agent_but_allows_retired_runtime_nulls(self) -> None:
        enabled = agent("kant")
        enabled["home_directory"] = None
        with self.assertRaisesRegex(MODULE.SnapshotError, "incomplete"):
            MODULE.snapshot_document(
                source(agents=[enabled]),
                allowed_tenants=frozenset({"Steven"}),
            )

        retired = agent("dedalo", enabled=False, harness=None)
        for key in ("container_name", "runtime_user", "home_directory", "state_directory"):
            retired[key] = None
        document = MODULE.snapshot_document(
            source(agents=[retired], memberships=[membership("dedalo")]),
            allowed_tenants=frozenset({"Steven"}),
        )
        self.assertEqual(document["retired"], {"dedalo": {}})

    def test_retired_agent_does_not_require_a_membership(self) -> None:
        document = MODULE.snapshot_document(
            source(
                agents=[agent("kant"), agent("dedalo", enabled=False)],
                memberships=[membership("kant")],
            ),
            allowed_tenants=frozenset({"Steven"}),
        )
        self.assertEqual(document["retired"], {"dedalo": {}})
        self.assertNotIn("dedalo", document["systemPrincipals"])

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

    def test_loads_exact_overlay_shape_and_all_three_keys(self) -> None:
        expected = {
            "kant": {
                "dockerHost": "kratos",
                "registryContainer": "host:kratos",
                "healthContainer": "ctrl-infra",
            },
        }
        self.write({"schemaVersion": 1, "placement": expected})
        self.assertEqual(MODULE.load_placement(self.path), expected)

    def test_missing_overlay_means_no_physical_exceptions(self) -> None:
        self.assertEqual(MODULE.load_placement(self.path), {})

    def test_rejects_unknown_key_and_docker_host(self) -> None:
        for entry in ({"volume": "x"}, {"dockerHost": "remote"}):
            with self.subTest(entry=entry):
                self.write({"schemaVersion": 1, "placement": {"kant": entry}})
                with self.assertRaises(MODULE.SnapshotError):
                    MODULE.load_placement(self.path)

    def test_rejects_boolean_schema_version(self) -> None:
        self.write({"schemaVersion": True, "placement": {}})
        with self.assertRaises(MODULE.SnapshotError):
            MODULE.load_placement(self.path)

    def test_rejects_overlay_alias_outside_enabled_fleet(self) -> None:
        with self.assertRaisesRegex(MODULE.SnapshotError, "non-fleet"):
            MODULE.snapshot_document(
                source(),
                {"unknown": {"dockerHost": "local"}},
                frozenset({"Steven"}),
            )

    def test_snapshot_revalidates_programmatic_overlay(self) -> None:
        with self.assertRaisesRegex(MODULE.SnapshotError, "dockerHost"):
            MODULE.snapshot_document(
                source(),
                {"kant": {"dockerHost": "remote"}},
                frozenset({"Steven"}),
            )

    def test_rejects_defaults_that_make_the_overlay_redundant(self) -> None:
        cases = {
            "docker host": ({"dockerHost": "local"}, "dockerHost repeats"),
            "health container": ({"healthContainer": "ctrl-infra"}, "healthContainer repeats"),
            "implicit registry container": (
                {"registryContainer": "ctrl-infra"},
                "registryContainer repeats",
            ),
            "explicit registry container": (
                {
                    "healthContainer": "ctrl-health",
                    "registryContainer": "ctrl-health",
                },
                "registryContainer repeats",
            ),
        }
        for label, (entry, error) in cases.items():
            with self.subTest(label=label), self.assertRaisesRegex(MODULE.SnapshotError, error):
                MODULE.snapshot_document(
                    source(),
                    {"kant": entry},
                    frozenset({"Steven"}),
                )

    def test_generator_rejects_redundant_defaults_before_writing(self) -> None:
        document = MODULE.snapshot_document(
            source(),
            allowed_tenants=frozenset({"Steven"}),
        )
        snapshot = self.root / "flota.json"
        output = self.root / "container-aliases.json"
        original = b"unchanged\n"
        cases = (
            {"dockerHost": "local"},
            {"healthContainer": "ctrl-infra"},
            {"registryContainer": "ctrl-infra"},
            {
                "healthContainer": "ctrl-health",
                "registryContainer": "ctrl-health",
            },
        )
        for entry in cases:
            with self.subTest(entry=entry):
                document["placement"] = {"kant": entry}
                snapshot.write_bytes(MODULE.canonical_bytes(document))
                output.write_bytes(original)
                completed = subprocess.run(
                    [
                        sys.executable,
                        os.fspath(GENERATOR),
                        "--snapshot",
                        os.fspath(snapshot),
                        "--output",
                        os.fspath(output),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(completed.returncode, 1)
                self.assertIn("repeats its default", completed.stderr)
                self.assertEqual(output.read_bytes(), original)


class FleetQueryTest(unittest.TestCase):
    def test_sql_is_one_read_only_query_over_all_three_tables(self) -> None:
        query = QUERY.read_text(encoding="utf-8")
        self.assertEqual(query.count(";"), 1)
        self.assertRegex(query.lstrip(), r"^SELECT\b")
        for table in ("agents", "memberships", "role_policies"):
            self.assertRegex(query, rf"\bFROM\s+{table}\b")
        self.assertNotRegex(query, r"\bWHERE\b")
        self.assertNotRegex(query, r"\b(?:INSERT|UPDATE|DELETE|MERGE|COPY|CALL)\b")

    def test_database_url_query_uses_versioned_sql_and_read_only_session(self) -> None:
        completed = subprocess.CompletedProcess([], 0, json.dumps(source()), "")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as called:
            payload = MODULE.query_database(database_url_file=pathlib.Path("/private/database-url"))
        self.assertEqual(payload, source())
        command = called.call_args.args[0]
        self.assertIn("PGOPTIONS=-c default_transaction_read_only=on", command)
        self.assertIn("--no-password", command)
        self.assertEqual(called.call_args.kwargs["input"], QUERY.read_text(encoding="utf-8"))
        self.assertNotIn("timeout", called.call_args.kwargs)

    def test_container_query_uses_database_identity_from_the_container(self) -> None:
        completed = subprocess.CompletedProcess([], 0, json.dumps(source()), "")
        with mock.patch.object(MODULE.subprocess, "run", return_value=completed) as called:
            MODULE.query_database(postgres_container="cauce-v3-prod-postgres-1")
        command = called.call_args.args[0]
        self.assertEqual(command[:3], ["docker", "exec", "-i"])
        self.assertIn("PGOPTIONS=-c default_transaction_read_only=on", command)
        shell = command[command.index("-c") + 1]
        self.assertIn('"$POSTGRES_USER"', shell)
        self.assertIn('"$POSTGRES_DB"', shell)

    def test_query_failure_and_non_json_are_fail_loud(self) -> None:
        failures = (
            subprocess.CompletedProcess([], 1, "", "synthetic database failure"),
            subprocess.CompletedProcess([], 0, "not-json\n", ""),
        )
        for completed in failures:
            with (
                self.subTest(completed=completed),
                mock.patch.object(MODULE.subprocess, "run", return_value=completed),
                self.assertRaises(MODULE.SnapshotError),
            ):
                MODULE.query_database(database_url_file=pathlib.Path("/private/database-url"))


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

    def test_rejects_redundant_overlay_before_writing(self) -> None:
        self.output.write_bytes(b"unchanged\n")
        self.overlay.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "placement": {"kant": {"dockerHost": "local"}},
                }
            ),
            encoding="utf-8",
        )
        result, stderr = self.run_main()
        self.assertEqual(result, 1)
        self.assertIn("dockerHost repeats its default", stderr)
        self.assertEqual(self.output.read_bytes(), b"unchanged\n")

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
