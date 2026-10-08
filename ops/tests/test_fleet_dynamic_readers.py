from __future__ import annotations

import ast
import json
import os
import pathlib
import pwd
import shlex
import socket
import subprocess
import sys
import tempfile
import types
import unittest
from unittest import mock

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

from fleet_derive import load_fleet_assignments  # noqa: E402
from fleet_runtime_inventory import inventory_root, resolve_runtime_key  # noqa: E402
from fleet_runtime_materialization import materialize  # noqa: E402
from test_fleet_observation_identity import functions  # noqa: E402
from test_fleet_runtime_materialization import dynamic_source  # noqa: E402

OPS = pathlib.Path(__file__).resolve().parents[1]


class DynamicReaderTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory(prefix="cauce-readers-", dir="/var/tmp")
        self.addCleanup(temporary.cleanup)
        self.root = pathlib.Path(temporary.name)
        self.state = self.root / "runtime"
        payload = dynamic_source()
        first = payload["agents"][0]
        first.update(container_name="host:native-host", runtime_mode="native", host_id="native-host",
                     runtime_user="dev", systemd_user="manager", home_directory="/home/dev",
                     state_directory="/var/lib/cauce-v3/aliases/physical-one")
        second = dict(first, runtime_key="physical-two", tenant_id="Otro", host_id="second-host",
                      container_name="host:second-host", state_directory="/var/lib/cauce-v3/aliases/physical-two")
        payload["agents"].append(second)
        payload["memberships"].extend(dict(row, tenant_id="Otro") for row in list(payload["memberships"]))
        receipt = materialize(payload, {}, self.state)
        (self.state / "applied-fleet.json").write_text(json.dumps(receipt))
        environment = mock.patch.dict(os.environ, {"CAUCE_FLEET_RUNTIME_STATE": str(self.state)})
        environment.start()
        self.addCleanup(environment.stop)
        self.scope = functions("cauce-sesiones", {
            "OPS": str(OPS), "Path": pathlib.Path, "os": os, "json": json, "pwd": pwd,
            "socket": socket, "shlex": shlex, "subprocess": subprocess, "READER_FLEET": None,
            "inventory_root": inventory_root, "load_fleet_assignments": load_fleet_assignments,
            "resolve_runtime_key": resolve_runtime_key, "HOST_NATIVE": {"kant": "cauce-v3-host-kant"},
            "SONDA": "probe", "MAP": "unused",
        })

    def test_two_native_runtimes_with_same_wire_alias_use_published_host_and_runtime_user(self) -> None:
        fleet = self.scope["reader_fleet"]()
        self.assertEqual(resolve_runtime_key("Otro/shared_alias", fleet), "physical-two")
        with self.assertRaisesRegex(ValueError, "ambiguous"):
            resolve_runtime_key("shared_alias", fleet)
        with mock.patch.object(subprocess, "run", return_value=types.SimpleNamespace(
                stdout='{"sesiones": [], "otros": {}, "error": null}', stderr="", returncode=0)) as run:
            for key, host in (("physical-one", "native-host"), ("physical-two", "second-host")):
                self.scope["_sonda"](key, fleet[key])
                command = run.call_args.args[0]
                self.assertEqual(command[command.index("-l") + 1:command.index("-l") + 3], ["dev", host])
                self.assertNotIn("docker", " ".join(command))
                self.assertIn("HOME=/home/dev", command[-1])
                self.assertIn(fleet[key]["stateDirectory"], command[-1])

    def test_container_probe_uses_remote_manager_and_container_runtime_user(self) -> None:
        info = dict(self.scope["reader_fleet"]()["physical-one"], runtimeMode="container",
                    container="runtime-box", hostId="docker-host")
        with mock.patch.object(subprocess, "run", return_value=types.SimpleNamespace(
                stdout='{"sesiones": [], "otros": {}, "error": null}', stderr="", returncode=0)) as run:
            self.scope["_sonda"]("physical-one", info)
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("-l") + 1:command.index("-l") + 3], ["manager", "docker-host"])
        self.assertIn("docker exec -i --user dev runtime-box python3", command[-1])

    def test_real_native_probe_reads_only_its_published_state_without_docker(self) -> None:
        declarations = ast.parse((OPS / "guardias/cauce-sesiones").read_text())
        self.scope["SONDA"] = next(ast.literal_eval(node.value) for node in declarations.body
                                   if isinstance(node, ast.Assign)
                                   and any(isinstance(target, ast.Name) and target.id == "SONDA" for target in node.targets))
        state = self.root / "native-state"
        state.mkdir()
        (state / "sessions.json").write_text(json.dumps({"sessions": {
            "codex:fixture": {"native_id": "fixture-native", "initialized": True,
                              "origin": {"channel": "fixture", "conversation_id": "native-reader"}},
        }}))
        info = dict(self.scope["reader_fleet"]()["physical-one"], hostId="local", home=str(self.root),
                    user=pwd.getpwuid(os.geteuid()).pw_name, harness="codex", stateDirectory=str(state))
        result = self.scope["_sonda"]("physical-one", info)
        self.assertIsNone(result["error"])
        self.assertEqual([row["native"] for row in result["sesiones"]], ["fixture-native"])
        self.assertEqual(result["sesiones"][0]["origen"]["conversation_id"], "native-reader")

    def test_local_native_read_preserves_uid_home_and_fails_for_wrong_unprivileged_user(self) -> None:
        info = dict(self.scope["reader_fleet"]()["physical-one"], hostId="local")
        with mock.patch.object(pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=4242, pw_dir="/home/dev")), \
                mock.patch.object(os, "geteuid", return_value=0), mock.patch.object(subprocess, "run") as run:
            self.scope["runtime_read"]("physical-one", info, ["python3", "-"])
        self.assertEqual(run.call_args.args[0], ["runuser", "-u", "dev", "--", "env", "HOME=/home/dev",
                                               "XDG_RUNTIME_DIR=/run/user/4242", "python3", "-"])
        with mock.patch.object(pwd, "getpwnam", return_value=types.SimpleNamespace(pw_uid=4242, pw_dir="/home/dev")), \
                mock.patch.object(os, "geteuid", return_value=1000), mock.patch.object(subprocess, "run") as run:
            with self.assertRaises(PermissionError):
                self.scope["runtime_read"]("physical-one", info, ["python3", "-"])
            run.assert_not_called()

    def test_panel_only_captures_existing_physical_pane_and_propagates_missing_panel(self) -> None:
        with mock.patch.object(subprocess, "run", return_value=types.SimpleNamespace(stdout="", returncode=1)) as run:
            with self.assertRaises(SystemExit):
                self.scope["panel"]("physical-two")
        command = run.call_args.args[0]
        self.assertIn("tmux -L cauce capture-pane -p -t cauce-physical-two:agente", command[-1])
        self.assertNotIn("ensure", " ".join(command))
        info = dict(self.scope["reader_fleet"]()["physical-one"], harness="openclaw")
        self.scope["alias_info"] = lambda _: info
        with mock.patch.object(subprocess, "run") as run:
            self.assertEqual(self.scope["panel"]("physical-one"), 3)
            run.assert_not_called()

    def test_missing_systemd_unit_is_unmeasured_and_manager_differs_from_native_probe(self) -> None:
        fleet = self.scope["reader_fleet"]()
        state = functions("cauce-estado", {"FLEET": fleet, "os": os, "pwd": pwd, "shlex": shlex,
                                           "socket": socket, "subprocess": subprocess, "ERRORS": {}})
        with mock.patch.object(subprocess, "run", return_value=types.SimpleNamespace(
                stdout="LoadState=not-found\nActiveState=inactive\n", returncode=0)) as run:
            self.assertEqual(state["propiedades"]("physical-two", ["ActiveState"]), {})
        command = run.call_args.args[0]
        self.assertEqual(command[command.index("-l") + 1:command.index("-l") + 3], ["manager", "second-host"])
        self.assertIn("cauce-v3-alias-physical-two.service", command[-1])
        with mock.patch.object(subprocess, "run", return_value=types.SimpleNamespace(stdout="{}", returncode=0)) as run:
            state["at_host"]("physical-two", ["python3", "-"], as_manager=False)
        self.assertEqual(run.call_args.args[0][run.call_args.args[0].index("-l") + 1], "dev")
        result = state["veredicto"]({"marcador": None, "unidad": {}, "presencia": None}, None)
        self.assertEqual(result[0], "NO MEDIDO")

    def test_reader_keeps_one_verified_generation_and_rejects_missing_receipt(self) -> None:
        fleet = self.scope["reader_fleet"]()
        (self.state / "applied-fleet.json").unlink()
        self.assertIs(self.scope["reader_fleet"](), fleet)
        self.scope["READER_FLEET"] = None
        with self.assertRaises((ValueError, OSError)):
            self.scope["reader_fleet"]()

    def test_real_cli_resolves_tenant_wire_to_reader_without_forwarding_to_remote_cli(self) -> None:
        home = self.root / "reader-home"
        bin_directory = home / ".local/bin"
        bin_directory.mkdir(parents=True)
        ops_link = home / ".local/share/cauce-v3/ops"
        ops_link.parent.mkdir(parents=True)
        ops_link.symlink_to(OPS)
        getent = bin_directory / "getent"
        getent.write_text('#!/bin/sh\nprintf "%s\\n" "$HOME"\n')
        getent.chmod(0o700)
        for reader in ("cauce-estado", "cauce-sesiones", "cauce-panel"):
            wrapper = bin_directory / reader
            wrapper.write_text('#!/bin/sh\nprintf "%s %s\\n" "${0##*/}" "$*"\n')
            wrapper.chmod(0o700)
        environment = {**os.environ, "HOME": str(home), "PATH": str(bin_directory) + ":" + os.environ["PATH"]}
        for verb, reader in (("estado", "cauce-estado"), ("sesiones", "cauce-sesiones"), ("panel", "cauce-panel")):
            result = subprocess.run(["bash", str(OPS / "cli/cauce"), "Otro/shared_alias", verb],
                                    env=environment, capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout, reader + " physical-two\n")


