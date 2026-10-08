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

    def test_empty_purged_metadata_preserves_legacy_snapshot_bytes(self) -> None:
        self.assertEqual(MODULE.canonical_bytes(MODULE.snapshot_document(source())),
                         MODULE.canonical_bytes(MODULE.snapshot_document({**source(), "purgedRuntimeKeys": []})))

    def test_rejects_unbounded_malformed_duplicate_or_current_purged_runtime_keys(self) -> None:
        invalid = (None, False, {}, "purged-runtime", [None], [False], ["bad/key"], ["bad_key"],
                   ["Bad"], ["a" * 65], ["gone", "gone"], ["kant"], [f"gone-{index}" for index in range(1001)])
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(MODULE.SnapshotError):
                MODULE.snapshot_document({**source(), "purgedRuntimeKeys": value})
        retired = source(agents=[agent("kant", enabled=False)], memberships=[])
        with self.assertRaises(MODULE.SnapshotError):
            MODULE.snapshot_document({**retired, "purgedRuntimeKeys": ["kant"]})

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

    def test_durable_placement_rejects_invalid_identifiers_modes_and_native_container_mismatch(self) -> None:
        for field, value in (("host_id", "../host"), ("runtime_mode", "shell"), ("systemd_user", "root;cmd"),
                             ("runtime_mode", "native")):
            with self.subTest(field=field, value=value), self.assertRaises(MODULE.SnapshotError):
                MODULE.snapshot_document(source(agents=[{**agent("kant"), field: value}]))

    def test_maps_enabled_retired_and_filters_disabled_memberships(self) -> None:
        payload = source(
            agents=[agent("kant"), agent("dedalo", enabled=False, harness=None)],
            memberships=[
                membership("kant", role="operator"),
                membership("dedalo", enabled=True),
                membership("quota-collector", role="operador-ñ"),
                membership("disabled-collector", enabled=False),
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
                "runtimeStateDirectory": "/home/dev/.local/state/cauce-v3/kant",
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

    def test_accepts_tenants_provisioned_outside_the_historical_list(self) -> None:
        hospital = MODULE.snapshot_document(
            source(
                agents=[agent("operador", tenant="Hospital")],
                memberships=[
                    membership(
                        "operador", tenant="Hospital", room="grp.hospital", role="operator"
                    )
                ],
            )
        )
        self.assertEqual(hospital["fleet"]["operador"]["tenant"], "Hospital")
        document = MODULE.snapshot_document(source(
            agents=[agent("kant", tenant="Equipo_42")],
            memberships=[membership("kant", tenant="Equipo_42", room="grp.equipo")],
        ))
        self.assertEqual(document["fleet"]["kant"]["tenant"], "Equipo_42")

    def test_rejects_malformed_tenant_and_alias_even_when_disabled(self) -> None:
        for tenant in ("42Equipo", "Equipo/42", "A" * 65):
            with self.subTest(tenant=tenant), self.assertRaises(MODULE.SnapshotError):
                MODULE.snapshot_document(source(
                    agents=[agent("kant", tenant=tenant, enabled=False)],
                    memberships=[],
                ))
        for alias in ("bad/alias", "Bad", "a" * 65):
            with self.subTest(alias=alias), self.assertRaises(MODULE.SnapshotError):
                MODULE.snapshot_document(source(
                    agents=[agent(alias, enabled=False)], memberships=[],
                ))

    def test_selects_explicit_primary_and_keeps_sorted_enabled_memberships(self) -> None:
        row = {**agent("kant"), "runtime_key": "kant", "primary_room_id": "grp.other"}
        document = MODULE.snapshot_document(source(
            agents=[row],
            memberships=[
                membership("kant", room="grp.other", role="operator"),
                membership("kant", enabled=False, room="grp.disabled"),
                membership("kant"),
            ],
        ))
        projected = document["fleet"]["kant"]
        self.assertEqual((projected["room"], projected["role"]), ("grp.other", "operator"))
        self.assertEqual(projected["memberships"], [
            {"room": "grp.other", "role": "operator"},
            {"room": "grp.steven", "role": "agent"},
        ])

    def test_requires_an_enabled_primary_instead_of_choosing_a_sorted_room(self) -> None:
        for primary in (None, "grp.missing", "grp.disabled"):
            row = {**agent("kant"), "runtime_key": "kant", "primary_room_id": primary}
            with self.subTest(primary=primary), self.assertRaisesRegex(MODULE.SnapshotError, "primary"):
                MODULE.snapshot_document(source(agents=[row], memberships=[
                    membership("kant"), membership("kant", room="grp.other"),
                    membership("kant", room="grp.disabled", enabled=False),
                ]))

    def test_legacy_single_membership_and_nullable_new_columns_keep_fixture_bytes(self) -> None:
        fixture = SCRIPT.parents[1] / "tests/fixtures/fleet_snapshot/minimal/flota.json"
        expected = json.loads(fixture.read_bytes())
        agents = [{
            "tenant_id": row["tenant"], "alias": alias, "harness_id": row["harness"],
            "enabled": row["enabled"], "container_name": row["container"],
            "runtime_user": row["user"], "home_directory": row["home"],
            "state_directory": row["runtimeStateDirectory"],
        } for alias, row in expected["fleet"].items()]
        agents.append(agent("fixture-retired", enabled=False))
        memberships = [membership(alias, tenant=row["tenant"], room=row["room"], role=row["role"])
                       for section in ("fleet", "systemPrincipals")
                       for alias, row in expected[section].items()]
        roles = tuple(sorted({str(row["role"]) for row in memberships}))
        for columns in ({}, {"runtime_key": None, "primary_room_id": None}):
            with self.subTest(columns=columns):
                document = MODULE.snapshot_document(source(
                    agents=[{**row, **columns} for row in agents],
                    memberships=memberships, roles=roles,
                ), expected["placement"])
                self.assertEqual(MODULE.canonical_bytes(document), fixture.read_bytes())

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

    def test_rejects_colliding_or_unsafe_runtime_keys(self) -> None:
        for runtime_key in ("bad/key", "bad_key", "a" * 65, "", False, 0):
            with self.subTest(key=runtime_key), self.assertRaisesRegex(MODULE.SnapshotError, "runtime key"):
                MODULE.snapshot_document(source(agents=[{**agent("kant"), "runtime_key": runtime_key,
                                                        "primary_room_id": None}]))
        with self.assertRaisesRegex(MODULE.SnapshotError, "runtime key"):
            MODULE.snapshot_document(source(
                agents=[{**agent("kant"), "runtime_key": "same", "primary_room_id": None,
                         "state_directory": "/home/dev/.local/state/cauce-v3/same"},
                        {**agent("bacon"), "runtime_key": "same", "primary_room_id": None,
                         "state_directory": "/home/dev/.local/state/cauce-v3/same"}],
                memberships=[membership("kant"), membership("bacon")],
            ))

    def test_disabled_membership_cannot_start_runtime(self) -> None:
        with self.assertRaisesRegex(MODULE.SnapshotError, "enabled membership"):
            MODULE.snapshot_document(source(memberships=[membership("kant", enabled=False)]))

    def test_retired_overlay_is_omitted_without_accepting_never_seen_aliases(self) -> None:
        document = MODULE.snapshot_document(source(
            agents=[agent("kant"), agent("dedalo", enabled=False)],
            memberships=[membership("kant"), membership("dedalo", enabled=False)],
        ), {"dedalo": {"dockerHost": "server2"}})
        self.assertEqual(document["placement"], {})
        self.assertEqual(document["retired"], {"dedalo": {}})

    def test_wire_alias_with_underscore_requires_a_separate_physical_key(self) -> None:
        row = {**agent("logical_alias"), "runtime_key": "physical-alias", "primary_room_id": None}
        row["state_directory"] = "/home/dev/.local/state/cauce-v3/physical-alias"
        document = MODULE.snapshot_document(source(agents=[row], memberships=[membership("logical_alias")]))
        self.assertEqual(document["fleet"]["physical-alias"]["alias"], "logical_alias")

    def test_rejects_duplicate_membership(self) -> None:
        with self.assertRaises(MODULE.SnapshotError):
            MODULE.snapshot_document(source(agents=[], memberships=[membership("kant"), membership("kant")]))

    def test_system_principals_keep_tenant_identity_and_all_memberships(self) -> None:
        import hashlib

        rows = [membership("collector", room="grp.other", role="operator"), membership("collector"),
                membership("collector", tenant="Pablo", room="grp.pablo")]
        document = MODULE.snapshot_document(source(agents=[], memberships=rows))
        def key(tenant):
            return "principal-" + hashlib.sha256(f"{tenant}\0collector".encode()).hexdigest()[:40]
        self.assertEqual(document["systemPrincipals"], {
            key("Steven"): {"tenant": "Steven", "alias": "collector", "memberships": [
                {"room": "grp.other", "role": "operator"}, {"room": "grp.steven", "role": "agent"}]},
            key("Pablo"): {"tenant": "Pablo", "alias": "collector", "room": "grp.pablo", "role": "agent"},
        })

    def test_system_principal_key_avoids_a_fleet_physical_key_collision(self) -> None:
        import hashlib

        row = {**agent("runtime_agent"), "runtime_key": "collector"}
        row["state_directory"] = "/home/dev/.local/state/cauce-v3/collector"
        document = MODULE.snapshot_document(source(agents=[row], memberships=[
            membership("runtime_agent"), membership("collector"), membership("logical_principal")]))
        for alias in ("collector", "logical_principal"):
            key = "principal-" + hashlib.sha256(f"Steven\0{alias}".encode()).hexdigest()[:40]
            self.assertEqual(document["systemPrincipals"][key]["alias"], alias)
        self.assertEqual(set(document["fleet"]), {"collector"})

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

    def test_validates_container_and_host_runtime_paths_but_copies_the_literal(self) -> None:
        container_agent = agent("argos")
        container_agent["harness_id"] = "openclaw"
        container_agent["runtime_user"] = "claw"
        container_agent["home_directory"] = "/home/claw"
        container_agent["state_directory"] = "/home/claw/.openclaw/cauce-v3/argos"
        host_agent = agent("kant")
        host_agent["container_name"] = "host:kratos"
        host_agent["runtime_user"] = "stev"
        host_agent["home_directory"] = "/home/stev"
        host_agent["state_directory"] = "/var/lib/cauce-v3/aliases/kant"
        for row, alias in ((container_agent, "argos"), (host_agent, "kant")):
            with self.subTest(alias=alias):
                literal = row["state_directory"]
                document = MODULE.snapshot_document(
                    source(agents=[row], memberships=[membership(alias)]),
                    allowed_tenants=frozenset({"Steven"}),
                )
                self.assertEqual(document["fleet"][alias]["runtimeStateDirectory"], literal)

    def test_warns_on_runtime_state_directory_drift(self) -> None:
        drifting = agent("kant")
        drifting["state_directory"] = "/var/lib/cauce-v3/aliases/kant"
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
                MODULE.snapshot_document(
                source(agents=[drifting]),
                allowed_tenants=frozenset({"Steven"}),
            )
        self.assertIn("state_directory drifts", stderr.getvalue())


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

    def test_rejects_unknown_key_and_unsafe_placement_names(self) -> None:
        for entry in ({"volume": "x"}, {"dockerHost": "-remote"}):
            with self.subTest(entry=entry):
                self.write({"schemaVersion": 1, "placement": {"kant": entry}})
                with self.assertRaises(MODULE.SnapshotError):
                    MODULE.load_placement(self.path)

    def test_accepts_safe_remote_manager_and_its_systemd_user(self) -> None:
        expected = {"kant": {"dockerHost": "server2", "systemdUser": "server"}}
        self.write({"schemaVersion": 1, "placement": expected})
        self.assertEqual(MODULE.load_placement(self.path), expected)

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
                {"kant": {"dockerHost": "-remote"}},
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
        self.assertNotRegex(query, r"\b(?:WHERE|AND)\s+(?:agent\.|membership\.)?enabled\b")
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
