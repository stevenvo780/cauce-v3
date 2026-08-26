#!/usr/bin/env python3
"""Publish a create-only production override manifest from an exact YAML inventory."""

from __future__ import annotations

import argparse
import hashlib
import os
import pathlib
import secrets
import stat
import sys


class ManifestError(ValueError):
    pass


def sha256(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def discover(directory: pathlib.Path) -> list[pathlib.Path]:
    if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir():
        raise ManifestError("override directory must be an absolute non-symlink directory")
    entries: list[pathlib.Path] = []
    for path in sorted(directory.iterdir(), key=lambda item: item.name):
        if path.suffix not in {".yaml", ".yml"}:
            continue
        metadata = path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or metadata.st_nlink != 1:
            raise ManifestError(f"override is not a single-link regular file: {path.name}")
        entries.append(path)
    if not entries:
        raise ManifestError("override directory contains no YAML files to retain")
    return entries


def publish(output: pathlib.Path, content: bytes) -> None:
    if not output.is_absolute() or output.parent.is_symlink() or not output.parent.is_dir():
        raise ManifestError("output must be an absolute path in an existing non-symlink directory")
    parent_metadata = output.parent.lstat()
    if parent_metadata.st_uid not in {0, os.geteuid()} \
            or stat.S_IMODE(parent_metadata.st_mode) & 0o022:
        raise ManifestError("output directory must be owned and not writable by group/others")
    if output.exists() or output.is_symlink():
        metadata = output.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) \
                or metadata.st_nlink != 1 or stat.S_IMODE(metadata.st_mode) != 0o600 \
                or metadata.st_uid not in {0, os.geteuid()}:
            raise ManifestError("existing output is not an owned single-link mode-0600 file")
        if output.read_bytes() != content:
            raise ManifestError("existing output differs from the idempotent manifest candidate")
        return
    temporary = output.parent / f".{output.name}.inactive-{os.getpid()}-{secrets.token_hex(8)}"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    descriptor = -1
    try:
        descriptor = os.open(temporary, flags, 0o600)
        view = memoryview(content)
        while view:
            written = os.write(descriptor, view)
            view = view[written:]
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = -1
        os.link(temporary, output, follow_symlinks=False)
        output.chmod(0o600)
        directory = os.open(output.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    except FileExistsError as error:
        raise ManifestError("output appeared concurrently; refusing to overwrite it") from error
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--overrides-dir", required=True, type=pathlib.Path)
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument(
        "--expected-yaml-count",
        type=int,
        metavar="COUNT",
        help="fail unless the directory contains exactly this many YAML files",
    )
    parser.add_argument(
        "--active",
        action="append",
        default=[],
        metavar="BASENAME",
        help="mark this YAML active in the supplied order; all remaining YAML stays inactive",
    )
    arguments = parser.parse_args(argv)
    try:
        if arguments.output.parent != arguments.overrides_dir:
            raise ManifestError("output manifest must be published inside the override directory")
        entries = discover(arguments.overrides_dir)
        if arguments.expected_yaml_count is not None:
            if arguments.expected_yaml_count < 1:
                raise ManifestError("expected YAML count must be positive")
            if len(entries) != arguments.expected_yaml_count:
                raise ManifestError(
                    f"expected exactly {arguments.expected_yaml_count} YAML files, found {len(entries)}"
                )
        by_name = {path.name: path for path in entries}
        if len(arguments.active) != len(set(arguments.active)):
            raise ManifestError("active override list contains duplicates")
        missing = [name for name in arguments.active if name not in by_name]
        if missing:
            raise ManifestError("active override list names a missing or non-YAML file")
        ordered = [("active", by_name[name]) for name in arguments.active]
        ordered.extend(
            ("inactive", path) for path in entries if path.name not in set(arguments.active)
        )
        content = "".join(
            f"{state} {sha256(path)} {path.name}\n" for state, path in ordered
        ).encode("utf-8")
        publish(arguments.output, content)
    except (OSError, ManifestError) as error:
        print(f"override manifest failed: {error}", file=sys.stderr)
        return 1
    print(
        f"override manifest admitted for {len(entries)} retained override(s), "
        f"{len(arguments.active)} active"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
