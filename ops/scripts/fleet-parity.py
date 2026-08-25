#!/usr/bin/env python3
"""Fail-closed parity gate between the declarative fleet and a sanitized DB snapshot.

The snapshot deliberately contains no credentials, message bodies, delivery identifiers or
external user IDs.  It is safe to retain as release evidence.  Disabled historical registry rows
may remain for audit, but the enabled set, placement and expected room must match exactly.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

from container_alias_lib import (
    ContainerAliasError,
    load_container_aliases,
    load_historical_aliases,
    load_system_principals,
)


class ParityError(ValueError):
    pass


EXPECTED_ROLE_POLICIES = {
    "agent_notify": {
        "allow_route": True,
        "allow_read": True,
        "allow_control": False,
        "allow_notify": True,
    },
}


def object_value(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ParityError(f"{label} must be an object")
    return value


def list_value(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ParityError(f"{label} must be an array")
    return value


def text_field(row: dict[str, Any], field: str, label: str) -> str:
    value = row.get(field)
    if not isinstance(value, str) or not value:
        raise ParityError(f"{label}.{field} must be non-empty text")
    return value


def boolean_field(row: dict[str, Any], field: str, label: str) -> bool:
    value = row.get(field)
    if not isinstance(value, bool):
        raise ParityError(f"{label}.{field} must be boolean")
    return value


def exact_fields(
    row: dict[str, Any], label: str, required: set[str], optional: set[str] | None = None,
) -> None:
    allowed = required | (optional or set())
    if missing := required - set(row):
        raise ParityError(f"{label} is missing fields: {','.join(sorted(missing))}")
    if unexpected := set(row) - allowed:
        raise ParityError(f"{label} has unexpected fields: {','.join(sorted(unexpected))}")


def identity(row: dict[str, Any], label: str) -> tuple[str, str]:
    return text_field(row, "tenant_id", label), text_field(row, "alias", label)


def indexed(rows: list[Any], label: str) -> dict[tuple[str, str], dict[str, Any]]:
    result: dict[tuple[str, str], dict[str, Any]] = {}
    for index, raw in enumerate(rows):
        row = object_value(raw, f"{label}[{index}]")
        if label == "agents":
            exact_fields(
                row, f"{label}[{index}]", {"tenant_id", "alias", "enabled"},
                {
                    "harness_id", "container_name", "runtime_user", "home_directory",
                    "state_directory",
                },
            )
        elif label == "leases":
            exact_fields(row, f"{label}[{index}]", {"tenant_id", "alias", "active"})
        key = identity(row, f"{label}[{index}]")
        if key in result:
            raise ParityError(f"{label} contains duplicate identity {key[0]}:{key[1]}")
        result[key] = row
    return result


def compare(
    inventory: dict[str, dict[str, str]],
    system_principals: dict[str, dict[str, str]],
    historical_aliases: dict[str, dict[str, str]],
    snapshot: dict[str, Any],
    expected_offline: set[tuple[str, str]],
    allowed_extra_leases: set[tuple[str, str]],
) -> list[str]:
    expected_snapshot_keys = {
        "schemaVersion", "agents", "memberships", "rolePolicies", "leases",
    }
    if set(snapshot) != expected_snapshot_keys:
        raise ParityError(
            "snapshot must have exact schemaVersion/agents/memberships/rolePolicies/leases keys"
        )
    if snapshot["schemaVersion"] != 3:
        raise ParityError("snapshot schemaVersion must be 3")

    agents = indexed(list_value(snapshot["agents"], "agents"), "agents")
    leases = indexed(list_value(snapshot["leases"], "leases"), "leases")
    role_policies: dict[str, dict[str, Any]] = {}
    for index, raw in enumerate(list_value(snapshot["rolePolicies"], "rolePolicies")):
        row = object_value(raw, f"rolePolicies[{index}]")
        exact_fields(row, f"rolePolicies[{index}]", {
            "role", "allow_route", "allow_read", "allow_control", "allow_notify",
        })
        role = text_field(row, "role", f"rolePolicies[{index}]")
        if role in role_policies:
            raise ParityError(f"rolePolicies contains duplicate role {role}")
        role_policies[role] = row
    memberships_raw = list_value(snapshot["memberships"], "memberships")
    memberships: set[tuple[str, str, str, str]] = set()
    for index, raw in enumerate(memberships_raw):
        row = object_value(raw, f"memberships[{index}]")
        exact_fields(row, f"memberships[{index}]", {"tenant_id", "alias", "room_id", "role"})
        key = (
            *identity(row, f"memberships[{index}]"),
            text_field(row, "room_id", f"memberships[{index}]"),
            text_field(row, "role", f"memberships[{index}]"),
        )
        if key in memberships:
            raise ParityError(f"memberships contains duplicate {key[0]}:{key[1]}:{key[2]}:{key[3]}")
        memberships.add(key)

    expected = {(entry["tenant"], alias): entry for alias, entry in inventory.items()}
    principal_identities = {
        (entry["tenant"], alias): entry for alias, entry in system_principals.items()
    }
    historical_identities = {
        (entry["tenant"], alias): entry for alias, entry in historical_aliases.items()
    }
    enabled = {
        key: row for key, row in agents.items()
        if boolean_field(row, "enabled", f"agents[{key[0]}:{key[1]}]")
    }
    problems: list[str] = []
    for role, expected_policy in EXPECTED_ROLE_POLICIES.items():
        actual_policy = role_policies.get(role)
        if actual_policy is None:
            problems.append(f"role policy missing: {role}")
            continue
        for permission, expected_value in expected_policy.items():
            actual_value = boolean_field(
                actual_policy, permission, f"rolePolicies[{role}]",
            )
            if actual_value is not expected_value:
                problems.append(f"role policy mismatch: {role} field={permission}")
    for key in sorted(expected.keys() - enabled.keys()):
        problems.append(f"enabled agent missing: {key[0]}:{key[1]}")
    for key in sorted(enabled.keys() - expected.keys()):
        problems.append(f"undeclared enabled agent: {key[0]}:{key[1]}")
    for key in sorted(historical_identities.keys() - agents.keys()):
        problems.append(f"historical agent missing: {key[0]}:{key[1]}")
    for key in sorted(historical_identities.keys() & enabled.keys()):
        problems.append(f"historical agent enabled: {key[0]}:{key[1]}")

    fields = {
        "harness_id": "harness",
        "container_name": "registryContainer",
        "runtime_user": "user",
        "home_directory": "home",
        "state_directory": "stateDirectory",
    }
    for key in sorted(expected.keys() & enabled.keys()):
        actual, declared = enabled[key], expected[key]
        for actual_name, declared_name in fields.items():
            if actual.get(actual_name) != declared[declared_name]:
                problems.append(f"placement mismatch {key[0]}:{key[1]} field={actual_name}")
        lease = leases.get(key)
        if key in expected_offline:
            if lease is not None and boolean_field(lease, "active", f"leases[{key[0]}:{key[1]}]"):
                problems.append(f"maintenance-offline agent is active: {key[0]}:{key[1]}")
            continue
        if lease is None:
            problems.append(f"lease missing: {key[0]}:{key[1]}")
        elif not boolean_field(lease, "active", f"leases[{key[0]}:{key[1]}]"):
            problems.append(f"lease inactive: {key[0]}:{key[1]}")

    expected_memberships = {
        (entry["tenant"], alias, entry["room"], entry["membershipRole"])
        for alias, entry in inventory.items()
    } | {
        (entry["tenant"], alias, entry["room"], entry["membershipRole"])
        for alias, entry in system_principals.items()
    }
    for membership in sorted(expected_memberships - memberships):
        problems.append(f"membership missing: {':'.join(membership)}")
    for membership in sorted(memberships - expected_memberships):
        problems.append(f"undeclared enabled membership: {':'.join(membership)}")

    for key in sorted(principal_identities.keys() & agents.keys()):
        problems.append(f"system principal must not have agent row: {key[0]}:{key[1]}")

    active_leases: set[tuple[str, str]] = set()
    for key, row in leases.items():
        if boolean_field(row, "active", f"leases[{key[0]}:{key[1]}]"):
            active_leases.add(key)
    # Historical aliases stay explicit but are not silently allowed online: a live
    # retired lease still requires a narrow, visible cutover exception.
    permitted_active = set(expected) | set(principal_identities) | allowed_extra_leases
    for key in sorted(active_leases - permitted_active):
        problems.append(f"undeclared active lease: {key[0]}:{key[1]}")

    for key in sorted(expected_offline - expected.keys()):
        problems.append(f"offline exception is not declared: {key[0]}:{key[1]}")
    for key in sorted(allowed_extra_leases & (set(expected) | set(principal_identities))):
        problems.append(f"extra lease exception is already declared: {key[0]}:{key[1]}")
    return problems


def parse_identity(value: str) -> tuple[str, str]:
    tenant, separator, alias = value.partition(":")
    if not separator or not tenant or not alias or ":" in alias:
        raise argparse.ArgumentTypeError("identity must be TENANT:ALIAS")
    return tenant, alias


def main() -> int:
    parser = argparse.ArgumentParser(description="verify declarative/live Cauce fleet parity")
    parser.add_argument("--ops-root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    parser.add_argument("--snapshot", type=pathlib.Path, required=True)
    parser.add_argument(
        "--expect-offline", action="append", type=parse_identity, default=[],
        help="require this declared identity to be offline during a bounded maintenance gate",
    )
    parser.add_argument("--allow-extra-lease", action="append", type=parse_identity, default=[])
    args = parser.parse_args()
    try:
        inventory = load_container_aliases(args.ops_root)
        system_principals = load_system_principals(args.ops_root)
        historical_aliases = load_historical_aliases(args.ops_root)
        snapshot = object_value(json.loads(args.snapshot.read_text(encoding="utf-8")), "snapshot")
        problems = compare(
            inventory,
            system_principals,
            historical_aliases,
            snapshot,
            set(args.expect_offline),
            set(args.allow_extra_lease),
        )
    except (OSError, json.JSONDecodeError, ContainerAliasError, ParityError) as error:
        print(f"fleet parity: invalid evidence: {error}", file=sys.stderr)
        return 2
    if problems:
        for problem in problems:
            print(f"fleet parity: {problem}", file=sys.stderr)
        return 1
    print(
        f"fleet parity passed: {len(inventory)} enabled aliases, "
        f"{len(system_principals)} system principals, "
        f"{len(historical_aliases)} disabled historical aliases, "
        f"{len(args.expect_offline)} expected-offline maintenance identities, "
        f"{len(args.allow_extra_lease)} transitional lease exceptions"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
