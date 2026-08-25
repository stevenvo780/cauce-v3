#!/usr/bin/env python3
"""Certify that every declared physical Docker container exists before a fleet migration.

Only container names are observed. Docker IDs, inspect bodies, environment variables and mounts
never leave the subprocess or enter release evidence.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess
import sys
from typing import Any

from container_alias_lib import ContainerAliasError, load_container_aliases


class PhysicalFleetError(ValueError):
    pass


def observed_snapshot(path: pathlib.Path) -> set[str]:
    document: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or set(document) != {"schemaVersion", "containers"}:
        raise PhysicalFleetError("snapshot must have exact schemaVersion/containers keys")
    if document["schemaVersion"] != 1 or not isinstance(document["containers"], list):
        raise PhysicalFleetError("snapshot schemaVersion must be 1 and containers must be an array")
    names: set[str] = set()
    for index, value in enumerate(document["containers"]):
        if not isinstance(value, str) or not value or value.strip() != value:
            raise PhysicalFleetError(f"containers[{index}] must be a non-empty canonical name")
        if value in names:
            raise PhysicalFleetError(f"snapshot contains duplicate container name: {value}")
        names.add(value)
    return names


def observed_docker() -> set[str]:
    try:
        result = subprocess.run(
            ["docker", "container", "ls", "--all", "--format", "{{.Names}}"],
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PhysicalFleetError("Docker container inventory is unavailable") from error
    if result.returncode != 0:
        raise PhysicalFleetError("Docker container inventory is unavailable")
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(description="verify physical Docker containers for Cauce fleet")
    parser.add_argument(
        "--ops-root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1],
    )
    parser.add_argument(
        "--snapshot", type=pathlib.Path,
        help="sanitized deterministic evidence for tests; production release-gate never supplies it",
    )
    args = parser.parse_args()
    try:
        aliases = load_container_aliases(args.ops_root)
        required = {entry["container"] for entry in aliases.values()}
        observed = observed_snapshot(args.snapshot) if args.snapshot is not None else observed_docker()
    except (OSError, json.JSONDecodeError, ContainerAliasError, PhysicalFleetError) as error:
        print(f"physical fleet gate: invalid evidence: {error}", file=sys.stderr)
        return 2

    missing = sorted(required - observed)
    if missing:
        for name in missing:
            print(f"physical fleet gate: declared container does not exist: {name}", file=sys.stderr)
        return 1
    print(
        f"physical fleet gate passed: {len(required)} declared containers exist "
        f"for {len(aliases)} enabled aliases"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
