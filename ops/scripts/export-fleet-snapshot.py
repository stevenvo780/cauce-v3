#!/usr/bin/env python3
"""Export the canonical, versioned fleet snapshot from PostgreSQL."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import subprocess
import sys
from typing import Any

from atomic_file import atomic_write
from fleet_derive import RUNTIME_KEY_PATTERN, SYSTEMD_USER, room_id, runtime_state_directory

PROJECT = pathlib.Path(__file__).resolve().parents[2]
OPS_DIR = PROJECT / "ops"
QUERY_PATH = pathlib.Path(__file__).with_name("fleet-query.sql")
DEFAULT_OUT = OPS_DIR / "flota.json"
DEFAULT_PLACEMENT = OPS_DIR / "flota-fisica.json"
PRIVATE_POSTGRES = pathlib.Path(__file__).with_name("private-postgres-command.py")
CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
PLACEMENT_KEYS = frozenset({"dockerHost", "registryContainer", "healthContainer", "systemdUser"})
PLACEMENT_NAME = re.compile(r"^[a-z][a-z0-9.-]*$")
HOST_NAME = re.compile(r"^[a-z][a-z0-9_.-]{0,63}$")
SYSTEMD_USER_NAME = re.compile(r"^[a-z_][a-z0-9_.-]{0,63}$")
READ_ONLY_OPTIONS = "-c default_transaction_read_only=on"
TENANT_PATTERN = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
ALIAS_PATTERN = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")

AGENT_FIELDS = frozenset(
    {
        "tenant_id",
        "alias",
        "harness_id",
        "enabled",
        "container_name",
        "runtime_user",
        "home_directory",
        "state_directory",
    }
)
AGENT_OPTIONAL_FIELDS = frozenset({"runtime_key", "primary_room_id", "lifecycle_state", "host_id",
                                   "runtime_mode", "systemd_user"})
BOOTSTRAP_LIFECYCLES = frozenset({"draft", "provisioning", "auth_pending", "verifying"})
LIFECYCLES = BOOTSTRAP_LIFECYCLES | {"ready", "failed", "retiring", "retired"}
MEMBERSHIP_FIELDS = frozenset(
    {
        "tenant_id",
        "alias",
        "room_id",
        "role",
        "enabled",
    }
)
POLICY_FIELDS = frozenset({"role"})


class SnapshotError(ValueError):
    """Raised when database or overlay data cannot form one fleet snapshot."""


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SnapshotError(f"{label} must be an object")
    if any(not isinstance(key, str) for key in value):
        raise SnapshotError(f"{label} has a non-string key")
    return value


def _rows(value: Any, label: str) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise SnapshotError(f"{label} must be an array")
    return [_object(row, f"{label}[{index}]") for index, row in enumerate(value)]


def _exact_fields(row: dict[str, Any], fields: frozenset[str], label: str) -> None:
    observed = frozenset(row)
    if observed != fields:
        missing = sorted(fields - observed)
        extra = sorted(observed - fields)
        raise SnapshotError(f"{label} fields differ: missing={missing}, extra={extra}")


def _text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value or value != value.strip():
        raise SnapshotError(f"{label} must be a non-empty trimmed string")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise SnapshotError(f"{label} contains control characters")
    return value


def _optional_text(value: Any, label: str) -> str | None:
    if value is None:
        return None
    return _text(value, label)


def _boolean(value: Any, label: str) -> bool:
    if type(value) is not bool:
        raise SnapshotError(f"{label} must be a boolean")
    return value


def _identifier(value: Any, pattern: re.Pattern[str], label: str) -> str:
    text = _text(value, label)
    if pattern.fullmatch(text) is None:
        raise SnapshotError(f"{label} is invalid")
    return text


def _identity(
    row: dict[str, Any], label: str, allowed_tenants: frozenset[str] | None,
) -> tuple[str, str]:
    tenant = _identifier(row["tenant_id"], TENANT_PATTERN, f"{label}.tenant_id")
    alias = _identifier(row["alias"], ALIAS_PATTERN, f"{label}.alias")
    if allowed_tenants is not None and tenant not in allowed_tenants:
        raise SnapshotError(f"{label}.tenant_id is outside the allowed tenants")
    return tenant, alias


def validate_placement(value: Any) -> dict[str, dict[str, str]]:
    placement = _object(value, "physical fleet overlay placement")
    normalized: dict[str, dict[str, str]] = {}
    for raw_alias, raw_entry in placement.items():
        alias = _identifier(raw_alias, RUNTIME_KEY_PATTERN, "physical fleet overlay runtime key")
        entry = _object(raw_entry, f"placement.{alias}")
        unknown = sorted(set(entry) - PLACEMENT_KEYS)
        if unknown:
            raise SnapshotError(f"placement.{alias} has unsupported keys: {unknown}")
        normalized_entry = {key: _text(value, f"placement.{alias}.{key}") for key, value in entry.items()}
        for key, pattern in (("dockerHost", HOST_NAME), ("systemdUser", SYSTEMD_USER_NAME)):
            if key in normalized_entry and pattern.fullmatch(normalized_entry[key]) is None:
                raise SnapshotError(f"placement.{alias}.{key} must be a safe name")
        normalized[alias] = normalized_entry
    return normalized


def validate_placement_defaults(
    placement: dict[str, dict[str, str]],
    fleet: dict[str, dict[str, Any]],
) -> None:
    for alias, entry in placement.items():
        if not entry:
            raise SnapshotError(f"placement.{alias} is empty and redundant")
        container = fleet[alias]["container"]
        health_container = entry.get("healthContainer", container)
        if entry.get("dockerHost") == "local":
            raise SnapshotError(f"placement.{alias}.dockerHost repeats its default: local")
        if entry.get("healthContainer") == container:
            raise SnapshotError(f"placement.{alias}.healthContainer repeats its default: {container}")
        if entry.get("registryContainer") == health_container:
            raise SnapshotError(f"placement.{alias}.registryContainer repeats its default: {health_container}")


def load_placement(path: pathlib.Path | None = DEFAULT_PLACEMENT) -> dict[str, dict[str, str]]:
    if path is None or not path.exists():
        return {}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SnapshotError("physical fleet overlay is not readable JSON") from exc
    root = _object(document, "physical fleet overlay")
    if (
        set(root) != {"schemaVersion", "placement"}
        or type(root["schemaVersion"]) is not int
        or root["schemaVersion"] != 1
    ):
        raise SnapshotError("physical fleet overlay must have schemaVersion 1 and placement only")
    return validate_placement(root["placement"])


def _roles(policies: list[dict[str, Any]]) -> set[str]:
    roles: set[str] = set()
    for index, policy in enumerate(policies):
        label = f"rolePolicies[{index}]"
        _exact_fields(policy, POLICY_FIELDS, label)
        role = _text(policy["role"], f"{label}.role")
        if role in roles:
            raise SnapshotError(f"duplicate role policy: {role}")
        roles.add(role)
    return roles


def _memberships(
    memberships: list[dict[str, Any]], roles: set[str], allowed_tenants: frozenset[str] | None,
    *, include_disabled: bool = False,
) -> dict[tuple[str, str], list[dict[str, str]]]:
    memberships_by_identity: dict[tuple[str, str], list[dict[str, str]]] = {}
    observed: set[tuple[str, str, str]] = set()
    for index, membership in enumerate(memberships):
        label = f"memberships[{index}]"
        _exact_fields(membership, MEMBERSHIP_FIELDS, label)
        identity = _identity(membership, label, allowed_tenants)
        try:
            room = room_id(membership["room_id"])
        except ValueError as exc:
            raise SnapshotError(f"{label}.room_id is invalid") from exc
        role = _text(membership["role"], f"{label}.role")
        enabled = _boolean(membership["enabled"], f"{label}.enabled")
        if role not in roles:
            raise SnapshotError(f"{label}.role has no role policy: {role}")
        membership_key = (*identity, room)
        if membership_key in observed:
            raise SnapshotError(f"duplicate membership: {identity[0]}/{identity[1]}/{room}")
        observed.add(membership_key)
        if enabled or include_disabled:
            row = {"room": room, "role": role}
            if include_disabled:
                row["enabled"] = enabled
            memberships_by_identity.setdefault(identity, []).append(row)
    return {identity: sorted(rows, key=lambda row: row["room"])
            for identity, rows in memberships_by_identity.items()}


def _agents(
    agents: list[dict[str, Any]], allowed_tenants: frozenset[str] | None,
) -> dict[tuple[str, str], dict[str, Any]]:
    agents_by_identity: dict[tuple[str, str], dict[str, Any]] = {}
    runtime_identities: dict[str, tuple[str, str]] = {}
    for index, agent in enumerate(agents):
        label = f"agents[{index}]"
        if set(agent) - AGENT_OPTIONAL_FIELDS != AGENT_FIELDS:
            _exact_fields(agent, AGENT_FIELDS | AGENT_OPTIONAL_FIELDS, label)
        identity = _identity(agent, label, allowed_tenants)
        tenant, alias = identity
        lifecycle = _optional_text(agent.get("lifecycle_state"), f"{label}.lifecycle_state")
        if lifecycle is not None and lifecycle not in LIFECYCLES:
            raise SnapshotError(f"{label}.lifecycle_state is invalid")
        raw_runtime_key = agent.get("runtime_key")
        enabled = _boolean(agent["enabled"], f"{label}.enabled")
        runtime_key = None if raw_runtime_key is None and lifecycle is not None and not enabled else \
            _identifier(alias if raw_runtime_key is None else raw_runtime_key, RUNTIME_KEY_PATTERN, f"{label} runtime key")
        primary_room = _optional_text(agent.get("primary_room_id"), f"{label}.primary_room_id")
        harness = _optional_text(agent["harness_id"], f"{label}.harness_id")
        container = _optional_text(agent["container_name"], f"{label}.container_name")
        user = _optional_text(agent["runtime_user"], f"{label}.runtime_user")
        home = _optional_text(agent["home_directory"], f"{label}.home_directory")
        state_directory = _optional_text(agent["state_directory"], f"{label}.state_directory")
        host_id = _optional_text(agent.get("host_id"), f"{label}.host_id")
        runtime_mode = _optional_text(agent.get("runtime_mode"), f"{label}.runtime_mode")
        systemd_user = _optional_text(agent.get("systemd_user"), f"{label}.systemd_user")
        if host_id is not None and ALIAS_PATTERN.fullmatch(host_id) is None:
            raise SnapshotError(f"{label}.host_id is invalid")
        if runtime_mode is not None and runtime_mode not in {"container", "native"}:
            raise SnapshotError(f"{label}.runtime_mode is invalid")
        if systemd_user is not None and SYSTEMD_USER_NAME.fullmatch(systemd_user) is None:
            raise SnapshotError(f"{label}.systemd_user is invalid")
        if runtime_mode is not None and container is not None and \
                (runtime_mode == "native") != container.startswith(("host:", "vm:")):
            raise SnapshotError(f"{label}.runtime_mode differs from its container placement")
        if identity in agents_by_identity:
            raise SnapshotError(f"duplicate agent: {tenant}/{alias}")
        if runtime_key is not None and runtime_key in runtime_identities:
            raise SnapshotError(f"duplicate runtime key: {runtime_key}")
        if runtime_key is not None:
            runtime_identities[runtime_key] = identity
        if enabled and None in (harness, container, user, home, state_directory):
            raise SnapshotError(f"enabled agent has incomplete runtime placement: {tenant}/{alias}")
        normalized_agent = {
            "alias": alias,
            "runtimeKey": runtime_key,
            "primaryRoom": primary_room,
            "lifecycleState": lifecycle,
            "hostId": host_id,
            "runtimeMode": runtime_mode,
            "systemdUser": systemd_user,
            "tenant": tenant,
            "harness": harness,
            "enabled": enabled,
            "container": container,
            "user": user,
            "home": home,
            "runtimeStateDirectory": state_directory,
        }
        if enabled:
            try:
                expected_state_directory = runtime_state_directory(runtime_key, normalized_agent)
            except ValueError as exc:
                raise SnapshotError(f"{label}.harness_id is unsupported: {harness}") from exc
            if state_directory != expected_state_directory:
                print(
                    f"aviso: {label}.state_directory drifts from the derived runtime path: "
                    f"expected {expected_state_directory}, got {state_directory}",
                    file=sys.stderr,
                )
        agents_by_identity[identity] = normalized_agent
    return agents_by_identity


def _runtime_row(agent: dict[str, Any], membership: dict[str, Any]) -> dict[str, Any]:
    row = {field: agent[field] for field in ("tenant", "harness", "enabled", "container", "user", "home",
                                          "runtimeStateDirectory")}
    row.update(room=membership["room"], role=membership["role"])
    if agent["alias"] != agent["runtimeKey"]:
        row["alias"] = agent["alias"]
    for field in ("hostId", "runtimeMode", "systemdUser"):
        if agent[field] is not None:
            row[field] = agent[field]
    return row


def _bootstrap_row(agent: dict[str, Any], memberships: list[dict[str, Any]]) -> dict[str, Any] | None:
    fields = ("runtimeKey", "harness", "container", "user", "home", "runtimeStateDirectory", "primaryRoom",
              "hostId", "runtimeMode", "systemdUser")
    if agent["lifecycleState"] not in BOOTSTRAP_LIFECYCLES or any(agent[field] is None for field in fields):
        return None
    primary = next((row for row in memberships if row["room"] == agent["primaryRoom"]), None)
    if primary is None:
        raise SnapshotError(f"bootstrap primary room has no membership: {agent['tenant']}/{agent['alias']}")
    return {**_runtime_row(agent, primary), "admission": False,
            "lifecycleState": agent["lifecycleState"], "memberships": memberships}


def _primary_membership(
    identity: tuple[str, str], rows: list[dict[str, str]], primary: str | None,
) -> dict[str, str]:
    if not rows:
        raise SnapshotError(f"enabled agent has no enabled membership: {identity[0]}/{identity[1]}")
    if primary is None and len(rows) == 1:
        return rows[0]
    for row in rows:
        if row["room"] == primary:
            return row
    raise SnapshotError(f"agent requires an enabled primary membership: {identity[0]}/{identity[1]}")


def snapshot_document(
    source: Any,
    placement: dict[str, dict[str, str]] | None = None,
    allowed_tenants: frozenset[str] | None = None,
) -> dict[str, Any]:
    root = _object(source, "fleet query result")
    if set(root) != {"agents", "memberships", "rolePolicies"}:
        raise SnapshotError("fleet query result must contain agents, memberships and rolePolicies")
    roles = _roles(_rows(root["rolePolicies"], "rolePolicies"))
    member_rows = _rows(root["memberships"], "memberships")
    memberships_by_identity = _memberships(member_rows, roles, allowed_tenants)
    all_memberships = _memberships(member_rows, roles, allowed_tenants, include_disabled=True)
    agents_by_identity = _agents(_rows(root["agents"], "agents"), allowed_tenants)

    fleet: dict[str, dict[str, Any]] = {}
    retired: dict[str, dict[str, Any]] = {}
    bootstrap: dict[str, dict[str, Any]] = {}
    for identity, agent in agents_by_identity.items():
        memberships = memberships_by_identity.pop(identity, [])
        runtime_key = agent["runtimeKey"]
        if agent["enabled"]:
            membership = _primary_membership(identity, memberships, agent["primaryRoom"])
            row = _runtime_row(agent, membership)
            if len(memberships) > 1:
                row["memberships"] = memberships
            fleet[runtime_key] = row
        else:
            row = _bootstrap_row(agent, all_memberships.get(identity, []))
            if row is not None:
                bootstrap[runtime_key] = row
            elif runtime_key is not None and agent["lifecycleState"] not in BOOTSTRAP_LIFECYCLES:
                retired[runtime_key] = {}

    system_principals: dict[str, dict[str, Any]] = {}
    aliases = [identity[1] for identity in memberships_by_identity]
    for identity, memberships in memberships_by_identity.items():
        alias = identity[1]
        key = alias if RUNTIME_KEY_PATTERN.fullmatch(alias) and aliases.count(alias) == 1 \
            and alias not in fleet and alias not in retired and alias not in bootstrap else \
            "principal-" + hashlib.sha256(f"{identity[0]}\0{alias}".encode("utf-8")).hexdigest()[:40]
        if key in system_principals or key in fleet or key in retired or key in bootstrap:
            raise SnapshotError(f"system principal catalog key collision: {identity[0]}/{alias}")
        principal = {"tenant": identity[0]}
        if alias != key:
            principal["alias"] = alias
        principal.update(memberships[0] if len(memberships) == 1 else {"memberships": memberships})
        system_principals[key] = principal
    physical = validate_placement(placement or {})
    for agent in agents_by_identity.values():
        key = agent["runtimeKey"]
        if key not in fleet and key not in bootstrap:
            continue
        overlay = dict(physical.get(key, {}))
        for field, property_name, default in (("hostId", "dockerHost", "local"),
                                             ("systemdUser", "systemdUser", SYSTEMD_USER)):
            if agent[field] is not None:
                overlay.pop(property_name, None)
                if agent[field] != default:
                    overlay[property_name] = agent[field]
        if overlay:
            physical[key] = overlay
        else:
            physical.pop(key, None)
    known_keys = {agent["runtimeKey"] for agent in agents_by_identity.values() if agent["runtimeKey"] is not None}
    unknown_placement = sorted(set(physical) - known_keys)
    if unknown_placement:
        raise SnapshotError(f"physical fleet overlay names non-fleet aliases: {unknown_placement}")
    physical = {key: row for key, row in physical.items() if key in fleet or key in bootstrap}
    validate_placement_defaults(physical, {**fleet, **bootstrap})

    document = {
        "schemaVersion": 1,
        "fleet": fleet,
        "systemPrincipals": system_principals,
        "retired": retired,
        "placement": physical,
    }
    if bootstrap:
        document["bootstrap"] = bootstrap
    return document


def canonical_bytes(document: dict[str, Any]) -> bytes:
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _query_text(path: pathlib.Path = QUERY_PATH) -> str:
    try:
        query = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise SnapshotError("fleet query is not readable") from exc
    if not query.strip():
        raise SnapshotError("fleet query is empty")
    return query


def _completed_payload(completed: subprocess.CompletedProcess[str]) -> Any:
    if completed.returncode != 0:
        raise SnapshotError("fleet query failed")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as exc:
        raise SnapshotError("fleet query did not return one JSON document") from exc
    if not isinstance(payload, dict):
        raise SnapshotError("fleet query did not return a JSON object")
    return payload


def query_database(
    *,
    database_url_file: pathlib.Path | None = None,
    postgres_container: str | None = None,
    query_path: pathlib.Path = QUERY_PATH,
    private_postgres: pathlib.Path = PRIVATE_POSTGRES,
) -> Any:
    if (database_url_file is None) == (postgres_container is None):
        raise SnapshotError("select exactly one PostgreSQL connection method")
    query = _query_text(query_path)
    if database_url_file is not None:
        if not database_url_file.is_absolute():
            raise SnapshotError("database URL file must be absolute")
        command = [
            sys.executable,
            os.fspath(private_postgres),
            os.fspath(database_url_file),
            "--",
            "env",
            f"PGOPTIONS={READ_ONLY_OPTIONS}",
            "psql",
            "-XAtq",
            "--no-password",
            "--set=ON_ERROR_STOP=1",
        ]
    else:
        assert postgres_container is not None
        if not CONTAINER_NAME.fullmatch(postgres_container):
            raise SnapshotError("PostgreSQL container name is invalid")
        command = [
            "docker",
            "exec",
            "-i",
            "--env",
            f"PGOPTIONS={READ_ONLY_OPTIONS}",
            postgres_container,
            "sh",
            "-eu",
            "-c",
            'exec psql -XAtq --no-password -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$@"',
            "cauce-fleet-export",
            "--set=ON_ERROR_STOP=1",
        ]
    try:
        completed = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            input=query,
        )
    except OSError as exc:
        raise SnapshotError("cannot run the fleet query") from exc
    return _completed_payload(completed)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    database = parser.add_mutually_exclusive_group()
    database.add_argument("--database-url-file", type=pathlib.Path)
    database.add_argument("--postgres-container")
    parser.add_argument("--placement", type=pathlib.Path, default=DEFAULT_PLACEMENT)
    parser.add_argument("--out", type=pathlib.Path, default=DEFAULT_OUT)
    parser.add_argument("--check", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    database_url_file = args.database_url_file
    if database_url_file is None and args.postgres_container is None:
        configured_file = os.environ.get("DATABASE_URL_FILE")
        if not configured_file:
            parser.error("--database-url-file or --postgres-container is required")
        database_url_file = pathlib.Path(configured_file)
    try:
        source = query_database(
            database_url_file=database_url_file,
            postgres_container=args.postgres_container,
        )
        placement = load_placement(args.placement)
        body = canonical_bytes(snapshot_document(source, placement))
        if args.check:
            try:
                current = args.out.read_bytes()
            except OSError:
                current = None
            if current != body:
                print(f"fleet snapshot differs: {args.out}", file=sys.stderr)
                return 3
            return 0
        atomic_write(args.out, body)
        return 0
    except (OSError, SnapshotError) as exc:
        print(f"export-fleet-snapshot: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
