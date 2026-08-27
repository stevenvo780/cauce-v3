#!/usr/bin/env python3
"""Rollout transaccional del agente PTY en los dos managers de la flota.

El controlador se ejecuta desde un checkout de Cauce. El mismo fichero se envia como codigo
efimero al manager remoto: no presupone que el host ya tenga una copia mutable del deployer. Las
releases, en cambio, si quedan publicadas por digest y nunca se sobrescriben.

Este programa no lee ni transporta el contenido de configuraciones, claves o certificados. El
preflight local existente los valida en el manager que ya los custodia.
"""
from __future__ import annotations

import argparse
import base64
import dataclasses
import os
import pathlib
import re
import shlex
import subprocess
import sys
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

_agent_dir = str(pathlib.Path(__file__).resolve().parent)
if _agent_dir not in sys.path:
    sys.path.insert(0, _agent_dir)

from rollout_pty_lib import (
    EXECUTABLE_FILES,
    MANAGERS,
    MODE_RE,
    NAME_RE,
    RELEASE_FILES,
    RETIRED_REQUIRED_DISABLED,
    SCHEMA_VERSION,
    SHA_RE,
    UNIT_RE,
    CommandResult,
    Fleet,
    ManagerWorker,
    ReleaseBundle,
    RolloutError,
    Runner,
    UnitPresence,
    atomic_write,
    canonical_json,
    decode_release_request,
    duplicate_safe_json,
    fail,
    fsync_directory,
    manager_for_entry,
    require_ok,
    safe_directory,
    safe_regular,
    sha256,
)


def inventory_value(inventory: Mapping[str, UnitPresence]) -> dict[str, Any]:
    return {
        alias: dataclasses.asdict(presence)
        for alias, presence in sorted(inventory.items())
    }


def parse_inventory(value: Mapping[str, Any]) -> dict[str, UnitPresence]:
    parsed: dict[str, UnitPresence] = {}
    for alias, raw in value.items():
        if NAME_RE.fullmatch(alias) is None or not isinstance(raw, dict):
            fail("inventario remoto contiene un alias invalido")
        if set(raw) != {"enabled", "active", "selector"} or not all(isinstance(item, bool) for item in raw.values()):
            fail(f"inventario remoto de {alias} es invalido")
        parsed[alias] = UnitPresence(**raw)
    return parsed


def validate_inventories(fleet: Fleet, inventories: Mapping[str, Mapping[str, UnitPresence]], *, migrate_kant: bool) -> None:
    if set(inventories) != set(MANAGERS):
        fail("faltan inventarios de los dos managers")
    observed: dict[str, list[str]] = {}
    for manager, inventory in inventories.items():
        for alias, presence in inventory.items():
            if not presence.present:
                continue
            if alias in fleet.retired:
                fail(f"alias retirado {alias} sigue presente en {manager}")
            if alias not in fleet.aliases:
                fail(f"alias desconocido {alias} sigue presente en {manager}")
            observed.setdefault(alias, []).append(manager)
    duplicates = {alias: managers for alias, managers in observed.items() if len(managers) > 1}
    if duplicates:
        fail(f"aliases PTY duplicados entre managers: {duplicates}")
    for alias, managers in observed.items():
        actual = managers[0]
        desired = fleet.placements[alias]
        if actual == desired:
            continue
        if alias == "kant" and actual == "kratos" and desired == "server" and migrate_kant:
            continue
        if alias == "kant" and actual == "kratos" and desired == "server":
            fail("kant requiere --migrate-kant para retirar kratos antes de activar server")
        fail(f"placement drift de {alias}: observado={actual} esperado={desired}")


class Transport:
    def call(self, operation: str, request: Mapping[str, Any]) -> dict[str, Any]:
        raise NotImplementedError


