#!/usr/bin/env python3
"""Certify that every declared physical Docker container exists before a fleet migration.

Only host aliases and container names are observed. Docker IDs, inspect bodies,
environment variables and mounts never leave the subprocess or enter release evidence.
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


def canonical_names(values: Any, label: str) -> set[str]:
    if not isinstance(values, list):
        raise PhysicalFleetError(f"{label} must be an array")
    names: set[str] = set()
    for index, value in enumerate(values):
        if not isinstance(value, str) or not value or value.strip() != value:
            raise PhysicalFleetError(f"{label}[{index}] must be a non-empty canonical name")
        if value in names:
            raise PhysicalFleetError(f"{label} contains duplicate container name: {value}")
        names.add(value)
    return names


def observed_snapshot(path: pathlib.Path) -> dict[str, set[str]]:
    document: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(document, dict) or set(document) != {"schemaVersion", "hosts"}:
        raise PhysicalFleetError("snapshot must have exact schemaVersion/hosts keys")
    if document["schemaVersion"] != 2 or not isinstance(document["hosts"], dict):
        raise PhysicalFleetError("snapshot schemaVersion must be 2 and hosts must be an object")
    if not document["hosts"]:
        raise PhysicalFleetError("snapshot hosts must not be empty")
    observed: dict[str, set[str]] = {}
    for host, values in document["hosts"].items():
        if not isinstance(host, str) or not host or host.strip() != host:
            raise PhysicalFleetError("snapshot host names must be canonical")
        observed[host] = canonical_names(values, f"hosts.{host}")
    return observed


def observed_docker(host: str) -> set[str]:
    command = ["docker", "container", "ls", "--all", "--format", "{{.Names}}"]
    if host != "local":
        command = [
            "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "--", host,
            *command,
        ]
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise PhysicalFleetError(f"Docker container inventory is unavailable for host {host}") from error
    if result.returncode != 0:
        raise PhysicalFleetError(f"Docker container inventory is unavailable for host {host}")
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
        required: dict[str, set[str]] = {}
        for entry in aliases.values():
            required.setdefault(entry["dockerHost"], set()).add(entry["container"])
        observed = observed_snapshot(args.snapshot) if args.snapshot is not None else {
            host: observed_docker(host) for host in sorted(required)
        }
    except (OSError, json.JSONDecodeError, ContainerAliasError, PhysicalFleetError) as error:
        print(f"physical fleet gate: invalid evidence: {error}", file=sys.stderr)
        return 2

    missing_hosts = sorted(set(required) - set(observed))
    if missing_hosts:
        for host in missing_hosts:
            print(f"physical fleet gate: host inventory is missing: {host}", file=sys.stderr)
        return 1
    missing = sorted(
        (host, name)
        for host, names in required.items()
        for name in names - observed[host]
    )
    if missing:
        for host, name in missing:
            print(
                f"physical fleet gate: declared container does not exist: {host}/{name}",
                file=sys.stderr,
            )
        return 1
    placement_count = sum(len(names) for names in required.values())
    print(
        f"physical fleet gate passed: {placement_count} declared host/container placements exist "
        f"across {len(required)} hosts for {len(aliases)} enabled aliases"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
