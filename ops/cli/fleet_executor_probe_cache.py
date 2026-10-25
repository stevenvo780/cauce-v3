from __future__ import annotations

import fcntl
import hashlib
import json
import math
import os
import pathlib
import re
import stat
import sys
import time
import uuid
from collections.abc import Callable

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / 'scripts'))
from secure_path import open_absolute_directory

TTL_SECONDS = 24 * 60 * 60


def executor_code_sha256() -> str:
    root = pathlib.Path(__file__).resolve().parents[1]
    digest = hashlib.sha256()
    # Include the local import closure, including dynamically selected harness modules.
    for directory in ('cli', 'scripts', 'container-runtime'):
        for source in sorted((root / directory).glob('*.py')):
            digest.update(str(source.relative_to(root)).encode() + b'\0')
            digest.update(hashlib.sha256(source.read_bytes()).digest())
    return digest.hexdigest()


def probe_key(row: dict, placement: dict | None, harness: str, code_sha256: str) -> str:
    target = {key: placement.get(key) for key in ('image', 'runtime_user', 'python')} if placement is not None else {
        'runtime_user': row.get('runtime_user'), 'python': str(pathlib.Path(sys.executable).resolve())}
    document = {'schema': 1, 'row': row, 'target': target, 'harness': harness,
                'mode': 'container' if placement is not None else 'native', 'code_sha256': code_sha256}
    body = json.dumps(document, sort_keys=True, separators=(',', ':'), ensure_ascii=True, allow_nan=False).encode()
    return hashlib.sha256(body).hexdigest()


def _private_file(descriptor: int) -> bool:
    details = os.fstat(descriptor)
    return stat.S_ISREG(details.st_mode) and details.st_uid == os.geteuid() \
        and stat.S_IMODE(details.st_mode) == 0o600 and details.st_nlink == 1


def _directory(state_root: str | pathlib.Path) -> int:
    parent = open_absolute_directory(state_root)
    try:
        details = os.fstat(parent)
        if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o700:
            raise ValueError('probe state root must be private and owned')
        try:
            os.mkdir('provider-probes', 0o700, dir_fd=parent)
        except FileExistsError:
            pass
        descriptor = os.open('provider-probes', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                             dir_fd=parent)
        details = os.fstat(descriptor)
        if details.st_uid != os.geteuid() or stat.S_IMODE(details.st_mode) != 0o700:
            os.close(descriptor)
            raise ValueError('probe cache must be private and owned')
        return descriptor
    finally:
        os.close(parent)


def _read(directory: int, key: str, now: float, ttl: int) -> bool | None:
    try:
        descriptor = os.open(key + '.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                             dir_fd=directory)
        try:
            if not _private_file(descriptor):
                return None
            body = os.read(descriptor, 4097)
            if len(body) > 4096:
                return None
            value = json.loads(body)
        finally:
            os.close(descriptor)
        if not isinstance(value, dict) or set(value) != {'key', 'created_at', 'result'} or value['key'] != key \
                or type(value['result']) is not bool or type(value['created_at']) not in (int, float):
            return None
        created = value['created_at']
        return value['result'] if math.isfinite(created) and 0 <= now - created < ttl else None
    except (OSError, ValueError, TypeError, OverflowError):
        return None


def _write(directory: int, key: str, result: bool, now: float) -> None:
    staged = key + '.' + uuid.uuid4().hex + '.tmp'
    try:
        descriptor = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                             0o600, dir_fd=directory)
        with os.fdopen(descriptor, 'wb') as stream:
            os.fchmod(stream.fileno(), 0o600)
            stream.write(json.dumps({'key': key, 'created_at': now, 'result': result}, allow_nan=False).encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(staged, key + '.json', src_dir_fd=directory, dst_dir_fd=directory)
        os.fsync(directory)
    finally:
        try:
            os.unlink(staged, dir_fd=directory)
        except FileNotFoundError:
            pass


def cached_probe(state_root: str | pathlib.Path, key: str, probe: Callable[[], bool], *,
                 now: float | None = None, ttl: int = TTL_SECONDS) -> bool:
    if re.fullmatch(r'[a-f0-9]{64}', key) is None:
        raise ValueError('invalid probe cache key')
    directory = lock = None
    try:
        try:
            directory = _directory(state_root)
            lock = os.open(key + '.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                           0o600, dir_fd=directory)
            if not _private_file(lock):
                raise ValueError('unsafe probe cache lock')
            fcntl.flock(lock, fcntl.LOCK_EX)
        except (OSError, ValueError):
            return probe()
        timestamp = time.time() if now is None else now
        value = _read(directory, key, timestamp, ttl)
        if value is not None:
            return value
        result = probe()
        if type(result) is bool:
            try:
                _write(directory, key, result, time.time() if now is None else now)
            except (OSError, ValueError):
                pass
        return result
    finally:
        if lock is not None:
            os.close(lock)
        if directory is not None:
            os.close(directory)


def measured_capability(policy: dict, row: dict, placement: dict | None, harness: str, module,
                        code_sha256: str) -> bool:
    import subprocess

    def probe():
        container = getattr(module, 'measured_container_definition', None) if placement is not None else None
        return container(row, placement, strict=True) if container else module.measured_definition(row, strict=True)

    try:
        state_root = policy.get('roots', {}).get('state')
        if state_root is None:
            return probe()
        return cached_probe(state_root, probe_key(row, placement, harness, code_sha256), probe)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError, UnicodeError):
        return False
