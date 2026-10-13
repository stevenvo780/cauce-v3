from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import stat
import sys
import zipfile

ROOTS = frozenset({'context', 'directives', 'projects', 'config', 'data'})
IDENTITY_FIELDS = frozenset({'company_id', 'tenant_id', 'alias', 'runtime_key'})
IDENTIFIER = re.compile(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z')
CREDENTIAL_FILE = re.compile(
    r'(?:auth\.json|\.?credentials(?:[^/]*\.json|\.(?:ya?ml|toml|ini|txt))?|\.git-credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc|\.htpasswd'
    r'|id_(?:rsa|dsa|ecdsa|ed25519)|client_secrets?[^/]*\.json|secrets?\.(?:json|ya?ml|toml)|token\.json|[^/]+\.session'
    r'|cookies(?:-journal|\.(?:txt|json|sqlite(?:-wal|-shm|-journal)?))?|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))\Z', re.I)
CREDENTIAL_DIRECTORIES = frozenset({'.codex', '.claude', '.config', '.ssh', '.gnupg', '.aws', '.docker', '.kube', '.gemini'})
# .git config embeds remote URLs and hooks, and object stores break the entry cap or the hardlink check; the remote is the source of truth.
VCS_DIRECTORY = '.git'
OMISSION_REASONS = frozenset({'sensitive_path', 'sensitive_content', 'vcs_metadata', 'external_mount', 'special_file'})
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
CONFIG_ASSIGNMENT = re.compile(
    rb'["\x27]?(?:access_token|refresh_token|client_secret|api_key|password)["\x27]?\s*[:=]\s*["\x27]?[^\s"\x27]{6,}', re.I)
MAX_FILE = 128 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
MAX_ENTRIES = 20_000
MAX_MANIFEST = 8 * 1024 * 1024


class SpaceArchiveFailure(ValueError):
    pass


def identity(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) != IDENTITY_FIELDS \
            or any(not isinstance(item, str) or not IDENTIFIER.fullmatch(item) for item in value.values()):
        raise SpaceArchiveFailure('space identity is invalid')
    return value.copy()


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


def external_mount_path(value: str) -> str:
    path = pathlib.PurePosixPath(value)
    if not isinstance(value, str) or str(path) != value or not path.is_absolute() or value == '/' or len(value.encode()) > 1024 \
            or any(part == '..' or any(ord(character) < 32 or ord(character) == 127 for character in part) for part in path.parts):
        raise SpaceArchiveFailure('archive external mount path is invalid')
    return value


def external_mounts(root: int, source: str) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Declared excluded mounts: archive-relative paths inside the space, and absolute paths outside it (recorded as receipts only)."""
    try:
        parent = os.open('config', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    except FileNotFoundError:
        return (), ()
    try:
        try:
            os.stat('external-mounts.json', dir_fd=parent, follow_symlinks=False)
        except FileNotFoundError:
            return (), ()
        info = os.fstat(parent)
        if info.st_uid != os.geteuid() or info.st_mode & 0o077:
            raise SpaceArchiveFailure('restored space directory has an unsafe owner or mode')
        data, _ = read_file(parent, 'external-mounts.json', MAX_MANIFEST)
    finally:
        os.close(parent)
    try:
        paths = [item['path'] for item in json.loads(data)['mounts'] if item.get('excluded_from_copy') is True]
        if not all(isinstance(path, str) and path for path in paths):
            raise TypeError
    except (ValueError, TypeError, KeyError, AttributeError):
        raise SpaceArchiveFailure('external mount declaration is invalid') from None
    inside, outside = [], []
    for path in paths:
        normalized = pathlib.PurePosixPath(os.path.normpath(path))
        if normalized.is_absolute():
            if not normalized.is_relative_to(source):
                try:
                    outside.append(external_mount_path(str(normalized)))
                except SpaceArchiveFailure:
                    raise SpaceArchiveFailure('external mount declaration is invalid') from None
                continue
            normalized = normalized.relative_to(source)
        if str(normalized) != '.':
            inside.append(str(normalized))
    return tuple(inside), tuple(sorted(set(outside)))


def omission_reason(value: str, mounts: tuple[str, ...] = ()) -> str | None:
    if any(value == mount or value.startswith(mount + '/') for mount in mounts):
        return 'external_mount'
    parts = pathlib.PurePosixPath(value).parts
    if any(part.lower() in CREDENTIAL_DIRECTORIES or CREDENTIAL_FILE.match(part) for part in parts):
        return 'sensitive_path'
    return 'vcs_metadata' if VCS_DIRECTORY in (part.lower() for part in parts) else None


def excluded(value: str) -> bool:
    return omission_reason(value) is not None


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


def literal_userinfo(data: bytes) -> bool:
    for _user, password in URL_USERINFO.findall(data):
        lowered = password.lower()
        if lowered.startswith(b'${') or lowered.startswith(b'process.env'):
            continue
        return True
    return False


def sensitive_content(path: str, data: bytes, schema_version: int = SCHEMA_VERSION) -> bool:
    if VERIFIED_CREDENTIAL.search(data):
        return True
    if schema_version in RESTORABLE_SCHEMAS and (AWS_SECRET_LITERAL.search(data) or NPM_AUTH_LITERAL.search(data) or literal_userinfo(data)):
        return True
    return path.startswith('config/') and CONFIG_ASSIGNMENT.search(data) is not None


def fingerprint(info: os.stat_result) -> tuple:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def read_file(parent: int, name: str, limit: int = MAX_FILE) -> tuple[bytes, int]:
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


def zip_entry(path: str, mode: int, directory: bool = False) -> zipfile.ZipInfo:
    item = zipfile.ZipInfo(path + '/' if directory else path)
    item.create_system = 3
    item.external_attr = ((stat.S_IFDIR if directory else stat.S_IFREG) | mode) << 16
    item.compress_type = zipfile.ZIP_STORED
    return item


def verify_context_identity(raw: bytes, expected: dict) -> None:
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        raise SpaceArchiveFailure('space context identity receipt is invalid') from None
    if not isinstance(value, dict) or any(value.get(field) != expected[field] for field in ('company_id', 'tenant_id', 'alias')):
        raise SpaceArchiveFailure('space belongs to another context identity')


def backup_space(source: str, archive: str, expected_identity: dict) -> dict:
    expected = identity(expected_identity)
    if pathlib.Path(archive).is_relative_to(pathlib.Path(source)):
        raise SpaceArchiveFailure('space backup archive must be outside the source space')
    root = open_directory(source)
    root_before = os.fstat(root)
    mounts, outside_mounts = external_mounts(root, source)
    destination = pathlib.Path(archive)
    parent = open_directory(str(destination.parent))
    file_descriptor = None
    created_identity = None
    directories, files = [], []
    omissions = [{'path': path, 'reason': 'external_mount'} for path in outside_mounts]
    size = 0
    try:
        file_descriptor = os.open(destination.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=parent)
        created_identity = os.fstat(file_descriptor).st_ino
        with os.fdopen(file_descriptor, 'wb', closefd=False) as output, zipfile.ZipFile(output, 'w') as zipped:
            def walk(descriptor: int, prefix: str) -> None:
                nonlocal size
                before = os.fstat(descriptor)
                if before.st_uid != os.geteuid() or before.st_mode & 0o022:
                    raise SpaceArchiveFailure('space child directory has an unsafe owner or mode')
                for name in sorted(os.listdir(descriptor)):
                    path = relative_path(prefix + '/' + name)
                    if len(directories) + len(files) + len(omissions) >= MAX_ENTRIES:
                        raise SpaceArchiveFailure('space contains too many archive entries')
                    reason = omission_reason(path, mounts)
                    if reason:
                        omissions.append({'path': path, 'reason': reason})
                        continue
                    details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
                    if stat.S_ISDIR(details.st_mode):
                        child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                        try:
                            directories.append(path)
                            zipped.writestr(zip_entry(path, 0o700, True), b'')
                            walk(child, path)
                        finally:
                            os.close(child)
                        continue
                    if not stat.S_ISREG(details.st_mode) or details.st_nlink != 1:
                        omissions.append({'path': path, 'reason': 'special_file'})
                        continue
                    data, mode = read_file(descriptor, name)
                    if sensitive_content(path, data):
                        omissions.append({'path': path, 'reason': 'sensitive_content'})
                        continue
                    if path == 'config/context-state.json':
                        verify_context_identity(data, expected)
                    size += len(data)
                    if size > MAX_TOTAL:
                        raise SpaceArchiveFailure('space archive exceeds its total byte limit')
                    files.append({'path': path, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest(), 'mode': mode})
                    zipped.writestr(zip_entry(path, mode), data)
                if fingerprint(os.fstat(descriptor)) != fingerprint(before):
                    raise SpaceArchiveFailure('space directory changed during backup')
            for name in sorted(ROOTS):
                try:
                    child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
                except FileNotFoundError:
                    continue
                try:
                    if len(directories) + len(files) + len(omissions) >= MAX_ENTRIES:
                        raise SpaceArchiveFailure('space contains too many archive entries')
                    directories.append(name)
                    zipped.writestr(zip_entry(name, 0o700, True), b'')
                    walk(child, name)
                finally:
                    os.close(child)
            if fingerprint(os.fstat(root)) != fingerprint(root_before):
                raise SpaceArchiveFailure('space root changed during backup')
            manifest = {'schema_version': SCHEMA_VERSION, 'identity': expected, 'directories': directories, 'files': files,
                        'omissions': omissions, 'excluded_roots': ['logs', 'tmp'], 'bytes': size}
            encoded = json.dumps(manifest, sort_keys=True, separators=(',', ':')).encode()
            if len(encoded) > MAX_MANIFEST:
                raise SpaceArchiveFailure('space manifest exceeds its limit')
            zipped.writestr(zip_entry('space-manifest.json', 0o600), encoded)
        os.fsync(file_descriptor)
        return {'state': 'backed_up', 'archive': archive, 'identity': expected, 'files': len(files),
                'bytes': size, 'omissions': omissions, 'manifest_sha256': hashlib.sha256(encoded).hexdigest()}
    except BaseException:
        if created_identity is not None:
            try:
                if os.stat(destination.name, dir_fd=parent, follow_symlinks=False).st_ino == created_identity:
                    os.unlink(destination.name, dir_fd=parent)
            except FileNotFoundError:
                pass
        raise
    finally:
        if file_descriptor is not None:
            os.close(file_descriptor)
        os.close(parent)
        os.close(root)


def validated_archive(zipped: zipfile.ZipFile, expected: dict) -> tuple[dict, bytes]:
    entries = zipped.infolist()
    if len(entries) > MAX_ENTRIES + 1 or len({entry.filename for entry in entries}) != len(entries):
        raise SpaceArchiveFailure('space archive has too many or duplicate entries')
    try:
        manifest_entry = zipped.getinfo('space-manifest.json')
        if manifest_entry.file_size > MAX_MANIFEST:
            raise SpaceArchiveFailure('space manifest exceeds its limit')
        encoded = zipped.read(manifest_entry)
        manifest = json.loads(encoded)
    except (KeyError, ValueError, UnicodeError):
        raise SpaceArchiveFailure('space manifest is unavailable') from None
    if not isinstance(manifest, dict) or set(manifest) != {'schema_version', 'identity', 'directories', 'files', 'omissions', 'excluded_roots', 'bytes'} \
            or type(manifest['schema_version']) is not int or manifest['schema_version'] not in RESTORABLE_SCHEMAS \
            or identity(manifest['identity']) != expected or manifest['excluded_roots'] != ['logs', 'tmp'] \
            or not all(isinstance(manifest[field], list) for field in ('directories', 'files', 'omissions')):
        raise SpaceArchiveFailure('space archive identity or schema differs')
    names = {'space-manifest.json'}
    directories = set()
    for path in manifest['directories']:
        relative_path(path)
        if excluded(path) or path in directories:
            raise SpaceArchiveFailure('space archive directory is sensitive or duplicated')
        directories.add(path)
        names.add(path + '/')
    if any(str(pathlib.PurePosixPath(path).parent) not in directories for path in directories if path not in ROOTS):
        raise SpaceArchiveFailure('space archive directory has no parent receipt')
    if len(manifest['omissions']) + len(entries) > MAX_ENTRIES + 1:
        raise SpaceArchiveFailure('space archive has too many omissions')
    for item in manifest['omissions']:
        if not isinstance(item, dict) or set(item) != {'path', 'reason'} or item['reason'] not in OMISSION_REASONS:
            raise SpaceArchiveFailure('space omission receipt is invalid')
        if item['reason'] == 'external_mount' and isinstance(item['path'], str) and item['path'].startswith('/'):
            external_mount_path(item['path'])
        else:
            relative_path(item['path'])
    size = 0
    for item in manifest['files']:
        if not isinstance(item, dict) or set(item) != {'path', 'bytes', 'sha256', 'mode'} \
                or type(item['bytes']) is not int or not 0 <= item['bytes'] <= MAX_FILE \
                or not isinstance(item['sha256'], str) or not re.fullmatch('[a-f0-9]{64}', item['sha256']) \
                or type(item['mode']) is not int or item['mode'] not in (0o600, 0o700):
            raise SpaceArchiveFailure('space file receipt is invalid')
        path = relative_path(item['path'])
        if excluded(path) or path in names or path in directories or str(pathlib.PurePosixPath(path).parent) not in directories:
            raise SpaceArchiveFailure('space archive file is sensitive, duplicate or orphaned')
        names.add(path)
        size += item['bytes']
    if type(manifest['bytes']) is not int or size != manifest['bytes'] or size > MAX_TOTAL \
            or names != {item.filename for item in entries}:
        raise SpaceArchiveFailure('space archive contents differ from the manifest')
    for item in entries:
        mode = item.external_attr >> 16
        expected_type = stat.S_IFDIR if item.filename.endswith('/') else stat.S_IFREG
        if stat.S_IFMT(mode) != expected_type or item.compress_type != zipfile.ZIP_STORED or item.flag_bits & 1 \
                or item.filename.endswith('/') and (item.file_size != 0 or mode != stat.S_IFDIR | 0o700) \
                or item.filename == 'space-manifest.json' and mode != stat.S_IFREG | 0o600 \
                or item.file_size > (MAX_MANIFEST if item.filename == 'space-manifest.json' else MAX_FILE):
            raise SpaceArchiveFailure('space archive entry has an unsafe type or compression')
    for item in manifest['files']:
        entry = zipped.getinfo(item['path'])
        if entry.file_size != item['bytes'] or entry.external_attr >> 16 != stat.S_IFREG | item['mode']:
            raise SpaceArchiveFailure('space archive entry differs from its receipt')
        data = zipped.read(entry)
        if hashlib.sha256(data).hexdigest() != item['sha256'] or sensitive_content(item['path'], data, manifest['schema_version']):
            raise SpaceArchiveFailure('space archive digest or content is invalid')
        if item['path'] == 'config/context-state.json':
            verify_context_identity(data, expected)
    return manifest, encoded


def restore_space(archive: str, destination: str, expected_identity: dict) -> dict:
    expected = identity(expected_identity)
    source = pathlib.Path(archive)
    archive_parent = open_directory(str(source.parent))
    descriptor = os.open(source.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=archive_parent)
    root = None
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid() or before.st_mode & 0o077 \
                or before.st_nlink != 1 or before.st_size > MAX_TOTAL + MAX_MANIFEST + 32 * 1024 * 1024:
            raise SpaceArchiveFailure('space archive must be private and owned by the selected user')
        with os.fdopen(descriptor, 'rb', closefd=False) as stream, zipfile.ZipFile(stream) as zipped:
            manifest, encoded = validated_archive(zipped, expected)
            path = pathlib.Path(destination)
            parent = open_directory(str(path.parent))
            try:
                try:
                    os.mkdir(path.name, 0o700, dir_fd=parent)
                except FileExistsError:
                    pass
                root = open_directory(destination)
            finally:
                os.close(parent)
            if os.listdir(root):
                raise SpaceArchiveFailure('space restore destination must be new or empty')
            for directory in sorted(manifest['directories'], key=lambda value: (len(pathlib.PurePosixPath(value).parts), value)):
                parent = open_relative_directory(root, str(pathlib.PurePosixPath(directory).parent))
                try:
                    os.mkdir(pathlib.PurePosixPath(directory).name, 0o700, dir_fd=parent)
                finally:
                    os.close(parent)
            for item in manifest['files']:
                parent = open_relative_directory(root, str(pathlib.PurePosixPath(item['path']).parent))
                try:
                    data = zipped.read(item['path'])
                    if hashlib.sha256(data).hexdigest() != item['sha256'] or sensitive_content(item['path'], data, manifest['schema_version']):
                        raise SpaceArchiveFailure('space archive changed before file restoration')
                    target = os.open(pathlib.PurePosixPath(item['path']).name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, item['mode'], dir_fd=parent)
                    with os.fdopen(target, 'wb') as output:
                        output.write(data)
                        output.flush()
                        os.fsync(output.fileno())
                    readback, _ = read_file(parent, pathlib.PurePosixPath(item['path']).name)
                    if hashlib.sha256(readback).hexdigest() != item['sha256']:
                        raise SpaceArchiveFailure('restored space file readback differs')
                finally:
                    os.close(parent)
            if fingerprint(os.fstat(descriptor)) != fingerprint(before):
                raise SpaceArchiveFailure('space archive changed during restore')
            receipt = {'state': 'restored', 'identity': expected, 'files': len(manifest['files']), 'bytes': manifest['bytes'],
                       'omissions': manifest['omissions'], 'manifest_sha256': hashlib.sha256(encoded).hexdigest()}
            target = os.open('space-restore-receipt.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=root)
            with os.fdopen(target, 'w') as output:
                json.dump(receipt, output, sort_keys=True)
                output.flush()
                os.fsync(output.fileno())
            os.fsync(root)
            return {**receipt, 'directory': destination}
    finally:
        if root is not None:
            os.close(root)
        os.close(descriptor)
        os.close(archive_parent)


STANDARD_DIRECTORIES = ('context', 'directives', 'projects', 'config', 'data', 'logs', 'tmp')
NATIVE_DOCUMENTS = frozenset({'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'SOUL.md'})
MAX_TREE_ENTRIES = 500_000
CHUNK_BYTES = 1024 * 1024
MIGRATION_RECEIPT = 'space-migration.json'
ROLLBACK = 'Quita SPACE_CWD_MIGRATED=1 de la configuración del alias y reinícialo: el origen no se modificó.'


def write_all(descriptor: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        view = view[os.write(descriptor, view):]


def stream_file(parent: int, name: str, output: int | None = None, keep: bool = False) -> tuple[str, int, int, bytes | None]:
    """Hashes a regular file without following links and optionally copies it; content is kept only for the secret scan."""
    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise SpaceArchiveFailure('tree file changed type during its read')
        digest, size, kept = hashlib.sha256(), 0, bytearray()
        while chunk := os.read(descriptor, CHUNK_BYTES):
            digest.update(chunk)
            size += len(chunk)
            if keep and size <= MAX_FILE:
                kept += chunk
            if output is not None:
                write_all(output, chunk)
        if size != before.st_size or fingerprint(os.fstat(descriptor)) != fingerprint(before):
            raise SpaceArchiveFailure('tree file changed during its read')
        return digest.hexdigest(), size, before.st_mtime_ns, bytes(kept) if keep and size <= MAX_FILE else None
    finally:
        os.close(descriptor)


def descend(root: int, relative: str, owned: bool) -> int:
    descriptor = os.dup(root)
    try:
        for part in pathlib.PurePosixPath(relative).parts:
            following = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = following
            if owned and os.fstat(descriptor).st_uid != os.geteuid():
                raise SpaceArchiveFailure('migrated directory has an unexpected owner')
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def tree_entries(location: str, private: bool, skip: str | None = None, annotate=None) -> list[dict]:
    """Every entry below location without its content: kind, mode, bytes and sha256 of files and the target of links."""
    root = open_directory(location, private)
    entries: list[dict] = []

    def walk(descriptor: int, prefix: str) -> None:
        for name in sorted(os.listdir(descriptor)):
            if len(entries) >= MAX_TREE_ENTRIES:
                raise SpaceArchiveFailure('tree has too many entries to inventory')
            details = os.stat(name, dir_fd=descriptor, follow_symlinks=False)
            entry, content = {'path': prefix + name, 'mode': stat.S_IMODE(details.st_mode)}, None
            if entry['path'] == skip:
                entry['kind'] = 'space_root'
            elif stat.S_ISDIR(details.st_mode):
                entry['kind'] = 'directory'
            elif stat.S_ISLNK(details.st_mode):
                entry.update(kind='symlink', target=os.readlink(name, dir_fd=descriptor))
            elif stat.S_ISREG(details.st_mode):
                sha256, size, _, content = stream_file(descriptor, name, keep=annotate is not None)
                entry.update(kind='file', bytes=size, sha256=sha256)
            else:
                entry['kind'] = 'special'
            if annotate is not None:
                annotate(entry, content)
            entries.append(entry)
            if entry['kind'] == 'directory':
                child = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
                try:
                    walk(child, entry['path'] + '/')
                finally:
                    os.close(child)
    try:
        walk(root, '')
    finally:
        os.close(root)
    return entries


def classification(path: str) -> str:
    top = path.split('/', 1)[0]
    return top if top in STANDARD_DIRECTORIES else 'native_document' if path in NATIVE_DOCUMENTS else 'desconocida'


def backup_reason(entry: dict, content: bytes | None) -> str | None:
    top = entry['path'].split('/', 1)[0]
    if top in ('logs', 'tmp'):
        return 'excluded_root'
    if top not in ROOTS:
        return 'outside_allowlist'
    reason = omission_reason(entry['path'])
    if reason or entry['kind'] == 'directory':
        return reason
    if entry['kind'] != 'file':
        return 'special_file'
    if entry['bytes'] > MAX_FILE:
        return 'exceeds_file_limit'
    return 'sensitive_content' if content is not None and sensitive_content(entry['path'], content) else None


def migration_reason(entry: dict) -> str | None:
    """Why an entry of the legacy cwd stays only at its origin; Git metadata is project data and moves with it."""
    if entry['kind'] in ('space_root', 'special'):
        return 'space_root' if entry['kind'] == 'space_root' else 'special_file'
    reason = omission_reason(entry['path'])
    return None if reason == 'vcs_metadata' else reason


def space_skip(workspace: str, directory: str) -> str | None:
    source, space = pathlib.PurePosixPath(workspace), pathlib.PurePosixPath(directory)
    if source.is_relative_to(space):
        raise SpaceArchiveFailure('the workspace already lives inside the space')
    return str(space.relative_to(source)) if space.is_relative_to(source) else None


def verify_space_identity(root: int, expected: dict) -> None:
    try:
        config = os.open('config', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    except FileNotFoundError:
        return
    try:
        raw, _ = read_file(config, 'context-state.json', MAX_MANIFEST)
    except FileNotFoundError:
        return
    finally:
        os.close(config)
    verify_context_identity(raw, expected)


def inventory_space(directory: str, expected_identity: dict, workspace: str | None = None) -> dict:
    """Dry run that writes nothing: path, size, sha256, place in the layout and backup exclusion of every entry, never content."""
    expected = identity(expected_identity)

    def annotate(entry: dict, content: bytes | None) -> None:
        entry['classification'] = classification(entry['path'])
        entry['backup'] = backup_reason(entry, content)
        if entry['path'] == 'config/context-state.json' and content is not None:
            verify_context_identity(content, expected)
    entries = tree_entries(directory, True, annotate=annotate)
    directories = {entry['path'] for entry in entries if entry['kind'] == 'directory'}
    result = {'state': 'inventoried', 'dry_run': True, 'identity': expected, 'directory': directory, 'entries': entries,
              'missing_directories': [name for name in STANDARD_DIRECTORIES if name not in directories],
              'unknown': [entry['path'] for entry in entries if entry['classification'] == 'desconocida'],
              'bytes': sum(entry.get('bytes', 0) for entry in entries), 'workspace': None}
    if workspace is not None:
        legacy = tree_entries(workspace, False, skip=space_skip(workspace, directory))
        for entry in legacy:
            entry.update(classification='projects', migration=migration_reason(entry) or 'copy')
        result['workspace'] = {'directory': workspace, 'entries': legacy, 'bytes': sum(entry.get('bytes', 0) for entry in legacy)}
    return result


def manifest_digest(entries: list[dict]) -> str:
    return hashlib.sha256(json.dumps(entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def same_entry(before: dict, after: dict | None) -> bool:
    if after is None or before['kind'] != after['kind']:
        return False
    if before['kind'] == 'file':
        return (before['sha256'], before['bytes'], before['mode'] & 0o100) == (after['sha256'], after['bytes'], after['mode'] & 0o100)
    return before.get('target') == after.get('target')


def copy_entry(source_root: int, target_root: int, entry: dict) -> None:
    relative = pathlib.PurePosixPath(entry['path'])
    source = descend(source_root, str(relative.parent), False)
    try:
        target = descend(target_root, str(relative.parent), True)
        try:
            if entry['kind'] == 'directory':
                os.mkdir(relative.name, 0o700, dir_fd=target)
            elif entry['kind'] == 'symlink':
                os.symlink(entry['target'], relative.name, dir_fd=target)
            else:
                mode = 0o700 if entry['mode'] & stat.S_IXUSR else 0o600
                output = os.open(relative.name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=target)
                try:
                    os.fchmod(output, mode)
                    sha256, size, mtime, _ = stream_file(source, relative.name, output)
                    os.fsync(output)
                    os.utime(output, ns=(mtime, mtime))
                finally:
                    os.close(output)
                if (sha256, size) != (entry['sha256'], entry['bytes']):
                    raise SpaceArchiveFailure('source changed during migration; stop the agent and retry')
        finally:
            os.close(target)
    finally:
        os.close(source)


def write_receipt(root: int, receipt: dict) -> None:
    config = os.open('config', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
    try:
        temporary = MIGRATION_RECEIPT + '.tmp'
        output = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600, dir_fd=config)
        try:
            write_all(output, json.dumps(receipt, ensure_ascii=False, sort_keys=True).encode())
            os.fsync(output)
        finally:
            os.close(output)
        os.replace(temporary, MIGRATION_RECEIPT, src_dir_fd=config, dst_dir_fd=config)
        os.fsync(config)
    finally:
        os.close(config)


def migrate_workspace(workspace: str, directory: str, expected_identity: dict, dry_run: bool = False) -> dict:
    """Copies the legacy harness cwd into space/projects without moving it and proves from both manifests that nothing was lost."""
    expected = identity(expected_identity)
    skip = space_skip(workspace, directory)
    projects = str(pathlib.PurePosixPath(directory) / 'projects')
    root = open_directory(directory)
    try:
        verify_space_identity(root, expected)
        try:
            os.close(open_directory(projects))
        except FileNotFoundError:
            raise SpaceArchiveFailure('space/projects is missing; prepare the space layout first') from None
        before = tree_entries(workspace, False, skip=skip)
        existing = {entry['path']: entry for entry in tree_entries(projects, True)}
        kept = [{'path': entry['path'], 'reason': migration_reason(entry)} for entry in before if migration_reason(entry)]
        pending = [entry for entry in before if not migration_reason(entry) and entry['path'] not in existing]
        conflicts = [entry['path'] for entry in before if not migration_reason(entry) and entry['path'] in existing
                     and not same_entry(entry, existing[entry['path']])]
        result = {'identity': expected, 'workspace': workspace, 'cwd': projects, 'dry_run': dry_run, 'kept_at_origin': kept,
                  'conflicts': conflicts, 'copied': 0, 'existing': len(before) - len(kept) - len(pending) - len(conflicts),
                  'before': {'sha256': manifest_digest(before), 'entries': before}, 'rollback': ROLLBACK}
        if dry_run or conflicts:
            return {**result, 'state': 'conflict' if conflicts else 'planned', 'to_copy': len(pending), 'after': None, 'lost': []}
        source_root = open_directory(workspace, False)
        target_root = open_directory(projects)
        try:
            for entry in pending:
                copy_entry(source_root, target_root, entry)
            os.fsync(target_root)
        finally:
            os.close(target_root)
            os.close(source_root)
        if tree_entries(workspace, False, skip=skip) != before:
            raise SpaceArchiveFailure('source changed during migration; stop the agent and retry')
        after = tree_entries(projects, True)
        indexed = {entry['path']: entry for entry in after}
        lost = [entry['path'] for entry in before if not migration_reason(entry) and not same_entry(entry, indexed.get(entry['path']))]
        receipt = {'schema_version': 1, 'state': 'incomplete' if lost else 'migrated', 'identity': expected, 'workspace': workspace,
                   'cwd': projects, 'before_sha256': result['before']['sha256'], 'after_sha256': manifest_digest(after),
                   'copied': len(pending), 'kept_at_origin': kept, 'lost': lost, 'rollback': ROLLBACK}
        write_receipt(root, receipt)
        return {**result, **receipt, 'dry_run': False, 'after': {'sha256': receipt['after_sha256'], 'entries': after}}
    finally:
        os.close(root)


def main() -> int:
    parser = argparse.ArgumentParser(description='Backup, inventario y migración privados de los datos permitidos de un espacio Cauce')
    parser.add_argument('operation', choices=('backup', 'restore', 'inventory', 'migrate'))
    parser.add_argument('--archive')
    parser.add_argument('--directory', required=True)
    parser.add_argument('--workspace')
    parser.add_argument('--dry-run', action='store_true')
    for field in sorted(IDENTITY_FIELDS):
        parser.add_argument('--' + field.replace('_', '-'), required=True)
    args = parser.parse_args()
    archived = args.operation in ('backup', 'restore')
    if archived != (args.archive is not None) or archived and (args.workspace is not None or args.dry_run) \
            or args.operation == 'migrate' and args.workspace is None or args.operation == 'inventory' and not args.dry_run:
        parser.error('backup y restore exigen --archive; migrate exige --workspace; inventory es de solo lectura y exige --dry-run')
    try:
        expected = {field: getattr(args, field) for field in IDENTITY_FIELDS}
        if args.operation == 'inventory':
            result = inventory_space(args.directory, expected, args.workspace)
        elif args.operation == 'migrate':
            result = migrate_workspace(args.workspace, args.directory, expected, args.dry_run)
        elif args.operation == 'backup':
            result = backup_space(args.directory, args.archive, expected)
        else:
            result = restore_space(args.archive, args.directory, expected)
        omissions = result.get('omissions') or []
        if omissions:
            print('omisiones:', file=sys.stderr)
            for item in omissions:
                print(f"{item['reason']} {item['path']}", file=sys.stderr)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 1 if result.get('lost') or result.get('conflicts') else 0
    except (OSError, ValueError, zipfile.BadZipFile, RuntimeError) as error:
        print(str(error) if isinstance(error, SpaceArchiveFailure) else 'El backup o la restauración no pudo completarse; revisa identidad, rutas y permisos.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
