from __future__ import annotations

import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import zipfile

import space_archive

MAX_BYTES = 32 * 1024 * 1024
CHUNK_BYTES = 64 * 1024


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
