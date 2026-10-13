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
    if not raw.get('gateway') or not raw.get('origin'):
        raise ContextFailure('vuelve a iniciar sesión con cauce login')
    return raw


def private_cookie(location: str) -> str:
    return private_session(location)['cookie']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, stream, code, message, headers, new_url):
        return None


def trusted_origin(value: str) -> str:
    try:
        parsed = urllib.parse.urlsplit(value)
        port = parsed.port
        if not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment \
                or parsed.path not in ('', '/') or any(ord(char) < 33 or ord(char) == 127 for char in value) \
                or parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname in ('localhost', '127.0.0.1', '::1')):
            raise ValueError()
        host = parsed.hostname.lower()
        if ':' in host:
            host = '[' + host + ']'
        default_port = 443 if parsed.scheme == 'https' else 80
        return parsed.scheme + '://' + host + (':' + str(port) if port is not None and port != default_port else '')
    except (ValueError, AttributeError, TypeError):
        raise ContextFailure('gateway and origin must use HTTPS or loopback HTTP without credentials or paths') from None


def request_json(gateway: str, origin: str, ca_file: str | None, method: str, path: str, body=None, headers=None,
                 timeout: int = 30, rejected: str = 'console request rejected', unavailable: str = 'console gateway is unavailable'):
    parsed = urllib.parse.urlsplit(path)
    if not path.startswith('/') or path.startswith('//') or parsed.scheme or parsed.netloc or parsed.fragment \
            or '\\' in path or any(ord(char) < 32 or ord(char) == 127 for char in path):
        raise ContextFailure('console request path must stay on its gateway')
    payload = None if body is None else json.dumps(body, separators=(',', ':')).encode()
    request = urllib.request.Request(gateway + path, method=method, data=payload,
        headers={'Origin': origin, 'Accept': 'application/json', 'Content-Type': 'application/json', **(headers or {})})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler(), NoRedirect(),
        urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=ca_file)))
    try:
        with opener.open(request, timeout=timeout) as response:
            raw = response.read(2097153)
            if len(raw) > 2097152:
                raise ContextFailure('console response exceeds limit')
            result = json.loads(raw) if raw else None
            return result, response.headers.get_all('Set-Cookie', [])
    except urllib.error.HTTPError as error:
        code = error.code
        error.close()
        raise ContextFailure(rejected + ' with HTTP ' + str(code) + '; redirects are disabled') from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise ContextFailure(unavailable) from None


class ConsoleSessionClient:
    def __init__(self, session_file: str, gateway: str | None = None, origin: str | None = None, ca_file: str | None = None):
        self.session = private_session(session_file)
        stored_gateway = trusted_origin(self.session.get('gateway'))
        stored_origin = trusted_origin(self.session.get('origin'))
        self.gateway = trusted_origin(gateway) if gateway is not None else stored_gateway
        self.origin = trusted_origin(origin) if origin is not None else stored_origin
        if self.gateway != stored_gateway or self.origin != stored_origin:
            raise ContextFailure('console session is bound to a different gateway or origin; log in again')
        self.cookie = self.session['cookie']
        self.csrf = self.session.get('csrf_token')
        self.ca_file = ca_file

    def request(self, method: str, path: str, body=None):
        method = method.upper()
        headers = {'Cookie': self.cookie}
        if method not in ('GET', 'HEAD'):
            if not isinstance(self.csrf, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', self.csrf):
                raise ContextFailure('console session requires a valid csrf_token for mutations')
            headers['X-CSRF-Token'] = self.csrf
        return request_json(self.gateway, self.origin, self.ca_file, method, path, body, headers)[0]


class ContextClient:
    def __init__(self, gateway: str, origin: str, session_file: str, ca_file: str | None = None):
        session = ConsoleSessionClient(session_file, gateway, origin, ca_file)
        self.gateway = session.gateway
        self.origin = session.origin
        self.cookie = session.cookie
        self.csrf = session.csrf
        self.ca_file = ca_file
        self.tls = ssl.create_default_context(cafile=ca_file)

    def request(self, method: str, tenant: str, alias: str, suffix: str = '', body=None):
        if not IDENTITY.fullmatch(tenant) or not IDENTITY.fullmatch(alias):
            raise ContextFailure('context target is unavailable')
        base = '/v3/console/context/agents/' + urllib.parse.quote(tenant, safe='') + '/' + urllib.parse.quote(alias, safe='')
        headers = {'Cookie': self.cookie}
        if method not in ('GET', 'HEAD'):
            if not isinstance(self.csrf, str) or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', self.csrf):
                raise ContextFailure('console session file requires a valid csrf_token for mutations')
            headers['X-CSRF-Token'] = self.csrf
        try:
            return request_json(self.gateway, self.origin, self.ca_file, method, base + suffix, body, headers, timeout=65,
                                rejected='context request rejected', unavailable='context gateway is unavailable')[0]
        except ContextFailure as error:
            message = str(error)
            marker = '; redirects are disabled'
            if message.endswith(marker) and message.startswith('context request rejected'):
                raise ContextFailure(message[:-len(marker)]) from None
            raise


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
