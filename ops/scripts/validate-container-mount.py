#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any


def fail(message: str) -> None:
    print(f"container mount validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def is_ancestor_or_equal(destination: str, state: str) -> bool:
    # Component-wise containment so "/home/dev/.loca" never matches "/home/dev/.local"
    # and the mount root "/" is a valid (outermost) ancestor.
    dest = pathlib.PurePosixPath(destination)
    target = pathlib.PurePosixPath(state)
    return dest == target or dest in target.parents


def main() -> None:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("mounts_json")
    parser.add_argument("state_directory")
    parser.add_argument("--type", dest="expected_type")
    parser.add_argument("--source", dest="expected_source")
    parser.add_argument("--name", dest="expected_name")
    parser.add_argument("--rw", dest="expected_rw")
    try:
        arguments = parser.parse_args()
    except SystemExit:
        fail("usage: MOUNTS_JSON STATE_DIR [--type T] [--source S] [--name N] [--rw true|false]")

    state = arguments.state_directory
    if not state.startswith("/") or "//" in state:
        fail("state directory must be a canonical absolute path")

    try:
        mounts: Any = json.loads(pathlib.Path(arguments.mounts_json).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        fail(f"invalid structured Docker mount JSON: {error}")
    if not isinstance(mounts, list):
        fail("Docker Mounts must be a JSON array")

    # Discover the persistent mount that CONTAINS the alias state directory. The real
    # containers never dedicate a mount to the state dir: the state lives inside a broad
    # persistent bind (e.g. /home/dev/.local). The guarantee to preserve is that the state
    # survives a container recreate, i.e. it lives on a bind/volume mount (never tmpfs) that
    # is read-write. Pick the closest ancestor (longest matching Destination) so a nested
    # mount always wins over a broader one.
    candidates = []
    for mount in mounts:
        if not isinstance(mount, dict):
            fail("Docker mount entry must be an object")
        destination = mount.get("Destination")
        if not isinstance(destination, str) or not destination.startswith("/"):
            continue
        if is_ancestor_or_equal(destination, state):
            candidates.append(mount)
    if not candidates:
        fail("no persistent mount contains the alias state directory")

    def depth(mount: dict[str, Any]) -> int:
        return len(pathlib.PurePosixPath(mount["Destination"]).parts)

    deepest = max(depth(mount) for mount in candidates)
    closest = [mount for mount in candidates if depth(mount) == deepest]
    if len(closest) != 1:
        fail("the closest persistent mount is ambiguous")
    mount = closest[0]

    if mount.get("Type") not in ("bind", "volume"):
        fail("the persistent mount must be a bind or volume, not an ephemeral mount")
    if mount.get("RW") is not True:
        fail("the persistent mount must be read-write so state survives a recreate")

    # Optional reinforcement: any field the operator config declares must match exactly.
    if arguments.expected_type is not None and mount.get("Type") != arguments.expected_type:
        fail("the declared mount type differs from the persistent mount")
    if arguments.expected_source is not None and mount.get("Source") != arguments.expected_source:
        fail("the declared mount source differs from the persistent mount")
    if arguments.expected_name is not None:
        actual_name = mount.get("Name", "")
        if not isinstance(actual_name, str) or actual_name != arguments.expected_name:
            fail("the declared mount name differs from the persistent mount")
    if arguments.expected_rw is not None and (arguments.expected_rw == "true") is not (mount.get("RW") is True):
        fail("the declared mount read/write policy differs from the persistent mount")

    # The discovered Destination is emitted so the caller can bound safe state creation to it.
    print(mount["Destination"])


main()
