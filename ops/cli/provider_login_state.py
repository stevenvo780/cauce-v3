from __future__ import annotations

import fcntl
import hashlib
import json
import os
import pathlib
import re
import stat
import time
import uuid

from fleet_executor_view import open_directory


class LoginFailure(ValueError):
    pass


def operation(value) -> str:
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise LoginFailure('invalid operation identity')
    return value


def canonical_path(value) -> str:
    if not isinstance(value, str) or not value.startswith('/') or str(pathlib.PurePosixPath(value)) != value \
            or '..' in pathlib.PurePosixPath(value).parts or any(ord(char) < 32 for char in value):
        raise LoginFailure('invalid approved path')
    return value


def pinned_digest(filename: str) -> str:
    parent = open_directory(pathlib.Path(canonical_path(filename)).parent)
    try:
        descriptor = os.open(pathlib.Path(filename).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=parent)
        try:
            details = os.fstat(descriptor)
            if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid not in {0, os.geteuid()} \
                    or details.st_mode & 0o022:
                raise LoginFailure('pinned login file ownership or mode differs')
            fingerprint = hashlib.sha256()
            while body := os.read(descriptor, 1024 * 1024):
                fingerprint.update(body)
            return fingerprint.hexdigest()
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def private_state(value: str, *, create: bool = False) -> int:
    canonical_path(value)
    if create:
        parent = open_directory(pathlib.Path(value).parent)
        try:
            try:
                os.mkdir(pathlib.Path(value).name, 0o700, dir_fd=parent)
            except FileExistsError:
                pass
        finally:
            os.close(parent)
    root = open_directory(pathlib.Path(value))
    details = os.fstat(root)
    if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o700:
        os.close(root)
        raise LoginFailure('login state must be private and owned by the executor')
    return root


def checked_file(root: int, name: str, flags: int) -> int:
    descriptor = os.open(name, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=root)
    details = os.fstat(descriptor)
    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1 or details.st_uid != os.geteuid() \
            or stat.S_IMODE(details.st_mode) != 0o600:
        os.close(descriptor)
        raise LoginFailure('login metadata ownership or privacy differs')
    return descriptor


def acquire(root: int, identity: str, *, wait: float = 0) -> int:
    descriptor = checked_file(root, operation(identity) + '.lock', os.O_RDWR | os.O_CREAT)
    deadline = time.monotonic() + wait
    while True:
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return descriptor
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(descriptor)
                raise LoginFailure('login operation is already active') from None
            time.sleep(0.05)


def write_metadata(root: int, identity: str, document: dict) -> None:
    temporary = '.' + operation(identity) + '.' + os.urandom(8).hex()
    descriptor = checked_file(root, temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL)
    try:
        body = json.dumps(document, sort_keys=True, separators=(',', ':')).encode()
        if len(body) > 16384:
            raise LoginFailure('login process identity exceeds its limit')
        offset = 0
        while offset < len(body):
            offset += os.write(descriptor, body[offset:])
        os.fsync(descriptor)
        os.rename(temporary, identity + '.json', src_dir_fd=root, dst_dir_fd=root)
        os.fsync(root)
    finally:
        os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=root)
        except FileNotFoundError:
            pass


def read_metadata(root: int, identity: str) -> dict | None:
    try:
        descriptor = checked_file(root, operation(identity) + '.json', os.O_RDONLY)
    except FileNotFoundError:
        return None
    try:
        body = os.read(descriptor, 16385)
        if len(body) > 16384:
            raise LoginFailure('login metadata exceeds its limit')
        document = json.loads(body)
    finally:
        os.close(descriptor)
    if not isinstance(document, dict) or document.get('schemaVersion') != 1 or document.get('operation_id') != identity:
        raise LoginFailure('login metadata operation differs')
    return document


def remove_metadata(root: int, identity: str) -> None:
    if read_metadata(root, identity) is not None:
        os.unlink(identity + '.json', dir_fd=root)
        os.fsync(root)


def validate_plan(plan, *, child: bool = False) -> dict:
    required = {'operation_id', 'command', 'runtime_user', 'home', 'cwd', 'env', 'backend', 'state_root', 'account_scope'}
    optional = {'command_sha256', 'command_files', 'container_binding', 'ttl_seconds'}
    if not isinstance(plan, dict) or required - set(plan) or set(plan) - required - optional:
        raise LoginFailure('invalid trusted login plan')
    operation(plan['operation_id'])
    if plan['backend'] not in {'native', 'container'} or child and plan['backend'] != 'native':
        raise LoginFailure('invalid login backend')
    command = plan['command']
    if not isinstance(command, list) or not 1 <= len(command) <= 32 or any(
            not isinstance(value, str) or len(value) > 4096 or '\0' in value for value in command):
        raise LoginFailure('invalid pinned login command')
    canonical_path(command[0])
    for key in ('home', 'cwd', 'state_root'):
        canonical_path(plan[key])
    if not isinstance(plan['runtime_user'], str) or re.fullmatch(r'[A-Za-z_][A-Za-z0-9_-]{0,63}', plan['runtime_user']) is None:
        raise LoginFailure('invalid exact runtime user')
    if not isinstance(plan['account_scope'], str) or not 1 <= len(plan['account_scope']) <= 128 \
            or any(ord(char) < 32 for char in plan['account_scope']):
        raise LoginFailure('invalid login account scope')
    environment = plan['env']
    if not isinstance(environment, dict) or len(environment) > 40 or any(
            not isinstance(key, str) or re.fullmatch(r'[A-Z_][A-Z0-9_]{0,63}', key) is None or not isinstance(value, str)
            or len(value) > 4096 or '\0' in value for key, value in environment.items()):
        raise LoginFailure('invalid bounded login environment')
    fingerprint = plan.get('command_sha256')
    if fingerprint is not None and (not isinstance(fingerprint, str) or re.fullmatch(r'[0-9a-f]{64}', fingerprint) is None):
        raise LoginFailure('invalid executable pin')
    files = plan.get('command_files', {})
    if not isinstance(files, dict) or len(files) > 32:
        raise LoginFailure('invalid pinned login files')
    for filename, fingerprint in files.items():
        canonical_path(filename)
        if not isinstance(fingerprint, str) or re.fullmatch(r'[0-9a-f]{64}', fingerprint) is None:
            raise LoginFailure('invalid login file pin')
    ttl = plan.get('ttl_seconds', 600)
    if type(ttl) is not int or not 1 <= ttl <= 900:
        raise LoginFailure('invalid login lifetime')
    return {**plan, 'ttl_seconds': ttl}
