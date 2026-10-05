"""Serialize identity registry writers on a private, persistent lock inode."""
from __future__ import annotations

import fcntl
import json
import os
import stat
import uuid
from pathlib import Path


class RegistryLock:
    def __init__(self, registry: Path):
        self.registry = registry
        self.fd = None
        self.directory_fd = None
        self.directory_identity = None

    def __enter__(self):
        try:
            self.directory_fd = os.open(self.registry.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
            directory = os.fstat(self.directory_fd)
            if directory.st_uid not in (0, 1000) or directory.st_mode & 0o022:
                raise ValueError("unsafe identity registry directory")
            self.directory_identity = self.identity(directory)
            self.validate_directory()
            name = f".{self.registry.name}.lock"
            self.fd = os.open(name, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600,
                              dir_fd=self.directory_fd)
            details = os.fstat(self.fd)
            if (not stat.S_ISREG(details.st_mode) or details.st_uid not in (0, 1000)
                    or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o600):
                raise ValueError("unsafe identity registry lock")
            self.check_inode(name, details)
            fcntl.flock(self.fd, fcntl.LOCK_EX)
            self.validate_directory()
            self.check_inode(name, details)
            return self
        except BaseException:
            self.__exit__()
            raise

    def check_inode(self, name: str, expected: os.stat_result):
        current = os.stat(name, dir_fd=self.directory_fd, follow_symlinks=False)
        if (not stat.S_ISREG(current.st_mode) or current.st_uid not in (0, 1000)
                or current.st_nlink != 1 or stat.S_IMODE(current.st_mode) != 0o600
                or (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino)):
            raise ValueError("identity registry lock changed during acquisition")

    @staticmethod
    def identity(details: os.stat_result) -> tuple:
        return (details.st_dev, details.st_ino, details.st_uid, details.st_gid, details.st_mode)

    def validate_directory(self) -> None:
        pinned = os.fstat(self.directory_fd)
        named = os.stat(self.registry.parent, follow_symlinks=False)
        if (not stat.S_ISDIR(named.st_mode) or pinned.st_uid not in (0, 1000) or pinned.st_mode & 0o022
                or self.identity(pinned) != self.directory_identity or self.identity(named) != self.directory_identity):
            raise ValueError("identity registry directory changed during transaction")

    def validate(self) -> None:
        self.validate_directory()
        self.check_inode(f".{self.registry.name}.lock", os.fstat(self.fd))

    def read(self) -> tuple[bytes, os.stat_result]:
        self.validate()
        fd = os.open(self.registry.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=self.directory_fd)
        with os.fdopen(fd, "rb") as stream:
            details = os.fstat(stream.fileno())
            if (not stat.S_ISREG(details.st_mode) or details.st_uid not in (0, 1000)
                    or details.st_nlink != 1 or stat.S_IMODE(details.st_mode) != 0o400):
                raise ValueError("unsafe identity registry file")
            body = stream.read()
        named = os.stat(self.registry.name, dir_fd=self.directory_fd, follow_symlinks=False)
        if self.identity(named) != self.identity(details):
            raise ValueError("identity registry changed during read")
        self.validate()
        return body, details

    def replace(self, document: dict, original: bytes, expected: os.stat_result) -> None:
        name = f".registry-{uuid.uuid4().hex}.tmp"
        fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                     0o600, dir_fd=self.directory_fd)
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(document, stream, sort_keys=True, separators=(",", ":"))
                stream.write("\n")
                stream.flush()
                os.fchown(stream.fileno(), expected.st_uid, expected.st_gid)
                os.fchmod(stream.fileno(), 0o400)
                os.fsync(stream.fileno())
            current, metadata = self.read()
            if current != original or self.identity(metadata) != self.identity(expected):
                raise ValueError("identity registry changed before replace")
            self.validate()
            os.replace(name, self.registry.name, src_dir_fd=self.directory_fd, dst_dir_fd=self.directory_fd)
            self.validate()
            os.fsync(self.directory_fd)
        finally:
            try:
                os.unlink(name, dir_fd=self.directory_fd)
            except FileNotFoundError:
                pass

    def __exit__(self, *_):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None
        if self.directory_fd is not None:
            os.close(self.directory_fd)
            self.directory_fd = None
