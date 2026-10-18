"""Private stopped-agent snapshots with raw Git state, work sessions and SQLite companions."""
from __future__ import annotations

import argparse
import collections
import hashlib
import io
import json
import os
import re
import stat
import sys
import tarfile
import time
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from v4_alcance_copia import check_sources, host_containers, tenant_scope  # noqa: E402
from v4_copia_migracion import (  # noqa: E402
    CHUNK,
    NAME_RE,
    OPEN_DIRECTORY,
    OPEN_FILE,
    OPEN_NEW,
    REGENERABLE,
    SHA256_RE,
    Failure,
    canonical,
    fold_text,
    open_verified,
    relative,
    safe_mode,
    seal,
    under,
)

SCHEMA = 'cauce.v4-migracion-integral/1'
SPACE = ('context', 'directives', 'projects', 'config', 'data', 'logs', 'tmp')
CREDENTIAL = re.compile(r'^(?:\.ssh|\.gnupg|\.aws|\.docker|\.kube|\.password-store|\.cauce-credentials|agent\.token|\.netrc|_netrc|\.git-credentials|\.pgpass|\.npmrc|\.pypirc|\.boto|\.s3cfg|\.htpasswd|(?:\.?credentials(?:\.(?:json|ya?ml|toml|ini|txt))?|auth(?:-profiles)?\.json|oauth(?:_creds|[-_]credentials|[-_]tokens)?\.json|application_default_credentials\.json)(?:[.-](?:bak|backup|old|tmp).*)?|client_secrets?[^/]*\.json|secrets?\.(?:json|ya?ml|toml)|token\.json|settings\.local\.json|\.env(?:\..*)?|kubeconfig|cookies(?:-(?:wal|shm|journal)|\.(?:txt|json|sqlite3?(?:-(?:wal|shm|journal))?))?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p8|p12|pfx|ppk|jks|keystore|kdbx|gpg|asc|ovpn|hdr))$')
VERIFIED_CREDENTIAL = re.compile(rb'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}|\bglpat-[A-Za-z0-9_-]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\bnpm_[A-Za-z0-9]{36}\b|\bxai-[A-Za-z0-9]{20,}')


def absolute(value: str) -> str:
    if not value.startswith('/') or os.path.normpath(value) != value or '\x00' in value:
        raise Failure('an absolute normalized path is required')
    return value


