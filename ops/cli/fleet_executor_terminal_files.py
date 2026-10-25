from __future__ import annotations

import hashlib
import os
import pathlib
import secrets
import stat

from fleet_executor_pki import checked_file
from fleet_executor_policy import SafeFailure, open_absolute_directory


def directory(base: pathlib.Path, relative: str = '', *, private: bool = True) -> pathlib.Path:
    target = base
    parent = open_absolute_directory(base)
    try:
        for name in pathlib.PurePosixPath(relative).parts:
            if name in {'', '.', '..'} or '/' in name:
                raise SafeFailure('terminal directory escapes its approved root')
            try:
                os.mkdir(name, 0o700, dir_fd=parent)
                os.fsync(parent)
            except FileExistsError:
                pass
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
            os.close(parent)
            parent = child
            target /= name
            details = os.fstat(parent)
            if details.st_uid != os.geteuid() or details.st_mode & 0o022:
                raise SafeFailure('terminal directory has an unsafe owner or mode')
        details = os.fstat(parent)
        if details.st_uid != os.geteuid() or details.st_mode & (0o077 if private else 0o022):
            raise SafeFailure('terminal directory is not private and executor-owned')
        return target
    finally:
        os.close(parent)


def read_file(filename: pathlib.Path, mode: int) -> bytes:
    raw = checked_file(filename, private=mode & 0o077 == 0)
    details = filename.stat(follow_symlinks=False)
    if stat.S_IMODE(details.st_mode) != mode:
        raise SafeFailure('terminal file mode differs from its approved channel material')
    return raw


def write_file(filename: pathlib.Path, raw: bytes, mode: int, *, previous: str | None = None) -> str:
    parent = open_absolute_directory(filename.parent)
    temporary = '.' + filename.name + '.' + secrets.token_hex(12)
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        try:
            with os.fdopen(descriptor, 'wb', closefd=False) as stream:
                stream.write(raw)
                stream.flush()
            os.fchmod(descriptor, mode)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        if previous is None:
            try:
                os.link(temporary, filename.name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError:
                if read_file(filename, mode) != raw:
                    raise SafeFailure('terminal publication would replace existing channel material') from None
        else:
            if hashlib.sha256(read_file(filename, mode)).hexdigest() != previous:
                raise SafeFailure('terminal file changed before its approved update')
            os.replace(temporary, filename.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)
    return hashlib.sha256(raw).hexdigest()


def remove_file(filename: pathlib.Path, expected: str, mode: int) -> None:
    try:
        raw = read_file(filename, mode)
    except FileNotFoundError:
        return
    if hashlib.sha256(raw).hexdigest() != expected:
        raise SafeFailure('terminal rollback file no longer matches its own publication')
    parent = open_absolute_directory(filename.parent)
    try:
        os.unlink(filename.name, dir_fd=parent)
        os.fsync(parent)
    finally:
        os.close(parent)
