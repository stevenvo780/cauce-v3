"""Durable atomic replacement for generated files."""

from __future__ import annotations

import os
import pathlib
import stat
import tempfile


def _fsync_directory(directory: pathlib.Path) -> None:
    descriptor = os.open(
        directory,
        os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0),
    )
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _ensure_directory(directory: pathlib.Path) -> None:
    missing: list[pathlib.Path] = []
    current = directory
    while True:
        try:
            details = current.stat()
        except FileNotFoundError:
            missing.append(current)
            current = current.parent
            continue
        if not stat.S_ISDIR(details.st_mode):
            raise NotADirectoryError(f"{current} is not a directory")
        break

    for current in reversed(missing):
        try:
            current.mkdir()
        except FileExistsError:
            if not current.is_dir():
                raise
        _fsync_directory(current.parent)


def atomic_write(destination: pathlib.Path, body: str | bytes, mode: int = 0o644) -> None:
    _ensure_directory(destination.parent)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.",
        dir=destination.parent,
    )
    temporary = pathlib.Path(temporary_name)
    try:
        os.fchmod(descriptor, mode)
        if isinstance(body, str):
            stream = os.fdopen(descriptor, "w", encoding="utf-8")
        else:
            stream = os.fdopen(descriptor, "wb")
        descriptor = -1
        with stream:
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, destination)
        _fsync_directory(destination.parent)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)
