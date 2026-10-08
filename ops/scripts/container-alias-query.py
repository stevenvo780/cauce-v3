#!/usr/bin/env python3
from __future__ import annotations

import argparse
import pathlib
import sys

from container_alias_lib import FIELDS, load_container_aliases
from fleet_derive import load_fleet_assignments
from fleet_runtime_inventory import inventory_root, resolve_runtime_key


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve physical or tenant/wire fleet identities")
    parser.add_argument("selector")
    parser.add_argument("--ops-root", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parents[1])
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--runtime-key", action="store_true")
    mode.add_argument("--identity", action="store_true")
    mode.add_argument("--route", action="store_true")
    mode.add_argument("--supervisor", action="store_true")
    args = parser.parse_args()
    try:
        root = inventory_root(args.ops_root)
        if (args.runtime_key or args.identity or args.route) and (root / "flota.json").exists():
            aliases = load_fleet_assignments(root, resolve_runtime=False, allow_empty=True)
        else:
            aliases = load_container_aliases(root, resolve_runtime=False, allow_empty=True)
        key = resolve_runtime_key(args.selector, aliases)
        entry = aliases[key]
        if args.runtime_key:
            print(key)
        elif args.identity:
            print("\t".join((key, entry["tenant"], entry.get("alias", key))))
        elif args.route:
            host = entry.get("dockerHost", "local")
            print("local" if host == "local" else f"ssh:{entry['systemdUser']}@{host}")
        else:
            print("\t".join(entry[field] for field in FIELDS))
            if args.supervisor:
                print(sum(candidate["container"] == entry["container"] for candidate in aliases.values()))
                print(entry.get("workspace", ""))
                print(entry.get("alias", key))
    except (KeyError, OSError, ValueError) as error:
        print(f"container alias lookup failed: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