class ProcessTransport(Transport):
    def __init__(self, manager: str, target: str, script: pathlib.Path) -> None:
        self.manager = manager
        self.target = target
        self.script = script

    def call(self, operation: str, request: Mapping[str, Any]) -> dict[str, Any]:
        payload = canonical_json(dict(request))
        if self.target == "local":
            argv = [sys.executable, str(self.script), "--worker", operation, "--manager", self.manager]
        elif self.target.startswith(("ssh:", "sudo-ssh:")):
            sudo_user: str | None = None
            if self.target.startswith("sudo-ssh:"):
                parts = self.target.split(":")
                if len(parts) != 3:
                    fail(f"target sudo-ssh invalido para {self.manager}")
                _, host, sudo_user = parts
                if NAME_RE.fullmatch(sudo_user) is None:
                    fail(f"usuario sudo-ssh invalido para {self.manager}")
            else:
                host = self.target.removeprefix("ssh:")
            if NAME_RE.fullmatch(host) is None:
                fail(f"target SSH invalido para {self.manager}")
            source = base64.b64encode(self.script.read_bytes()).decode("ascii")
            lib_path = self.script.parent / "rollout_pty_lib.py"
            lib_source = base64.b64encode(lib_path.read_bytes()).decode("ascii")
            bootstrap = (
                "import base64,sys,types;"
                "lib=types.ModuleType('rollout_pty_lib');"
                "lib_code=base64.b64decode(sys.argv[1],validate=True);"
                "exec(compile(lib_code,'rollout_pty_lib.py','exec'),lib.__dict__);"
                "sys.modules['rollout_pty_lib']=lib;"
                "code=base64.b64decode(sys.argv[2],validate=True);"
                "sys.argv=sys.argv[3:];"
                "exec(compile(code,'rollout-pty.py','exec'),{'__name__':'__main__'})"
            )
            worker = " ".join(
                shlex.quote(item)
                for item in (
                    "python3", "-c", bootstrap, lib_source, source,
                    "rollout-pty.py", "--worker", operation, "--manager", self.manager,
                )
            )
            if sudo_user is None:
                remote = worker
            else:
                quoted_user = shlex.quote(sudo_user)
                remote = (
                    f"set -eu; uid=$(id -u -- {quoted_user}); "
                    f"exec sudo -Hu {quoted_user} env "
                    'XDG_RUNTIME_DIR="/run/user/$uid" '
                    'DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" '
                    f"{worker}"
                )
            argv = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host, remote]
        else:
            fail(f"target de manager invalido: {self.target}")
        process = subprocess.run(
            argv,
            input=payload,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=180,
            check=False,
        )
        if process.returncode != 0:
            fail(f"operacion {operation} fallo en manager {self.manager} con codigo {process.returncode}")
        response = duplicate_safe_json(process.stdout, f"respuesta de {self.manager}/{operation}")
        if response.get("ok") is not True or not isinstance(response.get("result"), dict):
            fail(f"respuesta de {self.manager}/{operation} no acredita exito")
        return response["result"]


def parse_targets(values: Sequence[str]) -> dict[str, str]:
    targets: dict[str, str] = {}
    for value in values:
        manager, separator, target = value.partition("=")
        if not separator or manager not in MANAGERS or not target or manager in targets:
            fail(f"--manager invalido: {value}")
        targets[manager] = target
    if set(targets) != set(MANAGERS):
        fail("hay que declarar exactamente los managers server y kratos")
    return targets


def parse_modes(values: Sequence[str], fleet: Fleet) -> dict[str, frozenset[str]]:
    result = {
        alias: frozenset(("shell", "harness"))
        if entry.get("harness") in {"claude", "codex", "openclaw", "hermes"}
        else frozenset(("shell",))
        for alias, entry in fleet.aliases.items()
    }
    for value in values:
        alias, separator, modes_text = value.partition("=")
        modes = modes_text.split(",") if separator else []
        if alias not in fleet.aliases or not modes or any(MODE_RE.fullmatch(mode) is None for mode in modes):
            fail(f"--require-mode invalido: {value}")
        result[alias] = frozenset(modes)
    return result


def selected_aliases(value: str | None, fleet: Fleet, include_zeus: bool) -> list[str]:
    if value is None:
        aliases = sorted(fleet.aliases)
    else:
        aliases = value.split(",")
        if len(aliases) != len(set(aliases)) or any(alias not in fleet.aliases for alias in aliases):
            fail("--aliases contiene duplicados o aliases desconocidos")
    if "zeus" in aliases and not include_zeus:
        aliases.remove("zeus")
    return [alias for alias in aliases if alias != "zeus"] + (["zeus"] if "zeus" in aliases else [])


def rollback_applied_results(
    transports: Mapping[str, Transport],
    fleet: Fleet,
    results: Sequence[Mapping[str, Any]],
) -> list[str]:
    """Compensa en orden inverso sólo las mutaciones de esta invocación."""
    failures: list[str] = []
    for result in reversed(results):
        alias = result.get("alias")
        transaction = result.get("transaction")
        if not isinstance(alias, str) or not isinstance(transaction, str):
            continue
        manager = fleet.placements.get(alias)
        if manager is None:
            failures.append(alias)
            continue
        try:
            transports[manager].call(
                "rollback", {"alias": alias, "transaction": transaction}
            )
        except RolloutError:
            failures.append(alias)
    return failures


