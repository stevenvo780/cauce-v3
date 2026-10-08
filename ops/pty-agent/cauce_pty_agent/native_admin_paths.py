from __future__ import annotations

import hashlib
import os
import re
import stat
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

ID = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
MAX_FILE_BYTES = 262144


class NativeError(Exception):
    def __init__(self, code: str) -> None:
        self.code = code
        super().__init__(code)


def roots(bundle: dict[str, Any]) -> tuple[str, str]:
    facts = bundle.get("runtime_facts", {})
    key = {"codex": "codex_home", "claude": "claude_config_dir"}.get(bundle.get("harness"))
    root = facts.get(key) if key else None
    home = bundle.get("home")
    if (not isinstance(root, str) or not isinstance(home, str) or root == home
            or not root.startswith(home + "/") or os.path.normpath(root) != root):
        raise NativeError("unsupported")
    if os.geteuid() != bundle.get("runtime_uid"):
        raise NativeError("unsafe_path")
    with directory(root) as fd:
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise NativeError("unsafe_path")
    return home, root


def piece_path(bundle: dict[str, Any], kind: str, identifier: str) -> str:
    _, root = roots(bundle)
    if not ID.fullmatch(identifier):
        raise NativeError("invalid_input")
    harness = bundle["harness"]
    if kind == "skill":
        return root + "/skills/" + identifier + "/SKILL.md"
    if kind == "subagent" and harness == "claude":
        return root + "/agents/" + identifier + ".md"
    if kind == "mcp":
        return root + ("/config.toml" if harness == "codex" else "/.claude.json")
    raise NativeError("unsupported")


def kind_directory(bundle: dict[str, Any], kind: str) -> str:
    _, root = roots(bundle)
    if kind == "skill":
        return root + "/skills"
    if kind == "subagent" and bundle["harness"] == "claude":
        return root + "/agents"
    raise NativeError("unsupported")


@contextmanager
def directory(path: str, create: bool = False) -> Iterator[int]:
    if not path.startswith("/") or os.path.normpath(path) != path:
        raise NativeError("unsafe_path")
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.split("/")[1:]:
            if part in ("", ".", ".."):
                raise NativeError("unsafe_path")
            if create:
                try:
                    os.mkdir(part, 0o700, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    except OSError as error:
        raise NativeError("not_found" if error.errno == 2 else "unsafe_path") from None
    finally:
        os.close(fd)


def read_at(fd: int, name: str) -> bytes | None:
    try:
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
    except FileNotFoundError:
        return None
    except OSError:
        raise NativeError("unsafe_path") from None
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1:
            raise NativeError("unsafe_path")
        if before.st_size > MAX_FILE_BYTES:
            raise NativeError("too_large")
        raw = bytearray()
        while True:
            chunk = os.read(descriptor, min(65536, MAX_FILE_BYTES + 1 - len(raw)))
            if not chunk:
                break
            raw.extend(chunk)
            if len(raw) > MAX_FILE_BYTES:
                raise NativeError("too_large")
        after = os.fstat(descriptor)
        current = os.stat(name, dir_fd=fd, follow_symlinks=False)
        def identity(info: os.stat_result) -> tuple[int, int, int, int, int]:
            return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if identity(before) != identity(after) or identity(after) != identity(current):
            raise NativeError("conflict")
        return bytes(raw)
    finally:
        os.close(descriptor)


def read_path(path: str) -> bytes | None:
    try:
        with directory(os.path.dirname(path)) as fd:
            return read_at(fd, os.path.basename(path))
    except NativeError as error:
        if error.code == "not_found":
            return None
        raise


def digest(raw: bytes | None) -> str | None:
    return None if raw is None else hashlib.sha256(raw).hexdigest()


def durable_read_path(path: str, root: str) -> bytes | None:
    expected = read_path(path)
    parent = os.path.dirname(path)
    while parent == root or parent.startswith(root + "/"):
        try:
            with directory(parent) as fd:
                if expected is not None:
                    source = os.open(os.path.basename(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                    try:
                        info = os.fstat(source)
                        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1:
                            raise NativeError("unsafe_path")
                        os.fsync(source)
                    finally:
                        os.close(source)
                os.fsync(fd)
            if read_path(path) != expected:
                raise NativeError("conflict")
            return expected
        except NativeError as error:
            if error.code != "not_found" or parent == root or expected is not None:
                raise
            parent = os.path.dirname(parent)
    raise NativeError("unsafe_path")


def write_private(fd: int, name: str, raw: bytes) -> None:
    descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
    try:
        remaining = memoryview(raw)
        while remaining:
            count = os.write(descriptor, remaining)
            remaining = remaining[count:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    os.fsync(fd)
