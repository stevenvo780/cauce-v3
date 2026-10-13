"""Recoverable pre-cut copy of an agent's legacy data for the V4 migration, with a sealed manifest.

Projects travel as git bundles and come back at the same HEAD; every other file travels by content with
sha256. Paths that look like credentials (auth, session, token, profile and key material) are omitted with
a reason and their content is never read. Restoration rebuilds the tree, optionally under a normalized
layout (old path -> new path), and proves the result against the manifest.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import shutil
import socket
import stat
import subprocess
import sys
import tempfile
import time

SCHEMA = 'cauce.v4-migracion-copia/1'
RESTORE_SCHEMA = 'cauce.v4-migracion-restauracion/1'
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
OMISSION_RULES = (
    ('auth', re.compile(r'o?auth(?!or)', re.I)),
    ('session', re.compile(r'session', re.I)),
    ('token', re.compile(r'token', re.I)),
    ('profile', re.compile(r'profile', re.I)),
    ('credential', re.compile(r'^(?:\.ssh|\.gnupg|\.netrc|\.git-credentials|\.pgpass|\.npmrc|\.pypirc|\.env(?:\..*)?'
                              r'|cookies.*|id_(?:rsa|dsa|ecdsa|ed25519).*|.*credential.*|.*secret.*'
                              r'|.*\.(?:pem|key|p12|pfx|hdr))$', re.I)),
)
REGENERABLE = frozenset({'node_modules', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache',
                         '.ruff_cache', '.cache', '.npm', '.next', '.turbo'})
USERINFO = re.compile(r'(?<=://)[^/@\s]+@')
CHUNK = 1 << 20
GIT_ENV = {'GIT_OPTIONAL_LOCKS': '0', 'GIT_TERMINAL_PROMPT': '0', 'LC_ALL': 'C', 'GIT_CONFIG_NOSYSTEM': '1'}


class Failure(ValueError):
    pass


def canonical(value) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


def seal(doc: dict) -> str:
    return hashlib.sha256(canonical({k: v for k, v in doc.items() if k != 'sha256'})).hexdigest()


def omission_reason(name: str, directory: bool) -> str | None:
    for reason, pattern in OMISSION_RULES:
        if pattern.search(name) if reason != 'credential' else pattern.fullmatch(name):
            return reason
    return 'regenerable' if directory and name in REGENERABLE else None


def git(repository: str, *arguments: str, check: bool = True) -> str:
    command = ['git', '-c', 'safe.directory=*', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null',
               '-C', repository, *arguments]
    done = subprocess.run(command, capture_output=True, env={**os.environ, **GIT_ENV}, check=False, timeout=3600)
    if check and done.returncode:
        raise Failure(f'git {arguments[0]} failed in {repository}: {done.stderr.decode(errors="replace").strip()[:200]}')
    return done.stdout.decode('utf-8', 'surrogateescape') if done.returncode == 0 else ''


def relative(value: str) -> str:
    path = pathlib.PurePosixPath(value)
    if not value or path.is_absolute() or str(path) != value or any(part in ('', '.', '..') for part in path.parts) \
            or any(ord(character) < 32 for character in value):
        raise Failure(f'unsafe manifest path: {value!r}')
    return value


def under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + '/')


def hash_file(path: str, object_format: str | None, size: int) -> tuple[str, str | None]:
    digest = hashlib.sha256()
    blob = hashlib.new(object_format) if object_format else None
    if blob:
        blob.update(b'blob %d\0' % size)
    read = 0
    with open(path, 'rb', opener=lambda p, f: os.open(p, f | os.O_NOFOLLOW)) as handle:
        while chunk := handle.read(CHUNK):
            read += len(chunk)
            digest.update(chunk)
            if blob:
                blob.update(chunk)
    if read != size:
        raise Failure(f'{path} changed while it was copied; stop the agent and retry')
    return digest.hexdigest(), blob.hexdigest() if blob else None


def store(source: str, digest: str, output: str) -> None:
    target = os.path.join(output, 'data', digest[:2], digest)
    if os.path.exists(target):
        return
    os.makedirs(os.path.dirname(target), mode=0o700, exist_ok=True)
    temporary = target + '.part'
    with open(source, 'rb', opener=lambda p, f: os.open(p, f | os.O_NOFOLLOW)) as reader, \
            open(temporary, 'xb', opener=lambda p, f: os.open(p, f, 0o600)) as writer:
        shutil.copyfileobj(reader, writer, CHUNK)
    if hash_file(temporary, None, os.path.getsize(temporary))[0] != digest:
        os.unlink(temporary)
        raise Failure(f'{source} changed while it was copied; stop the agent and retry')
    os.replace(temporary, target)


class Copier:
    def __init__(self, output: str):
        self.output = output
        self.entries: list[dict] = []
        self.omissions: list[dict] = []
        self.repositories: dict[str, dict] = {}
        self.tracked: dict[str, dict] = {}

    def omit(self, path: str, reason: str, absolute: str, directory: bool) -> None:
        files, size = 0, 0
        if directory:
            for root, dirs, names in os.walk(absolute, followlinks=False):
                files += len(names)
                for name in names:
                    try:
                        size += os.lstat(os.path.join(root, name)).st_size
                    except OSError:
                        continue
                dirs.sort()
        else:
            files, size = 1, os.lstat(absolute).st_size
        self.omissions.append({'path': path, 'reason': reason, 'kind': 'directory' if directory else 'file',
                               'files': files, 'bytes': size})

    def repository(self, path: str, absolute: str) -> None:
        head = git(absolute, 'rev-parse', '--verify', '-q', 'HEAD^{commit}', check=False).strip()
        if not head:
            self.omissions.append({'path': path + '/.git', 'reason': 'git-without-commits', 'kind': 'directory',
                                   'files': 0, 'bytes': 0})
            return
        object_format = git(absolute, 'rev-parse', '--show-object-format', check=False).strip() or 'sha1'
        branch = git(absolute, 'symbolic-ref', '-q', '--short', 'HEAD', check=False).strip() or None
        remotes = {}
        for line in git(absolute, 'remote', '-v').splitlines():
            name, _, rest = line.partition('\t')
            if rest.endswith(' (fetch)'):
                remotes[name] = USERINFO.sub('', rest[:-len(' (fetch)')])
        bundle = f'repos/{len(self.repositories):04d}.bundle'
        os.makedirs(os.path.join(self.output, 'repos'), mode=0o700, exist_ok=True)
        git(absolute, 'bundle', 'create', '-q', os.path.join(self.output, bundle), 'HEAD', '--all')
        git(absolute, 'bundle', 'verify', '-q', os.path.join(self.output, bundle))
        tracked = {}
        for record in git(absolute, 'ls-files', '-s', '-z').split('\0'):
            if record:
                meta, _, name = record.partition('\t')
                mode, blob, _ = meta.split(' ', 2)
                tracked[name] = (mode, blob)
        refs = sorted(git(absolute, 'for-each-ref', '--format=%(refname)').split())
        bundle_path = os.path.join(self.output, bundle)
        bundle_digest = hash_file(bundle_path, None, os.path.getsize(bundle_path))[0]
        self.repositories[path] = {'path': path, 'head': head, 'branch': branch, 'objectFormat': object_format,
                                   'remotes': remotes, 'refs': len(refs), 'bundle': bundle,
                                   'bundleSha256': bundle_digest, 'deleted': [], 'worktree': os.path.isfile(
                                       os.path.join(absolute, '.git'))}
        self.tracked[path] = tracked

    def owner(self, path: str) -> str | None:
        holders = [repo for repo in self.repositories if under(path, repo) and path != repo]
        return max(holders, key=len) if holders else None

    def file(self, path: str, absolute: str, info: os.stat_result) -> None:
        repo = self.owner(path)
        inner = path[len(repo) + 1:] if repo else None
        tracked = self.tracked[repo].get(inner) if repo else None
        object_format = self.repositories[repo]['objectFormat'] if tracked else None
        entry = {'path': path, 'kind': 'file', 'mode': stat.S_IMODE(info.st_mode), 'bytes': info.st_size}
        digest, blob = hash_file(absolute, object_format, info.st_size)
        executable = bool(info.st_mode & 0o111)
        clean = tracked and tracked[1] == blob and tracked[0] == ('100755' if executable else '100644')
        entry.update(sha256=digest, source='git' if clean else 'data')
        if not clean:
            store(absolute, digest, self.output)
        self.entries.append(entry)

    def link(self, path: str, absolute: str) -> None:
        target = os.readlink(absolute)
        repo = self.owner(path)
        tracked = self.tracked[repo].get(path[len(repo) + 1:]) if repo else None
        clean = False
        if tracked and tracked[0] == '120000':
            raw = target.encode('utf-8', 'surrogateescape')
            blob = hashlib.new(self.repositories[repo]['objectFormat'], b'blob %d\0' % len(raw) + raw).hexdigest()
            clean = blob == tracked[1]
        self.entries.append({'path': path, 'kind': 'symlink', 'target': target, 'source': 'git' if clean else 'data'})

    def walk(self, path: str, absolute: str) -> None:
        if os.path.lexists(os.path.join(absolute, '.git')):
            self.repository(path, absolute)
        info = os.lstat(absolute)
        self.entries.append({'path': path, 'kind': 'directory', 'mode': stat.S_IMODE(info.st_mode)})
        with os.scandir(absolute) as iterator:
            children = sorted(iterator, key=lambda item: item.name)
        for child in children:
            child_path, child_absolute = f'{path}/{child.name}', child.path
            if child.name == '.git':
                continue
            info = child.stat(follow_symlinks=False)
            directory = stat.S_ISDIR(info.st_mode)
            reason = omission_reason(child.name, directory)
            if reason:
                self.omit(child_path, reason, child_absolute, directory)
            elif directory:
                self.walk(child_path, child_absolute)
            elif stat.S_ISREG(info.st_mode):
                self.file(child_path, child_absolute, info)
            elif stat.S_ISLNK(info.st_mode):
                self.link(child_path, child_absolute)
            else:
                self.omissions.append({'path': child_path, 'reason': 'special', 'kind': 'special', 'files': 1, 'bytes': 0})

    def deletions(self) -> None:
        present = {entry['path'] for entry in self.entries if entry['kind'] != 'directory'}
        omitted = [item['path'] for item in self.omissions]
        for repo, tracked in self.tracked.items():
            for name, (mode, _) in sorted(tracked.items()):
                path = f'{repo}/{name}'
                if mode != '160000' and path not in present and not any(under(path, o) for o in omitted) \
                        and self.owner(path) == repo:
                    self.repositories[repo]['deleted'].append(path)


def copy(alias: str, sources: list[str], output: str) -> dict:
    if not NAME_RE.fullmatch(alias):
        raise Failure('invalid alias')
    roots = {}
    for item in sources:
        name, _, location = item.partition('=')
        if not NAME_RE.fullmatch(name) or name in roots or not os.path.isabs(location) or not os.path.isdir(location) \
                or os.path.islink(location):
            raise Failure(f'source must be NAME=/absolute/directory: {item!r}')
        roots[name] = os.path.realpath(location)
    target = os.path.realpath(output)
    if any(under(target, root) or under(root, target) for root in roots.values()):
        raise Failure('the copy cannot live inside a source, nor a source inside the copy')
    os.makedirs(output, mode=0o700, exist_ok=False)
    copier = Copier(output)
    for name, location in sorted(roots.items()):
        copier.walk(name, location)
    copier.deletions()
    data = [e for e in copier.entries if e['kind'] == 'file' and e['source'] == 'data']
    manifest = {
        'schema': SCHEMA, 'alias': alias, 'createdAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'host': socket.gethostname(), 'sources': {name: {'files': sum(1 for e in copier.entries
                                                  if e['kind'] == 'file' and under(e['path'], name))} for name in roots},
        'entries': copier.entries, 'repositories': sorted(copier.repositories.values(), key=lambda r: r['path']),
        'omissions': copier.omissions,
        'totals': {'files': sum(1 for e in copier.entries if e['kind'] == 'file'),
                   'bytes': sum(e['bytes'] for e in copier.entries if e['kind'] == 'file'),
                   'dataFiles': len(data), 'dataBytes': sum(e['bytes'] for e in data),
                   'repositories': len(copier.repositories), 'omissions': len(copier.omissions),
                   'omittedBytes': sum(o['bytes'] for o in copier.omissions)}}
    manifest['sha256'] = seal(manifest)
    with open(os.path.join(output, 'manifest.json'), 'x', encoding='utf-8') as handle:
        json.dump(manifest, handle, indent=1, sort_keys=True)
    return manifest


def load(copy_directory: str) -> dict:
    with open(os.path.join(copy_directory, 'manifest.json'), encoding='utf-8') as handle:
        manifest = json.load(handle)
    if manifest.get('schema') != SCHEMA or manifest.get('sha256') != seal(manifest):
        raise Failure('manifest seal does not verify')
    for entry in manifest['entries']:
        relative(entry['path'])
    for repo in manifest['repositories']:
        relative(repo['path'])
        if not re.fullmatch(r'repos/\d{4}\.bundle', repo['bundle']):
            raise Failure('unsafe bundle path')
    return manifest


def check(copy_directory: str) -> dict:
    manifest = load(copy_directory)
    missing = []
    for entry in manifest['entries']:
        if entry['kind'] == 'file' and entry['source'] == 'data':
            blob = os.path.join(copy_directory, 'data', entry['sha256'][:2], entry['sha256'])
            if not os.path.isfile(blob) or hash_file(blob, None, os.path.getsize(blob))[0] != entry['sha256']:
                missing.append(entry['path'])
    for repo in manifest['repositories']:
        bundle = os.path.realpath(os.path.join(copy_directory, repo['bundle']))
        if not os.path.isfile(bundle) or hash_file(bundle, None, os.path.getsize(bundle))[0] != repo['bundleSha256']:
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
    return {'manifest': manifest['sha256'], 'alias': manifest['alias'], 'dataFiles': manifest['totals']['dataFiles'],
            'repositories': len(manifest['repositories']), 'verified': True}


def mapper(rules: list[str]):
    pairs = []
    for rule in rules:
        old, _, new = rule.partition('=')
        pairs.append((relative(old), relative(new)))
    pairs.sort(key=lambda pair: -len(pair[0]))

    def apply(path: str) -> str:
        for old, new in pairs:
            if under(path, old):
                return new + path[len(old):]
        return path
    return apply, pairs


def restore(copy_directory: str, destination: str, rules: list[str]) -> dict:
    manifest = load(copy_directory)
    apply, pairs = mapper(rules)
    for repo in manifest['repositories']:
        if any(under(old, repo['path']) and old != repo['path'] for old, _ in pairs):
            raise Failure(f'mapping splits repository {repo["path"]}')
    targets = [apply(e['path']) for e in manifest['entries']]
    if len(set(targets)) != len(targets):
        raise Failure('mapping sends two manifest paths to the same place')
    os.makedirs(destination, mode=0o700, exist_ok=True)
    if os.listdir(destination):
        raise Failure('restore destination must be empty')
    base = os.path.realpath(destination)

    def place(path: str) -> str:
        target = os.path.join(base, apply(path))
        if os.path.commonpath([base, os.path.realpath(os.path.dirname(target))]) != base:
            raise Failure(f'restore path escapes the destination: {path}')
        return target
    for repo in sorted(manifest['repositories'], key=lambda r: r['path'].count('/')):
        target = place(repo['path'])
        os.makedirs(target, mode=0o700, exist_ok=True)
        git(target, 'init', '-q')
        bundle = os.path.join(os.path.realpath(copy_directory), repo['bundle'])
        git(target, 'fetch', '-q', '--update-head-ok', bundle, '+refs/*:refs/*')
        git(target, 'fetch', '-q', bundle, 'HEAD')
        branch = repo['branch']
        if branch and git(target, 'rev-parse', '-q', '--verify', f'refs/heads/{branch}', check=False).strip() == repo['head']:
            git(target, 'symbolic-ref', 'HEAD', f'refs/heads/{branch}')
            git(target, 'reset', '-q', '--hard')
        else:
            git(target, 'checkout', '-q', '--detach', repo['head'])
        for name, url in sorted(repo['remotes'].items()):
            git(target, 'remote', 'add', name, url)
    for entry in manifest['entries']:
        target = place(entry['path'])
        if entry['kind'] == 'directory':
            os.makedirs(target, exist_ok=True)
        elif entry['kind'] == 'file' and entry['source'] == 'data':
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if os.path.lexists(target):
                os.unlink(target)
            shutil.copyfile(os.path.join(copy_directory, 'data', entry['sha256'][:2], entry['sha256']), target)
            os.chmod(target, entry['mode'])
    for repo in manifest['repositories']:
        for path in repo['deleted']:
            target = place(path)
            if os.path.lexists(target):
                os.unlink(target)
    for entry in manifest['entries']:
        target = place(entry['path'])
        if entry['kind'] == 'symlink' and entry['source'] == 'data':
            if os.path.lexists(target):
                os.unlink(target)
            os.symlink(entry['target'], target)
        elif entry['kind'] == 'directory':
            os.chmod(target, entry['mode'] | 0o700)
    return verify_restore(manifest, base, apply, rules)


def verify_restore(manifest: dict, base: str, apply, rules: list[str]) -> dict:
    expected = {apply(e['path']): e for e in manifest['entries'] if e['kind'] != 'directory'}
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
            ok = os.path.islink(target) and os.readlink(target) == entry['target']
        else:
            ok = os.path.isfile(target) and not os.path.islink(target) \
                and hash_file(target, None, os.path.getsize(target))[0] == entry['sha256'] \
                and (entry['source'] == 'git' or stat.S_IMODE(os.lstat(target).st_mode) == entry['mode'])
        if not ok:
            problems.append(path)
        layout.append({'from': entry['path'], 'to': path, 'sha256': entry.get('sha256'), 'source': entry['source']})
    for path, repo in sorted(repos.items()):
        if git(os.path.join(base, path), 'rev-parse', 'HEAD').strip() != repo['head']:
            problems.append(path + ' (HEAD)')
    receipt = {'schema': RESTORE_SCHEMA, 'manifest': manifest['sha256'], 'alias': manifest['alias'],
               'restoredAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'mapping': rules,
               'repositories': [{'from': r['path'], 'to': p, 'head': r['head']} for p, r in sorted(repos.items())],
               'layout': layout, 'extrasUnderOmissions': extras, 'problems': problems, 'verified': not problems}
    receipt['sha256'] = seal(receipt)
    return receipt


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog='v4-medicion-migracion.sh')
    commands = parser.add_subparsers(dest='command', required=True)
    make = commands.add_parser('copiar')
    make.add_argument('--alias', required=True)
    make.add_argument('--origen', action='append', required=True, help='NAME=/absolute/directory')
    make.add_argument('--destino', required=True)
    commands.add_parser('comprobar-copia').add_argument('copia')
    back = commands.add_parser('restaurar')
    back.add_argument('copia')
    back.add_argument('--destino')
    back.add_argument('--mapa', action='append', default=[], help='OLD_PREFIX=NEW_PREFIX')
    back.add_argument('--recibo')
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == 'copiar':
            manifest = copy(arguments.alias, arguments.origen, arguments.destino)
            print(json.dumps({'manifest': manifest['sha256'], **manifest['totals']}, sort_keys=True))
        elif arguments.command == 'comprobar-copia':
            print(json.dumps(check(arguments.copia), sort_keys=True))
        else:
            scratch = None if arguments.destino else tempfile.mkdtemp(prefix='cauce-v4-restauracion-')
            try:
                receipt = restore(arguments.copia, arguments.destino or scratch, arguments.mapa)
            finally:
                if scratch:
                    shutil.rmtree(scratch, ignore_errors=True)
            text = json.dumps(receipt, indent=1, sort_keys=True)
            if arguments.recibo:
                with open(arguments.recibo, 'x', encoding='utf-8') as handle:
                    handle.write(text + '\n')
            print(json.dumps({**{k: receipt[k] for k in ('manifest', 'verified', 'sha256')},
                              'problems': len(receipt['problems']), 'files': len(receipt['layout'])}, sort_keys=True))
            return 0 if receipt['verified'] else 1
    except (Failure, OSError, subprocess.SubprocessError, ValueError, KeyError) as error:
        print(f'v4-medicion-migracion: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