def controller(args: argparse.Namespace) -> dict[str, Any]:
    script = pathlib.Path(__file__).resolve()
    ops_root = script.parents[1]
    bundle = ReleaseBundle.from_ops_root(ops_root)
    fleet = Fleet.load(bundle.files["container-aliases.json"])
    targets = parse_targets(args.manager)
    transports = {
        manager: ProcessTransport(manager, targets[manager], script)
        for manager in MANAGERS
    }
    inventories = {
        manager: parse_inventory(transports[manager].call("inventory", {}).get("inventory", {}))
        for manager in MANAGERS
    }
    retirement_results: list[dict[str, Any]] = []
    if getattr(args, "preflight_only", False) and getattr(args, "retire_historical", False):
        fail("--preflight-only no puede combinarse con --retire-historical")
    if args.command == "retire-historical" or getattr(args, "retire_historical", False):
        for manager in MANAGERS:
            for alias, presence in sorted(inventories[manager].items()):
                if alias not in fleet.retired or not presence.present:
                    continue
                retirement_results.append(
                    transports[manager].call(
                        "deactivate-retired",
                        {"alias": alias, "bundle": bundle.request_value()},
                    )
                )
        inventories = {
            manager: parse_inventory(transports[manager].call("inventory", {}).get("inventory", {}))
            for manager in MANAGERS
        }
    validate_inventories(
        fleet,
        inventories,
        migrate_kant=args.migrate_kant or args.command == "retire-historical",
    )
    if args.command == "retire-historical":
        return {
            "status": "ok",
            "retired": retirement_results,
            "inventory": {manager: inventory_value(value) for manager, value in inventories.items()},
        }
    if args.command == "status":
        return {
            "status": "ok",
            "releaseSha": bundle.release_sha,
            "mappingSha256": bundle.mapping_sha,
            "inventory": {manager: inventory_value(value) for manager, value in inventories.items()},
        }
    if args.command == "rollback":
        alias = args.alias
        manager = fleet.placements.get(alias)
        if manager is None:
            fail("rollback solicitado para alias desconocido")
        result = transports[manager].call(
            "rollback", {"alias": alias, "transaction": args.transaction}
        )
        return {"status": "ok", "result": result}

    aliases = selected_aliases(args.aliases, fleet, args.include_zeus)
    modes = parse_modes(args.require_mode, fleet)
    preflight_results = []
    for alias in aliases:
        manager = fleet.placements[alias]
        preflight_results.append(
            transports[manager].call(
                "preflight",
                {
                    "bundle": bundle.request_value(),
                    "alias": alias,
                    "expectedManager": manager,
                },
            )
        )
    if args.command == "preflight" or args.preflight_only:
        return {
            "status": "ready",
            "releaseSha": bundle.release_sha,
            "mappingSha256": bundle.mapping_sha,
            "aliases": aliases,
            "preflight": preflight_results,
        }

    for manager in MANAGERS:
        transports[manager].call("publish", {"bundle": bundle.request_value()})

    kant_migration: dict[str, Any] | None = None
    if args.migrate_kant and inventories["kratos"].get("kant", UnitPresence()).present:
        kant_migration = transports["kratos"].call("deactivate-kant", {})
        refreshed = {
            manager: parse_inventory(transports[manager].call("inventory", {}).get("inventory", {}))
            for manager in MANAGERS
        }
        validate_inventories(fleet, refreshed, migrate_kant=False)

    results: list[dict[str, Any]] = []
    try:
        for alias in aliases:
            manager = fleet.placements[alias]
            results.append(
                transports[manager].call(
                    "apply",
                    {
                        "releaseSha": bundle.release_sha,
                        "alias": alias,
                        "expectedManager": manager,
                        "entryDigest": fleet.entry_digest(alias),
                        "requiredModes": sorted(modes[alias]),
                        "healthAttempts": args.health_attempts,
                        "healthDelay": args.health_delay,
                        "allowZeus": args.include_zeus,
                    },
                )
            )
    except BaseException as original:
        rollback_failures = rollback_applied_results(transports, fleet, results)
        if kant_migration is not None:
            try:
                transports["kratos"].call(
                    "rollback", {"alias": "kant", "transaction": kant_migration["transaction"]}
                )
            except RolloutError:
                rollback_failures.append("kant@kratos")
        if rollback_failures:
            fail(
                "el rollout fallo y la compensacion no pudo restaurar: "
                + ",".join(rollback_failures)
            )
        raise original
    return {
        "status": "ok",
        "releaseSha": bundle.release_sha,
        "mappingSha256": bundle.mapping_sha,
        "aliases": aliases,
        "results": results,
        "kantMigration": kant_migration,
        "retired": retirement_results,
    }


