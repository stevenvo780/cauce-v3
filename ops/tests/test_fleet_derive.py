#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import sys
import unittest
from typing import Any

OPS = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(OPS / "scripts"))

from fleet_derive import (  # noqa: E402
    HARNESS_RULES,
    HOST_STATE_DIRECTORY,
    SYSTEMD_USER,
    alias_entry,
    env_name,
    harness_workspace,
    manifest_doc,
    runtime_state_directory,
)

HARNESSES = {"claude", "codex", "grok", "hermes", "muse", "openclaw", "opencode"}


def fleet_row(harness: str, **overrides: Any) -> dict[str, Any]:
    home = "/home/claw" if harness == "openclaw" else "/home/dev"
    row: dict[str, Any] = {
        "tenant": "Steven",
        "room": "grp.steven",
        "role": "agent",
        "harness": harness,
        "enabled": True,
        "container": "ctrl-infra",
        "user": "claw" if harness == "openclaw" else "dev",
        "home": home,
        "runtimeStateDirectory": f"{home}/literal/runtime/argos",
    }
    row.update(overrides)
    return row


class FleetDeriveTests(unittest.TestCase):
    def test_wire_identity_uses_logical_alias_and_runtime_metadata_uses_physical_key(self) -> None:
        row = fleet_row("codex", alias="shared_alias", tenant="Equipo_42")
        entry = alias_entry("physical-one", row, {})
        self.assertEqual(entry["alias"], "shared_alias")
        document = manifest_doc("physical-one", row)
        self.assertEqual(document["metadata"]["name"], "physical-one")
        self.assertEqual(document["spec"]["alias"], "shared_alias")
        self.assertEqual(document["spec"]["relay"]["urlPathEnv"], "CAUCE_PHYSICAL_ONE_RELAY_URL")
        self.assertEqual(document["spec"]["stateDirectory"], "/var/lib/cauce-v3/aliases/physical-one")

    def test_invalid_wire_alias_cannot_be_rendered_as_yaml(self) -> None:
        for alias in ("bad\nalias", "Bad", "a" * 65):
            with self.subTest(alias=alias), self.assertRaises(ValueError):
                manifest_doc("physical-one", fleet_row("codex", alias=alias))

    def test_durable_room_ids_preserve_labels_but_reject_control_characters(self) -> None:
        for room in ("room.one", "Sala café: equipo"):
            with self.subTest(room=room):
                row = fleet_row("codex", room=room)
                self.assertEqual(manifest_doc("physical-one", row)["spec"]["room"], room)
                self.assertEqual(alias_entry("physical-one", row, {})["room"], room)
        for room in ("", "r" * 129, "room\nnewline"):
            with self.subTest(room=room), self.assertRaises(ValueError):
                manifest_doc("physical-one", fleet_row("codex", room=room))

    def test_logical_alias_does_not_allow_an_unsafe_physical_runtime_key(self) -> None:
        for key in ("bad_key", "bad.key", "Bad", "a" * 65):
            row = fleet_row("codex", alias="valid")
            with self.subTest(key=key, render="manifest"), self.assertRaises(ValueError):
                manifest_doc(key, row)
            with self.subTest(key=key, render="inventory"), self.assertRaises(ValueError):
                alias_entry(key, row, {})

    def test_constants_and_rules_cover_every_supported_harness(self) -> None:
        self.assertEqual(SYSTEMD_USER, "stev")
        self.assertEqual(
            HOST_STATE_DIRECTORY,
            "/var/lib/cauce-v3/aliases/{alias}",
        )
        self.assertEqual(set(HARNESS_RULES), HARNESSES)
        for harness, rule in HARNESS_RULES.items():
            with self.subTest(harness=harness):
                self.assertEqual(
                    set(rule["stateDirectory"]),
                    {"container", "host"},
                )
                self.assertEqual(
                    rule["stateDirectory"]["host"],
                    HOST_STATE_DIRECTORY,
                )
        self.assertEqual(HARNESS_RULES["openclaw"]["workspace"], "{home}/clawd")
        self.assertEqual(
            HARNESS_RULES["hermes"]["operationalModelEnv"],
            "HERMES_INFERENCE_MODEL",
        )
        for harness in HARNESSES - {"openclaw"}:
            self.assertNotIn("workspace", HARNESS_RULES[harness])
        for harness in HARNESSES - {"hermes"}:
            self.assertNotIn("operationalModelEnv", HARNESS_RULES[harness])

    def test_runtime_state_directory_uses_each_container_rule(self) -> None:
        for harness in HARNESSES:
            row = fleet_row(harness, home="/srv/runtime-user")
            expected_parent = ".openclaw" if harness == "openclaw" else ".local/state"
            with self.subTest(harness=harness):
                self.assertEqual(
                    runtime_state_directory("agent-one", row),
                    f"/srv/runtime-user/{expected_parent}/cauce-v3/agent-one",
                )

    def test_runtime_state_directory_uses_host_rule_for_every_harness(self) -> None:
        for harness in HARNESSES:
            row = fleet_row(
                harness,
                container="host:kratos",
                home="/path/ignored/by/host/rule",
            )
            with self.subTest(harness=harness):
                self.assertEqual(
                    runtime_state_directory("kant", row),
                    "/var/lib/cauce-v3/aliases/kant",
                )

    def test_env_name_supports_all_exact_kinds_and_normalizes_hyphens(self) -> None:
        expected = {
            "TOKEN_PATH": "CAUCE_AGENT_ONE_TOKEN_PATH",
            "CERT_PATH": "CAUCE_AGENT_ONE_CERT_PATH",
            "KEY_PATH": "CAUCE_AGENT_ONE_KEY_PATH",
            "CA_PATH": "CAUCE_AGENT_ONE_CA_PATH",
            "RELAY_URL": "CAUCE_AGENT_ONE_RELAY_URL",
            "EXEC_PATH": "CAUCE_AGENT_ONE_EXEC_PATH",
        }
        self.assertEqual(
            {kind: env_name("agent-one", kind) for kind in expected},
            expected,
        )

    def test_env_name_rejects_unknown_or_wrong_case_kind(self) -> None:
        for kind in ("TOKEN", "token_path", "PASSWORD_PATH"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                env_name("argos", kind)

    def test_alias_entry_projects_snapshot_and_overlay_in_wire_order(self) -> None:
        row = fleet_row(
            "codex",
            tenant="Miguel",
            room="grp.miguel",
            role="operator",
            container="host:kratos",
            user="stev",
            home="/home/stev",
            runtimeStateDirectory="/var/lib/cauce-v3/aliases/kant",
        )
        placement = {
            "healthContainer": "ctrl-infra",
            "registryContainer": "host:kratos",
            "dockerHost": "kratos",
        }

        entry = alias_entry("kant", row, placement)

        self.assertEqual(entry, {
            "tenant": "Miguel",
            "room": "grp.miguel",
            "container": "host:kratos",
            "registryContainer": "host:kratos",
            "dockerHost": "kratos",
            "systemdUser": "stev",
            "user": "stev",
            "home": "/home/stev",
            "stateDirectory": "/var/lib/cauce-v3/aliases/kant",
            "harness": "codex",
            "membershipRole": "operator",
        })
        self.assertEqual(list(entry), [
            "tenant",
            "room",
            "container",
            "registryContainer",
            "dockerHost",
            "systemdUser",
            "user",
            "home",
            "stateDirectory",
            "harness",
            "membershipRole",
        ])

    def test_alias_entry_copies_literal_runtime_path_instead_of_rederiving_it(self) -> None:
        row = fleet_row(
            "codex",
            runtimeStateDirectory="/workspace/.cauce-v3/custom",
        )
        self.assertEqual(
            alias_entry("custom", row, {})["stateDirectory"],
            "/workspace/.cauce-v3/custom",
        )

    def test_alias_entry_derives_openclaw_workspace_only_for_openclaw(self) -> None:
        for harness in HARNESSES:
            row = fleet_row(harness, home="/srv/agent")
            entry = alias_entry("argos", row, {})
            with self.subTest(harness=harness):
                if harness == "openclaw":
                    self.assertEqual(entry["workspace"], "/srv/agent/clawd")
                else:
                    self.assertNotIn("workspace", entry)

    def test_muse_workspace_agent_is_selected_by_its_declared_state_directory(self) -> None:
        bridge = fleet_row("muse", home="/srv/agent",
                           runtimeStateDirectory="/srv/agent/.local/state/cauce-v3/hegel")
        agent = fleet_row("muse", home="/srv/agent",
                          runtimeStateDirectory="/srv/agent/.muse/cauce-v3/teseo")
        self.assertIsNone(harness_workspace("hegel", bridge))
        self.assertNotIn("workspace", alias_entry("hegel", bridge, {}))
        self.assertNotIn("workspace", manifest_doc("hegel", bridge)["spec"]["profile"])
        self.assertIsNone(harness_workspace("perseo", agent))
        self.assertEqual(harness_workspace("teseo", agent), "/srv/agent/clawd")
        self.assertEqual(alias_entry("teseo", agent, {})["workspace"], "/srv/agent/clawd")
        self.assertEqual(manifest_doc("teseo", agent)["spec"]["profile"]["workspace"], "/srv/agent/clawd")

    def test_alias_entry_does_not_mutate_inputs(self) -> None:
        row = fleet_row("openclaw")
        placement = {"dockerHost": "kratos"}
        original_row = dict(row)
        original_placement = dict(placement)

        alias_entry("argos", row, placement)

        self.assertEqual(row, original_row)
        self.assertEqual(placement, original_placement)

    def test_manifest_doc_derives_exact_common_contract_for_every_harness(self) -> None:
        for harness in HARNESSES:
            row = fleet_row(harness, home="/srv/agent")
            document = manifest_doc("agent-one", row)
            spec = document["spec"]
            with self.subTest(harness=harness):
                self.assertEqual(set(document), {
                    "apiVersion", "kind", "metadata", "spec",
                })
                self.assertEqual(document["apiVersion"], "cauce.io/v3")
                self.assertEqual(document["kind"], "AliasRuntime")
                self.assertEqual(document["metadata"], {"name": "agent-one"})
                self.assertEqual(spec["tenant"], "Steven")
                self.assertEqual(spec["room"], "grp.steven")
                self.assertEqual(spec["alias"], "agent-one")
                self.assertEqual(spec["harness"], harness)
                self.assertEqual(spec["origin"], {"transport": "telegram"})
                self.assertEqual(spec["relay"], {
                    "urlPathEnv": "CAUCE_AGENT_ONE_RELAY_URL",
                    "requiredScheme": "wss",
                })
                self.assertEqual(spec["secretPathEnv"], {
                    "token": "CAUCE_AGENT_ONE_TOKEN_PATH",
                    "clientCertificate": "CAUCE_AGENT_ONE_CERT_PATH",
                    "clientKey": "CAUCE_AGENT_ONE_KEY_PATH",
                    "certificateAuthority": "CAUCE_AGENT_ONE_CA_PATH",
                })
                self.assertEqual(
                    spec["stateDirectory"],
                    "/var/lib/cauce-v3/aliases/agent-one",
                )

    def test_manifest_doc_adds_only_the_harness_specific_fields(self) -> None:
        for harness in HARNESSES:
            document = manifest_doc("argos", fleet_row(harness, home="/srv/agent"))
            profile = document["spec"]["profile"]
            process = document["spec"]["process"]
            with self.subTest(harness=harness):
                expected_profile = {
                    "seedOnConnect": True,
                    "configScope": "alias",
                }
                if harness == "openclaw":
                    expected_profile["workspace"] = "/srv/agent/clawd"
                self.assertEqual(profile, expected_profile)

                expected_process = {
                    "executablePathEnv": "CAUCE_ARGOS_EXEC_PATH",
                }
                if harness == "hermes":
                    expected_process["operationalModelEnv"] = "HERMES_INFERENCE_MODEL"
                self.assertEqual(process, expected_process)

    def test_manifest_doc_ignores_runtime_state_literal_and_does_not_mutate_row(self) -> None:
        row = fleet_row(
            "hermes",
            runtimeStateDirectory="/inside/container/state",
        )
        original = dict(row)

        document = manifest_doc("iza", row)

        self.assertEqual(
            document["spec"]["stateDirectory"],
            "/var/lib/cauce-v3/aliases/iza",
        )
        self.assertEqual(row, original)

    def test_derivations_reject_an_unknown_harness(self) -> None:
        row = fleet_row("unknown")
        for derive in (
            lambda: runtime_state_directory("argos", row),
            lambda: alias_entry("argos", row, {}),
            lambda: manifest_doc("argos", row),
        ):
            with self.subTest(derive=derive), self.assertRaises(ValueError):
                derive()


if __name__ == "__main__":
    unittest.main()
