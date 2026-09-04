#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
from typing import Any
from unittest import mock

AGENT_ROOT = pathlib.Path(__file__).resolve().parents[1]
OPS_ROOT = AGENT_ROOT.parent
SPEC = importlib.util.spec_from_file_location("rollout_pty", AGENT_ROOT / "rollout-pty.py")
assert SPEC is not None and SPEC.loader is not None
rollout = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = rollout
SPEC.loader.exec_module(rollout)


class FakeRunner(rollout.Runner):
    def __init__(self) -> None:
        self.enabled: set[str] = set()
        self.active: set[str] = set()
        self.release_sha = ""
        self.alias = ""
        self.modes = "shell"
        self.journal_ready_after = 1
        self.journal_calls = 0
        self.install_returncode = 0
        self.commands: list[tuple[str, ...]] = []

    def run(self, argv: Any, *, env: Any = None) -> rollout.CommandResult:
        values = tuple(str(value) for value in argv)
        self.commands.append(values)
        if values[0].endswith("install-pty-agent.sh"):
            return rollout.CommandResult(self.install_returncode)
        if values[0] == "journalctl":
            self.journal_calls += 1
            if self.journal_calls < self.journal_ready_after:
                return rollout.CommandResult(0, "connecting\n")
            return rollout.CommandResult(
                0,
                f"starting alias={self.alias} container=0123456789ab uid=1000 version={self.release_sha}\n"
                f"relay accepted alias={self.alias} modes={self.modes}\n",
            )
        if values[0] != "systemctl":
            return rollout.CommandResult(127)
        operation = values[2]
        unit = values[-1]
        if operation == "list-unit-files":
            body = "".join(f"{name} enabled enabled\n" for name in sorted(self.enabled))
            return rollout.CommandResult(0, body)
        if operation == "list-units":
            body = "".join(
                f"{name} loaded active running test\n" for name in sorted(self.active)
            )
            return rollout.CommandResult(0, body)
        if operation == "is-enabled":
            return rollout.CommandResult(0 if unit in self.enabled else 1)
        if operation == "is-active":
            return rollout.CommandResult(0 if unit in self.active else 3)
        if operation == "enable":
            self.enabled.add(unit)
            return rollout.CommandResult(0)
        if operation == "disable":
            self.enabled.discard(unit)
            return rollout.CommandResult(0)
        if operation in {"restart", "start"}:
            self.active.add(unit)
            return rollout.CommandResult(0)
        if operation == "stop":
            self.active.discard(unit)
            return rollout.CommandResult(0)
        if operation == "daemon-reload":
            return rollout.CommandResult(0)
        if operation == "show":
            return rollout.CommandResult(0, "123\n")
        return rollout.CommandResult(1)


class TestWorker(rollout.ManagerWorker):
    def _process_has_release(self, unit: str, release_sha: str) -> bool:
        return release_sha == self.runner.release_sha


class FakeTransport(rollout.Transport):
    def __init__(self, fail_alias: str | None = None) -> None:
        self.fail_alias = fail_alias
        self.calls: list[tuple[str, dict[str, Any]]] = []

    def call(self, operation: str, request: Any) -> dict[str, Any]:
        copied = dict(request)
        self.calls.append((operation, copied))
        if copied.get("alias") == self.fail_alias:
            raise rollout.RolloutError("fixture failure")
        return {"status": "ok"}


class RolloutPtyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.bundle = rollout.ReleaseBundle.from_ops_root(OPS_ROOT)
        cls.fleet = rollout.Fleet.load(cls.bundle.files["container-aliases.json"])

    def worker(self, manager: str = "server") -> tuple[tempfile.TemporaryDirectory[str], TestWorker, FakeRunner]:
        temporary = tempfile.TemporaryDirectory()
        home = pathlib.Path(temporary.name)
        unit_root = home / ".config/systemd/user"
        unit_root.mkdir(parents=True, mode=0o700)
        unit_file = unit_root / "cauce-v3-pty@.service"
        unit_file.write_text("[Service]\n", encoding="utf-8")
        unit_file.chmod(0o600)
        runner = FakeRunner()
        with mock.patch.object(rollout.os, "geteuid", return_value=1000):
            worker = TestWorker(manager, home=home, runner=runner, sleep=lambda _: None)
        return temporary, worker, runner

    def test_mapping_assigns_exactly_two_managers_and_recalculates_source_hashes(self) -> None:
        self.assertEqual(set(self.fleet.placements.values()), {"server", "kratos"})
        self.assertEqual(self.fleet.placements["kant"], "server")
        self.assertEqual(self.fleet.placements["salva"], "kratos")
        self.assertEqual(
            self.bundle.digests["pty-agent/cauce-pty-launcher.sh"],
            rollout.sha256((AGENT_ROOT / "cauce-pty-launcher.sh").read_bytes()),
        )
        self.assertEqual(
            self.bundle.digests["pty-agent/reap_orphan_agent.py"],
            rollout.sha256((AGENT_ROOT / "reap_orphan_agent.py").read_bytes()),
        )
        self.assertEqual(
            self.bundle.digests["pty-agent/cauce_pty_agent/agent.py"],
            rollout.sha256((AGENT_ROOT / "cauce_pty_agent/agent.py").read_bytes()),
        )
        self.assertEqual(
            self.bundle.mapping_sha,
            rollout.sha256((OPS_ROOT / "container-aliases.json").read_bytes()),
        )

    def test_sudo_ssh_transport_enters_the_real_user_bus_without_inheriting_root_home(self) -> None:
        transport = rollout.ProcessTransport(
            "server", "sudo-ssh:vpstn:stev", AGENT_ROOT / "rollout-pty.py",
        )
        response = rollout.canonical_json({"ok": True, "result": {"inventory": {}}})
        completed = subprocess.CompletedProcess([], 0, stdout=response, stderr=b"")
        with mock.patch.object(rollout.subprocess, "run", return_value=completed) as invoked:
            self.assertEqual(transport.call("inventory", {}), {"inventory": {}})
        argv = invoked.call_args.args[0]
        self.assertEqual(argv[:6], [
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "vpstn",
        ])
        remote = argv[6]
        self.assertIn("uid=$(id -u -- stev)", remote)
        self.assertIn("sudo -Hu stev env", remote)
        self.assertIn('XDG_RUNTIME_DIR="/run/user/$uid"', remote)
        self.assertIn('DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus"', remote)
        self.assertNotIn("sudo -H root", remote)

    def test_sudo_ssh_transport_rejects_unbounded_host_or_user_syntax(self) -> None:
        for target in ("sudo-ssh:vpstn", "sudo-ssh:vpstn:stev:extra", "sudo-ssh:vpstn:Stev"):
            with self.subTest(target=target), self.assertRaises(rollout.RolloutError):
                rollout.ProcessTransport("server", target, AGENT_ROOT / "rollout-pty.py").call(
                    "inventory", {},
                )

    def test_both_physical_managers_must_be_declared_once(self) -> None:
        with self.assertRaisesRegex(rollout.RolloutError, "exactamente"):
            rollout.parse_targets([])
        with self.assertRaisesRegex(rollout.RolloutError, "exactamente"):
            rollout.parse_targets(["server=local"])
        with self.assertRaisesRegex(rollout.RolloutError, "invalido"):
            rollout.parse_targets(["server=local", "server=ssh:vpstn", "kratos=ssh:kratos"])
        self.assertEqual(
            rollout.parse_targets([
                "server=sudo-ssh:vpstn:stev", "kratos=ssh:kratos",
            ]),
            {"server": "sudo-ssh:vpstn:stev", "kratos": "ssh:kratos"},
        )

    def test_duplicate_json_keys_are_rejected_before_a_mapping_can_be_used(self) -> None:
        with self.assertRaisesRegex(rollout.RolloutError, "duplicada"):
            rollout.duplicate_safe_json(b'{"aliases":{},"aliases":{}}', "fixture")

    def test_inventory_rejects_retired_unknown_duplicate_and_placement_drift(self) -> None:
        empty = {"server": {}, "kratos": {}}
        rollout.validate_inventories(self.fleet, empty, migrate_kant=False)
        cases = (
            {"server": {"ficticio": rollout.UnitPresence(selector=True)}, "kratos": {}},
            {"server": {"fantasma": rollout.UnitPresence(active=True)}, "kratos": {}},
            {
                "server": {"janus": rollout.UnitPresence(active=True)},
                "kratos": {"janus": rollout.UnitPresence(selector=True)},
            },
            {"server": {"midas": rollout.UnitPresence(enabled=True)}, "kratos": {}},
        )
        for inventories in cases:
            with self.subTest(inventories=inventories), self.assertRaises(rollout.RolloutError):
                rollout.validate_inventories(self.fleet, inventories, migrate_kant=False)

    def test_unknown_alias_units_block_fail_closed(self) -> None:
        measured = {
            "server": {"espectro": rollout.UnitPresence(enabled=True)},
            "kratos": {"sombra": rollout.UnitPresence(active=True)},
        }
        with self.assertRaisesRegex(rollout.RolloutError, "desconocido"):
            rollout.validate_inventories(self.fleet, measured, migrate_kant=False)

    def test_kant_migration_is_explicit_and_never_accepts_double_presence(self) -> None:
        legacy = {"server": {}, "kratos": {"kant": rollout.UnitPresence(active=True)}}
        with self.assertRaisesRegex(rollout.RolloutError, "migrate-kant"):
            rollout.validate_inventories(self.fleet, legacy, migrate_kant=False)
        rollout.validate_inventories(self.fleet, legacy, migrate_kant=True)
        duplicate = {
            "server": {"kant": rollout.UnitPresence(selector=True)},
            "kratos": {"kant": rollout.UnitPresence(active=True)},
        }
        with self.assertRaisesRegex(rollout.RolloutError, "duplicados"):
            rollout.validate_inventories(self.fleet, duplicate, migrate_kant=True)

    def test_publish_is_immutable_idempotent_and_preserves_older_releases(self) -> None:
        temporary, worker, _ = self.worker()
        self.addCleanup(temporary.cleanup)
        first = worker.publish(self.bundle)
        second = worker.publish(self.bundle)
        self.assertEqual(first["status"], "published")
        self.assertEqual(second["status"], "already-published")
        release = worker.release_path(self.bundle.release_sha)
        self.assertTrue(release.is_dir())
        self.assertEqual((release / "manifest.json").stat().st_mode & 0o777, 0o400)
        old = worker.release_root / ("f" * 64)
        old.mkdir(mode=0o500)
        worker.publish(self.bundle)
        self.assertTrue(old.is_dir(), "publicar o reintentar no debe borrar releases anteriores")

    def test_published_release_tampering_fails_closed(self) -> None:
        temporary, worker, _ = self.worker()
        self.addCleanup(temporary.cleanup)
        worker.publish(self.bundle)
        path = worker.release_path(self.bundle.release_sha) / "pty-agent/cauce_pty_agent/agent.py"
        path.chmod(0o600)
        path.write_bytes(b"alterado")
        path.chmod(0o400)
        with self.assertRaisesRegex(rollout.RolloutError, "cambio"):
            worker.validate_release(self.bundle.release_sha)

    def test_apply_retries_health_then_is_idempotent_and_gates_requested_modes(self) -> None:
        temporary, worker, runner = self.worker("server")
        self.addCleanup(temporary.cleanup)
        worker.publish(self.bundle)
        runner.alias = "janus"
        runner.release_sha = self.bundle.release_sha
        runner.modes = "shell,harness"
        runner.journal_ready_after = 3
        result = worker.apply(
            self.bundle.release_sha,
            "janus",
            "server",
            self.fleet.entry_digest("janus"),
            frozenset(("shell", "harness")),
            attempts=4,
            delay=0,
        )
        self.assertEqual(result["status"], "updated")
        self.assertEqual(runner.journal_calls, 3)
        again = worker.apply(
            self.bundle.release_sha,
            "janus",
            "server",
            self.fleet.entry_digest("janus"),
            frozenset(("shell", "harness")),
            attempts=1,
            delay=0,
        )
        self.assertEqual(again["status"], "unchanged")
        restarts = [command for command in runner.commands if command[2] == "restart"]
        self.assertEqual(len(restarts), 1, "un retry idempotente no debe reiniciar una unit sana")

    def test_failed_published_preflight_cannot_activate_a_selector(self) -> None:
        temporary, worker, runner = self.worker("server")
        self.addCleanup(temporary.cleanup)
        worker.publish(self.bundle)
        runner.install_returncode = 78
        with self.assertRaisesRegex(rollout.RolloutError, "preflight PTY publicado"):
            worker.apply(
                self.bundle.release_sha,
                "janus",
                "server",
                self.fleet.entry_digest("janus"),
                frozenset(("shell",)),
            )
        self.assertFalse(worker._selector_path("janus").exists())
        operations = {command[2] for command in runner.commands if command[0] == "systemctl"}
        self.assertTrue(operations.isdisjoint({"daemon-reload", "enable", "restart"}))

    def test_failed_capability_gate_automatically_restores_selector_and_unit_state(self) -> None:
        temporary, worker, runner = self.worker("server")
        self.addCleanup(temporary.cleanup)
        worker.publish(self.bundle)
        runner.alias = "janus"
        runner.release_sha = self.bundle.release_sha
        runner.modes = "shell"
        runner.journal_ready_after = 1
        selector = worker._selector_path("janus")
        with self.assertRaisesRegex(rollout.RolloutError, "health/capability"):
            worker.apply(
                self.bundle.release_sha,
                "janus",
                "server",
                self.fleet.entry_digest("janus"),
                frozenset(("shell", "harness")),
                attempts=2,
                delay=0,
            )
        self.assertFalse(selector.exists())
        unit = "cauce-v3-pty@janus.service"
        self.assertNotIn(unit, runner.enabled)
        self.assertNotIn(unit, runner.active)
        recovered = list((worker.state_root / "transactions/janus").glob("*/selector.rolled-back"))
        self.assertEqual(len(recovered), 1, "el selector fallido se conserva en el backup")

    def test_retired_alias_deactivation_is_explicit_transactional_and_recoverable(self) -> None:
        temporary, worker, runner = self.worker("kratos")
        self.addCleanup(temporary.cleanup)
        with self.assertRaisesRegex(rollout.RolloutError, "historico"):
            worker.deactivate_retired("hegel", self.bundle)
        alias = "fantasma"
        catalogo = json.loads(self.bundle.files["container-aliases.json"])
        catalogo["historicalAliases"] = {alias: {"expectedEnabled": False}}
        declarado = types.SimpleNamespace(
            files={"container-aliases.json": json.dumps(catalogo).encode()}
        )
        unit = f"cauce-v3-pty@{alias}.service"
        runner.enabled.add(unit)
        runner.active.add(unit)
        selector = worker._selector_path(alias)
        selector.parent.mkdir(parents=True, mode=0o700)
        selector.write_text("[Service]\n", encoding="utf-8")
        result = worker.deactivate_retired(alias, declarado)
        self.assertNotIn(unit, runner.enabled)
        self.assertNotIn(unit, runner.active)
        self.assertFalse(selector.exists())
        restored = worker.rollback(alias, result["transaction"])
        self.assertEqual(restored["status"], "rolled-back")
        self.assertIn(unit, runner.enabled)
        self.assertIn(unit, runner.active)
        self.assertEqual(selector.read_text(encoding="utf-8"), "[Service]\n")

    def test_explicit_rollback_is_single_use_and_restores_previous_selector(self) -> None:
        temporary, worker, runner = self.worker("server")
        self.addCleanup(temporary.cleanup)
        worker.publish(self.bundle)
        selector = worker._selector_path("janus")
        selector.parent.mkdir(parents=True, mode=0o700)
        previous = b"[Service]\nEnvironment=CAUCE_PTY_AGENT_VERSION=previous\n"
        selector.write_bytes(previous)
        runner.alias = "janus"
        runner.release_sha = self.bundle.release_sha
        result = worker.apply(
            self.bundle.release_sha,
            "janus",
            "server",
            self.fleet.entry_digest("janus"),
            frozenset(("shell",)),
            attempts=1,
            delay=0,
        )
        rolled = worker.rollback("janus", result["transaction"])
        self.assertEqual(rolled["status"], "rolled-back")
        self.assertEqual(selector.read_bytes(), previous)
        repeated = worker.rollback("janus", result["transaction"])
        self.assertEqual(repeated["status"], "already-rolled-back")

    def test_zeus_is_excluded_by_default_and_forced_to_last_position(self) -> None:
        default = rollout.selected_aliases(None, self.fleet, include_zeus=False)
        self.assertNotIn("zeus", default)
        selected = rollout.selected_aliases("zeus,janus", self.fleet, include_zeus=True)
        self.assertEqual(selected, ["janus", "zeus"])

    def test_default_mode_gate_requires_real_tui_for_every_declared_harness(self) -> None:
        modes = rollout.parse_modes([], self.fleet)
        for alias in ("argos", "janus", "iza"):
            self.assertEqual(modes[alias], frozenset(("shell", "harness")))
        overridden = rollout.parse_modes(["iza=shell"], self.fleet)
        self.assertEqual(overridden["iza"], frozenset(("shell",)))

    def test_fleet_compensation_rolls_back_only_current_updates_in_reverse_order(self) -> None:
        server = FakeTransport()
        kratos = FakeTransport()
        failures = rollout.rollback_applied_results(
            {"server": server, "kratos": kratos},
            self.fleet,
            [
                {"status": "updated", "alias": "janus", "transaction": "txn-1"},
                {"status": "unchanged", "alias": "argos"},
                {"status": "updated", "alias": "salva", "transaction": "txn-2"},
            ],
        )
        self.assertEqual(failures, [])
        self.assertEqual(kratos.calls[0][1]["alias"], "salva")
        self.assertEqual(server.calls[0][1]["alias"], "janus")
        self.assertEqual(len(server.calls) + len(kratos.calls), 2)

    def test_selector_never_mentions_or_controls_the_zeus_adapter(self) -> None:
        temporary, worker, _ = self.worker("server")
        self.addCleanup(temporary.cleanup)
        release = worker.release_path(self.bundle.release_sha)
        body = worker._selector(self.bundle.release_sha, release).decode()
        self.assertIn("cauce-v3-pty@", worker._unit("zeus"))
        self.assertNotIn("cauce-v3-container", body)
        self.assertNotIn("adapter", body.lower())

    def test_selector_is_alias_neutral_environment_only_without_execstart(self) -> None:
        """A conf cloned to another alias must work as-is: no ExecStart, no alias name."""
        temporary, worker, _ = self.worker("server")
        self.addCleanup(temporary.cleanup)
        release = worker.release_path(self.bundle.release_sha)
        body = worker._selector(self.bundle.release_sha, release).decode()
        self.assertNotIn("ExecStart", body)
        directives = [line for line in body.splitlines() if line and not line.startswith("#")]
        self.assertEqual(directives, [
            "[Service]",
            f"Environment=CAUCE_PTY_OPS_ROOT={release}",
            f"Environment=CAUCE_PTY_AGENT_VERSION={self.bundle.release_sha}",
        ])
        neutral = body.replace(str(release), "")
        for alias in sorted(self.fleet.aliases):
            self.assertNotIn(alias, neutral, f"el conf del release menciona el alias {alias}")

    def test_unit_template_execstart_honours_ops_root_and_instance(self) -> None:
        """With no ExecStart in the drop-in, the template must resolve the launcher itself."""
        text = (AGENT_ROOT / "systemd/cauce-v3-pty@.service").read_text(encoding="utf-8")
        exec_lines = [line for line in text.splitlines() if line.startswith("ExecStart=")]
        self.assertEqual(len(exec_lines), 1, "el template debe declarar exactamente un ExecStart")
        self.assertIn("${CAUCE_PTY_OPS_ROOT}", exec_lines[0].replace("$$", "$"))
        self.assertIn("%i", exec_lines[0])
        self.assertIn("cauce-pty-launcher.sh", exec_lines[0])