def worker(args: argparse.Namespace) -> dict[str, Any]:
    request = duplicate_safe_json(sys.stdin.buffer.read(), "request del worker")
    implementation = ManagerWorker(args.manager)
    operation = args.worker
    if operation == "inventory":
        return {"inventory": inventory_value(implementation.inventory())}
    if operation == "publish":
        return implementation.publish(decode_release_request(request.get("bundle", {})))
    if operation == "preflight":
        bundle = decode_release_request(request.get("bundle", {}))
        return implementation.preflight_alias(
            bundle,
            str(request.get("alias", "")),
            str(request.get("expectedManager", "")),
        )
    if operation == "apply":
        required = request.get("requiredModes")
        if not isinstance(required, list) or not required or any(not isinstance(mode, str) or MODE_RE.fullmatch(mode) is None for mode in required):
            fail("requiredModes es invalido")
        alias = str(request.get("alias", ""))
        if alias == "zeus" and request.get("allowZeus") is not True:
            fail("Zeus PTY solo se admite con --include-zeus y siempre al final")
        return implementation.apply(
            str(request.get("releaseSha", "")),
            alias,
            str(request.get("expectedManager", "")),
            str(request.get("entryDigest", "")),
            frozenset(required),
            attempts=int(request.get("healthAttempts", 20)),
            delay=float(request.get("healthDelay", 1.0)),
        )
    if operation == "rollback":
        transaction = request.get("transaction")
        if transaction is not None and (not isinstance(transaction, str) or "/" in transaction or transaction in {".", ".."}):
            fail("transaction de rollback invalida")
        return implementation.rollback(str(request.get("alias", "")), transaction)
    if operation == "deactivate-kant":
        return implementation.deactivate_for_migration("kant")
    if operation == "deactivate-retired":
        bundle = decode_release_request(request.get("bundle", {}))
        return implementation.deactivate_retired(str(request.get("alias", "")), bundle)
    fail(f"operacion de worker invalida: {operation}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    result.add_argument(
        "--worker",
        choices=(
            "inventory", "publish", "preflight", "apply", "rollback", "deactivate-kant",
            "deactivate-retired",
        ),
        help=argparse.SUPPRESS,
    )
    result.add_argument("--manager", action="append", default=[], metavar="MANAGER=TARGET")
    subparsers = result.add_subparsers(dest="command")
    for name in ("status", "preflight", "rollout"):
        command = subparsers.add_parser(name)
        command.add_argument("--manager", action="append", default=[])
        command.add_argument("--aliases")
        command.add_argument("--include-zeus", action="store_true")
        command.add_argument("--migrate-kant", action="store_true")
        command.add_argument("--require-mode", action="append", default=[])
        command.add_argument("--health-attempts", type=int, default=20)
        command.add_argument("--health-delay", type=float, default=1.0)
        if name == "rollout":
            command.add_argument("--preflight-only", action="store_true")
            command.add_argument("--retire-historical", action="store_true")
        else:
            command.set_defaults(preflight_only=False, retire_historical=False)
    rollback = subparsers.add_parser("rollback")
    rollback.add_argument("alias")
    rollback.add_argument("--transaction")
    rollback.add_argument("--manager", action="append", default=[])
    rollback.set_defaults(
        aliases=None,
        include_zeus=False,
        migrate_kant=False,
        require_mode=[],
        health_attempts=20,
        health_delay=1.0,
        preflight_only=False,
    )
    retirement = subparsers.add_parser("retire-historical")
    retirement.add_argument("--manager", action="append", default=[])
    retirement.set_defaults(
        aliases=None,
        include_zeus=False,
        migrate_kant=False,
        require_mode=[],
        health_attempts=20,
        health_delay=1.0,
        preflight_only=False,
        retire_historical=True,
    )
    return result


def main() -> int:
    arguments = parser().parse_args()
    try:
        if arguments.worker is not None:
            if len(arguments.manager) != 1 or "=" in arguments.manager[0]:
                fail("worker requiere --manager server o --manager kratos")
            arguments.manager = arguments.manager[0]
            output = worker(arguments)
        else:
            if arguments.command is None:
                parser().error("falta un comando")
            output = controller(arguments)
        sys.stdout.buffer.write(canonical_json({"ok": True, "result": output}))
        return 0
    except RolloutError as error:
        print(f"rollout-pty: {error}", file=sys.stderr)
        return 78
    except (OSError, subprocess.SubprocessError, ValueError) as error:
        print(f"rollout-pty: fallo operacional cerrado ({type(error).__name__})", file=sys.stderr)
        return 75


if __name__ == "__main__":
    raise SystemExit(main())
