#!/usr/bin/env python3
"""Publish an immutable manifest that retains every production override as inactive."""

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
    if output.exists() or output.is_symlink():
        raise ManifestError("output already exists; immutable release manifests are never overwritten")
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
    arguments = parser.parse_args(argv)
    try:
        if arguments.output.parent != arguments.overrides_dir:
            raise ManifestError("output manifest must be published inside the override directory")
        entries = discover(arguments.overrides_dir)
        content = "".join(f"inactive {sha256(path)} {path.name}\n" for path in entries).encode("utf-8")
        publish(arguments.output, content)
    except (OSError, ManifestError) as error:
        print(f"inactive override manifest failed: {error}", file=sys.stderr)
        return 1
    print(f"inactive override manifest published for {len(entries)} retained override(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
