"""Fail-closed filesystem primitives for operational scripts."""

from __future__ import annotations

import os
import stat


class InvalidAbsolutePath(ValueError):
    pass


def absolute_components(path: os.PathLike[str] | str) -> tuple[str, ...]:
    raw = os.fspath(path)
    components = tuple(raw.split("/")[1:])
    if (
        not raw.startswith("/")
        or "//" in raw
        or "\x00" in raw
        or not components
        or any(component in ("", ".", "..") for component in components)
    ):
        raise InvalidAbsolutePath
    return components


def open_absolute_directory(path: os.PathLike[str] | str) -> int:
    components = absolute_components(path)
    current = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    try:
        for component in components:
            following = os.open(
                component,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                dir_fd=current,
            )
            os.close(current)
            current = following
        return current
    except Exception:
        os.close(current)
        raise


def open_regular_at(
    directory_fd: int,
    name: str,
    flags: int,
    *,
    mode: int | None = None,
) -> int:
    options = flags | os.O_NOFOLLOW | os.O_CLOEXEC
    if mode is None:
        return os.open(name, options, dir_fd=directory_fd)
    return os.open(name, options, mode, dir_fd=directory_fd)


def file_identity(details: os.stat_result) -> tuple[int, ...]:
    return (
        details.st_dev,
        details.st_ino,
        details.st_size,
        details.st_mtime_ns,
        details.st_ctime_ns,
        details.st_uid,
        details.st_gid,
        stat.S_IMODE(details.st_mode),
        details.st_nlink,
    )
