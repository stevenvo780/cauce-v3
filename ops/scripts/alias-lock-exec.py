#!/usr/bin/env python3
"""Acquire one alias lock safely and exec a command while inheriting the lock fd.

The lock root can be sticky and world-writable (``/run/lock``), so shell redirection is not
acceptable: it follows symlinks and has a check/open race.  This helper creates a private 0700
directory with ``mkdirat``, opens every component with ``O_NOFOLLOW``, validates the regular 0600
lock by descriptor, and also holds the pre-transition root-level lock. It then ``exec``s without
releasing either descriptor, so old and new supervisors cannot overlap during rollout.
"""

from __future__ import annotations

import argparse
import fcntl
import os
import pathlib
import re
import stat
import sys

ALIAS = re.compile(r"[a-z][a-z0-9-]*\Z")
FD_ENV = "CAUCE_ALIAS_LOCK_FD"
LEGACY_FD_ENV = "CAUCE_ALIAS_LEGACY_LOCK_FD"
ALIAS_ENV = "CAUCE_ALIAS_LOCK_ALIAS"


class LockError(RuntimeError):
    pass


def mkdir_private_at(name: str, directory_fd: int) -> None:
    previous_umask = os.umask(0o077)
    try:
        os.mkdir(name, 0o700, dir_fd=directory_fd)
    finally:
        os.umask(previous_umask)


def canonical_root(raw: str) -> pathlib.Path:
    path = pathlib.Path(raw)
    raw_components = raw.split("/")[1:]
    if (
        not path.is_absolute()
        or raw == "/"
        or "//" in raw
        or any(part in ("", ".", "..") for part in raw_components)
    ):
        raise LockError("invalid lock root")
    return path


def validate_alias(raw: str) -> str:
    if ALIAS.fullmatch(raw) is None:
        raise LockError("invalid alias")
    return raw


def assert_root_directory(fd: int) -> None:
    details = os.fstat(fd)
    mode = stat.S_IMODE(details.st_mode)
    if not stat.S_ISDIR(details.st_mode):
        raise LockError("lock root is not a directory")
    # A private user root is accepted. The system /run/lock form must be root-owned and sticky.
    if details.st_uid == os.geteuid() and not (mode & 0o022):
        return
    if details.st_uid == 0 and mode & stat.S_ISVTX:
        return
    raise LockError("lock root ownership or mode is unsafe")


def open_root_directory(root: pathlib.Path, *, create: bool) -> int:
    """Open every component from / without following a symlink.

    Rootless units use ``%t/cauce-v3`` and that final directory need not exist yet.  Creating it
    here keeps the entire create/open sequence descriptor-relative instead of falling back to a
    shell ``mkdir -p`` that could be raced through a substituted parent.
    """

    current_fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for component in root.parts[1:]:
            created = False
            try:
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=current_fd,
                )
            except FileNotFoundError:
                if not create:
                    raise LockError("lock root is absent")
                try:
                    mkdir_private_at(component, current_fd)
                    created = True
                except FileExistsError:
                    pass
                os.fsync(current_fd)
                next_fd = os.open(
                    component,
                    os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                    dir_fd=current_fd,
                )
            if created:
                os.fchmod(next_fd, 0o700)
                os.fsync(next_fd)
            details = os.fstat(next_fd)
            mode = stat.S_IMODE(details.st_mode)
            safe_owner = details.st_uid in (0, os.geteuid()) and not (mode & 0o022)
            safe_sticky_root = details.st_uid == 0 and bool(mode & stat.S_ISVTX)
            if not stat.S_ISDIR(details.st_mode) or not (safe_owner or safe_sticky_root):
                os.close(next_fd)
                raise LockError("lock root ancestor is unsafe")
            os.close(current_fd)
            current_fd = next_fd
        assert_root_directory(current_fd)
        return current_fd
    except Exception:
        os.close(current_fd)
        raise


def open_private_directory(root_fd: int, *, create: bool) -> int:
    name = f"cauce-v3-alias-locks-{os.geteuid()}"
    created = False
    if create:
        try:
            mkdir_private_at(name, root_fd)
            created = True
            os.fsync(root_fd)
        except FileExistsError:
            pass
    directory_fd = os.open(
        name,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        dir_fd=root_fd,
    )
    details = os.fstat(directory_fd)
    if created:
        os.fchmod(directory_fd, 0o700)
        os.fsync(directory_fd)
        details = os.fstat(directory_fd)
    if (
        not stat.S_ISDIR(details.st_mode)
        or details.st_uid != os.geteuid()
        or stat.S_IMODE(details.st_mode) != 0o700
    ):
        os.close(directory_fd)
        raise LockError("private lock directory is unsafe")
    return directory_fd


