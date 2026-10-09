from __future__ import annotations

import ast
import hashlib
import json
import os
import pathlib
import stat
import subprocess
import time
import uuid

from secure_path import InvalidAbsolutePath, open_absolute_directory, open_regular_at


class Abort(Exception):
    pass


def say(message):
    print(message, flush=True)


def require_root():
    if os.geteuid() != 0:
        raise Abort('requires root')


def directory_fd(directory, private=False, owners=(0,)):
    try:
        descriptor = open_absolute_directory(directory)
    except (OSError, InvalidAbsolutePath):
        raise Abort('directory contains a symlink or is unavailable: ' + str(directory)) from None
    details = os.fstat(descriptor)
    if details.st_uid not in owners or details.st_mode & (0o077 if private else 0o022):
        os.close(descriptor)
        raise Abort('directory ownership or mode is unsafe: ' + str(directory))
    return descriptor


def safe_read(filename, private=False, maximum=8_388_608, owners=(0,)):
    filename = pathlib.Path(filename)
    parent = directory_fd(filename.parent, owners=owners)
    descriptor = None
    try:
        descriptor = open_regular_at(parent, filename.name, os.O_RDONLY | os.O_NONBLOCK)
        details = os.fstat(descriptor)
        if not stat.S_ISREG(details.st_mode) or details.st_uid not in owners or details.st_nlink != 1 \
                or details.st_size > maximum or details.st_mode & (0o077 if private else 0o022):
            raise Abort('file ownership, links, size or mode is unsafe: ' + filename.name)
        chunks = bytearray()
        while chunk := os.read(descriptor, min(1_048_576, maximum + 1 - len(chunks))):
            chunks.extend(chunk)
            if len(chunks) > maximum:
                raise Abort('file exceeds its size limit: ' + filename.name)
        return bytes(chunks), details
    except OSError:
        raise Abort('file contains a symlink or is unavailable: ' + filename.name) from None
    finally:
        if descriptor is not None:
            os.close(descriptor)
        os.close(parent)


def sha256_file(filename):
    return hashlib.sha256(safe_read(filename, maximum=134_217_728)[0]).hexdigest()


def staged_sha256(filename):
    digest = hashlib.sha256()
    descriptor = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        while chunk := os.read(descriptor, 1_048_576):
            digest.update(chunk)
    finally:
        os.close(descriptor)
    return digest.hexdigest()


def write_new(filename, body, uid, gid, mode, replace=False, owners=(0,)):
    filename = pathlib.Path(filename)
    parent = directory_fd(filename.parent, owners=owners)
    temporary = '.' + filename.name + '.upgrade-' + uuid.uuid4().hex
    descriptor = None
    try:
        descriptor = open_regular_at(parent, temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode=0o600)
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, 'wb', closefd=False) as stream:
            stream.write(body)
            stream.flush()
        os.fsync(descriptor)
        if replace:
            os.replace(temporary, filename.name, src_dir_fd=parent, dst_dir_fd=parent)
        else:
            os.link(temporary, filename.name, src_dir_fd=parent, dst_dir_fd=parent)
        os.fsync(parent)
    finally:
        if descriptor is not None:
            os.close(descriptor)
        try:
            os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)


def run(command, check=True, **options):
    options.setdefault('stdin', subprocess.DEVNULL)
    options.setdefault('capture_output', True)
    options.setdefault('text', True)
    options.setdefault('timeout', 120)
    result = subprocess.run(command, **options)
    if check and result.returncode:
        raise Abort('command failed: ' + pathlib.Path(command[0]).name + ' (exit ' + str(result.returncode) + ')')
    return result


