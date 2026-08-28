#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys
import tempfile
from typing import Any

from fleet_derive import alias_entry

OPS_ROOT = pathlib.Path(__file__).resolve().parents[1]
SNAPSHOT_KEYS = {
    "schemaVersion",
    "fleet",
    "systemPrincipals",
    "retired",
    "placement",
}


class GeneratorError(ValueError):
    pass


def mapping(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise GeneratorError(f"{label} must be an object")
    return value


def load_snapshot(path: pathlib.Path) -> dict[str, Any]:
    try:
        document = mapping(json.loads(path.read_text(encoding="utf-8")), str(path))
    except (OSError, json.JSONDecodeError) as error:
        raise GeneratorError(f"cannot read fleet snapshot {path}: {error}") from error
    if set(document) != SNAPSHOT_KEYS or document.get("schemaVersion") != 1:
        raise GeneratorError("fleet snapshot must use exact schemaVersion 1 fields")
    fleet = mapping(document["fleet"], "fleet")
    if not fleet:
        raise GeneratorError("fleet must not be empty")
    retired = mapping(document["retired"], "retired")
    principals = mapping(document["systemPrincipals"], "systemPrincipals")
    placement = mapping(document["placement"], "placement")
    overlap = (set(fleet) & set(retired)) | (set(fleet) & set(principals))
    if overlap:
        raise GeneratorError(f"fleet aliases overlap non-fleet principals: {sorted(overlap)}")
    unknown_placement = set(placement) - set(fleet)
    if unknown_placement:
        raise GeneratorError(f"placement references unknown aliases: {sorted(unknown_placement)}")
    for alias, row in fleet.items():
        if not isinstance(row, dict) or row.get("enabled") is not True:
            raise GeneratorError(f"fleet.{alias} must be an enabled agent object")
    for alias, row in retired.items():
        if not isinstance(row, dict):
            raise GeneratorError(f"retired.{alias} must be an object")
    for alias, row in principals.items():
        if not isinstance(row, dict) or set(row) != {"tenant", "room", "role"}:
            raise GeneratorError(f"systemPrincipals.{alias} must contain tenant, room and role")
    return document


def render(document: dict[str, Any]) -> str:
    fleet = document["fleet"]
    placement = document["placement"]
    principals = document["systemPrincipals"]
    retired = document["retired"]
    generated = {
        "schemaVersion": 2,
        "systemPrincipals": {
            alias: {
                "tenant": principals[alias]["tenant"],
                "room": principals[alias]["room"],
                "membershipRole": principals[alias]["role"],
            }
            for alias in sorted(principals)
        },
        "historicalAliases": {alias: {"expectedEnabled": False} for alias in sorted(retired)},
        "aliases": {alias: alias_entry(alias, fleet[alias], placement.get(alias, {})) for alias in sorted(fleet)},
    }
    return json.dumps(generated, indent=2, ensure_ascii=False) + "\n"


def atomic_write(destination: pathlib.Path, body: str) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{destination.name}.", dir=destination.parent, text=True)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the legacy container alias mapping from the fleet snapshot")
    parser.add_argument("--snapshot", type=pathlib.Path, default=OPS_ROOT / "flota.json")
    parser.add_argument("--output", type=pathlib.Path, default=OPS_ROOT / "container-aliases.json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        body = render(load_snapshot(args.snapshot))
        atomic_write(args.output, body)
    except (GeneratorError, KeyError, TypeError, ValueError) as error:
        print(f"container alias generation failed: {error}", file=sys.stderr)
        return 1
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
