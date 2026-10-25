from __future__ import annotations

import base64
import hashlib
import json
import os
import pathlib
import re
import signal
import stat
import subprocess
import sys
import threading
import zipfile

import space_archive

MAX_BYTES = space_archive.MAX_ARCHIVE
CHUNK_BYTES = 4 * 1024 * 1024
FRAME_BYTES = 8 * 1024 * 1024
REQUEST_BYTES = 16384
CLOSE_SECONDS = 2
JOIN_SECONDS = 0.25


def closed_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate backup frame field')
        result[key] = value
    return result


def read_frame(source, limit: int = FRAME_BYTES) -> dict | None:
    raw = source.readline(limit + 1)
    if not raw:
        return None
    if len(raw) > limit or not raw.endswith(b'\n'):
        raise ValueError('backup stream frame exceeds its limit or is incomplete')
    value = json.loads(raw, object_pairs_hook=closed_object)
    if not isinstance(value, dict):
        raise ValueError('backup stream frame is not an object')
    return value


def write_frame(destination, value: dict) -> None:
    encoded = json.dumps(value, separators=(',', ':'), allow_nan=False).encode('ascii') + b'\n'
    if len(encoded) > FRAME_BYTES:
        raise ValueError('backup stream frame exceeds its limit')
    destination.write(encoded)
    destination.flush()


def acknowledged(source, offset: int) -> bool:
    frame = read_frame(source, 256)
    if frame is None or frame == {'cancel': True} and type(frame['cancel']) is bool:
        return False
    if set(frame) != {'offset'} or type(frame['offset']) is not int or frame['offset'] != offset:
        raise ValueError('backup stream acknowledgement differs')
    return True


class PinnedBackupReader:
    def __init__(self, archive: pathlib.Path, offset: int):
        self.parent = space_archive.open_directory(str(archive.parent))
        self.descriptor = None
        self.name = archive.name
        try:
            self.descriptor = os.open(self.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.parent)
            self.initial = os.fstat(self.descriptor)
            self.unchanged()
            if type(offset) is not int or not 0 <= offset <= self.initial.st_size:
                raise ValueError('invalid backup stream offset')
            self.offset = offset
        except BaseException:
            self.close()
            raise

    def unchanged(self) -> None:
        for info in (os.fstat(self.descriptor), os.stat(self.name, dir_fd=self.parent, follow_symlinks=False)):
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 \
                    or info.st_mode & 0o077 or not 0 < info.st_size <= MAX_BYTES \
                    or space_archive.fingerprint(info) != space_archive.fingerprint(self.initial):
                raise ValueError('backup stream copy changed or is not private and bounded')

    def read(self) -> dict | None:
        self.unchanged()
        if self.offset == self.initial.st_size:
            return None
        chunk = os.pread(self.descriptor, CHUNK_BYTES, self.offset)
        self.unchanged()
        if len(chunk) != min(CHUNK_BYTES, self.initial.st_size - self.offset):
            raise ValueError('backup stream chunk is incomplete')
        return {'offset': self.offset, 'data': base64.b64encode(chunk).decode('ascii')}

    def advance(self, frame: dict) -> int:
        self.offset += len(base64.b64decode(frame['data'], validate=True))
        return self.offset

    def close(self) -> None:
        if self.descriptor is not None:
            os.close(self.descriptor)
            self.descriptor = None
        os.close(self.parent)


def bounded_process_exit(process, remote: bool = False) -> tuple[int, bool]:
    forced = False
    for signum in (None, signal.SIGTERM, signal.SIGKILL):
        if signum is not None and process.poll() is None:
            try:
                if os.getpgid(process.pid) == process.pid:
                    os.killpg(process.pid, signum)
                else:
                    process.send_signal(signum)
                forced = True
            except ProcessLookupError:
                pass
        try:
            return process.wait(timeout=CLOSE_SECONDS), forced
        except subprocess.TimeoutExpired:
            pass
    message = 'backup stream local process exit could not be confirmed after forced termination'
    raise RuntimeError(message + ('; remote exit is unconfirmed' if remote else ''))


