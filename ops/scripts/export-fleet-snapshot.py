#!/usr/bin/env python3
"""Export the canonical, versioned fleet snapshot from PostgreSQL."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
from typing import Any

from fleet_derive import runtime_state_directory

PROJECT = pathlib.Path(__file__).resolve().parents[2]
OPS_DIR = PROJECT / "ops"
QUERY_PATH = pathlib.Path(__file__).with_name("fleet-query.sql")
SCHEMA_PATH = OPS_DIR / "schemas" / "alias-manifest.schema.json"
DEFAULT_OUT = OPS_DIR / "flota.json"
DEFAULT_PLACEMENT = OPS_DIR / "flota-fisica.json"
PRIVATE_POSTGRES = pathlib.Path(__file__).with_name("private-postgres-command.py")
CONTAINER_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$")
PLACEMENT_KEYS = frozenset({"dockerHost", "registryContainer", "healthContainer"})
DOCKER_HOSTS = frozenset({"local", "kratos"})
READ_ONLY_OPTIONS = "-c default_transaction_read_only=on"

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


def tenant_enum(schema_path: pathlib.Path = SCHEMA_PATH) -> frozenset[str]:
    try:
        schema = json.loads(schema_path.read_text(encoding="utf-8"))
        values = schema["properties"]["spec"]["properties"]["tenant"]["enum"]
    except (OSError, json.JSONDecodeError, KeyError, TypeError) as exc:
        raise SnapshotError("alias manifest schema has no readable tenant enum") from exc
    if (
        not isinstance(values, list)
        or not values
        or any(not isinstance(value, str) or not value for value in values)
        or len(values) != len(set(values))
    ):
        raise SnapshotError("alias manifest tenant enum is invalid")
    return frozenset(values)


def validate_placement(value: Any) -> dict[str, dict[str, str]]:
    placement = _object(value, "physical fleet overlay placement")
    normalized: dict[str, dict[str, str]] = {}
    for raw_alias, raw_entry in placement.items():
        alias = _text(raw_alias, "physical fleet overlay alias")
        entry = _object(raw_entry, f"placement.{alias}")
        unknown = sorted(set(entry) - PLACEMENT_KEYS)
        if unknown:
            raise SnapshotError(f"placement.{alias} has unsupported keys: {unknown}")
        normalized_entry = {key: _text(value, f"placement.{alias}.{key}") for key, value in entry.items()}
        docker_host = normalized_entry.get("dockerHost")
        if docker_host is not None and docker_host not in DOCKER_HOSTS:
            raise SnapshotError(f"placement.{alias}.dockerHost must be one of {sorted(DOCKER_HOSTS)}")
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


def snapshot_document(
    source: Any,
    placement: dict[str, dict[str, str]] | None = None,
    allowed_tenants: frozenset[str] | None = None,
) -> dict[str, Any]:
    root = _object(source, "fleet query result")
    expected_root = {"agents", "memberships", "rolePolicies"}
    if set(root) != expected_root:
        raise SnapshotError("fleet query result must contain agents, memberships and rolePolicies")

    tenants = allowed_tenants if allowed_tenants is not None else tenant_enum()
    agents = _rows(root["agents"], "agents")
    memberships = _rows(root["memberships"], "memberships")
    policies = _rows(root["rolePolicies"], "rolePolicies")

    roles: set[str] = set()
    for index, policy in enumerate(policies):
        label = f"rolePolicies[{index}]"
        _exact_fields(policy, POLICY_FIELDS, label)
        role = _text(policy["role"], f"{label}.role")
        if role in roles:
            raise SnapshotError(f"duplicate role policy: {role}")
        roles.add(role)

    memberships_by_identity: dict[tuple[str, str], dict[str, Any]] = {}
    alias_identities: dict[str, tuple[str, str]] = {}
    for index, membership in enumerate(memberships):
        label = f"memberships[{index}]"
        _exact_fields(membership, MEMBERSHIP_FIELDS, label)
        tenant = _text(membership["tenant_id"], f"{label}.tenant_id")
        alias = _text(membership["alias"], f"{label}.alias")
        room = _text(membership["room_id"], f"{label}.room_id")
        role = _text(membership["role"], f"{label}.role")
        _boolean(membership["enabled"], f"{label}.enabled")
        if tenant not in tenants:
            if membership["enabled"] is False:
                # Disabled membership of a retired tenant: message history keeps it alive via FK.
                print(f"{label}: skipping disabled membership of retired tenant {tenant}", file=sys.stderr)
                continue
            raise SnapshotError(f"{label}.tenant_id is outside the alias manifest tenant enum")
        if role not in roles:
            raise SnapshotError(f"{label}.role has no role policy: {role}")
        identity = (tenant, alias)
        if identity in memberships_by_identity:
            raise SnapshotError(f"membership is not 1:1 for {tenant}/{alias}")
        prior_identity = alias_identities.get(alias)
        if prior_identity is not None and prior_identity != identity:
            raise SnapshotError(f"alias is not globally unique: {alias}")
        alias_identities[alias] = identity
        memberships_by_identity[identity] = {
            "tenant": tenant,
            "room": room,
            "role": role,
        }

    agents_by_identity: dict[tuple[str, str], dict[str, Any]] = {}
    for index, agent in enumerate(agents):
        label = f"agents[{index}]"
        _exact_fields(agent, AGENT_FIELDS, label)
        tenant = _text(agent["tenant_id"], f"{label}.tenant_id")
        alias = _text(agent["alias"], f"{label}.alias")
        enabled = _boolean(agent["enabled"], f"{label}.enabled")
        harness = _optional_text(agent["harness_id"], f"{label}.harness_id")
        container = _optional_text(agent["container_name"], f"{label}.container_name")
        user = _optional_text(agent["runtime_user"], f"{label}.runtime_user")
        home = _optional_text(agent["home_directory"], f"{label}.home_directory")
        state_directory = _optional_text(agent["state_directory"], f"{label}.state_directory")
        if tenant not in tenants:
            raise SnapshotError(f"{label}.tenant_id is outside the alias manifest tenant enum")
        identity = (tenant, alias)
        if identity in agents_by_identity:
            raise SnapshotError(f"duplicate agent: {tenant}/{alias}")
        prior_identity = alias_identities.get(alias)
        if prior_identity is not None and prior_identity != identity:
            raise SnapshotError(f"alias is not globally unique: {alias}")
        alias_identities[alias] = identity
        if enabled and None in (harness, container, user, home, state_directory):
            raise SnapshotError(f"enabled agent has incomplete runtime placement: {tenant}/{alias}")
        normalized_agent = {
            "alias": alias,
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
                expected_state_directory = runtime_state_directory(alias, normalized_agent)
            except ValueError as exc:
                raise SnapshotError(f"{label}.harness_id is unsupported: {harness}") from exc
            if state_directory != expected_state_directory:
                print(
                    f"aviso: {label}.state_directory drifts from the derived runtime path: "
                    f"expected {expected_state_directory}, got {state_directory}",
                    file=sys.stderr,
                )
        agents_by_identity[identity] = normalized_agent

    fleet: dict[str, dict[str, Any]] = {}
    retired: dict[str, dict[str, Any]] = {}
    for identity, agent in agents_by_identity.items():
        membership = memberships_by_identity.pop(identity, None)
        alias = agent["alias"]
        if agent["enabled"]:
            if membership is None:
                raise SnapshotError(f"enabled agent has no 1:1 membership: {identity[0]}/{identity[1]}")
            fleet[alias] = {
                "tenant": agent["tenant"],
                "room": membership["room"],
                "role": membership["role"],
                "harness": agent["harness"],
                "enabled": True,
                "container": agent["container"],
                "user": agent["user"],
                "home": agent["home"],
                "runtimeStateDirectory": agent["runtimeStateDirectory"],
            }
        else:
            retired[alias] = {}

    system_principals = {identity[1]: membership for identity, membership in memberships_by_identity.items()}
    physical = validate_placement(placement or {})
    unknown_placement = sorted(set(physical) - set(fleet))
    if unknown_placement:
        raise SnapshotError(f"physical fleet overlay names non-fleet aliases: {unknown_placement}")
    validate_placement_defaults(physical, fleet)

    return {
        "schemaVersion": 1,
        "fleet": fleet,
        "systemPrincipals": system_principals,
        "retired": retired,
        "placement": physical,
    }


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


def atomic_write(path: pathlib.Path, body: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = pathlib.Path(temporary_name)
    try:
        os.fchmod(descriptor, 0o644)
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        directory_descriptor = os.open(
            path.parent,
            os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0),
        )
        try:
            os.fsync(directory_descriptor)
        finally:
            os.close(directory_descriptor)
    finally:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


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