class ReleaseInputsCoverTheWholeAgentPackage(unittest.TestCase):
    """Un modulo que no viaja en el release arranca con ModuleNotFoundError y exit 1, que no esta
    en RestartPreventExitStatus: la unidad reintenta para siempre y el alias no vuelve nunca.
    Ni el preflight del launcher (solo mira `__main__.py`) ni `validate_release` (solo mira lo
    listado) pueden verlo, asi que la lista se compara aqui contra el paquete en disco.

    La comparacion cubre TODO fichero del paquete, no solo los `.py`: el contrato de gobierno
    viaja como dato junto al modulo que lo carga al importarse, y si no viajara el agente moriria
    igual, con GovernanceContractError en vez de ModuleNotFoundError."""

    def _listed_and_on_disk(self) -> tuple[set[str], set[str]]:
        prefix = importlib.import_module("rollout_pty_lib").AGENT_PACKAGE_PREFIX
        listed = {path for path in rollout.RELEASE_FILES if path.startswith(prefix)}
        on_disk = {
            f"{prefix}{path.name}" for path in (OPS_ROOT / prefix).glob("*") if path.is_file()
        }
        return listed, on_disk

    def test_every_module_of_the_package_is_a_release_input(self) -> None:
        listed, on_disk = self._listed_and_on_disk()
        self.assertEqual(listed, on_disk, "RELEASE_FILES y el paquete en disco han divergido")

    def test_control_negativo_the_comparison_is_not_two_empty_sets(self) -> None:
        listed, on_disk = self._listed_and_on_disk()
        self.assertIn("pty-agent/cauce_pty_agent/__main__.py", listed)
        self.assertGreater(len(on_disk), 1, "el glob del paquete no encontro modulos")


if __name__ == "__main__":
    unittest.main()
