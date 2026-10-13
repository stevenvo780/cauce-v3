#!/usr/bin/env python3
"""Generate the public harness descriptor approvals file of a release for the owner to approve.

The owner names every harness they approve; nothing is approved implicitly. Each descriptor is
validated with the executor's own parser and pinned by the SHA-256 of its exact bytes:

    {"<harness>": "<sha256 of packages/adapter-sdk/descriptors/<harness>.json>"}

The gateway reads the file through CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE (deploy/compose.yaml)
and deploy/deploy.sh refuses to deploy when it is missing, malformed or stale for the release.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'ops/cli'))
from harness_operations import HARNESS_ID, HarnessOperationFailure, read_descriptor  # noqa: E402


def approved(descriptors: pathlib.Path, harnesses: list[str]) -> dict[str, str]:
    pins: dict[str, str] = {}
    with tempfile.TemporaryDirectory(prefix='cauce-descriptor-approvals-') as scratch:
        # read_descriptor only reads a bundle layout; validate an isolated private copy of the bytes.
        bundle = pathlib.Path(scratch) / 'packages/adapter-sdk/dist/descriptors'
        bundle.mkdir(parents=True, mode=0o700)
        for harness in harnesses:
            if HARNESS_ID.fullmatch(harness) is None:
                raise SystemExit(f'harness {harness!r} must match [a-z][a-z0-9_-]{{0,63}}')
            if harness in pins:
                raise SystemExit(f'harness {harness!r} is named twice')
            source = descriptors / f'{harness}.json'
            if source.is_symlink() or not source.is_file():
                raise SystemExit(f'{source}: no published descriptor declares {harness!r}')
            raw = source.read_bytes()
            copy = bundle / f'{harness}.json'
            copy.write_bytes(raw)
            copy.chmod(0o600)
            try:
                _, fingerprint = read_descriptor(scratch, harness, expected_sha256=hashlib.sha256(raw).hexdigest())
            except HarnessOperationFailure as error:
                raise SystemExit(f'{source}: {error}') from None
            pins[harness] = fingerprint
    return pins


def write(output: pathlib.Path, body: bytes, replace: bool) -> None:
    if not output.is_absolute():
        raise SystemExit('--output must be an absolute path')
    if output.exists() and not replace:
        raise SystemExit(f'{output} already exists; pass --replace to substitute it')
    descriptor, temporary = tempfile.mkstemp(prefix='.approvals-', dir=output.parent)
    try:
        os.write(descriptor, body)
        os.fchmod(descriptor, 0o644)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.replace(temporary, output)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('harness', nargs='*', help='harness ids the owner approves (none writes {}, which approves nothing)')
    parser.add_argument('--descriptors', type=pathlib.Path, default=ROOT / 'packages/adapter-sdk/descriptors',
                        help='published descriptor directory of the release (default: this checkout)')
    parser.add_argument('--output', type=pathlib.Path, help='absolute file to write atomically with mode 0644; stdout when absent')
    parser.add_argument('--replace', action='store_true', help='substitute an existing --output file')
    arguments = parser.parse_args()
    pins = approved(arguments.descriptors, arguments.harness)
    body = (json.dumps(pins, sort_keys=True, indent=2) + '\n').encode()
    for harness, pin in sorted(pins.items()):
        print(f'approve {harness} {pin}', file=sys.stderr)
    if arguments.output is None:
        sys.stdout.buffer.write(body)
    else:
        write(arguments.output, body, arguments.replace)
        print(f'wrote {arguments.output} ({len(pins)} approved descriptors)', file=sys.stderr)


if __name__ == '__main__':
    main()
