#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

from atomic_file import atomic_write
from fleet_derive import alias_entry

OPS_ROOT = pathlib.Path(__file__).resolve().parents[1]
ENTRY_FIELDS = (
    "tenant",
    "room",
    "container",
    "user",
    "home",
    "stateDirectory",
    "harness",
)


class GeneratorError(ValueError):
    pass


def load_source(path: pathlib.Path) -> tuple[dict[str, dict[str, Any]], dict[str, dict[str, Any]]]:
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise GeneratorError(f"cannot read fleet snapshot {path}: {error}") from error
    if not isinstance(document, dict) or document.get("schemaVersion") != 1:
        raise GeneratorError("fleet snapshot must use schemaVersion 1")
    fleet = document.get("fleet")
    placement = document.get("placement")
    if not isinstance(fleet, dict) or not fleet:
        raise GeneratorError("fleet snapshot must contain a non-empty fleet object")
    if not isinstance(placement, dict):
        raise GeneratorError("fleet snapshot must contain a placement object")
    unknown_placement = set(placement) - set(fleet)
    if unknown_placement:
        raise GeneratorError(f"placement references unknown aliases: {sorted(unknown_placement)}")
    for alias, row in fleet.items():
        if not isinstance(alias, str) or not isinstance(row, dict) or row.get("enabled") is not True:
            raise GeneratorError(f"fleet.{alias} must be an enabled agent object")
    return fleet, placement


def render(fleet: dict[str, dict[str, Any]], placement: dict[str, dict[str, Any]]) -> bytes:
    aliases: dict[str, dict[str, Any]] = {}
    for alias in sorted(fleet):
        entry = alias_entry(alias, fleet[alias], placement.get(alias, {}))
        aliases[alias] = {
            **{field: entry[field] for field in ENTRY_FIELDS},
            "enabled": True,
        }
    document = {"schemaVersion": 1, "aliases": aliases}
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate the legacy runtime fleet from the canonical snapshot")
    parser.add_argument("--snapshot", type=pathlib.Path, default=OPS_ROOT / "flota.json")
    parser.add_argument("--output", type=pathlib.Path, default=OPS_ROOT / "generated" / "fleet.json")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        fleet, placement = load_source(args.snapshot)
        atomic_write(args.output, render(fleet, placement))
    except (GeneratorError, KeyError, TypeError, ValueError) as error:
        print(f"runtime fleet generation failed: {error}", file=sys.stderr)
        return 1
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