class BackupStreamChild:
    def __init__(self, process, remote: bool = False):
        self.process = process
        self.remote = remote
        self.stderr = bytearray()
        self.output_overflow = False
        self.reader = threading.Thread(target=self.drain_errors, daemon=True)
        self.reader.start()

    def drain_errors(self) -> None:
        while chunk := self.process.stderr.read(1024):
            self.stderr.extend(chunk)
            del self.stderr[:-1024]

    def wait(self) -> int:
        code = self.process.wait(timeout=CLOSE_SECONDS)
        self.reader.join(timeout=JOIN_SECONDS)
        return code

    def discard_output(self) -> None:
        discarded = 0
        while chunk := self.process.stdout.read(65536):
            discarded += len(chunk)
            if discarded > FRAME_BYTES + 256:
                self.output_overflow = True
                return

    def close(self) -> None:
        try:
            if self.process.poll() is None:
                try:
                    write_frame(self.process.stdin, {'cancel': True})
                except (BrokenPipeError, OSError, ValueError):
                    pass
        finally:
            try:
                self.process.stdin.close()
            except OSError:
                pass
        output_reader = threading.Thread(target=self.discard_output, daemon=True)
        output_reader.start()
        try:
            code, forced = bounded_process_exit(self.process, remote=self.remote)
            self.reader.join(timeout=JOIN_SECONDS)
            output_reader.join(timeout=JOIN_SECONDS)
            if forced:
                if self.remote:
                    raise RuntimeError('backup stream remote exit is unconfirmed after forced termination of the local transport')
                raise RuntimeError('backup stream native child required forced termination; local exit was confirmed')
            if code != 0:
                import space_backup_runtime as runtime
                record = runtime.local_failure(bytes(self.stderr))
                if record is not None:
                    raise runtime.BackupEffectFailure(record)
                raise RuntimeError('backup stream child exit could not be confirmed successfully')
            if output_reader.is_alive() or self.output_overflow:
                raise RuntimeError('backup stream child exit could not be confirmed successfully')
        finally:
            if not output_reader.is_alive():
                self.process.stdout.close()
            if not self.reader.is_alive():
                self.process.stderr.close()


def relay_stream(child: BackupStreamChild, source, destination, offset: int) -> dict | None:
    short_chunk = False
    while True:
        frame = read_frame(child.process.stdout)
        if frame is None:
            raise ValueError('backup stream ended without its completion receipt')
        if set(frame) == {'done', 'offset'} and frame['done'] is True \
                and type(frame['offset']) is int and frame['offset'] == offset:
            if read_frame(child.process.stdout) is not None or child.wait() != 0:
                raise ValueError('backup stream child did not exit successfully')
            return frame
        if set(frame) != {'offset', 'data'} or type(frame['offset']) is not int or frame['offset'] != offset \
                or not isinstance(frame['data'], str) or short_chunk:
            raise ValueError('invalid closed backup chunk frame')
        data = base64.b64decode(frame['data'], validate=True)
        if not 0 < len(data) <= CHUNK_BYTES or offset + len(data) > MAX_BYTES:
            raise ValueError('backup stream chunk exceeds its bounds')
        short_chunk = len(data) < CHUNK_BYTES
        write_frame(destination, frame)
        offset += len(data)
        if not acknowledged(source, offset):
            return None
        write_frame(child.process.stdin, {'offset': offset})


def verified_archive(archive: str, expected: dict, manifest_sha256: str | None = None) -> dict:
    expected = space_archive.identity(expected)
    target = pathlib.Path(archive)
    parent = space_archive.open_directory(str(target.parent))
    descriptor = None
    try:
        descriptor = os.open(target.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1 \
                or before.st_mode & 0o077 or not 0 < before.st_size <= MAX_BYTES:
            raise ValueError('archive copy is not private or bounded')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            archive_hash = hashlib.sha256()
            while chunk := stream.read(CHUNK_BYTES):
                archive_hash.update(chunk)
            stream.seek(0)
            with zipfile.ZipFile(stream) as zipped:
                _, encoded = space_archive.validated_archive(zipped, expected)
        if space_archive.fingerprint(before) != space_archive.fingerprint(os.fstat(descriptor)):
            raise ValueError('archive copy changed during verification')
        manifest_hash = hashlib.sha256(encoded).hexdigest()
        if manifest_sha256 is not None and manifest_hash != manifest_sha256:
            raise ValueError('archive manifest digest differs')
        return {'bytes': before.st_size, 'sha256': archive_hash.hexdigest(), 'manifest_sha256': manifest_hash}
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def main() -> int:
    try:
        raw = sys.stdin.buffer.read(8193)
        request = json.loads(raw)
        if len(raw) > 8192 or not isinstance(request, dict) or set(request) != {'archive', 'identity', 'manifest_sha256'} \
                or not isinstance(request['manifest_sha256'], str) or not re.fullmatch('[a-f0-9]{64}', request['manifest_sha256']):
            raise ValueError('invalid archive verification request')
        verified_archive(request['archive'], request['identity'], request['manifest_sha256'])
        print(json.dumps({'verified': True}))
        return 0
    except (OSError, ValueError, TypeError, KeyError, zipfile.BadZipFile, RuntimeError):
        print('Space archive verification failed.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