def directory(path: str) -> int:
    descriptor = os.open('/', OPEN_DIRECTORY)
    try:
        for component in absolute(path).split('/')[1:]:
            if component:
                child = os.open(component, OPEN_DIRECTORY, dir_fd=descriptor)
                os.close(descriptor)
                descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def descend(base: int, path: str, create: bool = False) -> int:
    descriptor = os.dup(base)
    try:
        for component in path.split('/') if path else []:
            if create:
                try:
                    os.mkdir(component, 0o700, dir_fd=descriptor)
                except FileExistsError:
                    pass
            child = os.open(component, OPEN_DIRECTORY, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def fingerprint(info: os.stat_result) -> tuple:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def digest_stream(read, private: bool = False) -> str:
    digest, tail = hashlib.sha256(), b''
    while chunk := read(CHUNK):
        digest.update(chunk)
        if private and VERIFIED_CREDENTIAL.search(tail + chunk):
            raise Failure('credential material detected outside credential paths; arrange private recovery with the owner before retrying')
        tail = chunk[-4096:]
    return digest.hexdigest()


def inventory(roots: dict[str, int]) -> tuple[list[dict], list[dict], dict]:
    entries, omissions, identities = [], [], {}

    def visit(parent: int, name: str, path: str, source: int) -> None:
        info = os.stat(name, dir_fd=parent, follow_symlinks=False)
        identities[path] = fingerprint(info)
        folded = fold_text(name)
        reason = 'credential' if CREDENTIAL.fullmatch(folded) else 'regenerable' if stat.S_ISDIR(info.st_mode) and folded in REGENERABLE else None
        if reason:
            omissions.append({'path': path, 'reason': reason})
            return
        entry = {'path': path, 'mode': stat.S_IMODE(info.st_mode)}
        if stat.S_ISDIR(info.st_mode):
            entries.append({**entry, 'kind': 'directory'})
            child = open_verified(parent, name, info, OPEN_DIRECTORY)
            try:
                for item in sorted(os.listdir(child)):
                    relative(item)
                    visit(child, item, path + '/' + item, source)
                if fingerprint(os.fstat(child)) != identities[path]:
                    raise Failure('a directory changed; stop the agent before copying')
            finally:
                os.close(child)
        elif stat.S_ISREG(info.st_mode):
            child = open_verified(parent, name, info, OPEN_FILE)
            try:
                digest = digest_stream(lambda size: os.read(child, size), private=True)
                if fingerprint(os.fstat(child)) != identities[path]:
                    raise Failure('a file changed; stop the agent before copying')
                entries.append({**entry, 'kind': 'file', 'size': info.st_size, 'sha256': digest})
                if name in ('.git', 'commondir', 'alternates'):
                    os.lseek(child, 0, os.SEEK_SET)
                    raw = os.read(child, min(info.st_size, 65537)).decode('utf-8', 'surrogateescape')
                    if name == '.git' and raw.startswith('gitdir:') or name == 'commondir' and '/.git/' in path or name == 'alternates' and path.endswith('/objects/info/alternates'):
                        references = [item.removeprefix('gitdir:').strip() for item in raw.splitlines()]
                        base = os.path.join(os.readlink(f'/proc/self/fd/{parent}'), '../' if name == 'alternates' else '')
                        if info.st_size > 65536 or any(item.startswith('/') or not under(os.path.realpath(os.path.join(base, item)), os.readlink(f'/proc/self/fd/{source}')) for item in references):
                            raise Failure('external Git storage cannot be restored as a private snapshot')
            finally:
                os.close(child)
        elif stat.S_ISLNK(info.st_mode):
            target = os.readlink(name, dir_fd=parent)
            if target.startswith('/') or not under(os.path.realpath(os.path.join(os.readlink(f'/proc/self/fd/{parent}'), target)), os.readlink(f'/proc/self/fd/{source}')):
                raise Failure('a symlink leaves its source root')
            entries.append({**entry, 'kind': 'symlink', 'target': target, 'sha256': hashlib.sha256(os.fsencode(target)).hexdigest()})
        elif stat.S_ISSOCK(info.st_mode):
            omissions.append({'path': path, 'reason': 'regenerable-socket'})
        else:
            raise Failure('a device or FIFO cannot be included')

    for name, root in sorted(roots.items()):
        visit(root, '.', name, root)
    counts = collections.Counter((identities[e['path']][0], identities[e['path']][1]) for e in entries if e['kind'] == 'file')
    if any(identities[e['path']][-1] != counts[identities[e['path']][:2]] for e in entries if e['kind'] == 'file'):
        raise Failure('a hard link leaves the included source scope')
    return entries, omissions, identities


class Reader:
    def __init__(self, descriptor: int):
        self.descriptor, self.digest = descriptor, hashlib.sha256()

    def read(self, size: int) -> bytes:
        chunk = os.read(self.descriptor, size)
        self.digest.update(chunk)
        return chunk


def counts(entries: list[dict], omissions: list[dict]) -> dict:
    return {**dict(collections.Counter(e['kind'] for e in entries)), 'bytes': sum(e.get('size', 0) for e in entries), 'omitted': len(omissions)}


def pack(args: argparse.Namespace) -> dict:
    roots = {}
    for rule in args.origen:
        name, separator, path = rule.partition('=')
        if not separator or not NAME_RE.fullmatch(name) or name in roots:
            raise Failure('--origen requires unique NAME=/absolute/path entries')
        roots[name] = absolute(path)
        if any(CREDENTIAL.fullmatch(fold_text(part)) for part in path.split('/')):
            raise Failure('an explicit source must not be a credential path')
    if any(under(path, other) for name, path in roots.items() for key, other in roots.items() if name != key):
        raise Failure('source roots must not overlap')
    with open(args.config, encoding='utf-8') as stream:
        scope = tenant_scope(json.load(stream), args.alias, args.empresa, host_containers())
    check_sources(roots, scope)
    destination = absolute(args.destino)
    if any(under(destination, path) for path in roots.values()):
        raise Failure('the archive must be outside every source')
    handles, parent, temporary, created = {}, directory(os.path.dirname(destination)), '.' + uuid.uuid4().hex + '.tar', False
    try:
        for name, path in roots.items():
            handles[name] = directory(path)
        before = inventory(handles)
        manifest = {'schema': SCHEMA, 'alias': args.alias, 'tenant': args.empresa, 'container': scope['container'], 'roots': sorted(roots), 'entries': before[0], 'omissions': before[1]}
        manifest['sha256'] = seal(manifest)
        validate(manifest, args)
        descriptor = os.open(temporary, OPEN_NEW, 0o600, dir_fd=parent)
        created = True
        with os.fdopen(descriptor, 'wb') as stream, tarfile.open(fileobj=stream, mode='w') as archive:
            payload = canonical(manifest)
            member = tarfile.TarInfo('manifest.json')
            member.size, member.mode = len(payload), 0o600
            archive.addfile(member, io.BytesIO(payload))
            for entry in before[0]:
                if entry['kind'] != 'file':
                    continue
                source, _, path = entry['path'].partition('/')
                holder = descend(handles[source], os.path.dirname(path))
                try:
                    reader = os.open(os.path.basename(path), OPEN_FILE, dir_fd=holder)
                finally:
                    os.close(holder)
                try:
                    if fingerprint(os.fstat(reader)) != before[2][entry['path']]:
                        raise Failure('a file changed before the archive was written')
                    member = tarfile.TarInfo('files/' + entry['path'])
                    member.size, member.mode = entry['size'], 0o600
                    copied = Reader(reader)
                    archive.addfile(member, copied)
                    if copied.digest.hexdigest() != entry['sha256'] or fingerprint(os.fstat(reader)) != before[2][entry['path']]:
                        raise Failure('a file changed while the archive was written')
                finally:
                    os.close(reader)
        if inventory(handles) != before:
            raise Failure('source inventory changed; the archive was rejected')
        for name, path in roots.items():
            current = directory(path)
            try:
                if fingerprint(os.fstat(current)) != before[2][name]:
                    raise Failure('a source root changed during copying')
            finally:
                os.close(current)
        reader = os.open(temporary, OPEN_FILE, dir_fd=parent)
        with os.fdopen(reader, 'rb') as stream:
            archive_digest = digest_stream(stream.read)
            os.fsync(stream.fileno())
        os.link(temporary, os.path.basename(destination), src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        os.fsync(parent)
        return {'verified': True, 'manifestSha256': manifest['sha256'], 'archiveSha256': archive_digest, 'counts': counts(before[0], before[1]), 'omissions': before[1]}
    finally:
        try:
            if created:
                os.unlink(temporary, dir_fd=parent)
        except FileNotFoundError:
            pass
        os.close(parent)
        for handle in handles.values():
            os.close(handle)


def validate(manifest: dict, args: argparse.Namespace) -> dict[str, dict]:
    if not isinstance(manifest, dict) or manifest.get('schema') != SCHEMA or manifest.get('sha256') != seal(manifest) or (manifest.get('alias'), manifest.get('tenant')) != (args.alias, args.empresa):
        raise Failure('invalid manifest seal, alias or company')
    roots = manifest.get('roots')
    if not isinstance(roots, list) or not roots or len(set(roots)) != len(roots) or any(not isinstance(name, str) or not NAME_RE.fullmatch(name) for name in roots):
        raise Failure('invalid manifest roots')
    entries = {}
    for entry in manifest['entries']:
        path = relative(entry['path'])
        if path in entries or path.split('/')[0] not in roots or type(entry.get('mode')) is not int or not 0 <= entry['mode'] <= 0o7777 or entry['kind'] not in ('directory', 'file', 'symlink'):
            raise Failure('invalid manifest entry')
        if entry['kind'] == 'file' and (type(entry.get('size')) is not int or entry['size'] < 0 or not SHA256_RE.fullmatch(entry.get('sha256', ''))):
            raise Failure('invalid file digest or size')
        entries[path] = entry
    for path, entry in entries.items():
        if path in roots and entry['kind'] != 'directory' or any(entries.get('/'.join(path.split('/')[:i]), {}).get('kind') != 'directory' for i in range(1, len(path.split('/')))):
            raise Failure('manifest has a missing directory or symlink ancestor')
        if entry['kind'] == 'symlink':
            target = entry.get('target')
            if not isinstance(target, str) or not target or target.startswith('/') or '\x00' in target or hashlib.sha256(os.fsencode(target)).hexdigest() != entry.get('sha256'):
                raise Failure('invalid symlink')
            stack, pending, hops = path.split('/')[:-1], collections.deque(target.split('/')), 0
            while pending:
                item = pending.popleft()
                if item in ('', '.'):
                    continue
                if item == '..':
                    if len(stack) <= 1:
                        raise Failure('symlink leaves its source root')
                    stack.pop()
                else:
                    stack.append(item)
                    linked = entries.get('/'.join(stack), {})
                    if linked.get('kind') == 'symlink':
                        hops += 1
                        if hops > 40:
                            raise Failure('symlink loop')
                        if not isinstance(linked.get('target'), str) or linked['target'].startswith('/'):
                            raise Failure('invalid symlink target')
                        stack.pop()
                        pending.extendleft(reversed(linked['target'].split('/')))
    if any(root not in entries for root in roots):
        raise Failure('missing manifest root')
    if not isinstance(manifest.get('omissions'), list) or any(relative(item['path']).split('/')[0] not in roots or item['path'] in entries or item.get('reason') not in ('credential', 'regenerable', 'regenerable-socket') for item in manifest['omissions']):
        raise Failure('invalid manifest omissions')
    return entries


def unpack(args: argparse.Namespace) -> dict:
    archive_parent = directory(os.path.dirname(absolute(args.archivo)))
    try:
        descriptor = os.open(os.path.basename(args.archivo), OPEN_FILE, dir_fd=archive_parent)
    finally:
        os.close(archive_parent)
    with os.fdopen(descriptor, 'rb') as stream, tarfile.open(fileobj=stream, mode='r:') as archive:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise Failure('archive must be a regular file')
        archive_identity = fingerprint(os.fstat(stream.fileno()))
        members = archive.getmembers()
        if len({member.name for member in members}) != len(members) or any(not member.isfile() for member in members):
            raise Failure('archive has duplicate or non-regular members')
        raw = archive.extractfile('manifest.json')
        if raw is None or archive.getmember('manifest.json').size > 64 * CHUNK:
            raise Failure('invalid manifest member')
        manifest = json.load(raw)
        entries = validate(manifest, args)
        files = {'files/' + path: entry for path, entry in entries.items() if entry['kind'] == 'file'}
        if {member.name for member in members} != {'manifest.json', *files}:
            raise Failure('archive members do not match its manifest')
        for name, entry in files.items():
            if archive.getmember(name).size != entry['size'] or digest_stream(archive.extractfile(name).read) != entry['sha256']:
                raise Failure('archive file digest mismatch')
        mapping = {}
        for rule in args.mapa:
            name, separator, path = rule.partition('=')
            if not separator or name in mapping or name not in manifest['roots'] or relative(path).split('/')[0] not in SPACE:
                raise Failure('invalid --mapa; use unique NAME=standard-directory/subdirectory')
            mapping[name] = path
        if set(mapping) != set(manifest['roots']) or any(under(path, other) for name, path in mapping.items() for key, other in mapping.items() if name != key):
            raise Failure('every source requires a separate non-overlapping mapping')
        parent = directory(os.path.dirname(absolute(args.destino)))
        try:
            try:
                os.mkdir(os.path.basename(args.destino), 0o700, dir_fd=parent)
            except FileExistsError:
                pass
            root = os.open(os.path.basename(args.destino), OPEN_DIRECTORY, dir_fd=parent)
        finally:
            os.close(parent)
        layout = []
        try:
            if os.listdir(root):
                raise Failure('destination must be empty')
            os.fchmod(root, 0o700)
            for path in SPACE:
                os.mkdir(path, 0o700, dir_fd=root)
            for path, entry in sorted(entries.items(), key=lambda item: (item[1]['kind'] == 'symlink', item[0].count('/'), item[0])):
                source, _, suffix = path.partition('/')
                target = mapping[source] + ('/' + suffix if suffix else '')
                holder = descend(root, target if entry['kind'] == 'directory' else os.path.dirname(target), create=True)
                try:
                    if entry['kind'] == 'file':
                        writer = os.open(os.path.basename(target), OPEN_NEW, 0o600, dir_fd=holder)
                        with os.fdopen(writer, 'wb') as output, archive.extractfile('files/' + path) as incoming:
                            while chunk := incoming.read(CHUNK):
                                output.write(chunk)
                            output.flush()
                            os.fchmod(output.fileno(), safe_mode(entry['mode']))
                        reader = os.open(os.path.basename(target), OPEN_FILE, dir_fd=holder)
                        with os.fdopen(reader, 'rb') as output:
                            if digest_stream(output.read) != entry['sha256']:
                                raise Failure('restored digest mismatch')
                    elif entry['kind'] == 'symlink':
                        os.symlink(entry['target'], os.path.basename(target), dir_fd=holder)
                    layout.append({'from': path, 'to': target, 'sha256': entry.get('sha256'), 'kind': entry['kind']})
                finally:
                    os.close(holder)
            for path, entry in sorted(entries.items(), reverse=True):
                if entry['kind'] == 'directory':
                    source, _, suffix = path.partition('/')
                    holder = descend(root, mapping[source] + ('/' + suffix if suffix else ''))
                    os.fchmod(holder, safe_mode(entry['mode'], directory=True))
                    os.close(holder)
            if fingerprint(os.fstat(stream.fileno())) != archive_identity:
                raise Failure('archive changed during restoration')
            return {'verified': True, 'manifestSha256': manifest['sha256'], 'alias': args.alias, 'tenant': args.empresa, 'counts': counts(list(entries.values()), manifest['omissions']), 'omissions': manifest['omissions'], 'layout': layout}
        finally:
            os.close(root)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('pack')
    make.add_argument('--config', required=True)
    make.add_argument('--origen', action='append', required=True)
    restore = commands.add_parser('unpack')
    restore.add_argument('--archivo', required=True)
    restore.add_argument('--mapa', action='append', required=True)
    for command in (make, restore):
        command.add_argument('--alias', required=True)
        command.add_argument('--empresa', required=True)
        command.add_argument('--destino', required=True)
    args = parser.parse_args()
    started = time.monotonic()
    try:
        receipt = pack(args) if args.command == 'pack' else unpack(args)
        print(json.dumps({**receipt, 'durationSeconds': round(time.monotonic() - started, 3)}, ensure_ascii=True))
        return 0
    except (ValueError, OSError, KeyError, TypeError, tarfile.TarError) as error:
        print(json.dumps({'verified': False, 'error': str(error)}, ensure_ascii=True), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
