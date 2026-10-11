from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import ssl
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request

PATH = re.compile(r'(?:context|directives)/[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\.(?:md|txt|json|yaml|yml)\Z')
IDENTITY = re.compile(r'[A-Za-z][A-Za-z0-9_-]{0,63}\Z')
SENSITIVE = re.compile(r'(?:auth|credential|secret|token|session|key|password)', re.I)


class ContextFailure(ValueError):
    pass


def valid_path(value: str) -> str:
    if not PATH.fullmatch(value) or any(SENSITIVE.search(part) for part in value.split('/')):
        raise ContextFailure('context path is unavailable')
    return value


def read_scoped(root: pathlib.Path, relative: str, limit: int = 262144) -> bytes:
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.absolute().parts[1:]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        for part in pathlib.PurePosixPath(relative).parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_fd
        file_fd = os.open(pathlib.PurePosixPath(relative).name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=descriptor)
        try:
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > limit:
                raise ContextFailure('context file exceeds its safe boundary')
            with os.fdopen(file_fd, 'rb', closefd=False) as stream:
                content = stream.read(limit + 1)
            after = os.fstat(file_fd)
            if len(content) > limit or (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise ContextFailure('context file changed during its read')
            return content
        finally:
            os.close(file_fd)
    finally:
        os.close(descriptor)


def private_session(location: str) -> dict:
    path = pathlib.Path(location).absolute()
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o077:
        raise ContextFailure('console session file must be private and owned by this user')
    raw = json.loads(read_scoped(path.parent, path.name, 16384))
    cookie = raw.get('cookie') if isinstance(raw, dict) else None
    if not isinstance(cookie, str) or not cookie or len(cookie) > 12000 or any(ord(char) < 32 for char in cookie):
        raise ContextFailure('console session file is unavailable')
    return raw


def private_cookie(location: str) -> str:
    return private_session(location)['cookie']


class ContextClient:
    def __init__(self, gateway: str, origin: str, session_file: str, ca_file: str | None = None):
        destination = urllib.parse.urlsplit(gateway)
        browser = urllib.parse.urlsplit(origin)
        for value in (destination, browser):
            if value.username or value.password or value.query or value.fragment or value.path not in ('', '/') \
                    or value.scheme != 'https' and not (value.scheme == 'http' and value.hostname in ('localhost', '127.0.0.1', '::1')):
                raise ContextFailure('gateway and origin must be trusted absolute origins')
        self.gateway = gateway.rstrip('/')
        self.origin = origin.rstrip('/')
        session = private_session(session_file)
        self.cookie = session['cookie']
        self.csrf = session.get('csrf_token')
        self.tls = ssl.create_default_context(cafile=ca_file)

    def request(self, method: str, tenant: str, alias: str, suffix: str = '', body=None):
        if not IDENTITY.fullmatch(tenant) or not IDENTITY.fullmatch(alias):
            raise ContextFailure('context target is unavailable')
        base = '/v3/console/context/agents/' + urllib.parse.quote(tenant, safe='') + '/' + urllib.parse.quote(alias, safe='')
        payload = None if body is None else json.dumps(body, separators=(',', ':')).encode()
        headers = {'Cookie': self.cookie, 'Origin': self.origin, 'Content-Type': 'application/json'}
        if method not in ('GET', 'HEAD'):
            if not isinstance(self.csrf, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', self.csrf):
                raise ContextFailure('console session file requires a valid csrf_token for mutations')
            headers['X-CSRF-Token'] = self.csrf
        request = urllib.request.Request(self.gateway + base + suffix, method=method, data=payload,
                                         headers=headers)
        try:
            with urllib.request.urlopen(request, context=self.tls, timeout=65) as response:
                raw = response.read(2097153)
                if len(raw) > 2097152:
                    raise ContextFailure('context response exceeds limit')
                return json.loads(raw)
        except urllib.error.HTTPError as error:
            raise ContextFailure('context request rejected with HTTP ' + str(error.code)) from None
        except (urllib.error.URLError, TimeoutError):
            raise ContextFailure('context gateway is unavailable') from None


def arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument('--gateway', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--session-file', required=True)
    parser.add_argument('--ca-file')
    parser.add_argument('--tenant', required=True)
    parser.add_argument('--alias', required=True)


def export_context(snapshot: dict, directory: str) -> dict:
    root = pathlib.Path(directory).absolute()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    if root.resolve() != root:
        raise ContextFailure('context export root must be a real directory')
    for file in snapshot['files']:
        relative = valid_path(file['path'])
        path = root / relative
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
            stream.write(file['content'])
    metadata = {key: snapshot[key] for key in ('company_id', 'tenant_id', 'alias', 'version', 'digest')}
    descriptor = os.open(root / 'context-manifest.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        json.dump(metadata, stream)
    return {'state': 'exported', 'directory': str(root), **metadata}


def main() -> int:
    parser = argparse.ArgumentParser(description='Contextos versionados con sesión humana de la consola')
    arguments(parser)
    commands = parser.add_subparsers(dest='operation', required=True)
    for name in ('read', 'status', 'history', 'retry', 'apply'):
        command = commands.add_parser(name)
        if name == 'history':
            command.add_argument('--before', type=int)
    edit = commands.add_parser('edit')
    edit.add_argument('--expected-version', type=int, required=True)
    edit.add_argument('--input', required=True)
    restore = commands.add_parser('restore')
    restore.add_argument('--expected-version', type=int, required=True)
    restore.add_argument('--version', type=int, required=True)
    diff = commands.add_parser('diff')
    diff.add_argument('--from-version', type=int, required=True)
    diff.add_argument('--to-version', type=int, required=True)
    export = commands.add_parser('export')
    export.add_argument('--directory', required=True)
    args = parser.parse_args()
    try:
        client = ContextClient(args.gateway, args.origin, args.session_file, args.ca_file)
        body = None
        method = 'GET'
        suffix = '' if args.operation in ('read', 'export', 'edit') else '/' + args.operation
        if args.operation == 'edit':
            path = pathlib.Path(args.input).absolute()
            files = json.loads(read_scoped(path.parent, path.name, 1048576))
            body = {'expected_version': args.expected_version, 'source': 'cli', 'files': files}
            method = 'PUT'
        if args.operation in ('retry', 'apply', 'restore'):
            method = 'POST'
            body = {'expected_version': args.expected_version, 'version': args.version} if args.operation == 'restore' else {}
            if args.operation == 'retry':
                suffix = '/sync/retry'
        if args.operation == 'history' and args.before is not None:
            suffix += '?before=' + str(args.before)
        if args.operation == 'diff':
            suffix += '?from=' + str(args.from_version) + '&to=' + str(args.to_version)
        result = client.request(method, args.tenant, args.alias, suffix, body)
        if args.operation == 'export':
            result = export_context(result, args.directory)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ContextFailure as error:
        print(str(error), file=sys.stderr)
        return 1
    except (OSError, ValueError):
        print('La operación de contexto no pudo completarse; revisa sesión, destino, CAS y rutas permitidas.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
