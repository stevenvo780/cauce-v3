#!/usr/bin/env python3
"""Publish a desired fleet generation without editing mounted repository files."""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

from fleet_runtime_materialization import EXPORTER, external_directory, materialize


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--source", type=pathlib.Path)
    source.add_argument("--database-url-file", type=pathlib.Path)
    source.add_argument("--postgres-container")
    parser.add_argument("--placement", type=pathlib.Path, default=EXPORTER.DEFAULT_PLACEMENT)
    parser.add_argument("--state-directory", type=pathlib.Path, required=True)
    args = parser.parse_args(argv)
    try:
        external_directory(args.state_directory)
        payload = json.loads(args.source.read_bytes()) if args.source is not None else EXPORTER.query_database(
            database_url_file=args.database_url_file, postgres_container=args.postgres_container,
        )
        receipt = materialize(payload, EXPORTER.load_placement(args.placement), args.state_directory)
        print(json.dumps(receipt, sort_keys=True))
    except (OSError, ValueError) as error:
        print(f"fleet runtime materialization failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
