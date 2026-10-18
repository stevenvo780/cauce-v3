"""Recoverable pre-cut copy of one alias: git bundles at the same HEAD and stores other files by sha256. Credentials are omitted by name and content; the walk uses directory fds and O_NOFOLLOW."""
from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import os
import posixpath
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v4_alcance_copia import check_sources, host_containers, tenant_scope  # noqa: E402

SCHEMA = 'cauce.v4-migracion-copia/1'
CONFIG = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'container-aliases.json')
RESTORE_SCHEMA = 'cauce.v4-migracion-restauracion/1'
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
OMISSION_RULES = (
    ('auth', re.compile(r'o?auth(?!or)')), ('session', re.compile(r'session')), ('token', re.compile(r'token')), ('profile', re.compile(r'profile')),
    ('credential', re.compile(r'(?:\.ssh|\.gnupg|\.aws|\.docker|\.kube|\.password-store|\.netrc|_netrc|\.git-credentials|\.pgpass|\.npmrc|\.pypirc|\.yarnrc(?:\.yml)?|\.boto|\.s3cfg|\.htpasswd|\.env(?:\..*)?|kubeconfig|known_hosts|cookies?.*|id_(?:rsa|dsa|ecdsa|ed25519).*|.*credential.*|.*secret.*|.*passw(?:or)?d.*|.*api[-_]?key.*|.*contrase.*|.*clave.*|.*bearer.*|.*private[-_]?key.*|.*[-_]key\..*|.*\.(?:pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|gpg|asc|ovpn|hdr))')),
)
REGENERABLE = frozenset({'node_modules', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', '.npm', '.next', '.turbo', 'marketplace-cache'})
SENSITIVE_CONTENT = re.compile(
    rb'-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bnpm_[A-Za-z0-9]{36}\b|\bAIza[0-9A-Za-z_-]{35}|\bya29\.[0-9A-Za-z_-]{20,}|\bxai-[A-Za-z0-9]{20,}|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|hooks\.slack\.com/services/[A-Za-z0-9/]{10,}|://[^\s/:@"\'<>]+:[^\s/@"\'<>]+@|authorization["\']?\s*[:=]\s*["\']?(?:bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}|\bbearer(?:\s+|\s*[:=]\s*)["\']?[A-Za-z0-9._~+/=-]{10,}|\bcookie\s*:[^\r\n]{8,}|["\']?[a-z0-9_-]*(?:secret|token|password|passwd|passphrase|contrasena|contrase(?:\xc3\xb1|n)a|clave|credential|api[_-]?key|apikey|private[_-]?key)[a-z0-9_-]*["\']?\s*[:=]\s*["\']?(?!\$\{|process\.env)[^\s"\',;]{8,}', re.I)
CONFUSABLES = str.maketrans({
    '\u0430': 'a', '\u0432': 'b', '\u0433': 'r', '\u0434': 'd', '\u043a': 'k', '\u043c': 'm', '\u043d': 'h', '\u043f': 'n', '\u0441': 'c', '\u0435': 'e', '\u043e': 'o', '\u0440': 'p', '\u0442': 't', '\u0445': 'x', '\u0443': 'y', '\u044f': 'r', '\u0454': 'e', '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u04bb': 'h', '\u04cf': 'l', '\u0397': 'h', '\u039c': 'm', '\u039d': 'n', '\u03a5': 'y', '\u03b1': 'a', '\u03b2': 'b', '\u03b3': 'y', '\u03b4': 'd', '\u03b5': 'e', '\u03b7': 'n', '\u03b8': 'o', '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'u', '\u03bd': 'v', '\u03bf': 'o', '\u03c0': 'n', '\u03c1': 'p', '\u03c2': 's', '\u03c3': 's', '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x', '\u03c9': 'w'})
OVERLAP = 4096
CHUNK = 1 << 20
OPEN_DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
OPEN_FILE = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK | getattr(os, 'O_NOCTTY', 0)
OPEN_NEW = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC
GIT_ENV = {'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1'}
HEX_RE = re.compile(r'^(?:[0-9a-f]{40}|[0-9a-f]{64})$')
SHA256_RE = re.compile(r'^[0-9a-f]{64}$')
BRANCH_RE = re.compile(r'^(?!-)(?!.*\.\.)(?!.*//)[A-Za-z0-9._/-]{1,200}(?<![./])$')
REMOTE_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
SAFE_URL = re.compile(r'^(?:(?:https?|ssh|git)://[^\s]+|[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+)$')


class Failure(ValueError):
    pass


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def seal(doc: dict) -> str:
    return hashlib.sha256(canonical({k: v for k, v in doc.items() if k != 'sha256'})).hexdigest()


def fold_text(value: str) -> str:
    folded = unicodedata.normalize('NFKD', value).translate(CONFUSABLES).casefold().translate(CONFUSABLES)
    return ''.join(character for character in folded if character not in '\u115f\u1160\u3164\uffa0' and unicodedata.category(character) not in ('Cf', 'Mn', 'Me'))


def sensitive_bytes(raw: bytes) -> bool:
    return bool(SENSITIVE_CONTENT.search(fold_text(raw.decode('utf-8', 'surrogateescape')).encode('utf-8', 'surrogateescape')))


def omission_reason(name: str, directory: bool) -> str | None:
    folded = fold_text(name)
    found = next((reason for reason, pattern in OMISSION_RULES if (pattern.fullmatch if reason == 'credential' else pattern.search)(folded)), None)
    return found or ('regenerable' if directory and folded in REGENERABLE else None)


def clean_url(url: str) -> str | None:
    """Remote without userinfo, query or fragment; schemes that run commands (ext::, fd::) are dropped."""
    if '::' in url or url.startswith('-'):
        return None
    if '://' not in url:
        return url if SAFE_URL.fullmatch(url) and not sensitive_bytes(url.encode()) else None
    try:
        parts = urllib.parse.urlsplit(url)
        host, port = parts.hostname or '', parts.port
    except ValueError:
        return None
    netloc = (f'[{host}]' if ':' in host else host) + (f':{port}' if port else '')
    cleaned = urllib.parse.urlunsplit((parts.scheme, netloc, parts.path, '', ''))
    return cleaned if SAFE_URL.fullmatch(cleaned) and not sensitive_bytes(cleaned.encode()) else None


def scrub(text: str) -> str:
    return re.sub(r'://[^\s@]*@', '://', text)


def git(repository: str, *arguments: str, check: bool = True, fd: int | None = None) -> str:
    location = f'/proc/self/fd/{fd}' if fd is not None else repository
    command = ['git', '-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', '-C', location, *arguments]
    done = subprocess.run(command, capture_output=True, env={**os.environ, **GIT_ENV}, check=False, timeout=3600, pass_fds=(fd,) if fd is not None else ())
    if check and done.returncode:
        raise Failure(f'git {arguments[0]} failed: {scrub(done.stderr.decode(errors="replace").strip())[:200]}')
    return done.stdout.decode('utf-8', 'surrogateescape') if done.returncode == 0 else ''


def relative(value) -> str:
    if not isinstance(value, str) or not value or value.startswith('/') or posixpath.normpath(value) != value or any(part in ('', '.', '..') for part in value.split('/')) or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise Failure(f'unsafe manifest path: {value!r}')
    return value


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + '/')


def alternate_entries(raw: bytes) -> list[bytes]:
    """Git 2.56 parse_alternates. A '#' entry is a comment. A C quote consumes one extra byte, the separator."""
    simple = {97: 7, 98: 8, 102: 12, 110: 10, 114: 13, 116: 9, 118: 11, 92: 92, 34: 34}
    entries, i, n = [], 0, len(raw)

    def unquote(start: int) -> tuple[bytes, int] | None:
        out, j = bytearray(), start + 1
        while j < n and raw[j] != 34:
            if raw[j] != 92:
                out.append(raw[j])
                j += 1
            elif (esc := raw[j + 1] if j + 1 < n else -1) in simple:
                out.append(simple[esc])
                j += 2
            elif 48 <= esc <= 51 and j + 3 < n and raw[j + 2] in b'01234567' and raw[j + 3] in b'01234567':
                out.append(((esc - 48) << 6) | ((raw[j + 2] - 48) << 3) | (raw[j + 3] - 48))
                j += 4
            else:
                return None
        return (bytes(out), j + 1) if j < n and raw[j] == 34 else None
    while i < n:
        if raw[i] == 35:
            found = raw.find(b'\n', i)
            i = n if found < 0 else found + 1
        elif raw[i] == 34 and (quoted := unquote(i)):
            entries.append(quoted[0])
            i = quoted[1] + 1 if quoted[1] < n else n
        else:
            found = raw.find(b'\n', i)
            entries.append(raw[i:] if found < 0 else raw[i:found])
            i = n if found < 0 else found + 1
    return [entry for entry in entries if entry]


def escapes(path: str, target: str) -> bool:
    landing = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
    return target.startswith('/') or landing == '..' or landing.startswith('../')


def safe_mode(mode: int, directory: bool = False) -> int:
    return (mode & 0o775) | (0o700 if directory else 0)


def open_verified(parent: int, name: str, expected: os.stat_result, flags: int) -> int:
    descriptor = os.open(name, flags, dir_fd=parent)
    current = os.fstat(descriptor)
    if (current.st_dev, current.st_ino) != (expected.st_dev, expected.st_ino) or stat.S_IFMT(current.st_mode) != stat.S_IFMT(expected.st_mode):
        os.close(descriptor)
        raise Failure(f'{name!r} changed while it was copied; stop the agent and retry')
    return descriptor


def scan(descriptor: int, size: int, object_format: str | None) -> tuple[str, str | None, bool]:
    digest = hashlib.sha256()
    blob = hashlib.new(object_format) if object_format else None
    if blob:
        blob.update(b'blob %d\0' % size)
    os.lseek(descriptor, 0, os.SEEK_SET)
    read, tail, sensitive = 0, b'', False
    while chunk := os.read(descriptor, CHUNK):
        read += len(chunk)
        digest.update(chunk)
        if blob:
            blob.update(chunk)
        sensitive = sensitive or sensitive_bytes(tail + chunk)
        tail = chunk[-OVERLAP:]
    if read != size or os.fstat(descriptor).st_size != size:
        raise Failure('a file changed while it was copied; stop the agent and retry')
    return digest.hexdigest(), blob.hexdigest() if blob else None, sensitive


def store(descriptor: int, digest: str, output: str) -> None:
    target = os.path.join(output, 'data', digest[:2], digest)
    if os.path.lexists(target):
        return
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    temporary = target + '.part'
    writer = os.open(temporary, OPEN_NEW, 0o600)
    copied = hashlib.sha256()
    try:
        os.lseek(descriptor, 0, os.SEEK_SET)
        while chunk := os.read(descriptor, CHUNK):
            copied.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(writer, view):]
        os.fsync(writer)
    finally:
        os.close(writer)
    if copied.hexdigest() != digest:
        os.unlink(temporary)
        raise Failure('a file changed while it was copied; stop the agent and retry')
    os.replace(temporary, target)


class Copier:
    def __init__(self, output: str):
        self.output = output
        self.entries: list[dict] = []
        self.omissions: list[dict] = []
        self.repositories: dict[str, dict] = {}
        self.tracked: dict[str, dict] = {}
        self.host_roots: list[str] = []

    def inside_roots(self, path: str) -> bool:
        try:
            return any(under(os.path.realpath(path), root) for root in self.host_roots)
        except (OSError, ValueError):
            return False

    def inode_names(self, info: os.stat_result) -> int:
        if not hasattr(self, 'inode_name_counts'):
            counts: dict[tuple[int, int], int] = {}
            for root in self.host_roots:
                for base, _, files in os.walk(root):
                    for name in files:
                        try:
                            item = os.lstat(os.path.join(base, name))
                        except OSError:
                            continue
                        if stat.S_ISREG(item.st_mode) and item.st_nlink > 1:
                            counts[(item.st_dev, item.st_ino)] = counts.get((item.st_dev, item.st_ino), 0) + 1
            self.inode_name_counts = counts
        return self.inode_name_counts.get((info.st_dev, info.st_ino), 0)

    def git_store_escapes(self, root: str, seen: set[tuple[int, int]] | None = None) -> bool:
        seen = set() if seen is None else seen
        try:
            identity = (os.stat(root).st_dev, os.stat(root).st_ino)
        except OSError:
            return True
        if identity in seen:
            return False
        seen.add(identity)
        errors: list[OSError] = []
        for base, directories, files in os.walk(root, onerror=errors.append):
            for name in directories + files:
                candidate = os.path.join(base, name)
                try:
                    info = os.lstat(candidate)
                    effective = os.stat(candidate) if stat.S_ISLNK(info.st_mode) else info
                except OSError:
                    return True
                if (stat.S_ISLNK(info.st_mode) and (not self.inside_roots(candidate) or name in directories and self.git_store_escapes(os.path.realpath(candidate), seen))
                        or stat.S_ISREG(effective.st_mode) and effective.st_nlink > 1 and self.inode_names(effective) < effective.st_nlink):
                    return True
        return bool(errors)

    def git_file_outside(self, directory: int) -> bool:
        try:
            descriptor = os.open('.git', OPEN_FILE, dir_fd=directory)
            try:
                size = os.fstat(descriptor).st_size
                content = os.read(descriptor, size if 0 < size <= 65536 else 0)
            finally:
                os.close(descriptor)
            host_directory = os.readlink(f'/proc/self/fd/{directory}')
        except OSError:
            return True
        text = content.decode('utf-8', 'surrogateescape').rstrip('\r\n')
        target = text[len('gitdir:'):].lstrip(' \t') if text.startswith('gitdir:') else ''
        target = os.path.join(host_directory, target) if target and not os.path.isabs(target) else target
        return len(content) != size or not target or '\x00' in target or not self.inside_roots(target)

    def git_metadata_outside(self, directory: int) -> bool:
        try:
            host_directory = os.readlink(f'/proc/self/fd/{directory}')
        except OSError:
            return True

        def located(*arguments: str) -> str:
            reported = git('.', 'rev-parse', *arguments, check=False, fd=directory).strip()
            return reported if not reported or os.path.isabs(reported) else os.path.join(host_directory, reported)
        paths = (located('--git-common-dir'), located('--git-dir'), located('--git-path', 'objects'))
        if not all(paths) or not all(self.inside_roots(path) for path in paths) or any(self.git_store_escapes(os.path.realpath(path)) for path in paths):
            return True
        def alternates_escape(objects: str, seen: set[str], depth: int = 0) -> bool:
            real = os.path.realpath(objects)
            if depth > 5 or real in seen:
                return False
            seen.add(real)
            alternates = os.path.join(real, 'info', 'alternates')
            try:
                info = os.lstat(alternates)
                if not stat.S_ISREG(info.st_mode) or info.st_size > 65536:
                    return True
                with os.fdopen(os.open(alternates, OPEN_FILE), 'rb') as handle:
                    raw = handle.read(info.st_size)
            except FileNotFoundError:
                return False
            except OSError:
                return True
            if len(raw) != info.st_size:
                return True
            for encoded in alternate_entries(raw):
                text = encoded.decode('utf-8', 'surrogateescape')
                candidate = text if os.path.isabs(text) else os.path.join(real, text)
                try:
                    resolved = os.path.realpath(candidate)
                except (OSError, ValueError):
                    return True
                if not os.path.isdir(resolved) or not self.inside_roots(resolved) or self.git_store_escapes(resolved) or alternates_escape(resolved, seen, depth + 1):
                    return True
            return False
        return alternates_escape(paths[2], set())

    def omit(self, path: str, reason: str, parent: int, name: str, info: os.stat_result) -> None:
        files, size = (0, 0) if stat.S_ISDIR(info.st_mode) else (1, info.st_size)
        if stat.S_ISDIR(info.st_mode):
            for _, _, names, root in os.fwalk(name, dir_fd=parent):
                for item in names:
                    try:
                        size += os.stat(item, dir_fd=root, follow_symlinks=False).st_size
                        files += 1
                    except OSError:
                        continue
        kind = 'directory' if stat.S_ISDIR(info.st_mode) else 'file' if stat.S_ISREG(info.st_mode) else 'symlink' if stat.S_ISLNK(info.st_mode) else 'special'
        self.omissions.append({'path': path, 'reason': reason, 'kind': kind, 'files': files, 'bytes': size})

    def repository(self, path: str, directory: int) -> None:
        head = git(path, 'rev-parse', '--verify', '-q', 'HEAD^{commit}', check=False, fd=directory).strip()
        if not head:
            self.omissions.append({'path': path + '/.git', 'reason': 'git-without-commits', 'kind': 'directory',
                                   'files': 0, 'bytes': 0})
            return
        object_format = git(path, 'rev-parse', '--show-object-format', check=False, fd=directory).strip() or 'sha1'
        if object_format not in ('sha1', 'sha256'):
            raise Failure(f'unsupported git object format in {path}')
        branch = git(path, 'symbolic-ref', '-q', '--short', 'HEAD', check=False, fd=directory).strip() or None
        remotes, dropped = {}, []
        for line in git(path, 'remote', '-v', fd=directory).splitlines():
            name, _, rest = line.partition('\t')
            if rest.endswith(' (fetch)') and REMOTE_RE.fullmatch(name):
                url = clean_url(rest[:-len(' (fetch)')])
                if url:
                    remotes[name] = url
                else:
                    dropped.append(name)
        bundle = f'repos/{len(self.repositories):04d}.bundle'
        bundle_path = os.path.join(self.output, bundle)
        os.makedirs(os.path.join(self.output, 'repos'), mode=0o700, exist_ok=True)
        git(path, 'bundle', 'create', '-q', bundle_path, 'HEAD', '--all', fd=directory)
        git(path, 'bundle', 'verify', '-q', bundle_path, fd=directory)
        tracked = {}
        for record in git(path, 'ls-files', '-s', '-z', fd=directory).split('\0'):
            if record:
                meta, _, name = record.partition('\t')
                mode, blob, _ = meta.split(' ', 2)
                tracked[name] = (mode, blob)
        refs = git(path, 'for-each-ref', '--format=%(refname)', fd=directory).split()
        reader = os.open(bundle_path, OPEN_FILE)
        try:
            bundle_digest = scan(reader, os.fstat(reader).st_size, None)[0]
        finally:
            os.close(reader)
        self.repositories[path] = {'path': path, 'head': head, 'branch': branch if branch and BRANCH_RE.fullmatch(branch) else None,
                                   'objectFormat': object_format, 'remotes': remotes, 'droppedRemotes': sorted(dropped), 'refs': len(refs),
                                   'bundle': bundle, 'bundleSha256': bundle_digest, 'deleted': [], 'trackedSensitive': []}
        self.tracked[path] = tracked

    def owner(self, path: str) -> str | None:
        holders = [repo for repo in self.repositories if under(path, repo) and path != repo]
        return max(holders, key=len) if holders else None

    def file(self, path: str, parent: int, name: str, info: os.stat_result) -> None:
        repo = self.owner(path)
        tracked = self.tracked[repo].get(path[len(repo) + 1:]) if repo else None
        object_format = self.repositories[repo]['objectFormat'] if tracked else None
        descriptor = open_verified(parent, name, info, OPEN_FILE)
        try:
            digest, blob, sensitive = scan(descriptor, info.st_size, object_format)
            clean = bool(tracked) and tracked[1] == blob and tracked[0] == ('100755' if info.st_mode & 0o111 else '100644')
            if sensitive and clean:
                self.repositories[repo]['trackedSensitive'].append(path)
            elif sensitive:
                self.omissions.append({'path': path, 'reason': 'sensitive-content', 'kind': 'file', 'files': 1, 'bytes': info.st_size})
                return
            if not clean:
                store(descriptor, digest, self.output)
        finally:
            os.close(descriptor)
        self.entries.append({'path': path, 'kind': 'file', 'mode': stat.S_IMODE(info.st_mode), 'bytes': info.st_size, 'sha256': digest, 'source': 'git' if clean else 'data'})

    def link(self, path: str, parent: int, name: str) -> None:
        target = os.readlink(name, dir_fd=parent)
        if sensitive_bytes(target.encode('utf-8', 'surrogateescape')):
            self.omissions.append({'path': path, 'reason': 'sensitive-content', 'kind': 'symlink', 'files': 1, 'bytes': 0})
            return
        repo = self.owner(path)
        tracked = self.tracked[repo].get(path[len(repo) + 1:]) if repo else None
        raw = target.encode('utf-8', 'surrogateescape')
        if tracked and tracked[0] == '120000' and hashlib.new(self.repositories[repo]['objectFormat'], b'blob %d\0' % len(raw) + raw).hexdigest() == tracked[1]:
            self.entries.append({'path': path, 'kind': 'symlink', 'source': 'git', 'targetSha256': hashlib.sha256(raw).hexdigest()})
        elif escapes(path, target):
            self.omissions.append({'path': path, 'reason': 'symlink-outside', 'kind': 'symlink', 'files': 1, 'bytes': 0})
        else:
            self.entries.append({'path': path, 'kind': 'symlink', 'target': target, 'source': 'data'})

    def walk(self, path: str, directory: int) -> None:
        try:
            marker = os.stat('.git', dir_fd=directory, follow_symlinks=False)
        except FileNotFoundError:
            marker = None
        if marker is not None and stat.S_ISLNK(marker.st_mode):
            self.omissions.append({'path': path + '/.git', 'reason': 'unsafe-git-link', 'kind': 'symlink', 'files': 0, 'bytes': 0})
        elif marker is not None and ((stat.S_ISREG(marker.st_mode) and self.git_file_outside(directory)) or self.git_metadata_outside(directory)):
            kind = 'directory' if stat.S_ISDIR(marker.st_mode) else 'file' if stat.S_ISREG(marker.st_mode) else 'special'
            self.omissions.append({'path': path + '/.git', 'reason': 'unsafe-git-link', 'kind': kind, 'files': 0, 'bytes': 0})
        elif marker is not None:
            self.repository(path, directory)
        self.entries.append({'path': path, 'kind': 'directory', 'mode': stat.S_IMODE(os.fstat(directory).st_mode)})
        with os.scandir(directory) as iterator:
            names = sorted(item.name for item in iterator)
        for name in names:
            if name == '.git':
                continue
            child = f'{path}/{name}'
            info = os.stat(name, dir_fd=directory, follow_symlinks=False)
            reason = omission_reason(name, stat.S_ISDIR(info.st_mode))
            if reason:
                self.omit(child, reason, directory, name, info)
            elif stat.S_ISDIR(info.st_mode):
                descriptor = open_verified(directory, name, info, OPEN_DIRECTORY)
                try:
                    self.walk(child, descriptor)
                finally:
                    os.close(descriptor)
            elif stat.S_ISREG(info.st_mode):
                self.file(child, directory, name, info)
            elif stat.S_ISLNK(info.st_mode):
                self.link(child, directory, name)
            else:
                self.omit(child, 'special', directory, name, info)

    def deletions(self) -> None:
        present = {entry['path'] for entry in self.entries if entry['kind'] != 'directory'}
        omitted = [item['path'] for item in self.omissions]
        for repo, tracked in self.tracked.items():
            for name, (mode, _) in sorted(tracked.items()):
                path = f'{repo}/{name}'
                if mode != '160000' and path not in present and not any(under(path, o) for o in omitted) and self.owner(path) == repo:
                    self.repositories[repo]['deleted'].append(path)


def copy(alias: str, sources: list[str], output: str, scope: dict) -> dict:
    if not NAME_RE.fullmatch(alias) or scope.get('alias') != alias:
        raise Failure('invalid alias or a scope computed for another alias')
    roots = {}
    for item in sources:
        name, _, location = item.partition('=')
        if not NAME_RE.fullmatch(name) or name in roots or not os.path.isabs(location) or os.path.islink(location) or not os.path.isdir(location):
            raise Failure(f'source must be NAME=/absolute/directory and not a symlink: {name!r}')
        roots[name] = os.path.realpath(location)
    check_sources(roots, scope)
    target = os.path.realpath(output)
    if any(under(target, root) or under(root, target) for root in roots.values()):
        raise Failure('the copy cannot live inside a source, nor a source inside the copy')
    os.makedirs(output, mode=0o700, exist_ok=False)
    copier = Copier(output)
    copier.host_roots = sorted(roots.values())
    for name, location in sorted(roots.items()):
        descriptor = os.open(location, OPEN_DIRECTORY)
        try:
            copier.walk(name, descriptor)
        finally:
            os.close(descriptor)
    copier.deletions()
    data = [e for e in copier.entries if e['kind'] == 'file' and e['source'] == 'data']
    manifest = {
        'schema': SCHEMA, 'alias': alias, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'host': socket.gethostname(), 'sources': sorted(roots), 'tenant': scope['tenant'], 'container': scope['container'],
        'entries': copier.entries, 'repositories': sorted(copier.repositories.values(), key=lambda r: r['path']), 'omissions': copier.omissions,
        'totals': {'files': sum(1 for e in copier.entries if e['kind'] == 'file'), 'bytes': sum(e['bytes'] for e in copier.entries if e['kind'] == 'file'),
                   'dataFiles': len(data), 'dataBytes': sum(e['bytes'] for e in data), 'repositories': len(copier.repositories),
                   'omissions': len(copier.omissions), 'omittedBytes': sum(o['bytes'] for o in copier.omissions)}}
    manifest['sha256'] = seal(manifest)
    writer = os.open(os.path.join(output, 'manifest.json'), OPEN_NEW, 0o600)
    with os.fdopen(writer, 'w', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)
    return manifest


def validate(manifest: dict) -> dict:
    if not isinstance(manifest, dict) or manifest.get('schema') != SCHEMA or manifest.get('sha256') != seal(manifest):
        raise Failure('manifest seal does not verify')
    if not NAME_RE.fullmatch(str(manifest.get('alias', ''))) or not NAME_RE.fullmatch(str(manifest.get('tenant', ''))):
        raise Failure('manifest alias or company is invalid')
    sources = manifest.get('sources')
    if not isinstance(sources, list) or not sources or any(not NAME_RE.fullmatch(str(name)) for name in sources):
        raise Failure('manifest sources are invalid')
    paths = [e['path'] for e in manifest['entries']] + [o['path'] for o in manifest['omissions']] + [r['path'] for r in manifest['repositories']] + [d for r in manifest['repositories'] for d in r.get('deleted', [])]
    for path in paths:
        if relative(path).split('/', 1)[0] not in sources:
            raise Failure(f'manifest path outside the copied space: {path}')
    for entry in manifest['entries']:
        kind = entry.get('kind')
        if kind not in ('file', 'directory', 'symlink') or entry.get('source', 'data') not in ('git', 'data'):
            raise Failure(f'unknown manifest entry: {entry["path"]}')
        if kind != 'symlink' and not isinstance(entry.get('mode'), int):
            raise Failure(f'manifest mode missing: {entry["path"]}')
        if kind == 'file' and not SHA256_RE.fullmatch(str(entry.get('sha256'))):
            raise Failure(f'manifest digest is invalid: {entry["path"]}')
        if kind == 'symlink' and not (entry.get('source') == 'git' and SHA256_RE.fullmatch(str(entry.get('targetSha256'))) or isinstance(entry.get('target'), str) and '\0' not in entry['target']):
            raise Failure(f'manifest link target is invalid: {entry["path"]}')
    for item in manifest['omissions']:
        relative(item['path'])
    for repo in manifest['repositories']:
        relative(repo['path'])
        if not re.fullmatch(r'repos/\d{4}\.bundle', str(repo.get('bundle'))) or not HEX_RE.fullmatch(str(repo.get('head'))) or not SHA256_RE.fullmatch(str(repo.get('bundleSha256'))) or (repo.get('branch') is not None and not BRANCH_RE.fullmatch(str(repo['branch']))):
            raise Failure(f'manifest repository is invalid: {repo["path"]}')
        for name, url in repo.get('remotes', {}).items():
            if not REMOTE_RE.fullmatch(name) or clean_url(url) != url:
                raise Failure(f'manifest remote is unsafe: {repo["path"]}')
        for path in repo.get('deleted', []):
            if not under(relative(path), repo['path']):
                raise Failure(f'manifest deletion leaves its repository: {path}')
    return manifest


def load(copy_directory: str) -> dict:
    descriptor = os.open(os.path.join(copy_directory, 'manifest.json'), OPEN_FILE)
    with os.fdopen(descriptor, encoding='utf-8') as handle:
        return validate(json.load(handle))


def digest_of(path: str) -> str:
    descriptor = os.open(path, OPEN_FILE)
    try:
        return scan(descriptor, os.fstat(descriptor).st_size, None)[0]
    finally:
        os.close(descriptor)


def check(copy_directory: str) -> dict:
    manifest = load(copy_directory)
    missing = []
    for entry in manifest['entries']:
        if entry['kind'] == 'file' and entry['source'] == 'data':
            blob = os.path.join(copy_directory, 'data', entry['sha256'][:2], entry['sha256'])
            if not os.path.isfile(blob) or os.path.islink(blob) or digest_of(blob) != entry['sha256']:
                missing.append(entry['path'])
    for repo in manifest['repositories']:
        bundle = os.path.realpath(os.path.join(copy_directory, repo['bundle']))
        if not os.path.isfile(bundle) or digest_of(bundle) != repo['bundleSha256']:
            missing.append(repo['bundle'])
            continue
        with tempfile.TemporaryDirectory(prefix='cauce-v4-bundle-') as scratch:
            git(scratch, 'init', '-q')
            git(scratch, 'bundle', 'verify', '-q', bundle)
            git(scratch, 'fetch', '-q', bundle, 'HEAD')
            if git(scratch, 'rev-parse', 'FETCH_HEAD').strip() != repo['head']:
                missing.append(repo['bundle'])
    if missing:
        raise Failure(f'copy is not recoverable: {len(missing)} blobs or bundles differ, first {missing[0]}')
    return {'manifest': manifest['sha256'], 'alias': manifest['alias'], 'dataFiles': manifest['totals']['dataFiles'], 'repositories': len(manifest['repositories']), 'verified': True}


def mapper(rules: list[str]):
    pairs = sorted(((relative(parts[0]), relative(parts[2])) for rule in rules for parts in [rule.partition('=')]), key=lambda pair: -len(pair[0]))

    def apply(path: str) -> str:
        return next((new + path[len(old):] for old, new in pairs if under(path, old)), path)
    return apply, pairs


def ownership(value: str | None) -> tuple[int, int] | None:
    if value is None:
        if os.geteuid() == 0:
            raise Failure('restoring as root needs --propietario UID:GID so the tree does not stay owned by root')
        return None
    match = re.fullmatch(r'(\d{1,10}):(\d{1,10})', value)
    if not match:
        raise Failure('--propietario must be UID:GID')
    return int(match.group(1)), int(match.group(2))


class Restorer:
    def __init__(self, copy_directory: str, destination: str, apply):
        self.copy_directory = os.path.realpath(copy_directory)
        self.apply = apply
        if os.path.islink(destination):
            raise Failure('restore destination must not be a symlink')
        os.makedirs(destination, mode=0o700, exist_ok=True)
        self.base = os.path.realpath(destination)
        if os.listdir(self.base) or os.lstat(self.base).st_uid != os.geteuid():
            raise Failure('restore destination must be an empty directory owned by the restoring user')
        os.chmod(self.base, 0o700)

    def place(self, path: str, mapped: bool = True) -> str:
        target = os.path.join(self.base, self.apply(path) if mapped else path)
        if os.path.commonpath([self.base, os.path.realpath(os.path.dirname(target))]) != self.base:
            raise Failure(f'restore path escapes the destination: {path}')
        return target

    def write(self, source: str, target: str, mode: int, digest: str) -> None:
        os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
        self.place(os.path.relpath(target, self.base), mapped=False)
        if os.path.lexists(target):
            os.unlink(target)
        reader = os.open(source, OPEN_FILE)
        writer = os.open(target, OPEN_NEW, 0o600)
        copied = hashlib.sha256()
        try:
            while chunk := os.read(reader, CHUNK):
                copied.update(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(writer, view):]
            os.fchmod(writer, safe_mode(mode))
        finally:
            os.close(writer)
            os.close(reader)
        if copied.hexdigest() != digest:
            os.unlink(target)
            raise Failure(f'stored blob does not match the manifest: {digest[:12]}')

    def repository(self, repo: dict) -> None:
        target = self.place(repo['path'])
        os.makedirs(target, mode=0o700, exist_ok=True)
        git(target, 'init', '-q')
        bundle = os.path.join(self.copy_directory, repo['bundle'])
        git(target, 'fetch', '-q', '--update-head-ok', bundle, '+refs/*:refs/*')
        git(target, 'fetch', '-q', bundle, 'HEAD')
        branch = repo['branch']
        if branch and git(target, 'rev-parse', '-q', '--verify', f'refs/heads/{branch}', check=False).strip() == repo['head']:
            git(target, 'symbolic-ref', 'HEAD', f'refs/heads/{branch}')
            git(target, 'reset', '-q', '--hard')
        else:
            git(target, 'checkout', '-q', '--detach', repo['head'])
        for name, url in sorted(repo['remotes'].items()):
            git(target, 'remote', 'add', '--', name, url)


def restore(copy_directory: str, destination: str, rules: list[str], omit: list[str] = (), duplicates: list[str] = (),
            owner: str | None = None, expected: tuple[str, str] | None = None) -> dict:
    manifest = load(copy_directory)
    if expected is None or (manifest['alias'], manifest['tenant']) != expected:
        raise Failure('the copy belongs to another alias or company than the one being restored')
    apply, pairs = mapper(rules)
    identity = ownership(owner)
    for repo in manifest['repositories']:
        if any(under(old, repo['path']) and old != repo['path'] for old, _ in pairs):
            raise Failure(f'mapping splits repository {repo["path"]}')
    targets = [apply(e['path']) for e in manifest['entries']]
    if len(set(targets)) != len(targets):
        raise Failure('mapping sends two manifest paths to the same place')
    restorer = Restorer(copy_directory, destination, apply)
    skipped = {e['path'] for e in manifest['entries'] if e['kind'] != 'directory' and e['source'] == 'data'
               and any(fnmatch.fnmatchcase(e['path'], glob) or fnmatch.fnmatchcase(e['path'].rsplit('/', 1)[-1], glob) for glob in omit)}
    for repo in sorted(manifest['repositories'], key=lambda r: r['path'].count('/')):
        restorer.repository(repo)
    for entry in manifest['entries']:
        target = restorer.place(entry['path'])
        if entry['kind'] == 'directory':
            os.makedirs(target, mode=0o700, exist_ok=True)
        elif entry['kind'] == 'file' and entry['source'] == 'data' and entry['path'] not in skipped:
            restorer.write(os.path.join(restorer.copy_directory, 'data', entry['sha256'][:2], entry['sha256']), target, entry['mode'], entry['sha256'])
    for repo in manifest['repositories']:
        for path in repo['deleted']:
            target = restorer.place(path)
            if os.path.lexists(target) and not os.path.isdir(target):
                os.unlink(target)
    unsafe_links = []
    for entry in manifest['entries']:
        target = restorer.place(entry['path'])
        if entry['kind'] == 'symlink' and entry['source'] == 'data' and entry['path'] not in skipped:
            if escapes(apply(entry['path']), entry['target']):
                unsafe_links.append(entry['path'])
                skipped.add(entry['path'])
                continue
            if os.path.lexists(target):
                os.unlink(target)
            os.symlink(entry['target'], target)
        elif entry['kind'] == 'directory':
            os.chmod(target, safe_mode(entry['mode'], directory=True), follow_symlinks=False)
    copies = duplicate(manifest, restorer, duplicates, skipped)
    if identity:
        for _, dirs, names, descriptor in os.fwalk(restorer.base):
            os.chown(descriptor, *identity)
            for name in dirs + names:
                os.chown(name, *identity, dir_fd=descriptor, follow_symlinks=False)
    layout_rules = {'mapping': list(rules), 'omit': list(omit), 'duplicates': list(duplicates), 'owner': owner, 'skippedUnsafeSymlinks': unsafe_links}
    return verify_restore(manifest, restorer.base, apply, layout_rules, skipped, copies)


def duplicate(manifest: dict, restorer: Restorer, duplicates: list[str], skipped: set) -> dict:
    files = {e['path']: e for e in manifest['entries'] if e['kind'] == 'file' and e['path'] not in skipped}
    copies = {}
    for rule in duplicates:
        old, _, new = rule.partition('=')
        new = relative(new)
        if old not in files:
            raise Failure(f'--duplicar names a file that is not restored: {old}')
        target = restorer.place(new, mapped=False)
        if os.path.lexists(target) or new in copies:
            raise Failure(f'--duplicar target already exists: {new}')
        restorer.write(restorer.place(old), target, files[old]['mode'], files[old]['sha256'])
        copies[new] = {**files[old], 'source': 'duplicate'}
    return copies


def verify_restore(manifest: dict, base: str, apply, layout_rules: dict, skipped: set, copies: dict) -> dict:
    expected = {apply(e['path']): e for e in manifest['entries'] if e['kind'] != 'directory' and e['path'] not in skipped}
    expected.update(copies)
    omitted = [apply(o['path']) for o in manifest['omissions']]
    repos = {apply(r['path']): r for r in manifest['repositories']}
    problems, extras, layout = [], [], []
    for root, dirs, names in os.walk(base):
        dirs[:] = sorted(d for d in dirs if not (d == '.git' and os.path.relpath(root, base) in repos))
        for name in sorted(names + [d for d in dirs if os.path.islink(os.path.join(root, d))]):
            path = os.path.relpath(os.path.join(root, name), base)
            if path not in expected:
                (extras if any(under(path, o) for o in omitted) else problems).append(path)
    for path, entry in sorted(expected.items()):
        target = os.path.join(base, path)
        if entry['kind'] == 'symlink':
            link = os.readlink(target) if os.path.islink(target) else None
            ok = link is not None and (link == entry['target'] if 'target' in entry else hashlib.sha256(link.encode('utf-8', 'surrogateescape')).hexdigest() == entry['targetSha256'])
        else:
            ok = os.path.isfile(target) and not os.path.islink(target) and digest_of(target) == entry['sha256'] and (entry['source'] == 'git' or stat.S_IMODE(os.lstat(target).st_mode) == safe_mode(entry['mode']))
        if not ok:
            problems.append(path)
        layout.append({'from': entry['path'], 'to': path, 'sha256': entry.get('sha256'), 'source': entry['source']})
    for path, repo in sorted(repos.items()):
        if git(os.path.join(base, path), 'rev-parse', 'HEAD').strip() != repo['head']:
            problems.append(path + ' (HEAD)')
    receipt = {'schema': RESTORE_SCHEMA, 'manifest': manifest['sha256'], 'alias': manifest['alias'],
               'restoredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **layout_rules,
               'repositories': [{'from': r['path'], 'to': p, 'head': r['head']} for p, r in sorted(repos.items())],
               'layout': layout, 'excludedByLayout': sorted(skipped), 'extrasUnderOmissions': extras, 'problems': problems, 'verified': not problems}
    receipt['sha256'] = seal(receipt)
    return receipt


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog='v4-medicion-migracion.sh')
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('copiar')
    make.add_argument('--alias', required=True)
    make.add_argument('--empresa', required=True, help='company (tenant) the alias must belong to in the config')
    make.add_argument('--config', default=CONFIG, help='versioned alias config with container, company and paths')
    make.add_argument('--origen', action='append', required=True, help='NAME=/absolute/directory')
    make.add_argument('--destino', required=True)
    commands.add_parser('comprobar-copia').add_argument('copia')
    back = commands.add_parser('restaurar')
    back.add_argument('copia')
    back.add_argument('--alias', required=True)
    back.add_argument('--empresa', required=True)
    back.add_argument('--destino')
    back.add_argument('--mapa', action='append', default=[], help='OLD_PREFIX=NEW_PREFIX')
    back.add_argument('--omitir', action='append', default=[], help='glob of data entries left out of the new layout')
    back.add_argument('--duplicar', action='append', default=[], help='OLD_FILE=NEW_FILE extra copy, e.g. context')
    back.add_argument('--propietario', help='UID:GID for the restored tree; required when running as root')
    back.add_argument('--recibo')
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == 'copiar':
            with open(arguments.config, encoding='utf-8') as handle:
                scope = tenant_scope(json.load(handle), arguments.alias, arguments.empresa, host_containers())
            manifest = copy(arguments.alias, arguments.origen, arguments.destino, scope)
            print(json.dumps({'manifest': manifest['sha256'], **manifest['totals']}, sort_keys=True))
        elif arguments.command == 'comprobar-copia':
            print(json.dumps(check(arguments.copia), sort_keys=True))
        else:
            scratch = None if arguments.destino else tempfile.mkdtemp(prefix='cauce-v4-restauracion-')
            try:
                receipt = restore(arguments.copia, arguments.destino or scratch, arguments.mapa, arguments.omitir, arguments.duplicar, arguments.propietario, (arguments.alias, arguments.empresa))
            finally:
                if scratch:
                    shutil.rmtree(scratch, ignore_errors=True)
            text = json.dumps(receipt, indent=1, sort_keys=True)
            if arguments.recibo:
                with os.fdopen(os.open(arguments.recibo, OPEN_NEW, 0o600), 'w', encoding='utf-8') as handle:
                    handle.write(text + '\n')
            print(json.dumps({**{k: receipt[k] for k in ('manifest', 'verified', 'sha256')}, 'problems': len(receipt['problems']), 'files': len(receipt['layout'])}, sort_keys=True))
            return 0 if receipt['verified'] else 1
    except (Failure, OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        print(f'v4-medicion-migracion: {scrub(str(error))}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
