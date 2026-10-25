from __future__ import annotations

import base64
import errno
import json
import os
import pathlib
import re
import resource
import signal
import stat
import subprocess
import sys
import time
import uuid
import zipfile

import space_archive
from space_backup_validate import CHUNK_BYTES, MAX_BYTES, verified_archive


class LimitExceeded(ValueError):
    pass


def failure_record(cause_type: str, message: str, stage: str) -> dict:
    if stage not in {'runtime', 'local'}:
        raise ValueError('invalid backup failure stage')
    for pattern, replacement in (
        (r'-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)', '[redacted]'),
        (r'\bbearer\s+[^\s"\']+', 'Bearer [redacted]'),
        (r'\b((?:pass(?:word|wd)?|secret|token|api[_-]?key)["\']?\s*[=:]\s*)(?:"[^"]*"|\'[^\']*\'|[^\s"\',;]+)', r'\1[redacted]'),
        (r'\b[a-z][a-z0-9+.-]*://[^\s<>"\']+', '[url]'),
        (r'[A-Z]:[\\/][^\s<>"\']*', '[path]'),
        (r'\\\\[^\s<>"\']+', '[path]'),
        (r'/[^\s<>"\']*', '[path]'),
        (r'[A-Z0-9._%+-]+@[A-Z0-9.-]+', '[email]'),
        (r'[A-Za-z0-9+_=-]{33,}', '[redacted]'),
    ):
        message = re.sub(pattern, replacement, message, flags=re.IGNORECASE)
    message = re.sub(r'[\x00-\x1f\x7f-\x9f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]', ' ', message)
    message = re.sub(r'\s+', ' ', message).strip().encode('ascii', 'backslashreplace').decode()[:384]
    return {'event': 'space_backup_failure', 'stage': stage,
            'cause_type': cause_type if re.fullmatch('[A-Za-z][A-Za-z0-9_]{0,63}', cause_type) else 'Error',
            'cause_message': message or 'backup effect could not be verified'}


def exception_record(error: BaseException, stage: str) -> dict:
    if isinstance(error, (TimeoutError, subprocess.TimeoutExpired)):
        message = 'space backup command exceeded its deadline'
    elif isinstance(error, subprocess.CalledProcessError):
        message = f'space backup command exited with status {error.returncode}'
    elif isinstance(error, OSError):
        message = error.strerror or 'space backup filesystem operation failed'
    else:
        message = str(error)
    return failure_record(type(error).__name__, message, stage)


def bounded_read_file(parent: int, name: str, limit: int = space_archive.MAX_FILE) -> tuple[bytes, int]:
    details = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISREG(details.st_mode) and details.st_size > limit:
        raise LimitExceeded('space file exceeds its limit')
    return original_read_file(parent, name, limit)


original_read_file = space_archive.read_file


def archive_path(request: dict) -> pathlib.Path:
    fields = {'action', 'id', 'claim_epoch', 'state_directory', 'identity'}
    if not isinstance(request, dict) or set(request) != fields | ({'offset'} if request.get('action') == 'read' else set()) \
            or request['action'] not in {'export', 'read', 'remove'} \
            or str(uuid.UUID(request['id'])) != request['id'] \
            or type(request['claim_epoch']) is not int or not 1 <= request['claim_epoch'] <= 2147483647:
        raise ValueError('invalid local backup request')
    space_archive.identity(request['identity'])
    root = request['state_directory']
    descriptor = space_archive.open_directory(root)
    os.close(descriptor)
    return pathlib.Path(root) / f"space-backup-{request['id']}-{request['claim_epoch']}.zip"


def remove_copy(parent: int, name: str) -> None:
    try:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
    except FileNotFoundError:
        return
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o077:
        raise ValueError('backup cache has an unsafe copy')
    os.unlink(name, dir_fd=parent)


def execute(request: dict) -> dict:
    archive = archive_path(request)
    parent = space_archive.open_directory(str(archive.parent))
    try:
        if request['action'] == 'remove':
            remove_copy(parent, archive.name)
            return {'removed': True}
        if request['action'] == 'export':
            for name in os.listdir(parent):
                parts = name.removeprefix('space-backup-').removesuffix('.zip').rsplit('-', 1)
                if not name.startswith('space-backup-') or not name.endswith('.zip') or len(parts) != 2:
                    continue
                try:
                    if str(uuid.UUID(parts[0])) != parts[0] or not parts[1].isdigit():
                        continue
                except ValueError:
                    continue
                if os.stat(name, dir_fd=parent, follow_symlinks=False).st_mtime < time.time() - 86400:
                    remove_copy(parent, name)
            try:
                os.stat(archive.name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                signal.signal(signal.SIGXFSZ, signal.SIG_IGN)
                resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_BYTES, MAX_BYTES))
                space_archive.MAX_TOTAL = MAX_BYTES
                space_archive.read_file = bounded_read_file
                space_archive.backup_space(str(archive.parent / 'space'), str(archive), request['identity'])
            return verified_archive(str(archive), request['identity'])
        offset = request['offset']
        if type(offset) is not int or not 0 <= offset < MAX_BYTES:
            raise ValueError('invalid backup read offset')
        descriptor = os.open(archive.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        try:
            info = os.fstat(descriptor)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 \
                    or info.st_mode & 0o077 or not 0 < info.st_size <= MAX_BYTES or offset >= info.st_size:
                raise ValueError('backup cache is not a private bounded copy')
            chunk = os.pread(descriptor, CHUNK_BYTES, offset)
            if not chunk or space_archive.fingerprint(info) != space_archive.fingerprint(os.fstat(descriptor)):
                raise ValueError('backup chunk changed during read')
            return {'offset': offset, 'data': base64.b64encode(chunk).decode('ascii')}
        finally:
            os.close(descriptor)
    finally:
        os.close(parent)


def main() -> int:
    def expired(_signal, _frame):
        raise TimeoutError('space export deadline elapsed')

    signal.signal(signal.SIGALRM, expired)
    signal.alarm(110)
    try:
        raw = sys.stdin.buffer.read(16385)
        if len(raw) > 16384:
            raise ValueError('backup request exceeds its limit')
        print(json.dumps(execute(json.loads(raw)), separators=(',', ':')))
        return 0
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, RuntimeError) as error:
        if isinstance(error, LimitExceeded) or isinstance(error, OSError) and error.errno == errno.EFBIG or isinstance(error, space_archive.SpaceArchiveFailure) \
                and str(error) in {'space archive exceeds its total byte limit', 'space contains too many archive entries',
                                   'space manifest exceeds its limit'}:
            print(json.dumps({'error': 'LIMIT_EXCEEDED'}))
            return 0
        print(json.dumps(exception_record(error, 'local'), separators=(',', ':')), file=sys.stderr)
        return 1
    finally:
        signal.alarm(0)


if __name__ == '__main__':
    raise SystemExit(main())