def open_regular_lock(directory_fd: int, name: str, label: str) -> int:
    created = False
    try:
        fd = os.open(
            name,
            os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
            0o600,
            dir_fd=directory_fd,
        )
        created = True
    except FileExistsError:
        fd = os.open(
            name,
            os.O_RDWR | os.O_NOFOLLOW | os.O_CLOEXEC,
            dir_fd=directory_fd,
        )
    try:
        if created:
            os.fchmod(fd, 0o600)
            os.fsync(fd)
            os.fsync(directory_fd)
        details = os.fstat(fd)
        named = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
        if (
            not stat.S_ISREG(details.st_mode)
            or details.st_uid != os.geteuid()
            or stat.S_IMODE(details.st_mode) != 0o600
            or details.st_nlink != 1
            or (details.st_dev, details.st_ino) != (named.st_dev, named.st_ino)
        ):
            raise LockError(f"{label} lock file is unsafe")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise LockError(f"{label} lock is already held") from error
        os.set_inheritable(fd, True)
        return fd
    except Exception:
        os.close(fd)
        raise


def open_locks(root: pathlib.Path, alias: str) -> tuple[int, int]:
    root_fd = open_root_directory(root, create=True)
    legacy_fd: int | None = None
    try:
        # The old supervisor locked this root-level inode. Hold it throughout one transition
        # release so an already-running pre-patch unit and the descriptor-safe implementation
        # cannot both mutate the same alias.
        legacy_fd = open_regular_lock(root_fd, f"cauce-v3-container-{alias}.lock", "legacy alias")
        directory_fd = open_private_directory(root_fd, create=True)
    except Exception:
        if legacy_fd is not None:
            os.close(legacy_fd)
        raise
    finally:
        os.close(root_fd)
    try:
        try:
            fd = open_regular_lock(directory_fd, f"{alias}.lock", "alias")
            return fd, legacy_fd
        except Exception:
            os.close(legacy_fd)
            raise
    finally:
        os.close(directory_fd)


def verify_inherited(root: pathlib.Path, alias: str) -> None:
    if os.environ.get(ALIAS_ENV) != alias:
        raise LockError("inherited lock alias differs")
    raw_fd = os.environ.get(FD_ENV, "")
    raw_legacy_fd = os.environ.get(LEGACY_FD_ENV, "")
    if not raw_fd.isdecimal() or not raw_legacy_fd.isdecimal():
        raise LockError("inherited lock descriptor is absent")
    fd = int(raw_fd)
    legacy_fd = int(raw_legacy_fd)
    details = os.fstat(fd)
    legacy_details = os.fstat(legacy_fd)
    root_fd = open_root_directory(root, create=False)
    try:
        legacy_named = os.stat(
            f"cauce-v3-container-{alias}.lock", dir_fd=root_fd, follow_symlinks=False
        )
        directory_fd = open_private_directory(root_fd, create=False)
    finally:
        os.close(root_fd)
    try:
        named = os.stat(f"{alias}.lock", dir_fd=directory_fd, follow_symlinks=False)
    finally:
        os.close(directory_fd)
    if (
        not stat.S_ISREG(details.st_mode)
        or details.st_uid != os.geteuid()
        or stat.S_IMODE(details.st_mode) != 0o600
        or details.st_nlink != 1
        or (details.st_dev, details.st_ino) != (named.st_dev, named.st_ino)
    ):
        raise LockError("inherited lock descriptor is unsafe")
    if (
        not stat.S_ISREG(legacy_details.st_mode)
        or legacy_details.st_uid != os.geteuid()
        or stat.S_IMODE(legacy_details.st_mode) != 0o600
        or legacy_details.st_nlink != 1
        or (legacy_details.st_dev, legacy_details.st_ino)
        != (legacy_named.st_dev, legacy_named.st_ino)
    ):
        raise LockError("inherited legacy lock descriptor is unsafe")
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(legacy_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise LockError("inherited descriptor does not own the alias lock") from error


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(add_help=False)
    actions = result.add_subparsers(dest="action", required=True)
    run = actions.add_parser("run", add_help=False)
    run.add_argument("--lock-root", required=True)
    run.add_argument("--alias", required=True)
    run.add_argument("command", nargs=argparse.REMAINDER)
    verify = actions.add_parser("verify", add_help=False)
    verify.add_argument("--lock-root", required=True)
    verify.add_argument("--alias", required=True)
    return result


def main() -> int:
    try:
        arguments = parser().parse_args()
        root = canonical_root(arguments.lock_root)
        alias = validate_alias(arguments.alias)
        if arguments.action == "verify":
            verify_inherited(root, alias)
            return 0
        command = arguments.command
        if command and command[0] == "--":
            command = command[1:]
        if not command:
            raise LockError("run requires a command")
        fd, legacy_fd = open_locks(root, alias)
        environment = dict(os.environ)
        environment[FD_ENV] = str(fd)
        environment[LEGACY_FD_ENV] = str(legacy_fd)
        environment[ALIAS_ENV] = alias
        os.execvpe(command[0], command, environment)
        raise AssertionError("exec returned")
    except LockError as error:
        print(f"alias-lock-exec: {error}", file=sys.stderr)
        return 73
    except (OSError, ValueError):
        print("alias-lock-exec: lock operation failed", file=sys.stderr)
        return 73


if __name__ == "__main__":
    raise SystemExit(main())