class DynamicMutationBlockTests(unittest.TestCase):
    def test_real_cli_rejects_mutations_before_runtime_or_identity_side_effects(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cauce-cli-block-") as temporary:
            root = pathlib.Path(temporary)
            log = root / "effects"
            for command in ("docker", "ssh", "systemctl", "python3", "node", "tmux"):
                script = root / command
                script.write_text('#!/bin/sh\nprintf "%s\\n" "$0" >> "$CAUCE_TEST_EFFECTS"\nexit 91\n')
                script.chmod(0o700)
            environment = {**os.environ, "PATH": str(root) + ":" + os.environ["PATH"], "CAUCE_TEST_EFFECTS": str(log)}
            for inventory in ("", "/missing/receipt"):
                environment["CAUCE_FLEET_RUNTIME_STATE"] = inventory
                for arguments in (["physical-one", "on"], ["physical-one", "off"], ["physical-one", "retirar"],
                                  ["physical-one", "aprovisionar"], ["physical-one"], ["physical-one", "login", "--ver"],
                                  ["physical-one", "auth"], ["pila-test"], ["pila-test", "estado"],
                                  ["pila-test", "ver"], ["pila-test", "panel"]):
                    result = subprocess.run(["bash", str(OPS / "cli/cauce"), *arguments], env=environment,
                                            capture_output=True, text=True, check=False)
                    self.assertEqual(result.returncode, 2, (arguments, result.stderr))
                    self.assertIn("coordinator durable", result.stderr)
            self.assertFalse(log.exists(), "a mutation reached a runtime or identity helper")

    def test_panel_guard_rejects_before_creating_state_or_lock(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cauce-panel-guard-") as temporary:
            result = subprocess.run(["bash", str(OPS / "guardias/cauce-panel-guard")], capture_output=True, text=True,
                                    env={**os.environ, "HOME": temporary, "CAUCE_FLEET_RUNTIME_STATE": ""}, check=False)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertEqual(list(pathlib.Path(temporary).iterdir()), [])

    def test_direct_attach_recovery_and_panel_creation_reject_before_any_effect(self) -> None:
        with tempfile.TemporaryDirectory(prefix="cauce-direct-block-") as temporary:
            for name, interpreter in (("cauce-attach", "python3"), ("cauce-attach-guard", "python3"),
                                      ("cauce-tmux-panel", "bash")):
                result = subprocess.run([interpreter, str(OPS / "guardias" / name), "physical-one"],
                                        capture_output=True, text=True, check=False,
                                        env={**os.environ, "HOME": temporary, "CAUCE_FLEET_RUNTIME_STATE": ""})
                self.assertEqual(result.returncode, 2, (name, result.stderr))
                self.assertIn("coordinator durable", result.stderr)
                self.assertEqual(list(pathlib.Path(temporary).iterdir()), [])


if __name__ == "__main__":
    unittest.main()
