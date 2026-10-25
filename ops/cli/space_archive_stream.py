from __future__ import annotations

import hashlib
import os
import pathlib
import re
import stat

ROOTS = frozenset({'context', 'directives', 'projects', 'config', 'data'})


SCHEMA_VERSION = 2
RESTORABLE_SCHEMAS = frozenset({1, 2})
VERIFIED_CREDENTIAL = re.compile(rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}'
    rb'|(?-i:\bgh[pous]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}'
    rb'|\bAKIA[0-9A-Z]{16}\b|\bnpm_[A-Za-z0-9]{36}\b)', re.I)
AWS_SECRET_LITERAL = re.compile(
    rb'aws_secret_access_key["\x27]?(?:\s{0,16}(?:=>|[:=]|>)|\s{1,16})\s{0,16}["\x27]?(?!\$\{)(?!process\.env\b)[A-Za-z0-9/+]{20,}', re.I)
NPM_AUTH_LITERAL = re.compile(
    rb'_authToken["\x27]?\s{0,16}[:=]\s{0,16}["\x27]?(?!\$\{|process\.env\b)[^\s"\x27]{8,}', re.I)
URL_USERINFO = re.compile(rb'://([^\s/:@"\x27]+):([^\s/@"\x27]+)@')
URL_USER_END = re.compile(rb'[\s/:@"\x27]')
URL_PASSWORD_END = re.compile(rb'[\s/@"\x27]')
CONFIG_ASSIGNMENT = re.compile(
    rb'["\x27]?(?:access_token|refresh_token|client_secret|api_key|password)["\x27]?\s*[:=]\s*["\x27]?[^\s"\x27]{6,}', re.I)
MAX_BUFFERED_FILE = 128 * 1024 * 1024
MAX_FILE = 16 * 1024 * 1024 * 1024
MAX_TOTAL = MAX_FILE
MAX_ENTRIES = 20_000
MAX_MANIFEST = 8 * 1024 * 1024
ARCHIVE_OVERHEAD = 64 * 1024 * 1024
MAX_ARCHIVE = MAX_TOTAL + MAX_MANIFEST + ARCHIVE_OVERHEAD
ARCHIVE_CHUNK_BYTES = 1024 * 1024


class SpaceArchiveFailure(ValueError):
    pass


def relative_path(value: str) -> str:
    if not isinstance(value, str):
        raise SpaceArchiveFailure('archive path is outside the space allowlist')
    path = pathlib.PurePosixPath(value)
    if str(path) != value or path.is_absolute() or len(value.encode()) > 1024 \
            or len(path.parts) > 32 or any(part in ('', '.', '..') or '\\' in part \
                or any(ord(character) < 32 or ord(character) == 127 for character in part) for part in path.parts) \
            or not path.parts or path.parts[0] not in ROOTS:
        raise SpaceArchiveFailure('archive path is outside the space allowlist')
    return value


def open_directory(location: str, private: bool = True) -> int:
    path = pathlib.PurePosixPath(location)
    if not path.is_absolute() or str(path) != location or '..' in path.parts or location == '/':
        raise SpaceArchiveFailure('space directory must be canonical and absolute')
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parts[1:]:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
            info = os.fstat(descriptor)
            sticky = info.st_uid == 0 and bool(info.st_mode & stat.S_ISVTX)
            if info.st_uid not in (0, os.geteuid()) or info.st_mode & 0o022 and not sticky:
                raise SpaceArchiveFailure('space directory has an unsafe owner or mode')
        info = os.fstat(descriptor)
        if private and (info.st_uid != os.geteuid() or info.st_mode & 0o077):
            raise SpaceArchiveFailure('space directory must be private and owned by the selected user')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_relative_directory(root: int, relative: str) -> int:
    if relative != '.':
        relative_path(relative)
    descriptor = os.dup(root)
    try:
        for part in pathlib.PurePosixPath(relative).parts:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
            info = os.fstat(descriptor)
            if info.st_uid != os.geteuid() or info.st_mode & 0o077:
                raise SpaceArchiveFailure('restored space directory has an unsafe owner or mode')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def fingerprint(info: os.stat_result) -> tuple:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def read_file(parent: int, name: str, limit: int = MAX_BUFFERED_FILE) -> tuple[bytes, int]:
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_nlink != 1 \
                or before.st_mode & 0o022 or before.st_size > limit:
            raise SpaceArchiveFailure('space file has an unsafe owner, type, size or links')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit or fingerprint(os.fstat(descriptor)) != fingerprint(before):
            raise SpaceArchiveFailure('space file changed during its read')
        return data, 0o700 if before.st_mode & stat.S_IXUSR else 0o600
    finally:
        os.close(descriptor)