def wait_until(predicate, seconds, interval=1.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()


def python_closure(ops, entry):
    names = {}
    for directory in ('cli', 'scripts', 'container-runtime'):
        for filename in sorted((ops / directory).glob('*.py')):
            names.setdefault(filename.stem, filename)
    seen, pending = set(), [ops / entry]
    while pending:
        current = pending.pop()
        if current in seen:
            continue
        seen.add(current)
        for node in ast.walk(ast.parse(safe_read(current)[0])):
            modules = [alias.name.split('.')[0] for alias in node.names] if isinstance(node, ast.Import) else []
            if isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                modules = [node.module.split('.')[0]]
            pending.extend(names[name] for name in modules if name in names and names[name] not in seen)
    return sorted(str(item.relative_to(ops)) for item in seen)


def normalized_mode(info):
    return 0o755 if stat.S_ISDIR(info.st_mode) or info.st_mode & 0o111 else 0o644


def snapshot(root):
    rows = {}
    for item in sorted(pathlib.Path(root).rglob('*')):
        info = item.lstat()
        relative = str(item.relative_to(root))
        if stat.S_ISLNK(info.st_mode):
            rows[relative] = ('l', 0, os.readlink(item))
        elif stat.S_ISREG(info.st_mode):
            rows[relative] = ('f', normalized_mode(info), staged_sha256(item))
        elif not stat.S_ISDIR(info.st_mode):
            raise Abort('unsupported file type in tree: ' + relative)
    return rows


def contained_links(root):
    root = pathlib.Path(root).resolve()
    for item in root.rglob('*'):
        info = item.lstat()
        try:
            escapes = stat.S_ISLNK(info.st_mode) and not item.resolve(strict=True).is_relative_to(root)
        except OSError:
            escapes = True
        if escapes or not (stat.S_ISLNK(info.st_mode) or stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
            raise Abort('dangling, escaping or unsupported entry in tree: ' + str(item.relative_to(root)))


def owned_tree(root, normalize):
    for item in [root, *root.rglob('*')]:
        os.lchown(item, 0, 0)
        if normalize and not item.is_symlink():
            item.chmod(normalized_mode(item.lstat()))


def mkdir_owned(directory, mode=0o755):
    if not directory.exists():
        directory.mkdir(mode=mode)
        os.chown(directory, 0, 0)
        directory.chmod(mode)


def dumps(document):
    return (json.dumps(document, indent=2) + '\n').encode()


class Rewriter:
    def __init__(self, old_root, new_root, adapter_digest):
        self.old, self.new, self.digest, self.log = str(old_root), str(new_root), adapter_digest, []

    def remap(self, text, name):
        if text == self.old or text.startswith(self.old + '/'):
            self.log.append((name, 'path'))
            return self.new + text[len(self.old):]
        return text

    def paths(self, node, name=''):
        if isinstance(node, dict):
            return {self.remap(key, name): self.paths(value, name) for key, value in node.items()}
        if isinstance(node, list):
            return [self.paths(value, name) for value in node]
        return self.remap(node, name) if isinstance(node, str) else node

    def under_new(self, value):
        return isinstance(value, str) and value.startswith(self.new + '/')

    def pin(self, name, container, key, value):
        if container.get(key) != value:
            self.log.append((name, 'pin'))
            container[key] = value

    def pins(self, node, name=''):
        if isinstance(node, dict):
            if self.under_new(node.get('executable')) and 'sha256' in node:
                self.pin(name, node, 'sha256', sha256_file(node['executable']))
            files = node.get('files')
            for filename in files if isinstance(files, dict) else ():
                if self.under_new(filename):
                    self.pin(name, files, filename, sha256_file(filename))
            if self.under_new(node.get('directory')) and 'digest' in node:
                self.pin(name, node, 'digest', self.digest)
            for value in node.values():
                self.pins(value, name)
        elif isinstance(node, list):
            for value in node:
                self.pins(value, name)

    def hook_closure(self, policy, ops, name=''):
        for hook in policy.get('hooks', {}).values():
            files = hook.get('files')
            if not isinstance(files, dict):
                continue
            for script in hook.get('argv', []):
                if isinstance(script, str) and script.startswith(str(ops) + '/') and script.endswith('.py'):
                    for relative in python_closure(ops, str(pathlib.Path(script).relative_to(ops))):
                        filename = str(ops / relative)
                        if filename not in files:
                            self.log.append((name, 'hook closure'))
                        files[filename] = sha256_file(filename)
            hook['files'] = dict(sorted(files.items()))


def verify_pins(new_root, documents):
    count = 0

    def walk(node):
        nonlocal count
        if isinstance(node, dict):
            pairs = list(node['files'].items()) if isinstance(node.get('files'), dict) else []
            if 'sha256' in node:
                pairs.append((node.get('executable'), node['sha256']))
            for filename, digest in pairs:
                if isinstance(filename, str) and filename.startswith(str(new_root) + '/'):
                    if sha256_file(filename) != digest:
                        raise Abort('installed file differs from its sha256 pin: ' + filename[len(str(new_root)):])
                    count += 1
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)

    for document in documents:
        walk(document)
    return count


def restore_configs(ctx):
    restored = True
    for filename, backup, expected, owners in reversed(ctx['rollback']):
        try:
            body, details = safe_read(backup, owners=owners)
            if hashlib.sha256(body).hexdigest() != expected:
                raise Abort('configuration backup was altered: ' + backup.name)
            write_new(filename, body, details.st_uid, details.st_gid, stat.S_IMODE(details.st_mode), replace=True, owners=owners)
            say(f'  restored {filename}')
        except (Abort, OSError) as error:
            say(f'  NOT restored {filename}: {error}')
            restored = False
    return restored