class SecretScanner:
    """Retains bounded lexical context; URL userinfo may span arbitrarily many chunks."""
    def __init__(self, path: str, schema_version: int = SCHEMA_VERSION):
        self.path, self.schema = path, schema_version
        self.tail = b''
        self.url_tail, self.url_stage, self.url_prefix, self.url_seen = b'', '', b'', False
        self.found = False

    def url_userinfo(self, chunk: bytes) -> bool:
        data = self.url_tail + chunk if not self.url_stage else chunk
        self.url_tail = b''
        offset = 0
        while offset < len(data):
            if not self.url_stage:
                start = data.find(b'://', offset)
                if start < 0:
                    self.url_tail = data[max(offset, len(data) - 2):]
                    return False
                self.url_stage, self.url_seen, self.url_prefix, offset = 'user', False, b'', start + 3
            pattern = URL_USER_END if self.url_stage == 'user' else URL_PASSWORD_END
            ending = pattern.search(data, offset)
            end = ending.start() if ending else len(data)
            seen = self.url_seen or end > offset
            if self.url_stage == 'password':
                self.url_prefix += data[offset:min(end, offset + 11 - len(self.url_prefix))]
            if ending is None:
                self.url_seen = seen
                return False
            separator = data[end:end + 1]
            if self.url_stage == 'user' and separator == b':' and seen:
                self.url_stage, self.url_seen, self.url_prefix, offset = 'password', False, b'', end + 1
                continue
            if self.url_stage == 'password' and separator == b'@' and seen \
                    and not self.url_prefix.lower().startswith((b'${', b'process.env')):
                return True
            self.url_stage, offset = '', max(0, end - 2)
        return False

    def feed(self, chunk: bytes, final: bool = False) -> None:
        if self.found:
            return
        if self.schema in RESTORABLE_SCHEMAS and self.url_userinfo(chunk):
            self.found = True
            return
        # Whitespace runs have no required lower bound greater than one; collapsing only widens the scan.
        data = re.sub(rb'\s+', b' ', self.tail + chunk)
        patterns = [VERIFIED_CREDENTIAL, AWS_SECRET_LITERAL, NPM_AUTH_LITERAL]
        if self.path.startswith('config/'):
            patterns.append(CONFIG_ASSIGNMENT)
        for pattern in patterns:
            for match in pattern.finditer(data):
                if final or match.start() + 256 <= len(data):
                    self.found = True
                    return
        if re.search(rb'-----BEGIN [A-Z ]{512}', data, re.I):
            self.found = True
        self.tail = data[-1024:]


def stream_content(stream, path: str, schema_version: int = SCHEMA_VERSION, output=None) -> tuple[str, int, bool, bytes]:
    digest, size, metadata = hashlib.sha256(), 0, bytearray()
    scanner = SecretScanner(path, schema_version)
    while chunk := stream.read(ARCHIVE_CHUNK_BYTES):
        size += len(chunk)
        if size > MAX_FILE:
            raise SpaceArchiveFailure('space file exceeds its size limit')
        digest.update(chunk)
        scanner.feed(chunk)
        if path == 'config/context-state.json':
            if size > MAX_MANIFEST:
                raise SpaceArchiveFailure('space context identity receipt exceeds its limit')
            metadata.extend(chunk)
        if output is not None:
            output.write(chunk)
    scanner.feed(b'', final=True)
    return digest.hexdigest(), size, scanner.found, bytes(metadata)


def require_free_space(descriptor: int, size: int, entries: int = 0) -> None:
    details = os.fstatvfs(descriptor)
    required = size + MAX_MANIFEST + ARCHIVE_OVERHEAD + entries * max(4096, details.f_frsize)
    available = details.f_bavail * details.f_frsize
    if available < required or details.f_favail < entries + 1:
        raise SpaceArchiveFailure(f'insufficient free space for space archive: required {required} bytes, available {available} bytes')


def backup_preflight(root: int, omit) -> tuple[int, int]:
    total, entries = 0, 0

    def walk(descriptor: int, prefix: str):
        nonlocal total, entries
        before = os.fstat(descriptor)
        if before.st_uid != os.geteuid() or before.st_mode & 0o022:
            raise SpaceArchiveFailure('space child directory has an unsafe owner or mode')
        for name in sorted(os.listdir(descriptor)):
            path = relative_path(prefix + '/' + name)
            entries += 1
            if entries > MAX_ENTRIES:
                raise SpaceArchiveFailure('space contains too many archive entries')
            if omit(path):
                continue
            details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISDIR(details.st_mode):
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                try:
                    walk(child, path)
                finally:
                    os.close(child)
            elif stat.S_ISREG(details.st_mode) and details.st_nlink == 1:
                if details.st_size > MAX_FILE:
                    raise SpaceArchiveFailure('space file exceeds its size limit')
                total += details.st_size
                if total > MAX_TOTAL:
                    raise SpaceArchiveFailure('space archive exceeds its total byte limit')
        if fingerprint(os.fstat(descriptor)) != fingerprint(before):
            raise SpaceArchiveFailure('space directory changed during preflight')

    for name in sorted(ROOTS):
        try:
            child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        except FileNotFoundError:
            continue
        try:
            entries += 1
            if entries > MAX_ENTRIES:
                raise SpaceArchiveFailure('space contains too many archive entries')
            walk(child, name)
        finally:
            os.close(child)
    return total, entries
